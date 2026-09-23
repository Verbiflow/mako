import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
import { BrowserCapture } from "../packages/control-runtime/src/browser-capture.js"
import { BrowserRecordings } from "../packages/control-runtime/src/browser-recording.js"
import type { BrowserConnection } from "../packages/control-runtime/src/browser-connection.js"
const directory = await mkdtemp(join(tmpdir(), "browser-recording-lifecycle-"))
const target = {
  browser: "fixture",
  tab: "tab",
  generation: "one",
  lease: "lease",
}
const jpeg = (
  await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#38444a" },
  })
    .jpeg()
    .toBuffer()
).toString("base64")
type Connection = Pick<
  BrowserConnection,
  "send" | "onEvent" | "onInput" | "onClose"
>
function fixture(failStop = false, gate?: Promise<void>, frames = true) {
  const calls: string[] = []
  let event: Parameters<Connection["onEvent"]>[0] = () => {}
  const connection: Connection = {
    onEvent(fn) {
      event = fn
      return () => {
        event = () => {}
      }
    },
    onInput() {
      return () => {}
    },
    onClose() {
      return () => {}
    },
    async send(method) {
      calls.push(method)
      if (method === "Page.startScreencast" && frames) {
        event({
          method: "Page.screencastFrame",
          sessionId: "session",
          params: {
            sessionId: 1,
            data: jpeg,
            metadata: {
              deviceWidth: 640,
              deviceHeight: 480,
              pageScaleFactor: 1,
              offsetTop: 0,
              timestamp: Date.now() / 1000,
            },
          },
        })
        await gate
      }
      if (method === "Page.stopScreencast" && failStop)
        throw new Error("Injected stop failure")
      if (method === "Target.detachFromTarget")
        event({ method, params: { sessionId: "session" } })
      return {}
    },
  }
  return { connection, calls }
}
for (const failStop of [false, true]) {
  const manager = new BrowserRecordings(),
    source = fixture(failStop)
  const started = await manager.start(
    "owner",
    target,
    source.connection,
    "session",
    { directory },
    new AbortController().signal,
    new BrowserCapture(source.connection, "session")
  )
  assert.throws(
    () => manager.get("intruder", target, started.id),
    /does not belong/
  )
  for (
    let i = 0;
    i < 30 && !manager.get("owner", target, started.id).receipt().frames;
    i++
  )
    await delay(10)
  const recording = manager.get("owner", target, started.id)
  await recording.stop()
  const result = await recording.settled()
  assert.equal(
    result.status,
    failStop ? "interrupted" : "finished",
    result.error
  )
  assert.equal(
    source.calls.filter((c) => c === "Target.detachFromTarget").length,
    failStop ? 1 : 0
  )
  assert.ok(result.video)
}
{
  const manager = new BrowserRecordings(),
    source = fixture()
  const starting = manager.start(
    "owner",
    target,
    source.connection,
    "session",
    { directory },
    new AbortController().signal,
    new BrowserCapture(source.connection, "session")
  )
  manager.stopOwner("owner")
  await assert.rejects(starting, /lease ended/)
  assert.ok(
    !source.calls.includes("Page.startScreencast"),
    "ended task cannot start capture after async preflight"
  )
}
{
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const manager = new BrowserRecordings(),
    source = fixture(false, gate)
  const starting = manager.start(
    "owner",
    target,
    source.connection,
    "session",
    { directory },
    new AbortController().signal,
    new BrowserCapture(source.connection, "session")
  )
  for (
    let i = 0;
    i < 200 && !source.calls.includes("Page.startScreencast");
    i++
  )
    await delay(10)
  manager.stopOwner("owner")
  release()
  await assert.rejects(starting, /ended during startup/)
  assert.equal(
    source.calls.at(-1),
    "Page.stopScreencast",
    "late successful startup is stopped again"
  )
}
console.log(
  "Browser recording: owner isolation, early/late teardown and exact-attachment cleanup after stop failure passed"
)

{
  const manager = new BrowserRecordings(), source = fixture(false, undefined, false)
  await assert.rejects(manager.start("owner", target, source.connection, "session", { directory }, new AbortController().signal, new BrowserCapture(source.connection, "session")), /no video frames within five seconds/)
  assert.equal(source.calls.filter(c => c === "Page.stopScreencast").length, 1)
  assert.ok(!source.calls.some(c => c === "Page.bringToFront" || c === "Target.activateTarget"))
  console.log("Browser recording: no-frame startup refuses without activation or retargeting")
}
