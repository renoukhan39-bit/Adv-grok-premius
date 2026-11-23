import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { renderScenePlan } from "./render-video-scene-plan.mjs";

const ARTIFACTS = ".advance-video-pipe";
const OUTPUTS = "artifacts";
const MAX_READ_BYTES = 32 * 1024 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ARTIFACT_NAME = new RegExp(`^render-${UUID}\\.mp4$`);

function inside(root, file) {
  const part = relative(root, file);
  return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

async function workspace() {
  const configured = process.env.OPENMAUSBOT_VIDEO_WORKSPACE_ROOT;
  if (!configured || !isAbsolute(configured)) {
    throw new Error("Video workspace is not configured; set OPENMAUSBOT_VIDEO_WORKSPACE_ROOT to a trusted absolute workspace directory");
  }
  const root = await realpath(configured).catch(() => { throw new Error("Configured video workspace is unavailable"); });
  if (!(await stat(root)).isDirectory()) throw new Error("Video workspace is not a directory");
  const scope = createHash("sha256").update(root).digest("hex").slice(0, 20);
  return { root, scope };
}

function planParts(input) {
  if (typeof input !== "string" || !input || input.length > 512 || input.includes("\\") || input.includes(":") ||
      isAbsolute(input) || !input.toLowerCase().endsWith(".json")) {
    throw new Error("plan_path must be a relative JSON file path within the selected workspace");
  }
  const parts = input.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) {
    throw new Error("plan_path must stay inside the selected workspace");
  }
  return parts;
}

async function artifactDirectory(root, create = false) {
  const parent = join(root, ARTIFACTS);
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) throw new Error("Workspace artifact directory must not be a symlink");
  const folder = join(parent, OUTPUTS);
  if (create) await mkdir(folder, { recursive: true, mode: 0o700 });
  const real = await realpath(folder);
  if (real !== folder) throw new Error("Workspace artifact directory must not be a symlink");
  if (!(await stat(real)).isDirectory()) throw new Error("Workspace artifact location must be a directory");
  return real;
}

function artifactUri(scope, name) {
  return `advance-video-pipe://workspace/${scope}/${name}`;
}

export class VideoResourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }

  static notFound() {
    return new VideoResourceError(-32002, "Video artifact not found in the selected workspace");
  }
}

function parseArtifactUri(uri, scope) {
  if (typeof uri !== "string") throw new VideoResourceError(-32602, "Artifact URI must be a string");
  let parsed;
  try { parsed = new URL(uri); } catch { throw new VideoResourceError(-32602, "Invalid video artifact URI"); }
  if (parsed.protocol !== "advance-video-pipe:" || parsed.host !== "workspace" ||
      parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) {
    throw new VideoResourceError(-32602, "Invalid video artifact URI");
  }
  const match = /^\/([0-9a-f]{20})\/(.+)$/.exec(parsed.pathname);
  if (!match || !ARTIFACT_NAME.test(match[2])) throw new VideoResourceError(-32602, "Invalid video artifact URI");
  if (match[1] !== scope) throw VideoResourceError.notFound();
  return match[2];
}

export async function renderWorkspaceVideo(planPath) {
  const { root, scope } = await workspace();
  const source = await realpath(resolve(root, ...planParts(planPath))).catch(() => {
    throw new Error("Scene plan is unavailable in the selected workspace");
  });
  if (!inside(root, source) || source.startsWith(join(root, ARTIFACTS) + sep)) {
    throw new Error("Scene plan is outside the selected workspace");
  }
  if (!(await stat(source)).isFile()) throw new Error("Scene plan must be a regular file");
  const directory = await artifactDirectory(root, true);
  const name = `render-${randomUUID()}.mp4`;
  const destination = join(directory, name);
  try {
    const { duration, width, height } = await renderScenePlan(source, destination);
    return { artifact: artifactUri(scope, name), duration, width, height };
  } catch (error) {
    await rm(destination, { force: true });
    if (/ffmpeg could not render/.test(error.message)) throw new Error("ffmpeg could not render the scene plan");
    if (/requires ffmpeg/.test(error.message)) throw new Error("Rendering requires ffmpeg with libx264");
    if (/outside the scene plan directory/.test(error.message)) throw new Error("A scene image is outside the scene plan directory");
    if (/ffprobe|Verified video/.test(error.message)) throw new Error("Rendered video verification failed");
    if (/^(Scene plan must|Scene \d+ needs|Use even dimensions|A render can)/.test(error.message)) throw error;
    throw new Error("Scene plan rendering failed; check the local media files");
  }
}

export async function readWorkspaceVideo(uri) {
  const { root, scope } = await workspace();
  const name = parseArtifactUri(uri, scope);
  const folder = await artifactDirectory(root);
  const filename = join(folder, name);
  const file = await lstat(filename);
  if (!file.isFile()) throw VideoResourceError.notFound();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_READ_BYTES) {
      throw new Error(`Video artifact must be a nonempty file under ${MAX_READ_BYTES} bytes`);
    }
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) throw new Error("Video artifact changed during read");
      offset += bytesRead;
    }
    return { contents: [{ uri, mimeType: "video/mp4", blob: bytes.toString("base64") }] };
  } finally {
    await handle.close();
  }
}

export async function listWorkspaceVideos() {
  const { root, scope } = await workspace();
  let names;
  try { names = await readdir(await artifactDirectory(root)); } catch (error) {
    if (error.code === "ENOENT") return { resources: [] };
    throw error;
  }
  const resources = [];
  for (const name of names.sort()) {
    if (!ARTIFACT_NAME.test(name)) continue;
    const filename = join(root, ARTIFACTS, OUTPUTS, name);
    const info = await lstat(filename);
    if (info.isFile() && info.size > 0 && info.size <= MAX_READ_BYTES) {
      resources.push({ uri: artifactUri(scope, name), name, mimeType: "video/mp4" });
    }
    if (resources.length === 100) break;
  }
  return { resources };
}
