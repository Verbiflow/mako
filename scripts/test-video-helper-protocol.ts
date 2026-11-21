import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BrowserVideo, type BrowserVideoViewer } from "@mako/control-runtime/browser"
import { VideoHelper, helperCapture, helperWindowSource, linuxDesktop, portalMonitor } from "@mako/control-runtime/desktop"
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

// A portal capture: its source types and restore token file go to the helper as arguments.
const portal = new BrowserVideo({ encoded: helperCapture(fake, { kind: "portal", types: "monitor", restore: join(root, "portal", "token"), still: true, cursor: "embedded" }) }, { fps: 30 })
const leavePortal = await portal.join(viewer)
// The newest start line, not the newest line: joining tells the open capture its box again (`BrowserVideo.join`).
const portalStarted = read().findLastIndex((entry) => entry.args)
assert.deepEqual(read()[portalStarted], { args: ["portal", "--types", "monitor", "--restore", join(root, "portal", "token"), "--still", "screenshot", "--cursor", "embedded", "--fps", "30", "--box", "320x200"] })
await until(() => read().length > portalStarted + 1, "the viewers' box told to the open portal capture")
assert.deepEqual(read()[portalStarted + 1], { type: "B", length: 4, width: 320, height: 200 })
assert.ok(existsSync(join(root, "portal")), "the token's folder is made for the helper")
await leavePortal()

// Which desktop a Linux session is, from its environment, and how the helper shows a window on each.
assert.equal(linuxDesktop({ WAYLAND_DISPLAY: "wayland-0" }, "darwin"), undefined)
assert.equal(linuxDesktop({}, "linux"), undefined, "a server or a cloud machine's host has no desktop")
// A display alone is no person's desktop (xvfb-run, a container's Xvfb): a logged-in session names its type.
assert.equal(linuxDesktop({ DISPLAY: ":99" }, "linux"), undefined, "a bare display drives nothing")
assert.equal(linuxDesktop({ DISPLAY: ":0", XDG_SESSION_TYPE: "tty" }, "linux"), undefined, "a console session's display isn't one either")
assert.equal(linuxDesktop({ DISPLAY: ":0", MAKO_DESKTOP_CONTROL: "1" }, "linux")?.session, "x11", "startx's session opts in")
assert.equal(linuxDesktop({ DISPLAY: ":0", XDG_SESSION_TYPE: "x11", MAKO_SCREENLESS: "1" }, "linux"), undefined, "a screenless host drives no desktop")
const session = (env: NodeJS.ProcessEnv) => linuxDesktop({ XDG_SESSION_TYPE: env.WAYLAND_DISPLAY ? "wayland" : "x11", ...env }, "linux")
assert.deepEqual(session({ DISPLAY: ":0", XDG_CURRENT_DESKTOP: "XFCE" }), { session: "x11", compositor: "other", xwayland: false })
assert.deepEqual(session({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }), { session: "wayland", compositor: "gnome", xwayland: true })
assert.deepEqual(session({ WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" }), { session: "wayland", compositor: "kde", xwayland: false })
assert.equal(session({ WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/user/1000/sway-ipc.sock" })?.compositor, "wlroots")
assert.equal(session({ WAYLAND_DISPLAY: "wayland-1", XDG_CURRENT_DESKTOP: "Hyprland" })?.compositor, "wlroots")
if (process.platform === "linux") {
  const x11 = session({ DISPLAY: ":0" })
  const wayland = session({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" })
  assert.deepEqual(helperWindowSource(77, x11), { kind: "window", windowId: 77 })
  // On Wayland a driver's window id isn't an X window, even where XWayland runs: the person's shared monitor, its
  // token one per user, and a still screen's first frame from the Screenshot portal only on wlroots.
  assert.deepEqual(helperWindowSource(77, wayland), { kind: "portal", types: "monitor", restore: join(homedir(), ".local/state/mako/portal-monitor.token"), still: false })
  assert.equal(helperWindowSource(77, undefined), undefined, "no desktop, no helper capture")
} else {
  assert.deepEqual(helperWindowSource(77, undefined), { kind: "window", windowId: 77 })
}
const sway = session({ WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/sway.sock" })!
assert.deepEqual(portalMonitor(sway, { XDG_STATE_HOME: "/state" }), { kind: "portal", types: "monitor", restore: join("/state", "mako", "portal-monitor.token"), still: true })
await rm(root, { recursive: true, force: true })
console.log("Video helper protocol: arguments, framed pictures and commands, units back, opening on the first unit, key asks, the helper's own reason for ending, portal arguments and the Linux desktop's capture route passed")
