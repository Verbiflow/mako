import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { HOST_NODE_OPTIONS } from "@mako/host/base/process-warnings"
import { probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"

/**
 * The host a benchmark measures (`npm run bench:vs-bare`, `npm run bench:actions`): this checkout's built
 * `mako-host` on a data root of the bench's own, with the probe loaded into it (`bench-vs-bare-probe.mjs`), which
 * writes one line for each thing the host says on its diagnostics topics to a pipe this process reads. Every line is
 * stamped on the machine's monotonic clock, which this process shares (`benchNow`), so the host's marks, a window's
 * and a scripted model's order against each other. The bench that starts a host stops it.
 */

/** Milliseconds on the machine's monotonic clock, which the host's probe and every child share. */
export const benchNow = (): number => Number(process.hrtime.bigint() / 1000n) / 1000

/** One line the probe wrote: when (`t`), what (`s`), and what each kind carries. */
export const ProbeLine = z.object({
  t: z.number(), s: z.string(), c: z.string().optional(), q: z.string().optional(), r: z.number().optional(),
  kind: z.string().optional(), evidence: z.string().optional(), client: z.string().optional(), bytes: z.number().optional(),
  u: z.array(z.tuple([z.string(), z.string().nullable(), z.number(), z.number()])).optional(),
  scope: z.string().optional(), message: z.string().optional(), status: z.string().optional(), connection: z.string().optional(),
  fields: z.record(z.string(), z.json()).optional(),
  // A step (`mako:live-step`), a call's answer and a session's mode, which `bench:actions` reads.
  channel: z.string().optional(), step: z.string().optional(), phase: z.string().optional(), detail: z.string().optional(),
  mode: z.string().nullable().optional(), refused: z.boolean().optional(),
}).loose()
export type ProbeLine = z.infer<typeof ProbeLine>

export interface BenchHost {
  child: ChildProcess
  socket: string
  /** Every line the probe has written so far, in order. */
  probe: ProbeLine[]
  /** The end of what the host printed to its standard error. */
  said: () => string
}

/** This checkout's built host program; refuses when it isn't built. */
export function benchHostScript(): string {
  const script = resolve(import.meta.dirname, "../../packages/host/dist/mako-host.js")
  if (!existsSync(script)) throw new Error(`${script} isn't built: npx tsgo -b packages/host`)
  return script
}

/**
 * Starts the host on `dataRoot` with the probe loaded, `env` its sealed environment. `mark`: the prefix of the
 * conversations the probe writes frames and tokens for; every conversation when not given.
 */
export function startBenchHost({ dataRoot, env, mark }: { dataRoot: string; env: NodeJS.ProcessEnv; mark?: string }): BenchHost {
  const { directory, socket } = runtimeLocation(dataRoot)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  mkdirSync(dataRoot, { recursive: true })
  const child = spawn(process.execPath, [...HOST_NODE_OPTIONS, "--import", join(import.meta.dirname, "bench-vs-bare-probe.mjs"), benchHostScript()], {
    env: { ...env, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_PROD: "1", MAKO_TELEMETRY: "off", ...mark !== undefined && { BENCH_VS_BARE_MARK: mark } },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_000) })
  const probe: ProbeLine[] = []
  // SAFETY: the host was started with a fourth descriptor piped, which its probe writes to.
  createInterface({ input: child.stdio[3] as NodeJS.ReadableStream }).on("line", (line) => {
    const read = ProbeLine.safeParse(JSON.parse(line))
    if (read.success) probe.push(read.data)
  })
  return { child, socket, probe, said: () => stderr.trim().slice(-800) }
}

/** Resolves once the host answers `/health` as ready; rejects when it exits first or `timeoutMs` passes. */
export async function benchHostReady(host: BenchHost, timeoutMs = 90_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; ; await delay(100)) {
    if (host.child.exitCode !== null) throw new Error(`the host exited (${host.child.exitCode}) before it was ready: ${host.said()}`)
    if ((await probeRuntime(host.socket, { timeoutMs: 2_000 }).catch(() => undefined))?.state === "ready") return
    if (Date.now() > deadline) throw new Error(`the host didn't answer /health within ${timeoutMs / 1000} s: ${host.said()}`)
  }
}
