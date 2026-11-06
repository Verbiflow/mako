import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { decodeControlVideo, decodeControlVideoBatch, encodeControlVideo, encodeControlVideoBatch, type ControlVideoPacket } from "@mako/control-runtime/contracts"
import type { SimulatorSetup } from "@mako/host/contracts/simulator-setup"
import type { SimulatorCaller, SimulatorsWatchInput, SimulatorsWatchResult } from "@mako/host/contracts/simulators"
import { SimulatorUnsupported, type SimulatorFrameSink, type SimulatorHost } from "@mako/host/control/simulators/host"
import { HUB_TOKEN_HEADER, inspectorSocket, SimulatorHub, type HubConnection } from "@mako/host/control/simulators/hub"
import { rawPoint, readScreenConfig, swipePlan, tapPlan, type ScreenConfig } from "@mako/host/control/simulators/hid"
import { parsePs, safariPages, simulatorOfProcess } from "@mako/host/control/simulators/inspector"
import { LocalSimulatorHost, orientationOf, type LocalDriving, type LocalInput } from "@mako/host/control/simulators/local-host"
import { SimulatorTools } from "@mako/host/control/simulators/mcp"
import type { Run } from "@mako/host/control/simulators/setup"
import { AvccReader, avccSize, decodable, FIRST_KEY_MS, jpegSize, MjpegReader, ServeSimCapture, type AvccUnit, type CaptureSource } from "@mako/host/control/simulators/capture"
import { SimulatorStreams } from "@mako/host/control/simulators/stream"
import { Simulators } from "@mako/host/control/simulators/simulators"
import { Simctl } from "@mako/host/control/simulators/simctl"
import { ToolProcess } from "@mako/host/control/simulators/tool-process"
import { admitted, hubRoute, hubUpgrade, inspectorSockets, inspectorType, upstreamHandshake } from "../electron/simulator-hub.ts"
import { pictureTurn, shownScreen, TouchStream, watchSimulatorVideo } from "../src/state/simulators.ts"
import { ControlVideoPlayer } from "../src/lib/control-video-player.ts"

/**
 * The local simulator host against fakes of the tools it drives: the hub's gate and routes (what a page or another
 * process on this Mac is refused), serve-sim's two stream formats, the stream each viewer reads, the web inspector's
 * simulator lookup, touches mapped onto the raw framebuffer however the device is turned, the host's actions over a
 * fake hub, the agent tools' offer, and the panel's touch and rotation helpers.
 */

const scratch = await mkdtemp(join(tmpdir(), "mako-simulator-host-"))
after(() => rm(scratch, { recursive: true, force: true }))

const PHONE = "5D1C8E52-7A0B-4C35-9C1B-2E6C2F0B6A11"
const TABLET = "A3F09B7D-14C2-4E8A-B5D0-77E1C9F4D2E3"
const TOKEN = Buffer.from("k".repeat(43))
const HOST = "127.0.0.1:20683"

