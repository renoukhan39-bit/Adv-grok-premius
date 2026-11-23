#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const verifier = fileURLToPath(new URL("./verify-rendered-video.mjs", import.meta.url));
const fps = 25;
const maxScenes = 12;
const maxFrames = 60 * fps;
const usage = "Usage: node scripts/render-video-scene-plan.mjs <scene-plan.json> <new-output.mp4>";
const help = `${usage}

Example plan:
{"width":640,"height":360,"scenes":[{"image":"opening.png","durationSeconds":1},{"image":"end.jpg","durationSeconds":0.5}]}

Use PNG or JPEG files within the plan directory, up to 8 MiB each. The default
frame size is 640×360. Up to 12 scenes and 60 seconds can render at 25 fps.
Each scene lasts at least one frame. Durations round to the nearest frame.
Install FFmpeg with libx264 and ffprobe. Success prints verified MP4 metadata
as JSON. Choose a new output filename in an existing directory.`;

async function readLocalFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) {
      throw new Error(`Expected a nonempty regular file of at most ${limit} bytes: ${path}`);
    }
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) throw new Error(`File changed while being read: ${path}`);
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

function parsePlan(bytes) {
  let plan;
  try {
    plan = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Scene plan must be valid JSON");
  }
  if (!Array.isArray(plan?.scenes) || !plan.scenes.length || plan.scenes.length > maxScenes) {
    throw new Error(`Scene plan must have between 1 and ${maxScenes} scenes`);
  }
  const { width = 640, height = 360 } = plan;
  if (![width, height].every(n => Number.isInteger(n) && n >= 2 && n % 2 === 0) ||
      width > 1920 || height > 1080) {
    throw new Error("Use even dimensions between 2×2 and 1920×1080");
  }
  let totalFrames = 0;
  const scenes = plan.scenes.map((scene, i) => {
    const asset = scene?.image;
    if (typeof asset !== "string" || !/\.(png|jpe?g)$/i.test(asset) ||
        isAbsolute(asset) || /^[a-z][a-z\d+.-]*:/i.test(asset) || asset.includes("\\")) {
      throw new Error(`Scene ${i + 1} needs a relative PNG or JPEG image path`);
    }
    if (!Number.isFinite(scene.durationSeconds) || scene.durationSeconds < 1 / fps) {
      throw new Error(`Scene ${i + 1} needs a positive durationSeconds of at least one frame`);
    }
    const frames = Math.round(scene.durationSeconds * fps);
    totalFrames += frames;
    return { asset, frames };
  });
  if (totalFrames > maxFrames) throw new Error("A render can be at most 60 seconds");
  return { width, height, scenes, totalFrames };
}

async function stageImage(directory, asset, stage, index) {
  const source = await realpath(resolve(directory, asset));
  const inside = relative(directory, source);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`Scene ${index + 1} image is outside the scene plan directory`);
  }
  const png = extname(asset).toLowerCase() === ".png";
  const path = join(stage, `scene-${index}.${png ? "png" : "jpg"}`);
  await writeFile(path, await readLocalFile(source, 8 * 1024 * 1024));
  return { path, codec: png ? "png" : "mjpeg" };
}

async function encode(plan, directory, stage, movie) {
  const { width, height, scenes } = plan;
  const inputs = [];
  const filters = [];
  for (const [i, scene] of scenes.entries()) {
    const { path, codec } = await stageImage(directory, scene.asset, stage, i);
    inputs.push("-protocol_whitelist", "file", "-f", "image2", "-pattern_type", "none",
      "-framerate", String(fps), "-threads", "1", "-max_pixels", "16777216", "-c:v", codec, "-i", path);
    filters.push(`[${i}:v]trim=end_frame=1,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,` +
      `loop=loop=${scene.frames - 1}:size=1:start=0,setpts=N/(${fps}*TB)[s${i}]`);
  }
  const streams = scenes.map((_, i) => `[s${i}]`).join("");
  filters.push(`${streams}concat=n=${scenes.length}:v=1:a=0,settb=1/${fps},setpts=N[out]`);
  try {
    await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
      ...inputs, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), "-map", "[out]",
      "-an", "-r", String(fps), "-c:v", "libx264", "-threads", "2", "-preset", "veryfast",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", movie],
    { timeout: 90_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Rendering requires ffmpeg with the libx264 encoder in PATH");
    if (error.killed) throw new Error("ffmpeg render timed out");
    throw new Error(`ffmpeg could not render the scene plan: ${error.stderr?.trim().slice(0, 500) || error.message}`);
  }
}

export async function renderScenePlan(input, output) {
  if (extname(output).toLowerCase() !== ".mp4") throw new Error("Output must use the .mp4 extension");
  const planPath = await realpath(resolve(input));
  const plan = parsePlan(await readLocalFile(planPath, 64 * 1024));
  const destination = resolve(output);
  const stage = await mkdtemp(join(dirname(destination), ".scene-render-"));
  const movie = join(stage, "render.mp4");
  try {
    await encode(plan, dirname(planPath), stage, movie);
    const { stdout } = await run(process.execPath, [verifier, movie],
      { timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true });
    const { duration, width, height } = JSON.parse(stdout);
    if (width !== plan.width || height !== plan.height || !Number.isFinite(duration) ||
        Math.abs(duration - plan.totalFrames / fps) >= 0.5 / fps) {
      throw new Error("Verified video dimensions or duration differ from the scene plan");
    }
    // A same-filesystem hard link publishes a verified file without replacing a concurrent writer.
    try {
      await link(movie, destination);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("Output file already exists");
      throw error;
    }
    return { output: destination, duration, width, height };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(help);
  } else if (process.argv.length !== 4) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await renderScenePlan(process.argv[2], process.argv[3])));
    } catch (error) {
      console.error(`render-video-scene-plan: ${error.stderr?.trim() || error.message}`);
      process.exitCode = 1;
    }
  }
}
