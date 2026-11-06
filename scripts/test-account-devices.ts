import assert from "node:assert/strict"
import { test } from "node:test"
import type { ListedSession } from "@mako/protocol/thread-listing"
import {
  cloudAddress,
  codePage,
  containerCommand,
  DEVICE_MAKO_NEEDED,
  deviceFamily,
  deviceHealth,
  deviceKindWords,
  healthWords,
  joinCommand,
  needsMakoUpdate,
  runPlace,
} from "@mako/host/contracts/account-devices"
import { listedSummary } from "@mako/host/contracts/listed-conversations"
import { selectAcpPresence } from "../src/state/acp-presence"
import { acpStore } from "../src/state/acp-state"
import { listLive } from "../src/state/live-recovery"
import { rowDetail } from "../src/web-client/rows"
import { foldThreads } from "../src/web-client/threads"

/**
 * The account's devices as Settings › Devices reads them, on a Mac and in a browser by the same rules: what kind a
 * device is, how it stands, whether its Mako is behind, the lines that add a machine, and the mark a Thread on a
 * machine of the person's own wears from the account's list to a rail row and a phone's.
 */

// Mid-afternoon wherever this runs, so "three hours ago" is the same day in every time zone.
const T = new Date(2026, 10, 6, 14, 0, 0).getTime()
const at = (minutes: number) => new Date(T + minutes * 60_000).toISOString()

test("a device's kind is its family and its system", () => {
  assert.equal(deviceFamily("desktop"), "mac")
  assert.equal(deviceFamily("runtime"), "machine")
  assert.equal(deviceFamily("cli"), "terminal")
  assert.equal(deviceFamily("browser"), "browser")
  assert.equal(deviceFamily("watch"), "other", "a kind a newer cloud adds is read, never refused")
  assert.equal(deviceKindWords({ kind: "desktop", platform: "macOS 26.0" }), "Mac")
  assert.equal(deviceKindWords({ kind: "runtime", platform: "Linux x64 · Ubuntu 24.04" }), "Linux machine")
  assert.equal(deviceKindWords({ kind: "runtime", platform: "macOS 26.0" }), "Mac with no window")
  assert.equal(deviceKindWords({ kind: "runtime", platform: "FreeBSD 15" }), "Machine")
  assert.equal(deviceKindWords({ kind: "watch", platform: "watchOS" }), "Device")
})

test("health: this device, the account's word, then when it was last seen", () => {
  const joined = { createdAt: at(-60 * 24), lastSeenAt: at(-60 * 24) }
  assert.deepEqual(deviceHealth(joined, { current: true, now: T }), { state: "online" }, "this device is here")
  assert.deepEqual(deviceHealth({ createdAt: at(-600), lastSeenAt: at(-2) }, { current: false, now: T }), { state: "online" })
  assert.deepEqual(deviceHealth({ createdAt: at(-600), lastSeenAt: at(-180) }, { current: false, now: T }), { state: "quiet", since: T - 180 * 60_000 })
  assert.deepEqual(deviceHealth(joined, { current: false, now: T }), { state: "never" }, "seen only as it joined: it never connected")
  // The account's own word wins over a sign-in taken a moment ago, and is never later than now.
  assert.deepEqual(deviceHealth({ createdAt: at(-600), lastSeenAt: at(-1) }, { current: false, quietSince: at(-30), now: T }), { state: "quiet", since: T - 30 * 60_000 })
  assert.deepEqual(deviceHealth({}, { current: false, quietSince: at(5), now: T }), { state: "quiet", since: T })
  // A list that holds no times of a device (a browser's kept one): there if it lists Sessions, else unknown as never.
  assert.deepEqual(deviceHealth({}, { current: false, heard: true, now: T }), { state: "online" })
  assert.deepEqual(deviceHealth({}, { current: false, now: T }), { state: "never" })
  assert.equal(healthWords({ state: "online" }, T), "Online now")
  assert.equal(healthWords({ state: "never" }, T), "Never connected")
  assert.match(healthWords({ state: "quiet", since: T - 3 * 3_600_000 }, T), /^Quiet since \d{1,2}[:.]\d{2}/)
  assert.match(healthWords({ state: "quiet", since: T - 12 * 24 * 3_600_000 }, T), /^Quiet since \D+ ?\d|^Quiet since \d+ \D+/, "another day's says the day")
})

test("only a known older release needs Mako's update", () => {
  assert.equal(needsMakoUpdate("0.1.37"), true)
  assert.equal(needsMakoUpdate("0.1.9"), true, "numbers, not text: 9 is below 38")
  assert.equal(needsMakoUpdate(DEVICE_MAKO_NEEDED), false)
  assert.equal(needsMakoUpdate("0.4.0"), false)
  assert.equal(needsMakoUpdate("1.0"), false)
  assert.equal(needsMakoUpdate("0.1.38-beta.2"), false)
  assert.equal(needsMakoUpdate("0.0.1"), false, "a checkout's build has no release to compare")
  assert.equal(needsMakoUpdate("0.0.1+development"), false)
  assert.equal(needsMakoUpdate(null), false, "a device that never said its version isn't called behind")
  assert.equal(needsMakoUpdate(undefined), false)
  assert.equal(needsMakoUpdate("nightly"), false)
  assert.equal(needsMakoUpdate("0.4.0", "0.5.0"), true)
})

