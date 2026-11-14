// One Cursor child's transcript write, as its own process: the patched SDK's
// writer on the real file system with the child's lock installed. Its write
// puts half its bytes on disk and tells its parent, then either waits for
// `go` on stdin to write the rest (a slow writer) or hangs for a SIGKILL.
// `repair` is a child opening the agent instead: it repairs `file`'s folder
// and prints what it cut, or what it left.
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs"
import * as promises from "node:fs/promises"
import { repairCursorTranscripts, transcriptLock } from "@mako/host/harnesses/cursor/sdk/transcript-tails"
import { CURSOR_TRANSCRIPT_LOCK } from "@mako/host/harnesses/cursor/sdk/transcript-lock"
import { loadWriters, rowsOf, jsonl, type Build } from "./cursor-transcript-writers.js"

interface Case {
  build: Build
  mode: "append" | "rewrite" | "repair"
  file: string
  from: number
  count: number
  tag: string
  /** Which write stops halfway, from 0; -1 for none. */
  stall: number
  finish: boolean
  /** Without the child's lock, as the unpatched SDK writes. */
  unlocked?: boolean
  /** For `repair`: how long it waits for a writer. */
  waitMs?: number
}
// SAFETY: the test that spawns this worker serialises a `Case` into CASE.
const job = JSON.parse(process.env.CASE ?? "null") as Case
if (!job.unlocked) Object.assign(globalThis, { [CURSOR_TRANSCRIPT_LOCK]: transcriptLock })

if (job.mode === "repair") {
  const outcome = await repairCursorTranscripts(job.file, { waitMs: job.waitMs ?? 10_000 }).then((cut) => ({ cut }), (error: Error) => ({ left: error.message }))
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
  process.exit(0)
}

let writes = 0
let go: () => void = () => undefined
const proceed = new Promise<void>((resolve) => { go = resolve })
process.stdin.on("data", () => go())

async function halfThenStop(fd: number, data: string): Promise<void> {
  const bytes = Buffer.from(data)
  const half = bytes.length >> 1
  writeSync(fd, bytes, 0, half)
  fsyncSync(fd)
  process.stdout.write("stalled\n")
  if (!job.finish) {
    setInterval(() => undefined, 1e9)
    return new Promise(() => undefined)
  }
  await proceed
  writeSync(fd, bytes, half, bytes.length - half)
  closeSync(fd)
}

const fs = {
  ...promises,
  async open(name: string, flags: string) {
    const handle = await promises.open(name, flags)
    if (flags !== "w") return handle
    return {
      fd: handle.fd,
      writeFile: async (data: string, encoding: BufferEncoding) => (writes++ === job.stall ? halfThenStop(handle.fd, data) : handle.writeFile(data, encoding)),
      sync: () => handle.sync(),
      close: () => handle.close(),
    }
  },
  async writeFile(name: string, data: string, options?: { flag?: string }) {
    if (writes++ === job.stall) return halfThenStop(openSync(name, options?.flag ?? "w"), data)
    return promises.writeFile(name, data, options)
  },
}

const writers = loadWriters(job.build, fs)
const rows = rowsOf(job.from, job.count, job.tag)
try {
  if (job.mode === "append") await writers.appendFile(job.file, jsonl(rows))
  else await writers.rewrite(job.file, rows)
  process.stdout.write(`done ${writes}\n`)
  process.exit(0)
} catch (cause) {
  console.error(cause)
  process.exit(1)
}
