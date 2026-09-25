import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { OpenCode } from "@opencode/client"
import { z } from "zod"
import { environmentForExecutable } from "../../executable.js"
import { trackProviderChild } from "../../provider-children.js"
import { ProviderStartupWatch } from "../../provider-startup.js"
import type { ProviderLaunchTrace } from "../../provider-launch.js"
import { isOpenCodeV2 } from "./version.js"

const Ready = z.object({ url: z.string().url() }).transform(({ url }) => {
  const endpoint = new URL(url)
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash)
    throw new Error("OpenCode reported an invalid local API endpoint")
  return endpoint.href
})
const Health = z.object({ healthy: z.literal(true), version: z.string(), pid: z.number().int().positive() })

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
  signal?: AbortSignal
  /** Transport fault injection uses the same SDK boundary as normal requests. */
  fetch?: typeof globalThis.fetch
}) {
  input.signal?.throwIfAborted()
  const password = randomBytes(32).toString("base64url")
  const lifetime = new AbortController()
  const child = input.trace.sync("spawn", () => spawn(input.command, ["serve", "--stdio", "--port", "0"], {
    cwd: input.cwd,
    env: environmentForExecutable(input.command, { ...input.env, OPENCODE_PASSWORD: password }),
    stdio: "pipe",
  }))
  trackProviderChild(child, { kind: "opencode:native-api", owner: input.conversationId })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096) })
  const watch = new ProviderStartupWatch(child, { harness: "OpenCode", stderr: () => stderr })
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()) })
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
    const client = OpenCode.make({
      baseUrl,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      fetch: (url, options) => (input.fetch ?? fetch)(url, {
        ...options,
        redirect: "error",
        signal: options?.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
      }),
    })
    const health = await input.trace.step("handshake", () => watch.step("native API health", client.health.get()))
    const checked = Health.parse(health)
    if (!isOpenCodeV2(checked.version)) throw new Error("OpenCode native API requires a v2 runtime")
    if (checked.pid !== child.pid) throw new Error("OpenCode API does not belong to the launched process")
    return { client, watch, health: checked, signal: lifetime.signal, close }
  } catch (error) {
    await close()
    throw error
  }
}
