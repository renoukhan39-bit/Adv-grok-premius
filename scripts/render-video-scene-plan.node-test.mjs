import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("./render-video-scene-plan.mjs", import.meta.url));
const verifier = fileURLToPath(new URL("./verify-rendered-video.mjs", import.meta.url));
const haveFFmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const mediaTest = { skip: haveFFmpeg ? false : "requires FFmpeg" };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "scene-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "project");
  await mkdir(directory);
  const plan = join(directory, "plan.json");
  const output = join(directory, "out.mp4");
  return {
    root, directory, output,
    plan: value => writeFile(plan, JSON.stringify(value)),
    render: (env = process.env) => run(process.execPath, [cli, plan, output], { env, timeout: 25_000 }),
  };
}

function scene(image, durationSeconds = 0.2) {
  return { image, durationSeconds };
}

async function still(path, color, dimensions = "64x48") {
  await run("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    `color=c=${color}:s=${dimensions}`, "-frames:v", "1", "-threads", "1", path], { timeout: 10_000 });
}

async function rejectsCli(promise, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, message);
    return true;
  });
}

it("encodes the supplied images in order at their requested durations", mediaTest, async t => {
  const f = await fixture(t);
  await still(join(f.directory, "first card.png"), "red");
  await still(join(f.directory, "second.jpg"), "blue", "32x64");
  await f.plan({ width: 96, height: 64, scenes: [scene("first card.png", 0.16), scene("second.jpg", 0.24)] });
  const { stdout, stderr } = await f.render();
  assert.equal(stderr, "");
  const metadata = { duration: 0.4, width: 96, height: 64 };
  assert.deepEqual(JSON.parse(stdout), { output: f.output, ...metadata });
  assert.deepEqual(JSON.parse((await run(process.execPath, [verifier, f.output])).stdout), metadata);

  const decoded = await run("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", f.output,
    "-vf", "format=rgb24,crop=1:1:48:32", "-threads", "1", "-f", "rawvideo", "pipe:1"],
  { encoding: "buffer", timeout: 10_000 });
  assert.equal(decoded.stdout.length, 10 * 3);
  for (let i = 0; i < 10; i++) {
    const [red, green, blue] = decoded.stdout.subarray(i * 3, i * 3 + 3);
    assert.ok(i < 4 ? red > 180 && blue < 60 : blue > 180 && red < 60, `wrong color at frame ${i}`);
    assert.ok(green < 60);
  }
});

it("validates the plan, dimensions, image names and frame budget before encoding", async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "plan.json"), "{");
  await rejectsCli(f.render(), /valid JSON/);
  for (const [plan, expected] of [
    [{ scenes: [] }, /between 1 and 12/],
    [{ scenes: Array(13).fill(scene("a.png")) }, /between 1 and 12/],
    [{ width: 15, scenes: [scene("a.png")] }, /even dimensions/],
    [{ scenes: [scene("https://example.invalid/img.png")] }, /relative PNG or JPEG/],
    [{ scenes: [scene("a.svg")] }, /relative PNG or JPEG/],
    [{ scenes: [scene("a.png", "1")] }, /durationSeconds/],
    [{ scenes: [scene("a.png", 0.01)] }, /durationSeconds/],
    [{ scenes: [scene("a.png", 41), scene("b.png", 20)] }, /at most 60 seconds/],
  ]) {
    await f.plan(plan);
    await rejectsCli(f.render(), expected);
  }
  assert.deepEqual(await readdir(f.directory), ["plan.json"]);
});

it("rejects images outside the project, including symlink targets", async t => {
  const f = await fixture(t);
  const outside = join(f.root, "outside.png");
  await writeFile(outside, "private fixture");
  await f.plan({ scenes: [scene("../outside.png")] });
  await rejectsCli(f.render(), /outside the scene plan directory/);
  if (process.platform !== "win32") {
    await symlink(outside, join(f.directory, "inside.png"));
    await f.plan({ scenes: [scene("inside.png")] });
    await rejectsCli(f.render(), /outside the scene plan directory/);
  }
  await assert.rejects(readFile(f.output), { code: "ENOENT" });
});

it("cleans failed attempts and lets a corrected image render to the same path", mediaTest, async t => {
  const f = await fixture(t);
  const image = join(f.directory, "retry.png");
  await f.plan({ scenes: [scene("retry.png", 0.04)] });
  await writeFile(image, "not a PNG");
  await rejectsCli(f.render(), /ffmpeg could not render/);
  assert.deepEqual((await readdir(f.directory)).sort(), ["plan.json", "retry.png"]);
  await still(image, "green");
  const { stdout } = await f.render();
  assert.deepEqual(JSON.parse(stdout), { output: f.output, width: 640, height: 360, duration: 0.04 });
});

it("preserves existing outputs and allows only one concurrent publisher", mediaTest, async t => {
  const f = await fixture(t);
  await still(join(f.directory, "card.png"), "yellow");
  await f.plan({ scenes: [scene("card.png")] });
  await writeFile(f.output, "keep me");
  await rejectsCli(f.render(), /already exists/);
  assert.equal(await readFile(f.output, "utf8"), "keep me");
  await rm(f.output);
  const attempts = await Promise.allSettled([f.render(), f.render()]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.match(attempts.find(result => result.status === "rejected").reason.stderr, /already exists/);
  assert.deepEqual((await readdir(f.directory)).sort(), ["card.png", "out.mp4", "plan.json"]);
});

it("reports a missing encoder and leaves no output", async t => {
  const f = await fixture(t);
  const noBins = join(f.root, "no-binaries");
  await mkdir(noBins);
  await writeFile(join(f.directory, "image.png"), "data");
  await f.plan({ scenes: [scene("image.png")] });
  await rejectsCli(f.render({ ...process.env, PATH: noBins, Path: noBins }), /requires ffmpeg/);
  assert.deepEqual((await readdir(f.directory)).sort(), ["image.png", "plan.json"]);
});

it("keeps a rendered file private when verification fails", {
  skip: !haveFFmpeg || process.platform === "win32" ? "uses a POSIX fixture verifier" : false,
}, async t => {
  const f = await fixture(t);
  await still(join(f.directory, "card.png"), "red");
  await f.plan({ scenes: [scene("card.png")] });
  const bin = join(f.root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "ffprobe"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await rejectsCli(f.render({ ...process.env, PATH: `${bin}:${process.env.PATH}` }), /ffprobe could not inspect/);
  assert.deepEqual((await readdir(f.directory)).sort(), ["card.png", "plan.json"]);
});
