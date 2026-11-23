#!/usr/bin/env node
import { execFile } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;

async function verify(input) {
  let filename;
  let info;
  try {
    filename = await realpath(resolve(input));
    info = await stat(filename);
  } catch {
    throw new Error("Input file does not exist or cannot be read");
  }
  if (!info.isFile()) throw new Error("Input must be a regular local file");
  if (info.size === 0) throw new Error("Input video file is empty");

  let stdout;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error",
      "-probesize", "1048576",
      "-analyzeduration", "2000000",
      "-select_streams", "v",
      "-read_intervals", "%+#1",
      "-count_packets",
      "-show_entries", "stream=codec_type,width,height,duration,nb_read_packets:stream_disposition=attached_pic:format=duration",
      "-of", "json",
      "-i", filename,
    ], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_OUTPUT_BYTES,
      windowsHide: true,
    }));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("ffprobe was not found in PATH (install FFmpeg/ffprobe)");
    if (error.killed || error.code === "ETIMEDOUT") throw new Error("ffprobe timed out while inspecting the file");
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("ffprobe metadata exceeded the output limit");
    throw new Error("ffprobe could not inspect the file (invalid or corrupt media)");
  }

  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch {
    throw new Error("ffprobe returned invalid metadata");
  }
  const video = metadata.streams?.find((stream) =>
    stream.codec_type === "video" && stream.disposition?.attached_pic !== 1 &&
    Number.isInteger(stream.width) && stream.width > 0 &&
    Number.isInteger(stream.height) && stream.height > 0 &&
    Number(stream.nb_read_packets) > 0
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
