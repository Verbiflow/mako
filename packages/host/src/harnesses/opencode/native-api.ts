import type { PrefetchLaunch } from "../start-prefetch.js"
import { spawnProviderProcess } from "../provider-process.js"
import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { promisify } from "node:util"
import { ClientError, OpenCode, type OpenCodeClient } from "@opencode/client"
import { z } from "zod"
import { environmentForExecutable } from "../../base/executable.js"
import { ProviderStartupWatch } from "../provider-startup.js"
import type { ProviderLaunchTrace } from "../provider-launch.js"
import { openCodeServesLegacyApi, openCodeVersionNumber, openCodeVersionProblem } from "./version.js"
import { openCodeLegacyFetch } from "./legacy-api.js"
import { configuredListenPort } from "../../base/listen-port.js"
import type { OpenCodeServers } from "./servers.js"

const Ready = z.object({ url: z.string().url() }).transform(({ url }) => {
  const endpoint = new URL(url)
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash)
    throw new Error("OpenCode reported an invalid local API endpoint")
  return endpoint.href
})
const Info = z.object({ version: z.string(), pid: z.number().int().positive() })
type Info = z.infer<typeof Info>
const NotFound = z.object({ status: z.literal(404) })

/** Whether OpenCode answered that it has no such route, as servers before a route was added do. */
export function openCodeLacksRoute(error: ClientError): boolean {
  return error.reason === "UnexpectedStatus" && NotFound.safeParse(error.cause).success
}

const run = promisify(execFile)

/**
 * The launched server's version and process. `/api/info` came in 2.0.6; an
 * older server is the process Mako spawned, whose own stdout named the
 * endpoint, at the version its executable reports.
 */
async function serverIdentity(client: OpenCodeClient, command: string, env: NodeJS.ProcessEnv, pid: number | undefined): Promise<Info> {
  try {
    return Info.parse(await client.server.info())
  } catch (error) {
    if (!(error instanceof ClientError) || !openCodeLacksRoute(error) || !pid) throw error
    const reported = (await run(command, ["--version"], { env, timeout: 3_000, maxBuffer: 4_096 })).stdout
    return { version: openCodeVersionNumber(reported), pid }
  }
}

/** A started OpenCode server: its client, identity and lifetime, closed together. */
export interface OpenCodeApi {
  client: OpenCodeClient
  watch: ProviderStartupWatch
  info: Info
  /** Aborted when the server exits or the connection closes. */
  signal: AbortSignal
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  stderr(): string
  close(): Promise<void>
}

/**
 * The native server as a start runs it: on its own password, on the configured port or one the system picks. Its
 * first line names its endpoint, which ends a `startPrefetch`.
 */
export function openCodeServe(command: string, env: NodeJS.ProcessEnv): PrefetchLaunch {
  const port = configuredListenPort("MAKO_OPENCODE_API_PORT", env)
  return { command, args: ["serve", "--stdio", "--port", String(port)], env: { ...env, OPENCODE_PASSWORD: randomBytes(32).toString("base64url") } }
}

/** One native server per adapter owner. OpenCode owns its execution and stores;
 * stdin is its native ownership lease. API failures never retry mutations.
 * The live adapter supplies account/configuration/MCP state before starting it.
 */
export async function startOpenCodeApi(input: {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  conversationId: string
  trace: ProviderLaunchTrace
  /** Where the server is known for its life, so the activity probe can ask it. */
  servers: OpenCodeServers
  signal?: AbortSignal
  /** Transport fault injection uses the same SDK boundary as normal requests. */
  fetch?: typeof globalThis.fetch
}): Promise<OpenCodeApi> {
  input.signal?.throwIfAborted()
  const serve = openCodeServe(input.command, input.env)
  const password = serve.env.OPENCODE_PASSWORD!
  const lifetime = new AbortController()
  const spawnEnv = environmentForExecutable(serve.command, serve.env)
  const child = input.trace.sync("spawn", () => spawnProviderProcess(serve.command, serve.args, {
    cwd: input.cwd,
    env: spawnEnv,
  }, { kind: "opencode:native-api", owner: input.conversationId }))
  const server = child.pid ? input.servers.add(child.pid) : undefined
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096) })
  const watch = new ProviderStartupWatch(child, { harness: "OpenCode", stderr: () => stderr })
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()) })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  void exited.then(() => server?.exited())
  const ready = new Promise<string>((resolve, reject) => {
    let pending = Buffer.alloc(0)
    let settled = false
    const fail = (error: Error) => { if (!settled) { settled = true; pending = Buffer.alloc(0); reject(error) } }
    child.once("error", fail)
    child.once("exit", () => {
      fail(new Error("OpenCode exited before reporting its API endpoint"))
      lifetime.abort(new Error("OpenCode native API process exited"))
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    })
    // Continue draining after readiness; otherwise native logging can block on stdout.
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return
      const end = chunk.indexOf(10)
      const part = end < 0 ? chunk : chunk.subarray(0, end)
      if (pending.length + part.length > 8192) return fail(new Error("OpenCode API readiness exceeded its size limit"))
      pending = Buffer.concat([pending, part])
      if (end < 0) return
      try {
        const url = Ready.parse(JSON.parse(pending.toString("utf8")))
        settled = true
        pending = Buffer.alloc(0)
        resolve(url)
      } catch { fail(new Error("OpenCode reported invalid API readiness")) }
    })
  })
  // Cancellation may dispose the shared watch before it starts this step.
  // The launch still reports that failure; readiness must not reject unobserved.
  void ready.catch(() => {})
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    input.signal?.removeEventListener("abort", abort)
    watch.dispose()
    lifetime.abort(new Error("OpenCode native API connection closed"))
    child.stdin.end()
    const terminate = setTimeout(() => { child.kill("SIGTERM") }, 3000)
    const kill = setTimeout(() => { child.kill("SIGKILL") }, 6000)
    try { await closed } finally { clearTimeout(terminate); clearTimeout(kill) }
  })()
  const abort = () => { void close() }
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) abort()
  // A failed spawn can close stdin before the normal lease shutdown.
  child.stdin.on("error", () => { void close() })
  try {
    const baseUrl = await input.trace.step("handshake", () => watch.step("native API readiness", ready))
    const transport: typeof fetch = (url, options) => (input.fetch ?? fetch)(url, {
      ...options,
      redirect: "error",
      signal: options?.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
    })
    // The handshake reads only what every OpenCode 2 serves alike; its answer picks the API the rest is spoken in.
    let speak = transport
    const client = OpenCode.make({
      baseUrl,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      fetch: (url, options) => speak(url, options),
    })
    const info = await input.trace.step("handshake", () => watch.step("native API info", serverIdentity(client, input.command, spawnEnv, child.pid)))
    if (openCodeServesLegacyApi(info.version)) speak = openCodeLegacyFetch(transport)
    const problem = openCodeVersionProblem(info.version)
    if (problem) throw new Error(problem)
    if (info.pid !== child.pid) throw new Error("OpenCode API does not belong to the launched process")
    server?.answers(client)
    return { client, watch, info, signal: lifetime.signal, exited, stderr: () => stderr, close }
  } catch (error) {
    await close()
    throw error
  }
}
