#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
const standaloneFormats = "mov,matroska,webm,avi,mpegts,mpeg,flv,asf,mxf,nut,dv,ogg,gif,apng,yuv4mpegpipe,wav,mp3,aac,flac";

function probe(fd, input, timeout) {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-probesize", "1048576", "-analyzeduration", "2000000",
    "-select_streams", "V", "-threads", "1", "-max_pixels", "67108864",
    "-err_detect", "explode", "-read_intervals", "%+#32", "-count_frames",
    "-show_entries", "stream=codec_type,width,height,duration,nb_read_frames:format=duration",
    "-of", "json", ...input,
  ], {
    stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout, killSignal: "SIGKILL",
    maxBuffer: PROBE_MAX_OUTPUT_BYTES, windowsHide: true,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") throw new Error("ffprobe was not found in PATH (install FFmpeg/ffprobe)");
    if (result.error.code === "ETIMEDOUT") throw new Error("ffprobe timed out while inspecting the file");
    if (result.error.code === "ENOBUFS") throw new Error("ffprobe metadata exceeded the output limit");
    throw result.error;
  }
  return result;
}

async function verify(input) {
  if (/^(?:[\\/]{2}|[a-z][a-z\d+.-]*:\/\/)/i.test(input)) {
    throw new Error("Input must be a local file path");
  }
  let filename;
  let file;
  try {
    filename = await realpath(resolve(input));
    file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    throw new Error("Input file does not exist or cannot be read");
  }

  let result;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Input must be a regular local file");
    if (info.size === 0) throw new Error("Input video file is empty");
    const deadline = performance.now() + PROBE_TIMEOUT_MS;
    result = probe(file.fd, ["-protocol_whitelist", "fd", "-i", "fd:"], PROBE_TIMEOUT_MS);
    // Older FFmpeg builds lack the seekable fd protocol. Only standalone file formats may use the path.
    if (result.status !== 0 && /fd:: Protocol not found/i.test(result.stderr)) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) throw new Error("ffprobe timed out while inspecting the file");
      result = probe(file.fd, ["-protocol_whitelist", "file", "-format_whitelist", standaloneFormats, "-i", filename], remaining);
    }
  } finally {
    await file.close();
  }
  if (result.status !== 0 || result.stderr.trim()) {
    throw new Error("ffprobe could not inspect the file (invalid or corrupt media)");
  }

  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    throw new Error("ffprobe returned invalid metadata");
  }
  const video = metadata.streams?.find((stream) =>
    stream.codec_type === "video" &&
    Number.isInteger(stream.width) && stream.width > 0 &&
    Number.isInteger(stream.height) && stream.height > 0 &&
    Number(stream.nb_read_frames) > 0
  );
  if (!video) throw new Error("No readable video stream found (audio-only or invalid video)");

  const duration = [video.duration, metadata.format?.duration]
    .map(Number)
    .find((seconds) => Number.isFinite(seconds) && seconds > 0);
  if (duration === undefined) throw new Error("Video stream has no positive duration");
  return { duration, width: video.width, height: video.height };
}

if (process.argv.length !== 3) {
  console.error("Usage: node scripts/verify-rendered-video.mjs <local-video-file>");
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await verify(process.argv[2])));
  } catch (error) {
    console.error(`verify-rendered-video: ${error.message}`);
    process.exitCode = 1;
  }
}