test("the lines that add a machine name the account's cloud", () => {
  assert.equal(cloudAddress("cloud.example.com"), "https://cloud.example.com")
  assert.equal(cloudAddress("127.0.0.1:8787"), "http://127.0.0.1:8787")
  assert.equal(cloudAddress("localhost:8787"), "http://localhost:8787")
  assert.equal(cloudAddress("https://cloud.example.com/"), "https://cloud.example.com")
  assert.equal(joinCommand("cloud.example.com"), "mako-host join --cloud https://cloud.example.com")
  assert.equal(joinCommand(undefined), "mako-host join", "a window that can't say the cloud leaves it to the host's build")
  assert.equal(containerCommand("cloud.example.com"), "docker run -d --init --name mako-device -v mako-device:/data \\\n  -e MAKO_CLOUD_URL=https://cloud.example.com mako-device")
  assert.match(containerCommand(undefined), /MAKO_CLOUD_URL=<your Mako cloud> /)
  assert.equal(codePage("cloud.example.com"), "https://cloud.example.com/device")
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const BOX = uuid(900)
const STUDIO = uuid(901)
const row = (n: number, runsOn: ListedSession["runsOn"]): ListedSession => ({
  session: uuid(n), thread: uuid(100 + n), conversation: uuid(200 + n), harness: "codex", title: `Session ${n}`, state: "idle", folder: "/srv/api",
  createdAt: at(-90), activityAt: at(-5), generation: 1, runsOn, listedAt: at(-5),
})

test("a Thread on a machine of the person's own is marked from the account's list to a row", () => {
  assert.equal(runPlace(true, undefined), "cloud")
  assert.equal(runPlace(false, "runtime"), "machine")
  assert.equal(runPlace(false, "desktop"), "device")
  assert.equal(runPlace(false, undefined), "device", "a device the list hasn't named reads as a computer")

  // As a Mac's host lists it to its window, and the window's rail reads it.
  const onBox = listedSummary(row(1, { kind: "device", deviceId: BOX }), "build-box", undefined, "runtime")
  const onStudio = listedSummary(row(2, { kind: "device", deviceId: STUDIO }), "Studio", undefined, "desktop")
  const inCloud = listedSummary(row(3, { kind: "cloud", threadId: `t-${"0".repeat(16)}` }), "a cloud machine", undefined, "runtime")
  assert.equal(onBox.elsewhereKind, "runtime")
  assert.equal(onStudio.elsewhereKind, "desktop")
  assert.equal(inCloud.elsewhereKind, undefined, "a cloud Thread's machine is no device of the account")
  assert.equal(listedSummary(row(4, { kind: "device", deviceId: BOX }), "build-box", undefined).elsewhereKind, undefined, "a host before it says none")
  listLive([onBox, onStudio, inCloud])
  const presences = new Map(selectAcpPresence(acpStore.get()).map((presence) => [presence.key, presence]))
  assert.equal(presences.get(uuid(201))?.elsewhereKind, "runtime")
  assert.equal(presences.get(uuid(201))?.elsewhere, "build-box")
  assert.equal(presences.get(uuid(202))?.elsewhereKind, "desktop")
  assert.equal(presences.get(uuid(203))?.elsewhereKind, undefined)

  // As a browser folds the same list: the machine's Thread, and a Thread split between a machine and a Mac.
  const devices = new Map([
    [BOX, { id: BOX, kind: "runtime", name: "build-box", platform: "Linux x64 · Ubuntu 24.04" }],
    [STUDIO, { id: STUDIO, kind: "desktop", name: "Studio", platform: "macOS 26.0" }],
  ])
  const split = { ...row(5, { kind: "device", deviceId: STUDIO }), thread: uuid(106) }
  const list = { rows: [row(1, { kind: "device", deviceId: BOX }), row(2, { kind: "device", deviceId: STUDIO }), row(6, { kind: "device", deviceId: BOX }), split], devices, quiet: new Map<string, string>(), waiting: new Map(), archived: [] }
  const threads = new Map(foldThreads(list).threads.map((thread) => [thread.id, thread]))
  assert.equal(threads.get(uuid(101))?.machine, true)
  assert.equal(threads.get(uuid(101))?.sessions[0]?.summary.elsewhereKind, "runtime")
  assert.equal(threads.get(uuid(102))?.machine, undefined)
  assert.equal(threads.get(uuid(106))?.machine, undefined, "only a Thread wholly on machines wears the server")
  assert.equal(rowDetail(threads.get(uuid(101))!, true).place, "machine")
  assert.equal(rowDetail(threads.get(uuid(102))!, true).place, "device")
})
