import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import type { JsonObject } from "../electron/codex-app-json.ts"

/**
 * A harness run sealed off from the person's own: a throwaway home and
 * project, no credentials or endpoints from this shell, temporary files
 * beside the home. Shared by the scripts that run real harness CLIs against
 * a local stand-in for their model.
 */

export const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/** Credentials, endpoints and homes a harness would otherwise take from this shell. */
const INHERITED = /^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|XAI_|GROK_|OPENCODE_|DEVIN_|WINDSURF_|CURSOR_|MAKO_)/

export interface Sandbox {
  root: string
  home: string
  project: string
  env: NodeJS.ProcessEnv
  /** Replaces the sandbox's paths, plain or URL-encoded, ids and today's date, so descriptions that name a session's folder or the month hash the same every run. */
  scrub: (text: string) => string
}

/** Runs `work` in a sandbox named `<prefix>-<harness>-…`, removed afterwards. */
export async function sandboxed<T>(prefix: string, harness: string, work: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `${prefix}-${harness}-`)))
  const home = join(root, "home")
  const project = join(root, "project")
  await mkdir(join(project, ".git"), { recursive: true })
  await mkdir(home, { recursive: true })
  // Codex sets up nothing in a home that sits inside TMPDIR, so temporary files get a sibling folder.
  await mkdir(join(root, "tmp"))
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name)))
  Object.assign(env, {
    HOME: home, TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
  })
  const unprivate = root.replace(/^\/private/, "")
  try {
    const paths = [root, unprivate].flatMap((path) => [path, encodeURIComponent(path)])
    const scrub = (text: string) => paths.reduce((scrubbed, path) => scrubbed.replaceAll(path, "<sandbox>"), text)
      .replace(UUID, "<id>")
      .replaceAll(new Date().toISOString().slice(0, 10), "<today>")
      .replaceAll(new Date().toLocaleString("en-US", { month: "long", year: "numeric" }), "<this month>")
    return await work({ root, home, project, env, scrub })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Sessions named after a sandbox in the person's own stores, which a harness that ignored the sandbox would leave. */
export async function strayStores(prefix: string): Promise<string[]> {
  const stray: string[] = []
  for (const store of [join(homedir(), ".claude", "projects"), join(homedir(), ".grok", "sessions")]) {
    if (!existsSync(store)) continue
    for (const entry of await readdir(store)) if (entry.includes(`${prefix}-`)) stray.push(join(store, entry))
  }
  return stray
}

export const RpcMessage = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
}).loose()
export type RpcMessage = z.infer<typeof RpcMessage>

interface RpcOutgoing {
  id?: number | string
  method?: string
  params?: JsonObject
  result?: JsonObject
  error?: { code: number; message: string }
}

export interface RpcPeerOptions {
  jsonrpc: boolean
  timeoutMs: number
  /** What the refusal of an unanswered request says. */
  refusal: string
  /** Every message the child sends that names a method, requests included. */
  received: (message: RpcMessage) => void
  /** The result for a request the child makes; undefined refuses it. */
  answer?: (message: RpcMessage) => JsonObject | undefined
}

/** One line-delimited JSON-RPC peer over a child's stdio. */
export function rpcPeer(child: ChildProcessWithoutNullStreams, options: RpcPeerOptions) {
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2_000) })
  const failure = (what: string) => new Error(`${what}${stderr.trim() ? `; its stderr ends: ${stderr.trim().slice(-600)}` : ""}`)
  const replies = new Map<number | string, { resolve: (message: RpcMessage) => void; reject: (error: Error) => void }>()
  const send = (message: RpcOutgoing) => child.stdin.write(`${JSON.stringify(options.jsonrpc ? { jsonrpc: "2.0", ...message } : message)}\n`)
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    let json: unknown
    try { json = JSON.parse(line) } catch { return }
    const message = RpcMessage.parse(json)
    if (message.method) options.received(message)
    if (message.method && message.id !== undefined) {
      const result = options.answer?.(message)
      send(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: options.refusal } })
    } else if (!message.method && message.id !== undefined) {
      const reply = replies.get(message.id)
      replies.delete(message.id)
      if (message.error !== undefined) reply?.reject(new Error(JSON.stringify(message.error).slice(0, 300)))
      else reply?.resolve(message)
    }
  })
  child.once("exit", (code, signal) => {
    for (const reply of replies.values()) reply.reject(failure(`it exited (${signal ?? code}) before answering`))
    replies.clear()
  })
  let next = 0
  return {
    /** The answer's `result`. */
    call: (method: string, params: JsonObject) => new Promise<RpcMessage["result"]>((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => { replies.delete(id); reject(failure(`no answer to ${method} within ${options.timeoutMs / 1000}s`)) }, options.timeoutMs)
      replies.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message.result) }, reject: (error) => { clearTimeout(timer); reject(error) } })
      send({ id, method, params })
    }),
    notify: (method: string, params?: JsonObject) => send(params ? { method, params } : { method }),
    close: () => lines.close(),
  }
}

export async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
  await exited
  clearTimeout(timer)
}
