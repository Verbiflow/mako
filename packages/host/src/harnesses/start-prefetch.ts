import { open, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { environmentForExecutable } from "../base/executable.js"
import { spawnProviderProcess } from "./provider-process.js"

/**
 * What a start runs first, run ahead: a cloud machine does it as it boots, for the harness its Thread was made for,
 * so the start finds in memory what it would read from disk. Two halves, run together: the files the start reads,
 * read whole by several readers at once (a copy's disk serves them several times faster than one process faulting
 * them in), and the start's own first steps, run to their first answers and stopped. Measured on fresh copies, a
 * harness's run ahead took 0.6–1.0 s with its files read alongside, 0.9–2.9 s without, and the start after it 0.04–0.3 s
 * (2026-10-20). Both run before any sign-in; what a start asks its service once signed in is `signedIn`, run when the
 * machine's sign-in for the harness is installed.
 */
export interface StartPrefetch {
  via: string
  /** The files the start reads from disk: its binary, or the packages its SDK loads. A folder is read whole. */
  files(env: NodeJS.ProcessEnv): Promise<string[]>
  /** The start's first steps, run to their first answers and stopped; resolves whether they answered. Never throws. */
  run(env: NodeJS.ProcessEnv, cwd: string, owner: string): Promise<boolean>
  /**
   * What the start asks its harness's service first, asked as soon as the machine's sign-in for it is installed,
   * and kept where the start finds it (Cursor's model list, kept an hour per credential). Without it,
   * the start asks nothing a read ahead could.
   */
  signedIn?(env: NodeJS.ProcessEnv): Promise<void>
  /**
   * Stops what `run` keeps for `signedIn` (Cursor's child, its SDK loaded), for when no sign-in will come. Without
   * it, `signedIn` or a time limit stops it.
   */
  release?(): void
}

/** A harness's own process as its start spawns it. */
export interface PrefetchLaunch {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  /** What its start writes first, in order: each written once the one before is answered. None: its first output. */
  exchange?: readonly PrefetchStep[]
}

export interface PrefetchStep {
  /** One or more lines, written as they are. */
  send: string
  /** What a line the process wrote, parsed as JSON, matches when it answers this step. */
  answer: z.ZodType
}

/** A JSON-RPC answer to request `id`. */
export const answersId = (id: number) => z.object({ id: z.literal(id) }).loose()

export interface PrefetchOutcome {
  answered: boolean
  ms: number
  /** The files read alongside: how much, and how long it took. */
  readMiB: number
  readMs: number
}

/** Long enough for a cold harness on a slow copy; a start that comes meanwhile isn't held by it. */
const PREFETCH_MS = 20_000
/** A stopped process that hasn't gone by then is killed. */
const STOP_MS = 2_000
/** The longest line read for an answer. */
const LINE_CHARS = 1 << 20
/** Readers at once; past eight a copy's disk read no faster (230 MiB in 0.77 s with 8, 0.92 s with 32, 5.1 s with 1). */
const READERS = 8
/** Each file is split into slices of this much, shared out among the readers. */
const SLICE_BYTES = 8 << 20

/** Both halves of `prefetch`, together. Never throws. `run` may keep its process for `signedIn` (`release`). */
export async function runPrefetch(prefetch: StartPrefetch, env: NodeJS.ProcessEnv, cwd: string, owner: string): Promise<PrefetchOutcome> {
  const began = performance.now()
  const [read, answered] = await Promise.all([
    prefetch.files({ ...env }).then(readAlongside, () => ({ bytes: 0, ms: 0 })),
    prefetch.run({ ...env }, cwd, owner).catch(() => false),
  ])
  return { answered, ms: Math.round(performance.now() - began), readMiB: Math.round(read.bytes / 1_048_576), readMs: read.ms }
}

/** Reads `paths` whole, a file or a folder and everything in it, by `READERS` readers at once, keeping nothing. */
export async function readAlongside(paths: readonly string[]): Promise<{ bytes: number; ms: number }> {
  const began = performance.now()
  const files: string[] = []
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined)
    if (info?.isDirectory())
      for (const entry of await readdir(path, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) files.push(join(entry.parentPath, entry.name))
      }
    else if (info) files.push(path)
  }
  const slices: Array<{ file: string; from: number; to: number }> = []
  for (const file of files) {
    const size = (await stat(file).catch(() => undefined))?.size ?? 0
    for (let from = 0; from < size; from += SLICE_BYTES) slices.push({ file, from, to: Math.min(size, from + SLICE_BYTES) })
  }
  let bytes = 0
  await Promise.all(Array.from({ length: READERS }, async () => {
    const buffer = Buffer.allocUnsafe(1 << 20)
    for (let slice = slices.shift(); slice; slice = slices.shift()) {
      const handle = await open(slice.file, "r").catch(() => undefined)
      if (!handle) continue
      try {
        for (let at = slice.from; at < slice.to;) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, slice.to - at), at)
          if (bytesRead === 0) break
          at += bytesRead
          bytes += bytesRead
        }
      } finally {
        await handle.close()
      }
    }
  }))
  return { bytes, ms: Math.round(performance.now() - began) }
}

/**
 * Runs `launch` through its exchange, each step written once the one before is answered, until the last is
 * answered, it exits or `timeoutMs` passes; then stops it and its process group. Resolves whether it answered all.
 */
export function prefetchProcess(launch: PrefetchLaunch | undefined, cwd: string, owner: string, timeoutMs = PREFETCH_MS): Promise<boolean> {
  if (!launch) return Promise.resolve(false)
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProviderProcess>
    try {
      child = spawnProviderProcess(launch.command, launch.args, { cwd, env: environmentForExecutable(launch.command, launch.env) }, { kind: "prefetch", owner })
    } catch {
      return resolve(false)
    }
    const steps = launch.exchange ?? []
    let step = 0
    let settled = false
    const settle = (answered: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(answered)
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill("SIGTERM")
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, STOP_MS).unref()
    }
    const write = () => {
      const next = steps[step]
      if (next) child.stdin.write(`${next.send}\n`)
    }
    const timer = setTimeout(() => settle(false), timeoutMs)
    timer.unref()
    let pending = ""
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return
      if (steps.length === 0) return settle(true)
      pending += chunk.toString("utf8")
      // A line past this isn't an answer to anything a start writes first.
      if (pending.length > LINE_CHARS) pending = pending.slice(pending.lastIndexOf("\n") + 1).slice(-LINE_CHARS)
      for (let end = pending.indexOf("\n"); end >= 0 && !settled; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (!answers(steps[step]!, line)) continue
        step += 1
        if (step === steps.length) return settle(true)
        write()
      }
    })
    child.once("error", () => settle(false))
    child.once("exit", () => settle(false))
    child.stderr.resume()
    child.stdin.on("error", () => undefined)
    write()
  })
}

function answers(step: PrefetchStep, line: string): boolean {
  try {
    return step.answer.safeParse(JSON.parse(line)).success
  } catch {
    return false
  }
}
