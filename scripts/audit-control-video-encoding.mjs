// A matched encoder/quality probe, not a sustained browser or whole-system benchmark.
import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import sharp from "sharp"
import { mediaExecutable, recordingVideoEncoding } from "../packages/control-runtime/dist/control-media.js"
import { renderRecordingImage } from "../packages/control-runtime/dist/recording-render.js"
import { processResources, summarizeProcessResources } from "./lib/control-process-resources.mjs"

assert.equal(process.platform, "darwin", "This comparison requires Mac hardware encoding")
const execute = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-hardware-quality-"))
const ffmpeg = mediaExecutable("ffmpeg"), ffprobe = mediaExecutable("ffprobe")
const width = 1920, height = 1080, frames = 240
const imageArgument = process.argv.find((arg) => arg.startsWith("--image="))?.slice(8)
const qualityArgument = process.argv.find((arg) => arg.startsWith("--quality="))?.slice(10)
if (qualityArgument !== undefined) assert.ok(Number.isInteger(Number(qualityArgument)) && Number(qualityArgument) >= 1 && Number(qualityArgument) <= 100)
const fixture = imageArgument ? await readFile(imageArgument) : Buffer.from(`<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><rect width="1920" height="1080" fill="#191714"/>${Array.from({length: 45}, (_, i) => `<text x="30" y="${24 + i * 23}" font-family="monospace" font-size="16" fill="${i % 3 === 0 ? '#55bbdd' : '#eeeeee'}">Row ${i}: exact values 0123456789 | Save changes | 1lI O0 {} [] () &amp; @ #</text>`).join("")}</svg>`)
const source = await sharp(fixture).resize(width, height, {fit: "contain"}).jpeg({quality: 92}).toBuffer()
await writeFile(join(root, "source.jpg"), source)
const render = (index) => {
  const pointer = {at: index * 1000 / 60, x: 200 + index * 4, y: 400, pressed: index % 30 < 12}
  return renderRecordingImage(source, {width, height}, pointer.at, pointer, pointer.pressed ? pointer : undefined, width, height)
}
const results = []
for (const platform of ["linux", "darwin"]) {
  const encoding = recordingVideoEncoding(platform)
  if (encoding.hardwareRequired && qualityArgument !== undefined)
    encoding.args[encoding.args.indexOf("-q:v") + 1] = qualityArgument
  const output = join(root, `${encoding.codec}.mp4`)
  const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n", "-filter_threads", "1", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-framerate", "60", "-i", "pipe:0", "-an", ...encoding.args, "-pix_fmt", "yuv420p", "-g", "60", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-flush_packets", "1", output], {stdio: ["pipe", "ignore", "pipe"]})
  let error = "", sampling = false
  const samples = []
  child.stderr.on("data", part => { error = (error + part).slice(-4096) })
  child.stdin.on("error", () => {})
  const closed = new Promise((resolve, reject) => {child.once("error", reject); child.once("close", resolve)})
  const sample = async () => {
    if (sampling) return
    sampling = true
    try { samples.push(await processResources({node: process.pid, encoder: child.pid})) }
    finally { sampling = false }
  }
  await sample()
  const started = performance.now(), cpu = process.cpuUsage()
  const timer = setInterval(() => void sample(), 250)
  try {
    for (let index = 0; index < frames; index++) {
      const pixels = await render(index)
      await new Promise((resolve, reject) => child.stdin.write(pixels, error => error ? reject(error) : resolve()))
    }
    await sample()
    child.stdin.end()
    assert.equal(await closed, 0, error)
  } finally { clearInterval(timer); child.kill() }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu)
  const probe = JSON.parse((await execute(ffprobe, ["-v", "error", "-count_frames", "-show_entries", "stream=width,height,nb_read_frames,has_b_frames:format=duration", "-of", "json", output])).stdout)
  assert.equal(Number(probe.streams[0].nb_read_frames), frames)
  assert.equal(probe.streams[0].width, width)
  assert.equal(probe.streams[0].height, height)
  assert.equal(Number(probe.format.duration), 4)
  if (encoding.hardwareRequired) assert.equal(probe.streams[0].has_b_frames, 0)
  const quality = []
  for (const index of [0, 21, 29, 60, 100, 200]) {
    const expected = await render(index)
    const decoded = join(root, `${encoding.codec}-${index}.png`)
    await execute(ffmpeg, ["-v", "error", "-ss", String(index / 60), "-i", output, "-frames:v", "1", decoded])
    const actual = await sharp(decoded).ensureAlpha().raw().toBuffer()
    assert.equal(actual.length, expected.length)
    let squaredError = 0, textError = 0, textCount = 0
    for (let offset = 0; offset < expected.length; offset += 4) {
      for (let channel = 0; channel < 3; channel++) {
        const error = (actual[offset + channel] - expected[offset + channel]) ** 2
        squaredError += error
        if (offset / 4 / width >= 600 && offset / 4 / width < 1040) {textError += error; textCount++}
      }
    }
    const mse = squaredError / (width * height * 3)
    quality.push({frame: index, mse, psnr: 10 * Math.log10(255 ** 2 / mse), textMse: textError / textCount})
  }
  results.push({encoding, elapsedMs, nodeCpuMs: (used.user + used.system) / 1000, resources: summarizeProcessResources(samples, elapsedMs), bytes: (await stat(output)).size, probe, quality})
}
const report = {root, scope: "240-frame capacity/quality comparison; OS services include other apps, GPU energy excluded; not sustained capture acceptance", ffmpeg, binarySha256: createHash("sha256").update(await readFile(ffmpeg)).digest("hex"), results}
await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
for (const [index, sample] of results[1].quality.entries()) {
  assert.ok(sample.textMse <= results[0].quality[index].textMse,
    `Hardware text reconstruction regressed at frame ${sample.frame}; retain the report before changing quality`)
}
