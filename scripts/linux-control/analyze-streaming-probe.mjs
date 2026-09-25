// Analyze retained evidence, independently of upstream's reported frame rate.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import sharp from "sharp"

const execute = promisify(execFile)
const directory = process.argv[2]
assert.ok(directory, "Supply a completed capture or viewer evidence directory")
const json = async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))
const gaps = (rows) => {
  const values = rows.slice(1).map((row, index) => row - rows[index]).sort((a,b) => a-b)
  return values.length ? { p50: values[Math.floor(values.length*.5)], p95: values[Math.floor(values.length*.95)], max: values.at(-1) } : null
}
const provenance = await json("provenance.json")
let summary
if (["websockets", "webrtc"].includes(provenance.mode)) {
  const result = await json("viewer-result.json"), samples = await json("viewer-progress.json")
  const cpu = (text) => Number(Object.fromEntries(text.trim().split("\n").map(line => line.split(" "))).usage_usec)
  summary = { mode: provenance.mode, scope: result.scope, elapsedMs: result.elapsedMs,
    distinctFps: result.seen.length*1000/result.elapsedMs, invalid: result.invalid,
    frameGapMs: gaps(result.seen.map(row => row.at)),
    // Resource reads surround the timer/poll; at most one polling interval of
    // extra work is included. Cgroup memory includes page cache, not only RSS.
    approximateContainerCores: (cpu(result.resourcesAfter.cpu)-cpu(result.resourcesBefore.cpu))/1000/result.elapsedMs,
    peakContainerMemoryBytes: Math.max(...samples.map(row => Number(row.memory))), errors: result.errors }
} else {
  const result = await json("result.json")
  assert.equal(result.failure, null)
  const active = result.phases.find(row => row.name === "active").atNs
  const end = result.phases.find(row => row.name === "idle-after").atNs
  const frames = result.frames.filter(row => row.receivedNs >= active && row.receivedNs < end)
  const ffmpeg = process.env.FFMPEG ?? "ffmpeg"
  const decoded = await execute(ffmpeg, ["-v", "error", "-i", join(directory,"stream.h264"),
    "-vf", "crop=1920:2:0:450,scale=48:1:flags=neighbor", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
  { encoding: "buffer", maxBuffer: 4*1024*1024 })
  assert.equal(decoded.stdout.length % 144, 0)
  const sequences = []
  let invalid = 0
  for (let offset=0; offset<decoded.stdout.length; offset+=144) {
    const words = []
    for (let byte=0; byte<6; byte++) {
      let word = 0
      for (let bit=0; bit<8; bit++) word = word<<1 | (decoded.stdout[offset+(byte*8+bit)*3]>127 ? 1 : 0)
      words.push(word)
    }
    if (words[4] !== 165 || words[5] !== words.slice(0,5).reduce((a,b) => a^b,0)) invalid++
    else sequences.push(words[0]*256+words[1])
  }
  // Text is stationary throughout the source fixture. Compare encoded pixels
  // against its independent GTK screenshot, excluding animated marker rows.
  const encoded = await execute(ffmpeg, ["-v","error","-i",join(directory,"stream.h264"),
    "-vf","select=eq(n\\,120)","-frames:v","1","-f","image2pipe","-vcodec","png","pipe:1"],
  { encoding:"buffer", maxBuffer:16*1024*1024 })
  const region = { left:0, top:580, width:1200, height:450 }
  const pixels = async (input) => sharp(input).extract(region).removeAlpha().raw().toBuffer()
  const source = await pixels(join(directory,"source.png")), actual = await pixels(encoded.stdout)
  assert.equal(source.length, actual.length)
  let squared = 0, absolute = 0, max = 0
  for (let i=0; i<source.length; i++) { const d=Math.abs(source[i]-actual[i]); squared+=d*d; absolute+=d; max=Math.max(max,d) }
  const first = result.samples.find(row => row.atNs>=active), last = result.samples.findLast(row => row.atNs<=end)
  const duration = (end-active)/1e9
  summary = { mode:provenance.mode, scope:result.scope, activeSeconds:duration,
    encodedFps:frames.length/duration, decodedFrames:decoded.stdout.length/144,
    // Includes first/final static frame; preserve that one-frame boundary limit.
    decodedDistinctFps: new Set(sequences).size/duration, invalid,
    callbackGapMs:gaps(frames.map(row=>row.receivedNs/1e6)),
    encodedBytesPerSecond:frames.reduce((n,row)=>n+row.bytes,0)/duration,
    captureAndFixtureCores:(last.cpuSeconds-first.cpuSeconds)/((last.atNs-first.atNs)/1e9),
    peakProcessRssBytes:Math.max(...result.samples.map(row=>row.peakRssBytes)),
    textQuality:{ region, meanAbsoluteError:absolute/source.length, maxError:max,
      psnrDb:squared===0 ? null : 10*Math.log10(255**2/(squared/source.length)), exact:squared===0 },
    idle:result.phases.slice(0,-1).filter(row=>row.name.startsWith("idle")).map(row=>{
      const next=result.phases[result.phases.indexOf(row)+1], count=result.frames.filter(frame=>frame.receivedNs>=row.atNs&&frame.receivedNs<next.atNs).length
      return {phase:row.name, seconds:(next.atNs-row.atNs)/1e9, fps:count/((next.atNs-row.atNs)/1e9)}
    }) }
}
await writeFile(join(directory,"analysis.json"), JSON.stringify(summary,null,2))
console.log(JSON.stringify(summary,null,2))