test("the hub admits only its host's own requests: its exact Host, its token, nothing a browser adds", () => {
  const own = { host: HOST, [HUB_TOKEN_HEADER]: TOKEN.toString() }
  assert.equal(admitted(own, HOST, TOKEN), true)
  assert.equal(admitted({ ...own, host: "localhost:20683" }, HOST, TOKEN), false, "a rebound name")
  assert.equal(admitted({ ...own, origin: "https://evil.example" }, HOST, TOKEN), false)
  assert.equal(admitted({ ...own, "sec-fetch-site": "cross-site" }, HOST, TOKEN), false)
  assert.equal(admitted({ ...own, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" }, HOST, TOKEN), false)
  // What the host's own `fetch` sends, Node's undici.
  assert.equal(admitted({ ...own, connection: "keep-alive", accept: "*/*", "accept-language": "*", "sec-fetch-mode": "cors", "user-agent": "node" }, HOST, TOKEN), true)
  assert.equal(admitted({ host: HOST }, HOST, TOKEN), false)
  assert.equal(admitted({ ...own, [HUB_TOKEN_HEADER]: "k".repeat(42) }, HOST, TOKEN), false)
  assert.equal(admitted({ ...own, [HUB_TOKEN_HEADER]: "j".repeat(43) }, HOST, TOKEN), false)
})

test("serve-sim sees only the helper routes Mako reads, never its api, exec or grid", () => {
  const at = (path: string) => new URL(path, `http://${HOST}`)
  assert.deepEqual(hubRoute("GET", at("/health")), { kind: "health" })
  assert.deepEqual(hubRoute("GET", at(`/helper/${PHONE}/stream.avcc`)), { kind: "helper", udid: PHONE, path: `/helper/${PHONE}/stream.avcc` })
  assert.deepEqual(hubRoute("GET", at(`/helper/${PHONE}/ax`)), { kind: "helper", udid: PHONE, path: `/helper/${PHONE}/ax` })
  assert.deepEqual(hubRoute("GET", at("/inspector/targets")), { kind: "targets" })
  for (const path of ["/api", "/exec", "/", "/grid", `/helper/${PHONE}/../api`, "/helper/not-a-udid/config", `/helper/${PHONE}/exec`])
    assert.deepEqual(hubRoute("GET", at(path)), { kind: "not-found" }, path)
  assert.deepEqual(hubRoute("POST", at(`/helper/${PHONE}/config`)), { kind: "not-found" })
  assert.deepEqual(hubUpgrade(at(`/helper/ws?device=${PHONE}`)), { kind: "touch", udid: PHONE })
  assert.deepEqual(hubUpgrade(at("/helper/ws?device=../../x")), { kind: "not-found" })
  assert.deepEqual(hubUpgrade(at("/inspector/page/sim%3A812%3A1%3A2")), { kind: "inspector", target: "sim:812:1:2" })
  assert.deepEqual(hubUpgrade(at("/devtools/page/1")), { kind: "not-found" })
})

test("the inspector restarts on the simulators' web inspector sockets alone, names each by its launchd_sim, and the upstream handshake drops the token", () => {
  const x = "/private/tmp/com.apple.launchd.x/com.apple.webinspectord_sim.socket"
  const y = "/private/tmp/com.apple.launchd.y/com.apple.webinspectord_sim.socket"
  const lsof = ["p812", "claunchd_sim", `n${x}`, `n${x}`, "p900", "cusbmuxd", "n/var/run/usbmuxd", "p933", "claunchd_sim", `n${y}`].join("\n")
  // As this Mac's iPhone showed: one of the simulator's own processes on its socket for a moment, listed last.
  const passing = `${lsof}\np31617\ncwebinspectord_sim\nn${x}`
  assert.equal(inspectorSockets(lsof).key, `812:${x}\n933:${y}`)
  assert.equal(inspectorSockets(passing).key, inspectorSockets(lsof).key, "a process passing through a socket starts nothing again")
  assert.equal(inspectorSockets(passing).simulator(31617), 812, "Safari's pages inspect-webkit found through it belong to that simulator")
  assert.equal(inspectorSockets(passing).simulator(933), 933)
  assert.equal(inspectorSockets(passing).simulator(4242), 4242)
  assert.equal(inspectorSockets("p900\ncusbmuxd\nn/var/run/usbmuxd").key, "")
  // What inspect-webkit's getTargets said of Safari's tabs on iOS 27.2: the host looks for "page".
  assert.deepEqual(["WIRTypeWebPage", "WIRTypeServiceWorker", "WIRTypeJavaScript"].map(inspectorType), ["page", "service_worker", "worker"])
  const handshake = upstreamHandshake("/devtools/page/sim:812:1:2", ["Host", HOST, HUB_TOKEN_HEADER, "secret", "Upgrade", "websocket", "Sec-WebSocket-Key", "abc"])
  assert.equal(handshake, "GET /devtools/page/sim:812:1:2 HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nSec-WebSocket-Key: abc\r\n\r\n")
})

const until = async (done: () => boolean) => {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > 5_000) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function envelope(tag: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(5 + payload.byteLength)
  new DataView(bytes.buffer).setUint32(0, 1 + payload.byteLength)
  bytes[4] = tag
  bytes.set(payload, 5)
  return bytes
}

/** The smallest JPEG `jpegSize` reads: start of image, then a baseline frame header of this size. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0])
}

function join8(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.byteLength
  }
  return joined
}

test("inspect-webkit's socket is in the hub's folder, or in this user's temporary folder when that path is too long to bind", () => {
  assert.equal(inspectorSocket("/Users/ada/Library/Application Support/Mako/simulators/hub", "/private/tmp/xy"), "/Users/ada/Library/Application Support/Mako/simulators/hub/inspector.sock")
  // As long as a Thread's data folder of a real stage B run, where macOS refused the socket with EINVAL.
  const long = "/Users/tester0/.mako/thread-data/folder-0000000000000000/workers/sim-phase1/data/simulators/hub"
  // As long as macOS's per-user temporary folder.
  const temporary = "/private/tmp/mako-0000000000000000000000000000/T"
  const socket = inspectorSocket(long, temporary)
  assert.ok(socket.startsWith(`${temporary}/mako-hub-`) && socket.endsWith(".sock"))
  assert.ok(Buffer.byteLength(socket) <= 103)
  assert.equal(inspectorSocket(long, temporary), socket)
  assert.notEqual(inspectorSocket(`${long}-2`, temporary), socket)
})

test("serve-sim's AVCC envelopes and MJPEG parts are read whole, however the network cut them", () => {
  const units: AvccUnit[] = []
  const reader = new AvccReader((unit) => units.push(unit))
  const stream = join8(envelope(1, new Uint8Array([1, 2])), envelope(2, new Uint8Array([3, 4, 5])), envelope(3, new Uint8Array([6])))
  for (let at = 0; at < stream.byteLength; at += 3) reader.push(stream.slice(at, at + 3))
  assert.deepEqual(units.map((unit) => [unit.tag, [...unit.payload]]), [[1, [1, 2]], [2, [3, 4, 5]], [3, [6]]])
  const huge = new Uint8Array(5)
  new DataView(huge.buffer).setUint32(0, 64 * 1024 * 1024)
  assert.throws(() => new AvccReader(() => undefined).push(huge), /envelope said it was/)

  const frames: Uint8Array[] = []
  const mjpeg = new MjpegReader((frame) => frames.push(frame))
  const part = (body: Uint8Array) => join8(new TextEncoder().encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.byteLength}\r\n\r\n`), body, new TextEncoder().encode("\r\n"))
  const parts = join8(part(jpeg(1206, 2622)), part(jpeg(2622, 1206)))
  for (let at = 0; at < parts.byteLength; at += 7) mjpeg.push(parts.slice(at, at + 7))
  assert.deepEqual(frames.map(jpegSize), [{ width: 1206, height: 2622 }, { width: 2622, height: 1206 }])
  assert.equal(jpegSize(new Uint8Array([0x89, 0x50])), undefined)
})

/**
 * A capture that sends what it's given, once per open, then waits until it's aborted. As one starting up, it may send
 * its H.264 only after `silentMs`, and not know its screen's size yet (`unsized`).
 */
function fakeSource(answers: Partial<Record<"stream.avcc" | "stream.mjpeg", Uint8Array[]>>, { silentMs = 0, unsized = false } = {}): CaptureSource & { opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    size: async () => (unsized ? undefined : { width: 1206, height: 2622 }),
    async open(_udid, route, signal) {
      opened.push(route)
      const chunks = answers[route] ?? []
      return (async function* () {
        if (route === "stream.avcc" && silentMs) await new Promise((resolve) => setTimeout(resolve, silentMs))
        for (const chunk of chunks) yield chunk
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      })()
    },
  }
}

const kinds = (packets: readonly Uint8Array[]): ControlVideoPacket["kind"][] => packets.map((packet) => decodeControlVideo(packet).kind)
const SCREEN = JSON.stringify(["local", PHONE])
/** The avcC records this Mac's serve-sim sent for Mako's iPhone 18 Pro and iPad Pro 13-inch (M5) on iOS 27.2. */
const PHONE_AVCC = Buffer.from("01640033ffe1001627640033ac13143c04c0149e6a9a81010103c20108f801000428ee3cb0", "hex")
const TABLET_AVCC = Buffer.from("01640034ffe1001527640034ac131424020405669a81010103c201089801000428ee3cb0", "hex")
const AVCC = envelope(1, PHONE_AVCC)
const SEED = envelope(4, jpeg(1206, 2622))
const MJPEG = join8(new TextEncoder().encode(`--frame\r\nContent-Length: 25\r\n\r\n`), jpeg(1206, 2622))

/**
 * Every packet one viewer reads of a capture, through the streams every host's screen is shared by, for `ms`. A viewer
 * that `decodes` tells the host the newest H.264 unit it was sent, as the panel does of the picture its decoder drew.
 */
async function watchCapture(source: CaptureSource, ms: number, { decodes = true } = {}): Promise<ControlVideoPacket["kind"][]> {
  const streams = new SimulatorStreams()
  const seen: ControlVideoPacket["kind"][] = []
  let drawn: number | undefined
  try {
    const started = Date.now()
    while (Date.now() - started < ms) {
      const read = (await streams.read(SCREEN, "panel", async (sink) => new ServeSimCapture(source, PHONE, sink), { waitMs: 200, ...(drawn !== undefined && { decoded: drawn }) })).packets.map((packet) => decodeControlVideo(packet))
      seen.push(...read.map((packet) => packet.kind))
      drawn = decodes ? read.findLast((packet) => packet.kind !== "poster")?.sequence : undefined
    }
  } finally {
    await streams.close()
  }
  return seen
}

test("a capture starting up, which knows no size and sends no seed, takes its size from the avcC record and stays on H.264", async () => {
  assert.deepEqual(avccSize(PHONE_AVCC), { width: 1206, height: 2622 })
  assert.deepEqual(avccSize(TABLET_AVCC), { width: 2064, height: 2752 })
  assert.equal(avccSize(new Uint8Array([1, 100, 0, 31])), undefined)
  assert.ok(decodable(PHONE_AVCC) && decodable(TABLET_AVCC))
  assert.equal(decodable(new Uint8Array([1, 100, 0, 31])), false, "a codec string's four bytes are no decoder configuration")
  assert.equal(decodable(PHONE_AVCC.subarray(0, PHONE_AVCC.byteLength - 2)), false, "nor is a record whose picture parameter set is cut short")
  assert.equal(decodable(Buffer.concat([PHONE_AVCC.subarray(0, PHONE_AVCC.byteLength - 7), Buffer.from([0])])), false, "nor one without a picture parameter set")
  const source = fakeSource({ "stream.avcc": [envelope(1, PHONE_AVCC), envelope(2, new Uint8Array([7])), envelope(3, new Uint8Array([8]))] }, { unsized: true })
  const packets: ControlVideoPacket[] = []
  const capture = new ServeSimCapture(source, PHONE, { packet: (packet) => packets.push(packet), ended: () => undefined })
  try {
    await until(() => packets.length >= 2)
  } finally {
    await capture.stop()
  }
  assert.deepEqual(packets.map((packet) => [packet.kind, packet.width, packet.height]), [["key", 1206, 2622], ["delta", 1206, 2622]])
})

test("a capture sends its JPEG seed, then H.264 from its first decodable key frame, and a late viewer starts at that key", async () => {
  const source = fakeSource({ "stream.avcc": [SEED, AVCC, envelope(3, new Uint8Array([9])), envelope(2, new Uint8Array([7])), envelope(3, new Uint8Array([8]))] })
  const streams = new SimulatorStreams()
  const start = async (sink: SimulatorFrameSink) => new ServeSimCapture(source, PHONE, sink)
  try {
    const packets: Uint8Array[] = []
    for (let read = 0; read < 10 && packets.length < 3; read++) packets.push(...(await streams.read(SCREEN, "panel", start, { waitMs: 200 })).packets)
    // The delta before any key frame isn't sent: a decoder can't start from it.
    assert.deepEqual(kinds(packets), ["poster", "key", "delta"])
    const key = decodeControlVideo(packets[1]!)
    assert.equal(key.width, 1206)
    assert.equal(key.height, 2622)
    assert.ok(key.kind === "key" && key.description.byteLength === PHONE_AVCC.byteLength)
    assert.deepEqual(kinds((await streams.read(SCREEN, "phone", start, { waitMs: 200 })).packets), ["poster", "key", "delta"], "a late viewer paints from the poster and the key frame since")
  } finally {
    await streams.close()
  }
  assert.deepEqual(source.opened, ["stream.avcc"])
})

test("only H.264 a viewer decodes keeps it: no H.264, deltas alone, a key without its avcC, an avcC that isn't whole, or one no viewer's decoder takes fall back to JPEGs; a slow start doesn't", { timeout: 15_000 }, async () => {
  const feeds = {
    seedOnly: fakeSource({ "stream.avcc": [SEED], "stream.mjpeg": [MJPEG] }),
    deltas: fakeSource({ "stream.avcc": [SEED, AVCC, envelope(3, new Uint8Array([8])), envelope(3, new Uint8Array([9]))], "stream.mjpeg": [MJPEG] }),
    keyWithoutAvcc: fakeSource({ "stream.avcc": [SEED, envelope(2, new Uint8Array([7])), envelope(3, new Uint8Array([8]))], "stream.mjpeg": [MJPEG] }),
    rejectedAvcc: fakeSource({ "stream.avcc": [SEED, envelope(1, new Uint8Array([0, 100, 0, 31])), envelope(2, new Uint8Array([7])), envelope(3, new Uint8Array([8]))], "stream.mjpeg": [MJPEG] }),
    // A version byte, a profile and a level make a codec string, but no decoder: it has no parameter sets.
    malformedAvcc: fakeSource({ "stream.avcc": [SEED, envelope(1, new Uint8Array([1, 100, 0, 31])), envelope(2, new Uint8Array([7])), envelope(3, new Uint8Array([8]))], "stream.mjpeg": [MJPEG] }),
    // A whole record a viewer's VideoDecoder still refuses: the host can't tell, only the viewer can.
    undecoded: fakeSource({ "stream.avcc": [SEED, AVCC, envelope(2, new Uint8Array([7])), envelope(3, new Uint8Array([8]))], "stream.mjpeg": [MJPEG] }),
    keyed: fakeSource({ "stream.avcc": [SEED, AVCC, envelope(2, new Uint8Array([7])), envelope(3, new Uint8Array([8]))], "stream.mjpeg": [MJPEG] }),
    // As a cold capture on a busy Mac: nothing for longer than a key frame is waited for, then the avcC and a key.
    slowStart: fakeSource({ "stream.avcc": [AVCC, envelope(2, new Uint8Array([7])), envelope(3, new Uint8Array([8]))], "stream.mjpeg": [MJPEG] }, { silentMs: FIRST_KEY_MS + 300 }),
  }
  const ms = FIRST_KEY_MS + 1_500
  const [seedOnly, deltas, keyWithoutAvcc, rejectedAvcc, malformedAvcc, undecoded, keyed, slowStart] = await Promise.all([
    watchCapture(feeds.seedOnly, ms),
    watchCapture(feeds.deltas, ms, { decodes: false }),
    watchCapture(feeds.keyWithoutAvcc, ms),
    watchCapture(feeds.rejectedAvcc, ms),
    watchCapture(feeds.malformedAvcc, ms),
    watchCapture(feeds.undecoded, ms, { decodes: false }),
    watchCapture(feeds.keyed, ms),
    watchCapture(feeds.slowStart, ms),
  ])
  for (const [name, feed, seen] of [["seedOnly", feeds.seedOnly, seedOnly], ["deltas", feeds.deltas, deltas], ["keyWithoutAvcc", feeds.keyWithoutAvcc, keyWithoutAvcc], ["rejectedAvcc", feeds.rejectedAvcc, rejectedAvcc], ["malformedAvcc", feeds.malformedAvcc, malformedAvcc]] satisfies [string, { opened: string[] }, string[]][]) {
    assert.deepEqual(feed.opened, ["stream.avcc", "stream.mjpeg"], `${name}: a viewer would sit on a still picture, so the capture's JPEGs take over`)
    assert.deepEqual(seen, ["poster", "poster"], `${name}: the viewer is sent the seed, then each JPEG, and nothing it can't decode`)
  }
  assert.deepEqual(feeds.undecoded.opened, ["stream.avcc", "stream.mjpeg"], "a key frame no viewer's decoder drew from isn't one it can show")
  assert.deepEqual(undecoded, ["poster", "key", "delta", "poster"], "its viewer paints the capture's JPEGs once the host gives up on its H.264")
  assert.deepEqual(feeds.keyed.opened, ["stream.avcc"], "a capture a viewer decoded stays on H.264")
  assert.deepEqual(keyed, ["poster", "key", "delta"])
  assert.deepEqual(feeds.slowStart.opened, ["stream.avcc"], "a capture silent while it starts isn't one that sends no H.264")
  assert.deepEqual(slowStart, ["key", "delta"])
})

test("each subscription of a capture needs its own decoded picture: one decoded before a reconnect, or told late, keeps nothing on H.264", { timeout: 15_000 }, async () => {
  /** A capture whose first subscription decodes and ends, then opens again on `second`, a viewer drawing what `decodes` says. */
  const reconnect = async (second: Uint8Array[], decodes: (sequence: number, first: number) => boolean) => {
    const opened: string[] = []
    const source: CaptureSource = {
      size: async () => ({ width: 1206, height: 2622 }),
      async open(_udid, route, signal) {
        opened.push(route)
        const which = opened.length
        return (async function* () {
          if (route === "stream.mjpeg") yield MJPEG
          else for (const chunk of which === 1 ? [AVCC, envelope(2, new Uint8Array([7]))] : second) yield chunk
          if (which === 1) return
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        })()
      },
    }
    let first: number | undefined
    let capture: ServeSimCapture | undefined
    const late = setInterval(() => first !== undefined && capture?.decoded(first), 50)
    capture = new ServeSimCapture(source, PHONE, {
      packet: (packet) => {
        if (packet.kind !== "key") return
        first ??= packet.sequence
        if (decodes(packet.sequence, first)) capture?.decoded(packet.sequence)
      },
      ended: () => undefined,
    })
    try {
      await until(() => opened.length >= 2)
      await new Promise((resolve) => setTimeout(resolve, FIRST_KEY_MS + 500))
      return opened
    } finally {
      clearInterval(late)
      await capture.stop()
    }
  }
  const [malformed, withheld, decodedAgain] = await Promise.all([
    reconnect([envelope(1, new Uint8Array([1, 100, 0, 31])), envelope(2, new Uint8Array([7]))], (sequence, first) => sequence === first),
    reconnect([AVCC, envelope(2, new Uint8Array([7]))], (sequence, first) => sequence === first),
    reconnect([AVCC, envelope(2, new Uint8Array([7]))], () => true),
  ])
  assert.deepEqual(malformed, ["stream.avcc", "stream.avcc", "stream.mjpeg"], "a reconnect whose avcC isn't whole shows JPEGs, however well the subscription before it decoded")
  assert.deepEqual(withheld, ["stream.avcc", "stream.avcc", "stream.mjpeg"], "a reconnect nobody decodes shows JPEGs: the earlier subscription's picture, told again late, isn't its")
  assert.deepEqual(decodedAgain, ["stream.avcc", "stream.avcc"], "a reconnect its viewer decodes stays on H.264")
})

test("a capture that replaces a retired one isn't kept on H.264 by a late decode of the retired one's picture", { timeout: 15_000 }, async () => {
  const opened: string[] = []
  const source: CaptureSource = {
    size: async () => ({ width: 1206, height: 2622 }),
    async open(_udid, route, signal) {
      opened.push(route)
      return (async function* () {
        if (route === "stream.mjpeg") yield MJPEG
        else for (const chunk of [AVCC, envelope(2, new Uint8Array([7]))]) yield chunk
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      })()
    },
  }
  let captures = 0
  const streams = new SimulatorStreams({ idleMs: 100, lingerMs: 1 })
  const start = async (sink: SimulatorFrameSink) => {
    captures++
    return new ServeSimCapture(source, PHONE, sink)
  }
  const keyOf = (packets: Uint8Array[]) => packets.map((packet) => decodeControlVideo(packet)).find((packet) => packet.kind === "key")?.sequence
  try {
    let retired: number | undefined
    for (let read = 0; read < 20 && retired === undefined; read++) retired = keyOf((await streams.read(SCREEN, "panel", start, { waitMs: 100 })).packets)
    assert.notEqual(retired, undefined)
    await streams.read(SCREEN, "panel", start, { waitMs: 0, decoded: retired })
    await until(() => streams.viewers(SCREEN).length === 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    while (Date.now() - started < FIRST_KEY_MS + 700) await streams.read(SCREEN, "panel", start, { waitMs: 100, decoded: retired })
  } finally {
    await streams.close()
  }
  assert.equal(captures, 2, "the first capture stopped once nobody watched, and the next viewer started another")
  assert.deepEqual(opened, ["stream.avcc", "stream.avcc", "stream.mjpeg"], "the replacement, whose own pictures nobody decoded, shows JPEGs")
})

test("a viewer read twice at once stays until its own idle deadline after its newest read", async () => {
  let stops = 0
  const streams = new SimulatorStreams({ idleMs: 400, lingerMs: 1 })
  const start = async () => ({ keyFrame: () => undefined, resize: () => undefined, stop: async () => void stops++ })
  try {
    await Promise.all([streams.read(SCREEN, "v", start, { waitMs: 0 }), streams.read(SCREEN, "v", start, { waitMs: 100 })])
    await new Promise((resolve) => setTimeout(resolve, 50))
    await streams.read(SCREEN, "v", start, { waitMs: 0 })
    const fresh = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 280))
    assert.deepEqual(streams.viewers(SCREEN), ["v"], "an earlier read's deadline doesn't end a viewer that read since")
    assert.equal(stops, 0)
    await until(() => stops === 1)
    assert.ok(Date.now() - fresh >= 400, "it goes at its own deadline")
  } finally {
    await streams.close()
  }
})

test("a viewer is its Thread's alone, and a Thread that ends or a viewer that stops reading stops the capture nobody else watches", { timeout: 10_000 }, async () => {
  let stopped = 0
  let sink: SimulatorFrameSink | undefined
  const host: SimulatorHost = {
    id: "local",
    label: "This Mac",
    kind: "local",
    summary: async () => ({ id: "local", label: "This Mac", kind: "local", platforms: { ios: { ready: true }, android: { ready: false, blocker: "no-xcode", why: "Not here." } } }),
    list: async () => [{ hostId: "local", id: PHONE, name: "Mako iPhone 18 Pro", platform: "ios", runtime: "iOS 27.2", form: "phone", state: "booted" }],
    boot: async () => undefined,
    act: async () => undefined,
    read: async () => ({ state: null }),
    screenshot: async () => ({ path: "/dev/null", width: 1, height: 1 }),
    record: async () => ({}),
    release: async () => undefined,
    close: async () => undefined,
    async frames(_simulator, frames) {
      sink = frames
      return { keyFrame: () => undefined, resize: () => undefined, stop: async () => void stopped++ }
    },
  }
  const streams = new SimulatorStreams({ idleMs: 300, lingerMs: 1 })
  const simulators = new Simulators({ hosts: [host], streams, consent: async () => [{ folder: "/project", allowed: true, at: 0 }], agent: (session) => ({ thread: session, session, conversation: session, folder: "/project" }) })
  const a = { kind: "agent" as const, session: "thread-a" }
  const b = { kind: "agent" as const, session: "thread-b" }
  const watch = async (caller: SimulatorCaller, extra: Partial<SimulatorsWatchInput> = {}) => {
    const read = await simulators.watch(caller, { host: "local", simulator: PHONE, viewer: "same-id", waitMs: 0, ...extra })
    assert.ok("batch" in read)
    return decodeControlVideoBatch(Buffer.from(read.batch, "base64")).packets.length
  }
  try {
    await simulators.open(a, { host: "local", simulator: PHONE })
    await watch(a)
    sink?.packet({ kind: "poster", width: 2, height: 2, sequence: 0, capturedAt: 0, data: jpeg(2, 2) })
    await watch(b)
    assert.deepEqual(streams.viewers(SCREEN).sort(), ["here/thread-a/same-id", "here/thread-b/same-id"], "two Threads' viewers of one name are two viewers")
    assert.equal(await watch(a), 1, "and one doesn't drain what the other was sent")
    await watch(b)
    simulators.releaseThread({ thread: "thread-a" })
    assert.deepEqual(streams.viewers(SCREEN), ["here/thread-b/same-id"], "an ended Thread stops watching; the other watches on")
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(stopped, 0, "the capture streams on for the Thread still watching")
    await until(() => stopped === 1)
    assert.deepEqual(streams.viewers(SCREEN), [], "a viewer that stopped reading goes, with no read to notice it, and the capture nobody watches stops")
    await watch({ kind: "person" })
    assert.equal(stopped, 1)
    await watch({ kind: "person" }, { leave: true })
    assert.deepEqual(streams.viewers(SCREEN), [], "a viewer that leaves goes at once")
    await until(() => stopped === 2)
  } finally {
    await simulators.close()
  }
})

test("the panel's player paints the capture's JPEGs again once the stream it decoded starts over or falls back", async () => {
  const drawn: string[] = []
  const decoders: string[] = []
  const restore = ["VideoDecoder", "EncodedVideoChunk", "createImageBitmap"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  Object.assign(globalThis, {
    VideoDecoder: class {
      state = "unconfigured"
      readonly #output: (frame: { timestamp: number; displayWidth: number; displayHeight: number; close(): void }) => void
      constructor(callbacks: { output: (frame: { timestamp: number; displayWidth: number; displayHeight: number; close(): void }) => void }) {
        this.#output = callbacks.output
        decoders.push("made")
      }
      configure() {
        this.state = "configured"
      }
      decode(chunk: { timestamp: number }) {
        this.#output({ timestamp: chunk.timestamp, displayWidth: 2, displayHeight: 2, close: () => undefined })
      }
      close() {
        this.state = "closed"
        decoders.push("closed")
      }
    },
    EncodedVideoChunk: class {
      constructor(fields: { timestamp: number }) {
        Object.assign(this, fields)
      }
    },
    createImageBitmap: async () => ({ width: 2, height: 2, close: () => undefined, jpeg: true }),
  })
  const player = new ControlVideoPlayer((picture) => drawn.push("jpeg" in picture ? "jpeg" : "h264"), () => undefined)
  const key = (sequence: number) => encodeControlVideo({ kind: "key", description: PHONE_AVCC, width: 2, height: 2, sequence, capturedAt: sequence, data: new Uint8Array([1]) })
  const poster = (sequence: number) => encodeControlVideo({ kind: "poster", width: 2, height: 2, sequence, capturedAt: sequence, data: jpeg(2, 2) })
  try {
    player.push(key(1))
    for (const sequence of [2, 2, 2]) player.push(poster(sequence))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(drawn, ["h264", "jpeg", "jpeg", "jpeg"], "after H.264 falls back, each JPEG is drawn")
    assert.deepEqual(decoders, ["made", "closed"], "and the decoder of the stream that ended is let go")
    player.push(key(3))
    player.push(poster(3))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(drawn.slice(4), ["h264", "jpeg"], "a restarted stream decodes from its key, and its poster is drawn too")
    assert.equal(player.stats.sequence, 3, "the newest picture decoded is the one the host is told of")
  } finally {
    player.close()
    for (const [name, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

test("the panel watches a screen through the host's watch verb, and a failed decoder rejoins as a new viewer", async () => {
  const asked: SimulatorsWatchInput[] = []
  const live = { done: false }
  const restore = { window: Object.getOwnPropertyDescriptor(globalThis, "window"), document: Object.getOwnPropertyDescriptor(globalThis, "document") }
  const poster = encodeControlVideoBatch({ live: true, packets: [encodeControlVideo({ kind: "poster", width: 1206, height: 2622, sequence: 0, capturedAt: 1, data: jpeg(1206, 2622) })] })
  Object.defineProperty(globalThis, "document", { value: { hidden: false }, configurable: true })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      mako: {
        simulatorsWatch: async (input: SimulatorsWatchInput): Promise<SimulatorsWatchResult> => {
          asked.push(input)
          await new Promise((resolve) => setTimeout(resolve, 5))
          return { live: !live.done, batch: Buffer.from(poster).toString("base64") }
        },
      },
    },
  })
  const pushed: ControlVideoPacket["kind"][] = []
  const ended: boolean[] = []
  const drawn = { decoded: 0, sequence: 0 }
  const watch = watchSimulatorVideo({ id: PHONE, hostId: "local" }, (packet) => pushed.push(decodeControlVideo(packet).kind), () => ({ ...drawn, skipped: 0 }), (isLive) => ended.push(isLive))
  try {
    await until(() => asked.length > 0)
    drawn.decoded = 3
    drawn.sequence = 41
    await until(() => asked.some((input) => input.decoded !== undefined))
    const toldAt = asked.findIndex((input) => input.decoded !== undefined)
    await until(() => asked.length >= toldAt + 2)
    assert.equal(asked[toldAt]?.decoded, 41, "the host is told the newest picture the viewer's decoder drew")
    assert.equal(asked[toldAt + 1]?.decoded, undefined, "and of each only once")
    watch.rejoin()
    const rejoinedAt = asked.length
    await until(() => asked.length >= rejoinedAt + 2)
  } finally {
    watch.stop()
    for (const [name, descriptor] of Object.entries(restore)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
  assert.deepEqual(asked[0], { simulator: PHONE, host: "local", viewer: asked[0]?.viewer })
  const left = asked.at(-1)
  assert.deepEqual(left, { simulator: PHONE, host: "local", viewer: left?.viewer, leave: true }, "a viewer that stops says so, so its screen stops without waiting for it to go idle")
  assert.notEqual(left?.viewer, asked[0]?.viewer, "it asks as a new viewer, which the host starts at its last key frame")
  assert.ok(pushed.length >= 2 && pushed.every((kind) => kind === "poster"))
  assert.ok(ended.every(Boolean))
})

/** A tool's child as `spawn` returns it: it exits when it's killed, or when the test says. */
class FakeChild extends EventEmitter {
  readonly pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.signalCode = signal
    setImmediate(() => this.emit("exit", null, signal))
    return true
  }

  crash(): void {
    this.exitCode = 1
    this.emit("exit", 1, null)
  }
}

function fakeTool(ready: () => Promise<boolean>) {
  const children: FakeChild[] = []
  const stateFile = join(scratch, `tool-${crypto.randomUUID()}.json`)
  const fakeSpawn = () => {
    const child = new FakeChild(70_000 + children.length)
    children.push(child)
    return child
  }
  const tool = new ToolProcess({
    name: "fake-tool",
    entry: "/fake/tool.js",
    args: (port) => ["--port", String(port)],
    env: {},
    ready,
    stateFile,
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
    spawn: fakeSpawn,
  })
  return { tool, children, stateFile }
}

test("a tool stopped while it starts never runs: before its spawn, during its readiness, or in a restart's wait", { timeout: 15_000 }, async () => {
  const early = fakeTool(async () => true)
  const beforeSpawn = early.tool.origin()
  await early.tool.stop()
  await assert.rejects(beforeSpawn, /stopped while it started/)
  assert.equal(early.children.length, 0, "nothing was spawned")
  assert.equal(early.tool.running, false)

  let release: (ready: boolean) => void = () => undefined
  const gate = new Promise<boolean>((resolve) => (release = resolve))
  const readying = fakeTool(() => gate)
  const duringReady = readying.tool.origin()
  await until(() => readying.children.length === 1)
  await readying.tool.stop()
  release(true)
  await assert.rejects(duringReady, /stopped while it started/)
  assert.equal(readying.children[0]?.signalCode, "SIGTERM", "the starting child was killed")
  assert.equal(readying.tool.running, false, "it was never published")
  await assert.rejects(readFile(readying.stateFile, "utf8"), { code: "ENOENT" })
  assert.match(await readying.tool.origin(), /^http:\/\/127\.0\.0\.1:\d+$/, "a later use starts it again")
  assert.equal(readying.children.length, 2)
  await readying.tool.stop()

  const restarting = fakeTool(async () => true)
  await restarting.tool.origin()
  restarting.children[0]?.crash()
  await until(() => !restarting.tool.running)
  await restarting.tool.stop()
  await new Promise((resolve) => setTimeout(resolve, 1_300))
  assert.equal(restarting.children.length, 1, "the restart after its 1 s wait never came")
  assert.equal(restarting.tool.running, false)
})

test("a hub stopped while its folder is prepared never starts its process", async () => {
  const folder = await mkdtemp(join(scratch, "hub-stop-"))
  const hub = new SimulatorHub({
    entry: join(folder, "no-such-entry.js"),
    serveSim: folder,
    inspectWebkit: folder,
    folder,
    run: async () => ({ code: 1, stdout: "", stderr: "" }),
  })
  // The refusal lands while stop is still in flight, so the catch has to be attached before that or Node reports it unhandled.
  const starting = hub.connection().then(
    () => "started",
    (error: Error) => error.message
  )
  await hub.stop()
  assert.match(await starting, /stopped while it started/)
  assert.equal(hub.running, false)
})

test("Safari's pages are found by the simulator their process runs in", async () => {
  assert.deepEqual(parsePs("  1  /sbin/launchd\n"), { ppid: 1, command: "/sbin/launchd" })
  assert.equal(parsePs(""), undefined)
  const tree = new Map([
    ["812", `  790 /Library/Developer/CoreSimulator/Volumes/iOS_23B80/.../MobileSafari.app/MobileSafari`],
    ["790", `  700 launchd_sim /Users/ada/Library/Developer/CoreSimulator/Devices/${PHONE.toLowerCase()}/data/var/run/launchd_bootstrap.plist`],
    ["900", "    1 /usr/libexec/webinspectord"],
  ])
  const run: Run = async (_file, args) => {
    const stdout = tree.get(args.at(-1) ?? "")
    return stdout ? { code: 0, stdout, stderr: "" } : { code: 1, stdout: "", stderr: "" }
  }
  assert.equal(await simulatorOfProcess(run, 812), PHONE)
  assert.equal(await simulatorOfProcess(run, 900), undefined)
  const page = { id: "sim:812:1:2", pid: 812, bundleId: "com.apple.mobilesafari", title: "Mako", url: "https://app.runmako.co/", type: "page", inUse: false }
  assert.deepEqual(safariPages([page, { ...page, id: "sim:812:1:3", type: "service-worker" }, { ...page, id: "sim:813:1:1", pid: 813 }, { ...page, id: "sim:812:2:1", bundleId: "com.example.app" }], new Set([812])), [page])
})

test("a point on the screen as it's shown lands on the raw portrait framebuffer however the device is turned", () => {
  const config = (orientation: ScreenConfig["orientation"]): ScreenConfig => ({ width: 1206, height: 2622, orientation })
  const portrait = { width: 402, height: 874 }
  const sideways = { width: 874, height: 402 }
  assert.deepEqual(rawPoint({ x: 100.5, y: 218.5 }, portrait, config("portrait")), { x: 0.25, y: 0.25 })
  assert.deepEqual(rawPoint({ x: 0, y: 0 }, sideways, config("landscape_left")), { x: 0, y: 1 })
  assert.deepEqual(rawPoint({ x: 0, y: 0 }, sideways, config("landscape_right")), { x: 1, y: 0 })
  assert.deepEqual(rawPoint({ x: 0, y: 0 }, portrait, config("portrait_upside_down")), { x: 1, y: 1 })
  assert.deepEqual(rawPoint({ x: 0, y: 0 }, sideways, { width: 2622, height: 1206, orientation: "landscape_left" }), { x: 0, y: 0 }, "a picture the helper already turned")
  assert.deepEqual(rawPoint({ x: -5, y: 9_000 }, portrait, undefined), { x: 0, y: 1 })
  assert.equal(orientationOf(config("landscape_right")), "landscape-right")
  assert.deepEqual(readScreenConfig(new Uint8Array([0x82, ...new TextEncoder().encode(JSON.stringify(config("portrait")))])), config("portrait"))
  assert.equal(readScreenConfig(new Uint8Array([0x01])), undefined)

  const tap = tapPlan({ x: 0.5, y: 0.5 })
  assert.deepEqual(tap.map((step) => step.afterMs), [0, 60])
  const swipe = swipePlan({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 300)
  assert.equal(swipe.length, 20)
  assert.equal(swipe.at(-1)?.afterMs, 300)
  const said = (step: (typeof swipe)[number]) => z.object({ type: z.string(), x: z.number(), y: z.number() }).parse(JSON.parse(new TextDecoder().decode(step.message.subarray(1))))
  assert.deepEqual([said(swipe[0]!).type, said(swipe.at(-1)!).type], ["begin", "end"])
  assert.equal(said(swipe.at(-1)!).y, 0.2)
})

/** A Mac whose setup line is done, with Mako's iPhone booted and its iPad off. */
const READY: SimulatorSetup = {
  phase: "ready",
  checkedAt: 1,
  mac: "macOS 26.6.2, arm64",
  steps: [
    { id: "xcode", state: "done", xcode: { path: "/Applications/Xcode.app", version: "26.1", build: "17B55" }, developerDir: "/Applications/Xcode.app/Contents/Developer", disk: { freeBytes: 161e9, needBytes: 10e9 } },
    { id: "finish", state: "done", selected: true, license: "done", firstLaunch: "done" },
    { id: "runtime", state: "done", runtime: { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-1", name: "iOS 26.1", version: "26.1", build: "23B80", available: true }, wanted: "26.1" },
    {
      id: "simulators",
      state: "done",
      simulators: [
        { form: "phone", name: "Mako iPhone 17 Pro", type: "iPhone-17-Pro", udid: PHONE, runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-1", state: "booted" },
        { form: "tablet", name: "Mako iPad Pro 13-inch (M5)", type: "iPad-Pro-13", udid: TABLET, runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-1", state: "shutdown" },
      ],
    },
    { id: "tools", state: "done", tools: [] },
    { id: "agents", state: "done", projects: [{ folder: "/Users/ada/shop", allowed: true, at: 1 }, { folder: "/Users/ada/bank", allowed: false, at: 2 }] },
  ],
}

/** What a fake hub and simctl did, in order. */
function fakeDriving(config: ScreenConfig = { width: 1206, height: 2622, orientation: "portrait" }) {
  const done: string[] = []
  const sent: Array<{ type?: string; x?: number; y?: number; button?: string }> = []
  const input: LocalInput = {
    config,
    open: true,
    ready: async () => undefined,
    close: () => void done.push("input closed"),
    send: (message) => void sent.push(JSON.parse(new TextDecoder().decode(message.subarray(1)))),
  }
  const hub: HubConnection = { origin: "http://127.0.0.1:20683", headers: { [HUB_TOKEN_HEADER]: "t" } }
  const driving: LocalDriving = {
    simctl: {
      boot: async (udid) => void done.push(`boot ${udid}`),
      openUrl: async (udid, url) => void done.push(`open ${udid} ${url}`),
      screenshot: async (_udid, path) => {
        const png = Buffer.alloc(24)
        png.writeUInt32BE(1206, 16)
        png.writeUInt32BE(2622, 20)
        await writeFile(path, png)
      },
      record: async (_udid, path) => ({ path, stop: async () => void done.push("recording stopped") }),
      screens: async () => new Map([["iPhone-17-Pro", { width: 1206, height: 2622, scale: 3 }]]),
    },
    hub: {
      connection: async () => hub,
      accessibility: async () => ({ elements: [] }),
      config: async () => config,
      open: async (_udid, route) => {
        done.push(`prime ${route}`)
        return (async function* () {
          yield new Uint8Array([1])
        })()
      },
      stop: async () => void done.push("hub stopped"),
      running: true,
    },
    inspector: {
      page: async () => ({ inspector: { target: "Mako", bootstrap: true }, page: {} }),
      console: async () => ({ entries: [], cursor: 0 }),
      evaluate: async (_udid, expression) => (done.push(expression.includes("querySelector") ? "focus field" : `evaluate ${expression.slice(0, 22)}`), expression.includes("querySelector") ? true : null),
      forget: (udid) => void done.push(`inspector forgot ${udid.slice(0, 4)}`),
      close: () => void done.push("inspector closed"),
    },
    capture: (udid, sink) => {
      done.push(`capture ${udid.slice(0, 4)}`)
      return {
        keyFrame: () => undefined,
        resize: () => undefined,
        stop: async () => void done.push(`capture stopped ${udid.slice(0, 4)}`),
        end: (reason) => sink.ended(reason),
      }
    },
    input: () => input,
  }
  return { driving, done, sent }
}

test("a device type's screen is read from its profile, or from its capabilities on Xcode 27, whose profile has none", async () => {
  const bundles = { old: "/Profiles/iPhone 17 Pro.simdevicetype", new: "/Profiles/iPhone 18 Pro.simdevicetype" }
  const plists = new Map<string, string>([
    [`${bundles.old}/Contents/Resources/profile.plist`, JSON.stringify({ mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 })],
    [`${bundles.new}/Contents/Resources/profile.plist`, JSON.stringify({ modelIdentifier: "iPhone19,2", supportedFeatures: {} })],
    [`${bundles.new}/Contents/Resources/capabilities.plist`, JSON.stringify({
      capabilities: { ScreenDimensionsCapability: { "main-screen-width": 1206, "main-screen-height": 2622, "main-screen-scale": 3, "main-screen-pitch": 460 } },
    })],
  ])
  const run: Run = async (file, args) => {
    if (file === "/usr/bin/xcrun")
      return { code: 0, stderr: "", stdout: JSON.stringify({ devicetypes: [{ identifier: "iPhone-17-Pro", bundlePath: bundles.old }, { identifier: "iPhone-18-Pro", bundlePath: bundles.new }] }) }
    const plist = plists.get(args.at(-1) ?? "")
    return plist === undefined ? { code: 1, stdout: "", stderr: "no such file" } : { code: 0, stdout: plist, stderr: "" }
  }
  const screens = await new Simctl({ run, developerDir: "/Applications/Xcode.app/Contents/Developer" }).screens(["iPhone-17-Pro", "iPhone-18-Pro"])
  assert.deepEqual(Object.fromEntries(screens), { "iPhone-17-Pro": { width: 1206, height: 2622, scale: 3 }, "iPhone-18-Pro": { width: 1206, height: 2622, scale: 3 } })
})

test("on a Mac left on the Command Line Tools, the host drives the simulators through Xcode's own folder", async () => {
  const onTools: SimulatorSetup = {
    ...READY,
    steps: READY.steps.map((step) =>
      step.id === "xcode" ? { ...step, developerDir: "/Library/Developer/CommandLineTools" } : step.id === "finish" ? { ...step, selected: false } : step
    ),
  }
  const folders: string[] = []
  const { driving } = fakeDriving()
  const host = new LocalSimulatorHost({ setup: async () => onTools, folder: scratch, driving: (developerDir) => (folders.push(developerDir), driving) })
  await host.boot(TABLET)
  assert.deepEqual(folders, ["/Applications/Xcode.app/Contents/Developer"])
  await host.close()
})

test("the host drives a booted simulator through its tools: touches land on the raw framebuffer, gestures play in time", async () => {
  const { driving, done, sent } = fakeDriving({ width: 1206, height: 2622, orientation: "landscape_left" })
  const slept: number[] = []
  const host = new LocalSimulatorHost({ setup: async () => READY, folder: scratch, driving: () => driving, sleep: async (ms) => void slept.push(ms), now: () => 42 })
  const listed = await host.list()
  assert.deepEqual(listed.map((simulator) => [simulator.id, simulator.state, simulator.orientation]), [[PHONE, "booted", "landscape-left"], [TABLET, "shutdown", undefined]])
  assert.deepEqual(listed[0]?.screen, { width: 402, height: 874, scale: 3 })
  assert.equal((await host.summary()).platforms.ios.ready, true)

  // Turned to the left, the shown screen is 874 wide: its top left is the framebuffer's bottom left.
  await host.act(PHONE, { kind: "touch", phase: "begin", at: { x: 0, y: 0 } })
  assert.deepEqual(sent.shift(), { type: "begin", x: 0, y: 1 })
  assert.ok(done.includes("prime stream.mjpeg"), "the capture runs before the first touch")
  await host.act(PHONE, { kind: "tap", at: { x: 437, y: 201 } })
  assert.deepEqual(sent.splice(0).map((message) => message.type), ["begin", "end"])
  assert.deepEqual(slept.splice(0), [60])
  await host.act(PHONE, { kind: "home" })
  assert.deepEqual(sent.splice(0), [{ button: "home" }])
  await assert.rejects(host.act(PHONE, { kind: "type", text: "héllo ✓" }), SimulatorUnsupported)
  await host.act(PHONE, { kind: "keyboard", shown: false })
  assert.ok(done.some((line) => line.startsWith("evaluate document.activeElement")))
  await host.act(PHONE, { kind: "open-url", url: "https://app.runmako.co" })
  assert.ok(done.includes(`open ${PHONE} https://app.runmako.co`))

  const shot = await host.screenshot(PHONE)
  assert.deepEqual(shot, { path: join(scratch, "shots", `${PHONE}-42.png`), width: 1206, height: 2622 })
  assert.deepEqual(await host.record(PHONE, "start"), {})
  assert.deepEqual(await host.record(PHONE, "stop"), { path: join(scratch, "recordings", `${PHONE}-42.mp4`) })
  const ended: string[] = []
  const sink = { packet: () => undefined, ended: (reason: string) => void ended.push(reason) }
  await assert.rejects(host.frames(TABLET, sink), SimulatorUnsupported, "an iPad that's off streams nothing")
  const screen = await host.frames(PHONE, sink)
  assert.ok(done.includes(`capture ${PHONE.slice(0, 4)}`))
  await screen.stop()
  assert.ok(done.includes(`capture stopped ${PHONE.slice(0, 4)}`))
  await host.frames(PHONE, sink)

  await host.close()
  for (const line of ["hub stopped", "inspector closed"]) assert.ok(done.includes(line), line)
  assert.deepEqual(ended, ["Mako's host is stopping."], "a capture still running ends with the host, and its viewers are told why")
})

test("the keyboard focuses the page's own field when the accessibility tree has none", async () => {
  const { driving, done } = fakeDriving()
  const host = new LocalSimulatorHost({ setup: async () => READY, folder: scratch, driving: () => driving })
  await host.act(PHONE, { kind: "keyboard", shown: true })
  assert.ok(done.includes("focus field"))
  await host.close()
})

test("agents are offered the simulator tools only where this Mac can run one and the person said yes", async () => {
  // Each Session works in the folder it's named for; `worktree` in a worktree of the shop.
  const folders = new Map([
    ["shop", { folder: "/Users/ada/shop/packages/web" }],
    ["worktree", { folder: "/Users/ada/.mako/worktrees/fix-scroll/shop", project: "/Users/ada/shop" }],
    ["bank", { folder: "/Users/ada/bank" }],
    ["elsewhere", { folder: "/Users/ada/elsewhere" }],
    ["shopping", { folder: "/Users/ada/shopping" }],
  ])
  const tools = new SimulatorTools((session) => {
    const found = folders.get(session)
    return found && { thread: `t-${session}`, session, ...found }
  })
  const asked: unknown[][] = []
  const offered = async (session: string) => {
    const server = new McpServer({ name: "mako", version: "1.0.0" })
    tools.register(server, {
      invoke: async (_channel, args) => (asked.push(args), { hosts: [], simulators: [], consent: "allowed" }),
      caller: () => ({ kind: "agent", session }),
    })
    const [toServer, toClient] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "agent", version: "1.0.0" })
    await server.connect(toServer)
    await client.connect(toClient)
    // A server with no tools has no tools/list at all.
    const listed = await client.listTools().then((answer) => answer.tools, () => [])
    return { client, listed, close: () => Promise.all([client.close(), server.close()]) }
  }
  const names = async (session: string) => {
    const { listed, close } = await offered(session)
    await close()
    return listed.map((tool) => tool.name)
  }

  assert.deepEqual(await names("shop"), [], "nothing before the setup line is read")
  tools.heard({ ...READY, steps: READY.steps.map((step) => (step.id === "tools" ? { id: "tools", state: "yours", fix: "install-tools", tools: [] } : step)) })
  assert.deepEqual(await names("shop"), [], "nothing while the tools aren't installed")
  tools.heard(READY)
  assert.deepEqual(await names("bank"), [], "a project the person said no to")
  assert.deepEqual(await names("elsewhere"), [], "a project never asked about")
  assert.deepEqual(await names("shopping"), [], "a sibling folder whose name only starts the same")
  assert.deepEqual(await names("nobody"), [], "a Session no Thread holds")
  assert.ok((await names("worktree")).includes("simulator_open"), "a worktree of an allowed project")

  // Claude's in-process server is built as its agent launches, when naming the caller throws: no turn is active yet.
  const launching = async () => {
    const server = new McpServer({ name: "mako", version: "1.0.0" })
    tools.register(server, {
      invoke: async () => ({ hosts: [], simulators: [], consent: "allowed" }),
      caller: () => {
        throw new Error("This provider no longer owns an active turn in this conversation")
      },
    })
    const [toServer, toClient] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "agent", version: "1.0.0" })
    await server.connect(toServer)
    await client.connect(toClient)
    const listed = await client.listTools().then((answer) => answer.tools.map((tool) => tool.name), (): string[] => [])
    await Promise.all([client.close(), server.close()])
    return listed
  }
  assert.ok((await launching()).includes("simulator_open"), "a launching agent's server is built, its calls decided by consent")
  tools.heard({ ...READY, steps: READY.steps.map((step) => (step.id === "tools" ? { id: "tools", state: "yours", fix: "install-tools", tools: [] } : step)) })
  assert.deepEqual(await launching(), [], "and offers nothing where this Mac can't run one, without asking who calls")
  tools.heard(READY)

  const { client, listed, close } = await offered("shop")
  try {
    const shown = listed.map((tool) => tool.name)
    for (const name of ["simulator_list", "simulator_open", "simulator_act", "simulator_read", "simulator_shot"]) assert.ok(shown.includes(name), `${name} in ${shown.join(", ")}`)
    const act = listed.find((tool) => tool.name === "simulator_act")
    assert.ok(act?.inputSchema.properties && "action" in act.inputSchema.properties, "the act tool says its action's shape")
    const answer = await client.callTool({ name: "simulator_list", arguments: {} })
    assert.deepEqual(asked, [[{ kind: "agent", session: "shop" }]])
    assert.match(JSON.stringify(answer.content), /consent/)
  } finally {
    await close()
  }
})

test("the panel turns a portrait capture upright and folds a drag's moves while one is on its way", async () => {
  assert.deepEqual(shownScreen({ width: 402, height: 874 }, "landscape-left"), { width: 874, height: 402 })
  assert.deepEqual(shownScreen({ width: 402, height: 874 }, "portrait"), { width: 402, height: 874 })
  assert.deepEqual(shownScreen({ width: 402, height: 874 }, undefined), { width: 402, height: 874 })
  assert.equal(pictureTurn({ width: 1206, height: 2622 }, "landscape-left"), 90)
  assert.equal(pictureTurn({ width: 1206, height: 2622 }, "landscape-right"), -90)
  assert.equal(pictureTurn({ width: 1206, height: 2622 }, "portrait-upside-down"), 180)
  assert.equal(pictureTurn({ width: 2622, height: 1206 }, "landscape-left"), 0)

  const sent: string[] = []
  let release: () => void = () => undefined
  const touches = new TouchStream(async (phase, at) => {
    sent.push(`${phase} ${at.x},${at.y}`)
    if (phase === "begin") await new Promise<void>((resolve) => (release = resolve))
  })
  touches.begin({ x: 1, y: 1 })
  for (let y = 2; y < 30; y++) touches.move({ x: 1, y })
  await Promise.resolve()
  release()
  await touches.settled()
  touches.end({ x: 1, y: 40 })
  await touches.settled()
  assert.deepEqual(sent, ["begin 1,1", "move 1,29", "end 1,40"])
})
