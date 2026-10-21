import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CursorSdkClient } from "./client.js"
import type { CursorSdkProbeClient, CursorSdkSpawnOptions } from "./auth.js"
import type { SdkModelListItem, SdkResult } from "./wire.js"

export interface CursorSdkModelsOptions {
  env: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
  /** Test hook: a client other than the real child. */
  client?(options: CursorSdkSpawnOptions): CursorSdkProbeClient
}

/**
 * The models Cursor's SDK offers this account, asked of a short-lived child.
 * Discovery has no session to piggyback on, so this is its own spawn; the
 * provider-owned cache shares successful lists with startup for an hour.
 * A display refresh asks natively again and concurrent loads share that request.
 */
export async function listCursorSdkModels(options: CursorSdkModelsOptions): Promise<SdkModelListItem[]> {
  options.signal?.throwIfAborted()
  const spawn: CursorSdkSpawnOptions = {
    owner: "cursor-sdk-models",
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    onEvent: () => undefined,
  }
  const client = options.client ? options.client(spawn) : new CursorSdkClient(spawn)
  let closing: Promise<void> | undefined
  const close = () => closing ??= client.close(2_000)
  const abort = () => { void close().catch(() => {}) }
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    await client.hello()
    options.signal?.throwIfAborted()
    const models = (await client.request("models", undefined)).models
    options.signal?.throwIfAborted()
    return models
  } finally {
    options.signal?.removeEventListener("abort", abort)
    await close()
  }
}

/** How long an account's model list and identity stand for a start. A display refresh always asks Cursor again. */
export const CURSOR_ACCOUNT_TTL_MS = 60 * 60_000
/** The SDK's own sign-in, which it reads when no key is in its environment, as on a cloud machine. */
export const CURSOR_SDK_AUTH_FILE = join(".cursor", "sdk", "auth.json")

/**
 * The credential an SDK child runs under, as a key: its `CURSOR_*` settings (a key, an endpoint: another account),
 * and without a key, the SDK's own sign-in file, which is then the credential. The rest of an environment differs
 * between a session and a display read of the same account, and once kept a start and the picker listing the same
 * models side by side, two SDK children at once on a cloud machine (2026-10-20). Undefined when neither says who:
 * the SDK may sign in some other way, so no answer is kept.
 */
export async function cursorCredentialScope(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const settings = cursorSettings(env)
  const file = env.CURSOR_API_KEY ? null : await readFile(join(env.HOME ?? homedir(), CURSOR_SDK_AUTH_FILE), "utf8").catch(() => undefined)
  if (file === undefined) return undefined
  return createHash("sha256").update(JSON.stringify([settings, file])).digest("hex")
}

/** An environment's Cursor settings, by name: what, beside the SDK's own sign-in file, says which account a child is. */
export function cursorSettings(env: NodeJS.ProcessEnv): Array<[string, string]> {
  return Object.entries(env).flatMap(([name, value]): Array<[string, string]> => (name.startsWith("CURSOR_") && value !== undefined ? [[name, value]] : [])).sort(([a], [b]) => a.localeCompare(b))
}

interface AccountEntry<T> {
  cached?: { value: T; expiresAt: number }
  pending?: Promise<T>
  pendingSignal?: AbortSignal
}

/** Asks Cursor, or answers from what it said for this credential within the hour. */
export interface CursorAccountCache<T> {
  (env: NodeJS.ProcessEnv, load: () => Promise<T>, refresh?: boolean, signal?: AbortSignal): Promise<T>
  /** Drops what this credential's answers were: Cursor refused it. */
  forget(env: NodeJS.ProcessEnv): Promise<void>
}

/**
 * What Cursor answers an account, shared by display, a start and the start run ahead, per credential scope. Concurrent
 * asks share one request; a refresh asks again; a failure is never kept, and a failed refresh keeps the last answer.
 */
function cursorAccountCache<T>(check: (value: T) => void, now: () => number): CursorAccountCache<T> {
  const entries = new Map<string, AccountEntry<T>>()
  const read = async (env: NodeJS.ProcessEnv, load: () => Promise<T>, refresh = false, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted()
    const key = await cursorCredentialScope(env)
    signal?.throwIfAborted()
    if (!key) {
      const value = await load()
      signal?.throwIfAborted()
      return value
    }
    for (const [key, entry] of entries)
      if (!entry.pending && (!entry.cached || entry.cached.expiresAt <= now())) entries.delete(key)
    let entry = entries.get(key)
    if (entry?.pendingSignal?.aborted) { entries.delete(key); entry = undefined }
    // A display refresh must not hold a launch behind another network call
    // while this exact credential scope still has a valid native result.
    if (!refresh && entry?.cached && entry.cached.expiresAt > now()) return structuredClone(entry.cached.value)
    if (!entry) {
      entry = {}
      if (entries.size >= 4) {
        const settled = [...entries].find(([, entry]) => !entry.pending)
        if (settled) entries.delete(settled[0])
      }
      if (entries.size < 4) entries.set(key, entry)
    }
    let pending = entry.pending
    if (!pending) {
      const current = entry
      pending = Promise.resolve().then(() => { signal?.throwIfAborted(); return load() }).then(value => {
        signal?.throwIfAborted()
        check(value)
        return structuredClone(value)
      })
      current.pending = pending
      current.pendingSignal = signal
      void pending.then(value => {
        current.cached = { value, expiresAt: now() + CURSOR_ACCOUNT_TTL_MS }
        current.pending = undefined
        current.pendingSignal = undefined
      }, () => {
        current.pending = undefined
        current.pendingSignal = undefined
        if ((!current.cached || current.cached.expiresAt <= now()) && entries.get(key) === current) entries.delete(key)
      })
    }
    const value = await pending
    signal?.throwIfAborted()
    return structuredClone(value)
  }
  return Object.assign(read, {
    async forget(env: NodeJS.ProcessEnv) {
      const key = await cursorCredentialScope(env)
      if (key) entries.delete(key)
    },
  })
}

/** The models Cursor offers each account. A start asks again before refusing a model the kept list lacks. */
export function createCursorModelCache(now: () => number = Date.now): CursorAccountCache<SdkModelListItem[]> {
  return cursorAccountCache((models) => {
    if (!models.length) throw new Error("Cursor's SDK listed no models for this account")
  }, now)
}
export type CursorModelCache = ReturnType<typeof createCursorModelCache>

/** Who each account is, by Cursor's `me`: what a session reports it runs as. */
export function createCursorIdentityCache(now: () => number = Date.now): CursorAccountCache<SdkResult<"me">> {
  return cursorAccountCache(() => undefined, now)
}
export type CursorIdentityCache = ReturnType<typeof createCursorIdentityCache>
