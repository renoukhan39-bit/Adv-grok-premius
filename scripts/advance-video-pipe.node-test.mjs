import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";

const mcp = fileURLToPath(new URL("./mcp-server.ts", import.meta.url));
const verify = fileURLToPath(new URL("./verify-rendered-video.mjs", import.meta.url));
const workspaceDir = await mkdtemp(join(tmpdir(), "video-pipe-mcp-"));
const haveFFmpeg = ["ffmpeg", "ffprobe"].every(command => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0);
after(() => rm(workspaceDir, { recursive: true, force: true }));

function image(filename, color, dimensions = "64x48") {
  const result = spawnSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    `color=c=${color}:s=${dimensions}`, "-frames:v", "1", "-threads", "1", filename], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
}

async function client(t, workspace) {
  const child = spawn(process.execPath, ["--experimental-strip-types", mcp], {
    env: { ...process.env, OPENMAUSBOT_VIDEO_WORKSPACE_ROOT: workspace, OPENMAUSBOT_URL: "http://127.0.0.1:8799" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let nextId = 0;
  const pending = new Map();
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", data => { errors += data; });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timeout); entry.resolve(message); }
  });
  child.on("exit", (code) => {
    for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(new Error(`MCP exited ${code}: ${errors}`)); }
    pending.clear();
  });
  async function send(method, params = {}) {
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out: ${errors}`)); }, 110_000);
      pending.set(id, { resolve, reject, timeout });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const message = await response;
    assert.notEqual(Object.hasOwn(message, "result"), Object.hasOwn(message, "error"));
    return message.error ? { error: message.error } : message.result;
  }
  const hello = await send("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture-video-client", version: "1" },
  });
  assert.equal(hello.serverInfo.name, "openmausbot-mcp");
  return send;
}

async function fixture(t) {
  const a = join(workspaceDir, `a-${t.name.replaceAll(/[^a-zA-Z0-9]/g, "-")}`);
  const b = join(workspaceDir, `b-${t.name.replaceAll(/[^a-zA-Z0-9]/g, "-")}`);
  await mkdir(join(a, "scenes"), { recursive: true });
  await mkdir(join(b, "scenes"), { recursive: true });
  image(join(a, "scenes", "red.png"), "red", "96x64");
  image(join(a, "scenes", "blue.jpg"), "blue", "64x96");
  await writeFile(join(a, "scenes", "plan.json"), JSON.stringify({
    width: 320, height: 180, scenes: [
      { image: "red.png", durationSeconds: 0.4 },
      { image: "blue.jpg", durationSeconds: 0.6 },
    ],
  }));
  await writeFile(join(b, "scenes", "foreign.json"), JSON.stringify({ width: 320, height: 180, scenes: [{ image: "foreign.png", durationSeconds: 1 }] }));
  return { a, b };
}

it("discovers advance-video-pipe and returns a re-openable 320x180 one-second artifact", { skip: !haveFFmpeg }, async t => {
  const { a, b } = await fixture(t);
  const call = await client(t, a);
  const tools = (await call("tools/list")).tools;
  assert.ok(tools.some(tool => tool.name === "advance-video-pipe_render_scene_plan"));
  const answer = await call("tools/call", { name: "advance-video-pipe_render_scene_plan", arguments: { plan_path: "scenes/plan.json" } });
  assert.equal(answer.isError, undefined, JSON.stringify(answer));
  const { artifact, duration, width, height } = answer.structuredContent;
  assert.equal(typeof artifact, "string");
  assert.match(artifact, /^advance-video-pipe:\/\/workspace\/[0-9a-f]{20}\/render-[0-9a-f-]+\.mp4$/);
  assert.deepEqual({ duration, width, height }, { duration: 1, width: 320, height: 180 });
  assert.equal(JSON.stringify(answer).includes(a), false, "MCP response must not reveal host file paths");
  assert.equal(JSON.stringify(answer).includes(b), false);
  const resources = await call("resources/list");
  const listed = resources.resources.find(item => item.uri === artifact);
  assert.ok(listed);
  const read = await call("resources/read", { uri: artifact });
  assert.equal(read.contents.length, 1);
  assert.equal(read.contents[0].mimeType, "video/mp4");
  const reopened = join(workspaceDir, "reopened.mp4");
  const downloaded = Buffer.from(read.contents[0].blob, "base64");
  assert.deepEqual(downloaded, await readFile(join(a, ".advance-video-pipe", "artifacts", listed.name)));
  await writeFile(reopened, downloaded);
  const verified = spawnSync(process.execPath, [verify, reopened], { encoding: "utf8", timeout: 15_000 });
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout), { duration, width, height });
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "default=noprint_wrappers=1:nokey=1", reopened], { encoding: "utf8", timeout: 15_000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(Number(probe.stdout.trim()), 25);
});

it("denies cross-workspace plans and artifacts without producing any file", { skip: !haveFFmpeg }, async t => {
  const { a, b } = await fixture(t);
  const callA = await client(t, a);
  const callB = await client(t, b);
  const otherPlan = relative(a, join(b, "scenes", "foreign.json")).split(sep).join("/");
  const forbidden = await callA("tools/call", { name: "advance-video-pipe_render_scene_plan", arguments: { plan_path: otherPlan } });
  assert.equal(forbidden.isError, true);
  assert.match(forbidden.content[0].text, /selected workspace/);
  const missing = await callA("tools/call", { name: "advance-video-pipe_render_scene_plan", arguments: { plan_path: "scenes/missing.json" } });
  assert.equal(missing.isError, true);
  assert.equal(JSON.stringify(missing).includes(a), false, "Missing input must not expose a host path");
  if (process.platform !== "win32") {
    await symlink(join(b, "scenes", "foreign.json"), join(a, "scenes", "linked.json"));
    const linked = await callA("tools/call", { name: "advance-video-pipe_render_scene_plan", arguments: { plan_path: "scenes/linked.json" } });
    assert.equal(linked.isError, true);
    assert.match(linked.content[0].text, /outside the selected workspace/);
  }
  const otherImage = join(b, "scenes", "foreign.png");
  await writeFile(otherImage, await readFile(join(a, "scenes", "red.png")));
  const imagePath = relative(join(a, "scenes"), otherImage).split(sep).join("/");
  await writeFile(join(a, "scenes", "other-image.json"), JSON.stringify({ scenes: [{ image: imagePath, durationSeconds: 1 }] }));
  const deniedImage = await callA("tools/call", { name: "advance-video-pipe_render_scene_plan", arguments: { plan_path: "scenes/other-image.json" } });
  assert.equal(deniedImage.isError, true);
  assert.match(deniedImage.content[0].text, /outside the scene plan directory/);
  assert.deepEqual((await callA("resources/list")).resources, []);
  const ok = await callA("tools/call", { name: "advance-video-pipe_render_scene_plan", arguments: { plan_path: "scenes/plan.json" } });
  assert.equal(ok.isError, undefined, JSON.stringify(ok));
  const foreign = await callB("resources/read", { uri: ok.structuredContent.artifact });
  assert.equal(foreign.error.code, -32002);
  const localName = (await callA("resources/list")).resources[0].name;
  await rm(join(a, ".advance-video-pipe", "artifacts", localName));
  const deleted = await callA("resources/read", { uri: ok.structuredContent.artifact });
  assert.deepEqual(foreign.error, deleted.error);
  assert.match(deleted.error.message, /selected workspace/);
  assert.deepEqual((await callB("resources/list")).resources, []);
});

it("returns JSON-RPC errors for malformed resource requests and storage failures", async t => {
  const root = await mkdtemp(join(workspaceDir, "resource-errors-"));
  const call = await client(t, root);
  for (const params of [{}, { uri: "invalid" }, { uri: "advance-video-pipe://workspace/bad/name" }]) {
    const response = await call("resources/read", params);
    assert.equal(response.error.code, -32602);
  }
  await writeFile(join(root, ".advance-video-pipe"), "unavailable storage");
  const listing = await call("resources/list");
  assert.equal(listing.error.code, -32603);
  assert.equal(listing.error.message.includes(root), false);
});

it("returns tool errors and publishes no artifact for a failed render", { skip: !haveFFmpeg }, async t => {
  const { a } = await fixture(t);
  const call = await client(t, a);
  await writeFile(join(a, "scenes", "red.png"), "not a valid image");
  const error = await call("tools/call", { name: "advance-video-pipe_render_scene_plan", arguments: { plan_path: "scenes/plan.json" } });
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /ffmpeg could not render/);
  assert.equal(JSON.stringify(error).includes(a), false, "Render errors must not expose host paths");
  assert.deepEqual((await call("resources/list")).resources, []);
  assert.deepEqual(await readdir(join(a, ".advance-video-pipe", "artifacts")), []);
});
