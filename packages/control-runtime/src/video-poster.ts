import { mp4Units } from "./mp4.js"
import { onLinux, onMac } from "./platform.js"
import { spawn } from "./processes.js"
import { videoHelperExecutable } from "./video-helper.js"

/**
 * A video's poster frame, taken by Mako's video helper and never an FFmpeg from PATH: on a Mac the helper decodes the
 * file itself (AVFoundation, whatever macOS plays); on Linux this reads the file's first key unit with Mediabunny and
 * the helper decodes it with OpenH264, so H.264 only. Elsewhere there is none yet, and a player draws the video's own
 * first frame.
 */

/** The helper that takes posters here, by its whole path; none where it isn't installed or has no poster mode. */
export function videoPosterHelper(): string | undefined {
  return onMac() || onLinux() ? videoHelperExecutable() : undefined
}

/** Writes `output` (a JPEG at most `side` on its longer side); false when the video has no frame the helper reads. */
export async function videoPoster(helper: string, video: string, output: string, side: number, timeoutMs: number): Promise<boolean> {
  if (onMac()) {
    return new Promise((resolve) => {
      const child = spawn(helper, ["poster", video, output, "--side", String(side)], { stdio: "ignore" })
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
      child.once("error", () => resolve(false))
      child.once("close", (code) => {
        clearTimeout(timer)
        resolve(code === 0)
      })
    })
  }
  if (!onLinux()) return false
  let unit
  try {
    const units = mp4Units(video)
    unit = (await units.next()).value
    await units.return(undefined)
  } catch {
    return false
  }
  if (!unit?.key || !unit.description) return false
  const { data, description } = unit
  // One 'V' command, as the helper's protocol frames it: the avcC's length, the avcC, then the unit.
  const body = Buffer.concat([Buffer.from([description.byteLength >> 8, description.byteLength & 0xff]), description, data])
  const header = Buffer.alloc(5)
  header.write("V", 0, "latin1")
  header.writeUInt32BE(body.byteLength, 1)
  return new Promise((resolve) => {
    const child = spawn(helper, ["poster", output, "--box", `${side}x${side}`], { stdio: ["pipe", "ignore", "ignore"] })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.once("error", () => resolve(false))
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
    child.stdin.on("error", () => {})
    child.stdin.end(Buffer.concat([header, body]))
  })
}
