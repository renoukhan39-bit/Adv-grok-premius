import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./verify-rendered-video.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "verify-rendered-video-"));
const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

after(() => rmSync(directory, { recursive: true, force: true }));

function runVerifier(args, env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, timeout: 15_000 });
}

function render(filename, source, encoder) {
  const destination = join(directory, filename);
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", source,
    ...encoder, destination,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `ffmpeg could not generate fixture: ${result.stderr}`);
  return destination;
}

function rejects(result, message) {
  assert.equal(result.status, 1, `unexpected verifier exit: ${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, message);
}

it("reports machine-readable metadata for a real generated video", { skip: !ffmpegAvailable }, () => {
  const video = render("tiny rendered clip.mp4", "color=c=red:s=64x48:r=10:d=0.5", ["-an", "-c:v", "mpeg4", "-q:v", "5"]);
  const result = runVerifier([video]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const data = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(data).sort(), ["duration", "height", "width"]);
  assert.deepEqual({ width: data.width, height: data.height }, { width: 64, height: 48 });
  assert.ok(data.duration >= 0.4 && data.duration <= 0.6, `unexpected duration ${data.duration}`);
});

it("accepts a rendered video containing both video and audio tracks", { skip: !ffmpegAvailable }, () => {
  const video = join(directory, "video and audio.mp4");
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=80x60:r=10:d=0.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
    "-shortest", "-c:v", "mpeg4", "-c:a", "aac", video,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `ffmpeg could not generate fixture: ${result.stderr}`);
  const verified = runVerifier([video]);
  assert.equal(verified.status, 0, verified.stderr);
  const metadata = JSON.parse(verified.stdout);
  assert.equal(metadata.width, 80);
  assert.equal(metadata.height, 60);
  assert.ok(metadata.duration > 0);
});

it("refuses missing arguments and missing local input", () => {
  rejects(runVerifier([]), /Usage:.*local-video-file/);
  rejects(runVerifier([join(directory, "missing.mp4")]), /does not exist/);
  rejects(runVerifier(["https://example.test/remote.mp4"]), /does not exist/);
});

it("refuses empty, corrupt and non-file input", () => {
  const empty = join(directory, "empty.mp4");
  const corrupt = join(directory, "corrupt.mp4");
  writeFileSync(empty, "");
  writeFileSync(corrupt, "this is not a video");
  rejects(runVerifier([empty]), /empty/);
  rejects(runVerifier([corrupt]), /invalid or corrupt media/);
  rejects(runVerifier([directory]), /regular local file/);
});

it("refuses audio-only media", { skip: !ffmpegAvailable }, () => {
  const audio = render("audio only.wav", "sine=frequency=440:duration=0.5", ["-c:a", "pcm_s16le"]);
  rejects(runVerifier([audio]), /No readable video stream/);
});

it("fails clearly when ffprobe is not installed", () => {
  const input = join(directory, "has content.mp4");
  writeFileSync(input, "nonempty");
  const emptyPath = join(directory, "no-binaries");
  rejects(runVerifier([input], { ...process.env, PATH: emptyPath, Path: emptyPath }), /ffprobe was not found in PATH/);
});
