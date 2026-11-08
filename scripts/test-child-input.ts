import assert from "node:assert/strict"
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import { ChildInputClosedError, childInput, endChildInput, sendToChild, writeChildInput } from "@mako/sessions/child-input"
import { acpWritable } from "@mako/host/harnesses/acp-stream"
import { CursorSdkClient, CursorSdkDisconnectedError } from "@mako/host/harnesses/cursor/sdk/client"
import { SleepHandOff } from "@mako/host/conversations/sleep-handoff"

/**
 * A child gone as the host writes to it, for each kind of writer the host has: a request line awaiting its answer
 * (the Cursor SDK's client), a line nothing waits on (the sleep watch's answer), an ACP stream, one input ended at
 * once (a command's, keychain's), and an IPC message. Each child closes its input, and the host writes after: the
 * write fails with EPIPE (a closed channel, for IPC), which must fail only that write's own caller. An `'error'`
 * nobody heard reaches `uncaughtException` here, which would have ended a host; every case fails on one.
 *
 * Nothing here waits on a clock: each case waits for the child to say its input is closed, then for the write's
 * failure to have been reported (the stream's `close`, a rejected request), then a turn of the event loop for an
 * `'error'` the stream emits after its callback.
 */

const unheard: string[] = []
process.on("uncaughtException", (error) => {
  unheard.push(`${error.name}: ${error.message}`)
  console.error("uncaught:", error)
  process.exitCode = 1
})
const scratch = mkdtempSync(join(tmpdir(), "mako-child-input-"))
const children = new Set<ChildProcess>()
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
/** The stream's `close`. Not `events.once`, which listens for `'error'` too, and would hear what the host must. */
const closeOf = (stream: NodeJS.EventEmitter) => new Promise<void>((resolve) => stream.once("close", () => resolve()))

/**
 * A child that closes its stdin, says so on stdout, and stays until it's killed. It closes the descriptor itself:
 * `process.stdin.destroy()` leaves it open, and a write to a pipe still open lands in its buffer and fails nothing.
 */
const CLOSES_INPUT = `require("node:fs").closeSync(0); process.stdout.write("closed\\n"); setInterval(() => {}, 60_000)`

function closedInput(): ChildProcessByStdio<Writable, Readable, null> {
  const child = spawn(process.execPath, ["-e", CLOSES_INPUT], { stdio: ["pipe", "pipe", "inherit"] })
  children.add(child)
  return child
}

async function said(child: { stdout: Readable }, word: string): Promise<void> {
  let heard = ""
  for await (const chunk of child.stdout) {
    heard += String(chunk)
    if (heard.includes(word)) return
  }
  throw new Error(`the child ended before it said ${word}`)
}

function heardNone(kind: string): void {
  assert.deepEqual(unheard.splice(0), [], `${kind}: a write to a child gone as it was written reached uncaughtException`)
}

const cases = [
  // A request line awaiting its answer: the Cursor SDK's client. Its child answers the first request, closing its input
  // as it does, so the second is written to a pipe nobody reads.
  async () => {
    const entry = join(scratch, "cursor-child.mjs")
    writeFileSync(entry, `
      import { closeSync, readSync } from "node:fs"
      const buffer = Buffer.alloc(65_536)
      let read = ""
      while (!read.includes("\\n")) {
        const bytes = readSync(0, buffer)
        if (bytes === 0) process.exit(0)
        read += buffer.toString("utf8", 0, bytes)
      }
      closeSync(0)
      const { id } = JSON.parse(read.slice(0, read.indexOf("\\n")))
      process.stdout.write(JSON.stringify({ id, ok: true, result: { wire: 0, sdkVersion: "0", node: process.version } }) + "\\n")
      setInterval(() => {}, 60_000)
    `)
    const client = new CursorSdkClient({ owner: "test-child-input", cwd: scratch, env: { PATH: process.env.PATH }, onEvent: () => {}, entry, execPath: process.execPath })
    await client.request("hello", undefined)
    await assert.rejects(client.request("hello", undefined), CursorSdkDisconnectedError, "the request written to a gone child fails as a disconnect")
    await turn()
    heardNone("the Cursor SDK's request")
    client.kill()
    await client.exited
    console.log("ok: a request written to a Cursor SDK child that closed its input fails that request alone")
  },
  // A line nothing waits on: the sleep watch's `allow`, written once the handoff is done.
  async () => {
    const child = spawn(process.execPath, ["-e", `require("node:fs").closeSync(0); process.stdout.write("will-sleep 7\\n"); setInterval(() => {}, 60_000)`], { stdio: ["pipe", "pipe", "pipe"] })
    children.add(child)
    let handedOff!: () => void
    const handed = new Promise<void>((resolve) => { handedOff = resolve })
    const watch = new SleepHandOff({
      helper: async () => process.execPath,
      enabled: async () => true,
      handOff: async () => handedOff(),
      woke: () => {},
      spawn: () => child,
    })
    const closed = closeOf(child.stdin)
    await watch.refresh()
    await handed
    await closed
    await turn()
    heardNone("the sleep watch's answer")
    watch.stop()
    console.log("ok: the sleep watch's answer to a helper that closed its input is dropped quietly")
  },
  // An ACP stream, as every ACP driver opens one.
  async () => {
    const child = closedInput()
    await said(child, "closed")
    const writer = acpWritable(childInput(child)).getWriter()
    await assert.rejects(writer.write(new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`)))
    await turn()
    heardNone("an ACP stream")
    console.log("ok: an ACP stream to a child that closed its input fails its write")
  },
  // One input ended at once, as a command, the keychain or a discovery takes it; a megabyte, so it can't all buffer.
  async () => {
    const child = closedInput()
    await said(child, "closed")
    const closed = closeOf(child.stdin)
    endChildInput(child, Buffer.alloc(1 << 20, 0x61))
    await closed
    await turn()
    heardNone("an input ended at once")
    await assert.rejects(writeChildInput(child, "after\n"), ChildInputClosedError, "a write after the input is gone fails at once")
    console.log("ok: an input ended at once on a child that closed it is dropped quietly, and a write after it fails")
  },
  // A line written and awaited, the helper's own.
  async () => {
    const child = closedInput()
    await said(child, "closed")
    await assert.rejects(writeChildInput(child, Buffer.alloc(1 << 20, 0x61)), ChildInputClosedError)
    await turn()
    heardNone("an awaited write")
    console.log("ok: an awaited write to a child that closed its input rejects with ChildInputClosedError")
  },
  // An IPC message, as the watcher and the sessions daemon's decode send theirs, to a child that closed its channel.
  async () => {
    const child = spawn(process.execPath, ["-e", `process.disconnect(); setInterval(() => {}, 60_000)`], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
    children.add(child)
    await once(child, "disconnect")
    await assert.rejects(sendToChild(child, { t: "probe", id: 1 }), ChildInputClosedError, "a send on a closed channel fails that send")
    await turn()
    heardNone("an IPC message")
    console.log("ok: an IPC message to a child that closed its channel rejects with ChildInputClosedError")
  },
]

const failures: string[] = []
try {
  for (const run of cases) await run().catch((error: Error) => failures.push(error.message))
} finally {
  for (const child of children) child.kill("SIGKILL")
  rmSync(scratch, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`${failures.length} of ${cases.length} cases failed:\n${failures.map((failure) => `  ${failure}`).join("\n")}`)
  process.exit(1)
}
