import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BrowserVideo, type BrowserVideoViewer } from "@mako/control-runtime/browser"
import { VideoHelper, helperCapture } from "@mako/control-runtime/desktop"
import { decodeControlVideo, type ControlVideoPacket } from "@mako/control-runtime/contracts"

/**
 * The video helper's Node side (`video-helper.ts`) against a fake that speaks its protocol (the real helpers have
 * their own checks: scripts/test-video-helper.mjs on Linux, scripts/test-video-helper-mac.mjs on a Mac): its
 * arguments, length-prefixed units in, framed commands out, its "ended:" line as the reason, and a capture that opens
 * on its first unit or refuses when the helper can't capture.
 */
const root = await mkdtemp(join(tmpdir(), "mako-video-helper-"))
const log = join(root, "log.jsonl")
process.env.FAKE_VIDEO_LOG = log
const fake = resolve("scripts/fixtures/fake-video-helper.mjs")
/** One line of the fake's log: its arguments when it started, or a command it read. */
interface Logged {
  args?: string[]
  type?: string
  length?: number
  width?: number
  height?: number
  bitrate?: number
  format?: number
  sequence?: number
  capturedAt?: number
}
const read = (): Logged[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line): Logged => JSON.parse(line)) : [])
const until = async (check: () => boolean, what: string) => {
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await delay(10)) if (check()) return
  assert.fail(`timed out waiting until ${what}`)
}

// Pictures: each goes in framed with its format, sequence and time, and comes back as the unit made of it.
const units: ControlVideoPacket[] = []
let ended: string | undefined
const frames = new VideoHelper(fake, { kind: "frames" }, { fps: 30, quality: 70, keyint: 30, content: "screen" }, { unit: (packet) => units.push(packet), ended: (reason) => (ended = reason) })
await until(() => read().length > 0, "the helper started")
assert.deepEqual(read()[0], { args: ["frames", "--fps", "30", "--keyint", "30", "--quality", "70", "--content", "screen"] })
let taken = false
frames.picture("rgb", 41, 1234.5, Buffer.alloc(2 * 2 * 3), { width: 2, height: 2 }, () => (taken = true))
assert.equal(frames.ready, false, "a picture on its way holds the next")
await until(() => units.length === 1, "the unit for the picture")
assert.ok(taken && frames.ready)
assert.deepEqual([units[0]!.kind, units[0]!.sequence, units[0]!.capturedAt], ["key", 41, 1234.5])
frames.rate(1_500_000)
frames.box({ width: 640, height: 360 })
frames.box(undefined)
await until(() => read().length >= 5, "the commands")
assert.deepEqual(read().slice(1), [
  { type: "F", length: 17 + 12, format: 1, sequence: 41, capturedAt: 1234.5 },
  { type: "R", length: 4, bitrate: 1_500_000 },
  { type: "B", length: 4, width: 640, height: 360 },
  { type: "B", length: 4, width: 0, height: 0 },
])
frames.close()
await delay(200)
assert.equal(ended, undefined, "closing isn't an ending")

// A capture: open at its first unit, a key frame when asked, the box on resize; a helper that can't capture refuses.
const packets: ControlVideoPacket[] = []
const viewer: BrowserVideoViewer = { size: () => ({ width: 320, height: 200 }), backlog: () => 0, send: (bytes) => packets.push(decodeControlVideo(bytes)), ended: () => {} }
const video = new BrowserVideo({ encoded: helperCapture(fake, { kind: "window", windowId: 77 }) }, { fps: 30 })
const leave = await video.join(viewer)
assert.equal(packets[0]?.kind, "key")
// The helper starts at the viewer's box, and joining tells the open capture its viewers' box again (`BrowserVideo.join`),
// a command the fake may log before or after this reads: the start is the newest start, not the newest line.
const started = read().findLastIndex((entry) => entry.args)
assert.deepEqual(read()[started], { args: ["window", "77", "--fps", "30", "--box", "320x200"] })
await until(() => read().length > started + 1, "the viewers' box told to the open capture")
assert.deepEqual(read()[started + 1], { type: "B", length: 4, width: 320, height: 200 })
video.refresh(viewer)
await delay(1100)
video.refresh(viewer)
await until(() => read().some((entry) => entry.type === "K"), "a key frame asked of the helper")
await leave()
// The fake takes the window id 0 as one it can't capture.
await assert.rejects(new BrowserVideo({ encoded: helperCapture(fake, { kind: "window", windowId: 0 }) }).join(viewer), /That window is gone/)
await rm(root, { recursive: true, force: true })
console.log("Video helper protocol: arguments, framed pictures and commands, units back, opening on the first unit, key asks, and the helper's own reason for ending passed")
