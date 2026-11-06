import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Payload, type EventFrame, type Subscription } from "@mako/protocol"
import type { ListedSession } from "@mako/protocol/thread-listing"
import {
  cloudAddress,
  codePage,
  CONTAINER_LOGS_COMMAND,
  CONTAINER_START_COMMAND,
  containerCommand,
  DEVICE_MAKO_NEEDED,
  deviceFacts,
  deviceFamily,
  deviceHealth,
  deviceKindWords,
  healthWords,
  HOST_COMMAND,
  joinCommand,
  needsMakoUpdate,
  runPlace,
} from "@mako/host/contracts/account-devices"
import { listedSummary } from "@mako/host/contracts/listed-conversations"
import { selectAcpPresence } from "../src/state/acp-presence"
import { acpStore } from "../src/state/acp-state"
import { listLive } from "../src/state/live-recovery"
import { AccountList, accountListStore } from "../src/web-client/account-list"
import { deviceReadings } from "../src/web-client/device-readings"
import { Gateway, type WebConnection } from "../src/web-client/gateway"
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

test("a row's facts say each thing once", () => {
  assert.deepEqual(deviceFacts({ kind: "runtime", platform: "Linux x64 · Ubuntu 24.04", appVersion: "0.4.0" }), ["Linux machine", "x64", "Ubuntu 24.04", "Mako 0.4.0"], "Linux is said by the kind, not again by the system")
  assert.deepEqual(deviceFacts({ kind: "runtime", platform: "Linux", appVersion: null }), ["Linux machine"])
  assert.deepEqual(deviceFacts({ kind: "desktop", platform: "macOS 26.0", appVersion: "0.4.0" }), ["Mac", "macOS 26.0", "Mako 0.4.0"])
  assert.deepEqual(deviceFacts({ kind: "cli", platform: "Linux", appVersion: null }), ["Terminal", "Linux"], "a terminal's system is all that says Linux")
  assert.deepEqual(deviceFacts({ kind: "runtime", platform: "macOS 26.0", appVersion: undefined }), ["Mac with no window", "macOS 26.0"])
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
  assert.equal(containerCommand(undefined), 'docker run -d --init --name mako-device -v mako-device:/data \\\n  -e MAKO_CLOUD_URL="$MAKO_CLOUD_URL" mako-device', "a window that can't say the cloud passes the shell's own on")
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

test("a device with a live Session is there, however old its record: a live stream past the timestamp's threshold, through the browser's own list", async () => {
  const before = accountListStore.get()
  const held = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  const kept = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => kept.set(key, value), removeItem: (key: string) => kept.delete(key) } })
  // A machine as the gateway lists one that joined 20 minutes ago: its `lastSeenAt` is its join's, never moved since.
  const joined = new Date(Date.now() - 20 * 60_000).toISOString()
  const machine = { id: BOX, kind: "runtime", name: "review-build-box", platform: "Linux x64", appVersion: "0.4.0", enrolledBy: "device-code", createdAt: joined, lastSeenAt: joined, enrolledFrom: null }
  let deviceReads = 0
  // The account's stream as the gateway sends it: each frame handed to whoever waits for the next.
  const frames: EventFrame[] = []
  const waiting: Array<(frame: EventFrame) => void> = []
  const send = (seq: number, event: Parameters<typeof Payload.of>[0]) => {
    // SAFETY: an event frame as the list reads one: its number and its payload, nothing else of the envelope.
    const frame = { seq, event: Payload.of(event) } as EventFrame
    const next = waiting.shift()
    if (next) next(frame)
    else frames.push(frame)
  }
  const subscription: Subscription = {
    next: () => new Promise((resolve) => (frames.length ? resolve(frames.shift()!) : waiting.push(resolve))),
    close: () => {},
  }
  // The browser's own gateway, with what it would fetch answered here: the two reads the list makes, and the
  // account's stream it follows.
  const gateway = new Gateway({ origin: "https://app.example.com", connect: async () => ({ token: "t", expiresAt: Date.now() + 300_000, deviceId: uuid(1), account: { id: "ana", name: "Ana", email: "ana@example.com", image: null, entitlements: [] } }) })
  Object.defineProperty(gateway, "rest", {
    value: async (_method: string, path: string) => {
      if (path === "/v1/sessions") return { sessions: [], seq: 0 }
      if (path === "/v1/devices") {
        deviceReads += 1
        return { devices: [machine] }
      }
      throw new Error(`no ${path} in this test`)
    },
  })
  Object.defineProperty(gateway, "session", { value: { subscribe: () => subscription, close: () => {}, wake: () => {}, probe: () => {} } })
  const list = new AccountList(gateway, "ana")
  const until = async (what: string, check: () => boolean) => {
    const deadline = Date.now() + 3_000
    while (!check()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  /** The machine's health as Settings › Devices reads it, from the list as it stands. */
  const health = () => {
    const state = accountListStore.get()
    const device = state.devices.get(BOX)!
    return deviceHealth(device, { current: false, quietSince: state.quiet.get(BOX), heard: deviceReadings(state).heard.has(BOX), now: Date.now() })
  }
  try {
    list.start()
    await until("the list followed", () => accountListStore.get().phase === "live" && accountListStore.get().devices.has(BOX))
    assert.deepEqual(health(), { state: "never" }, "joined and nothing heard of it: it never connected")

    // It runs a Session now, said on the account's stream. Its record isn't read again; the list is the evidence.
    send(1, { type: "sessions-listed", sessions: [{ ...row(7, { kind: "device", deviceId: BOX }), state: "working", createdAt: new Date().toISOString(), activityAt: new Date().toISOString(), listedAt: new Date().toISOString() }] })
    await until("its Session listed", () => accountListStore.get().rows.length === 1)
    assert.equal(deviceReads, 1, "its record was read once, 20 minutes stale by its own time")
    assert.deepEqual(deviceReadings(accountListStore.get()).runs.get(BOX), { threads: 1, fins: 0 })
    assert.deepEqual(health(), { state: "online" }, "a device with a live Session is there")

    // The account stops hearing from it: quiet since then, its own word, over the row it still lists.
    const since = new Date(Date.now() - 3 * 60_000).toISOString()
    send(2, { type: "device-quiet", deviceId: BOX, since })
    await until("the account's word on it", () => accountListStore.get().quiet.has(BOX))
    assert.deepEqual(health(), { state: "quiet", since: Date.parse(since) })

    // Heard from again: there, by the same row.
    send(3, { type: "device-quiet", deviceId: BOX, since: null })
    await until("heard from again", () => !accountListStore.get().quiet.has(BOX))
    assert.deepEqual(health(), { state: "online" })
  } finally {
    list.stop()
    accountListStore.set(before)
    if (held) Object.defineProperty(globalThis, "localStorage", held)
    else Reflect.deleteProperty(globalThis, "localStorage")
  }
})

test("the lines a browser shows name the cloud its gateway says of itself, and every line runs as it's written", async () => {
  // The hosted page's own options: its origin, which passes on only the app's routes, and a `connect` that hands on
  // the gateway's answer to this browser's sign-in as it came.
  const answer = (cloud?: string): WebConnection => ({ token: "t", expiresAt: Date.now() + 300_000, deviceId: uuid(1), account: { id: "ana", name: "Ana", email: "ana@example.com", image: null, entitlements: [] }, ...(cloud && { cloud }) })
  const page = (cloud?: string) => new Gateway({ origin: "https://app.example.com", connect: async () => answer(cloud) })

  // A gateway that says its address: the lines name it, never the page's origin, where a machine can't join.
  const hosted = page("https://api.example.com")
  const said = (await hosted.connection()).cloud
  hosted.close()
  assert.equal(joinCommand(said), "mako-host join --cloud https://api.example.com")
  assert.match(containerCommand(said), /-e MAKO_CLOUD_URL=https:\/\/api\.example\.com mako-device$/)

  // A gateway from before it said so, as the hosted page's options are today: no address reaches the browser.
  const older = page()
  const unsaid = (await older.connection()).cloud
  older.close()
  assert.equal(unsaid, undefined)

  // Every line the sheet can show is shell a person can run as written: no placeholder a shell reads as a redirection.
  const folder = mkdtempSync(join(tmpdir(), "mako-machine-lines-"))
  try {
    // A stand-in for each program a line names, saying how the shell called it.
    for (const program of ["docker", "mako-host"]) {
      writeFileSync(join(folder, program), `#!/bin/sh\nprintf '%s\\n' "${program}" "$@"\n`)
      chmodSync(join(folder, program), 0o755)
    }
    const run = (line: string, environment: Record<string, string> = {}) => spawnSync("/bin/sh", ["-c", line], { cwd: folder, env: { PATH: `${folder}:/usr/bin:/bin`, ...environment }, encoding: "utf8" })
    for (const cloud of [said, unsaid]) {
      for (const line of [joinCommand(cloud), HOST_COMMAND, containerCommand(cloud), CONTAINER_LOGS_COMMAND]) {
        const ran = run(line, { MAKO_CLOUD_URL: "https://set-by-hand.example.com" })
        assert.equal(ran.status, 0, `${line}: ${ran.stderr}`)
        assert.equal(ran.stderr, "", line)
        assert.doesNotMatch(line, /[<>]/, "nothing a shell reads as a redirection")
      }
    }
    assert.deepEqual(run(containerCommand(said)).stdout.trim().split("\n"), ["docker", "run", "-d", "--init", "--name", "mako-device", "-v", "mako-device:/data", "-e", "MAKO_CLOUD_URL=https://api.example.com", "mako-device"])
    // Without the gateway's word, the container takes the address the person set in their shell.
    assert.deepEqual(run(containerCommand(unsaid), { MAKO_CLOUD_URL: "https://set-by-hand.example.com" }).stdout.trim().split("\n").slice(-3), ["-e", "MAKO_CLOUD_URL=https://set-by-hand.example.com", "mako-device"])
    assert.deepEqual(run(joinCommand(unsaid)).stdout.trim().split("\n"), ["mako-host", "join"])
    // A container whose code ran out is started again, by the name the run line gave it; the run line can't run
    // twice, since that name is taken.
    assert.equal(CONTAINER_START_COMMAND, "docker start mako-device")
    assert.equal(/--name (\S+) /.exec(containerCommand(said))?.[1], CONTAINER_START_COMMAND.split(" ").at(-1), "it starts the container the run line named")
    assert.notEqual(CONTAINER_START_COMMAND, containerCommand(said))
    assert.deepEqual(run(CONTAINER_START_COMMAND).stdout.trim().split("\n"), ["docker", "start", "mako-device"])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
