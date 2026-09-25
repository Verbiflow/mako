import assert from "node:assert/strict"
import { spawn } from "node:child_process"

/** Independent decoder for the audit's 1920px binary marker strip. Requires
 * full FFmpeg on PATH, not extra filters in Mako's shipped minimal encoder. */
export async function recordedMarkers(video, seconds = 60) {
  const child = spawn("ffmpeg", ["-v", "error", "-i", video, "-t", String(seconds),
    "-an", "-vf", "fps=60,crop=1920:2:0:450,format=gray", "-f", "rawvideo", "pipe:1"],
  { stdio: ["ignore", "pipe", "pipe"] })
  let errors = ""
  child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-4096) })
  const exited = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject) })
  void exited.catch(() => {})
  const row = Buffer.allocUnsafe(1920 * 2)
  let filled = 0, frames = 0, invalid = 0, distinct = 0, last, held = 0, longestHold = 0
  try {
    for await (const chunk of child.stdout) {
      let offset = 0
      while (offset < chunk.length) {
        const count = Math.min(row.length - filled, chunk.length - offset)
        chunk.copy(row, filled, offset, offset + count)
        filled += count; offset += count
        if (filled !== row.length) continue
        frames++
        const words = []
        for (let byte = 0; byte < 6; byte++) {
          let value = 0
          for (let bit = 0; bit < 8; bit++)
            value = (value << 1) | (row[(byte * 8 + bit) * 40 + 20] > 127 ? 1 : 0)
          words.push(value)
        }
        if (words[4] !== 165 || words[5] !== (words[0] ^ words[1] ^ words[2] ^ words[3] ^ 165)) invalid++
        else {
          const sequence = words[0] * 256 + words[1]
          if (sequence !== last) { distinct++; held = 0; last = sequence }
        }
        longestHold = Math.max(longestHold, ++held)
        filled = 0
      }
    }
    assert.equal(await exited, 0, errors)
    assert.equal(filled, 0, "Partial decoded marker row")
    assert.ok(frames > 0)
    return { scope: "Actual fixture markers sampled at 60 Hz from timestamped 1920x1080 video; source gaps and repeats count against rate",
      seconds: frames / 60, frames, distinctFrames: distinct, invalidFrames: invalid,
      distinctFps: distinct * 60 / frames, longestHoldMs: longestHold * 1000 / 60 }
  } finally { child.kill("SIGKILL"); await exited }
}
