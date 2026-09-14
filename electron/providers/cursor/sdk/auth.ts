import { hostLog, hostWarn } from "../../../host-log.js"
import { errorMessage } from "../../../live-runtime.js"
import { readCursorCliApiKey } from "./cli-keychain.js"
import { CursorSdkClient, CursorSdkError } from "./client.js"
import {
  CursorCredentialStore,
  CursorCredentialStoreError,
  parseCursorApiKey,
  type CursorCredentialMethod,
  type StoredCursorCredential,
} from "./credentials.js"
import type { SdkEvent } from "./wire.js"

/** What a sign-in or probe needs from a child: a handshake, requests, and a close. */
export type CursorSdkProbeClient = Pick<CursorSdkClient, "hello" | "request" | "close">

export interface CursorSdkSpawnOptions {
  owner: string
  cwd: string
  env: NodeJS.ProcessEnv
  onEvent(event: SdkEvent): void
}

/** How long a verified answer stands before the next question re-asks Cursor. */
export const CURSOR_SDK_AUTH_TTL_MS = 10 * 60_000
/** A rejected or failed probe is re-asked sooner: the user may be fixing it. */
export const CURSOR_SDK_AUTH_RETRY_MS = 30_000

/**
 * Where the key the SDK runs under comes from, in the order they are tried.
 * `env` is the host's own `CURSOR_API_KEY`; `mako` the key Mako minted or was
 * given, encrypted; `cli` the key `cursor-agent login` left in the keychain;
 * `sdk` the SDK's own `~/.cursor/sdk/auth.json`, which the SDK reads itself
 * and so decides only when nobody else holds a key.
 */
export const CURSOR_KEY_SOURCES = ["env", "mako", "cli", "sdk"] as const
export type CursorKeySource = (typeof CURSOR_KEY_SOURCES)[number]

export type CursorSdkAuthState =
  | {
      status: "signed-in"
      source: CursorKeySource
      method?: CursorCredentialMethod
      email?: string
      keyName?: string
      /** ISO time the key lapses, when known. */
      expiresAt?: string
    }
  | {
      status: "signed-out"
      /**
       * Why a key that exists does not work — Cursor rejected it, or Mako's
       * copy cannot be opened — so the row can say so instead of "not signed in".
       */
      problem?: { source: CursorKeySource; message: string }
    }

export interface CursorSdkAuthSnapshot {
  state: CursorSdkAuthState
  checkedAt: number
}

export interface CursorSdkAuthOptions {
  /** The host environment a child inherits; `CURSOR_API_KEY` there is the first source. */
  env(): Promise<NodeJS.ProcessEnv>
  /** Opens the sign-in page the SDK mints; the user finishes there. */
  openUrl(url: string): Promise<void>
  credentials: CursorCredentialStore
  /** Test hook: the CLI keychain read. */
  cliKey?(): Promise<string | null>
  /** Test hook: a client factory other than spawning the real child. */
  client?(options: CursorSdkSpawnOptions): CursorSdkProbeClient
  now?(): number
}

/** A resolved key and where it came from; `sdk` resolves to no key because the SDK reads its own. */
interface ResolvedKey {
  source: CursorKeySource
  apiKey?: string
  credential?: StoredCursorCredential
}

/**
 * Whether, and as whom, the SDK can run. One object per host: the driver
 * asks it for a child's environment (fast — no network, at most one keychain
 * read), Settings asks for the verified state, and both hear when the answer
 * changes. Verification is a short-lived child answering `me` with the
 * candidate key in its environment, so the key is judged by Cursor, not by
 * its shape.
 */
export class CursorSdkAuth {
  private snapshot: CursorSdkAuthSnapshot | null = null
  private inflight: Promise<CursorSdkAuthSnapshot> | null = null
  private readonly listeners = new Set<(snapshot: CursorSdkAuthSnapshot) => void>()
  private readonly options: CursorSdkAuthOptions

  constructor(options: CursorSdkAuthOptions) {
    this.options = options
  }

  /** The last answer, or null when nothing has been asked yet. */
  get current(): CursorSdkAuthSnapshot | null {
    return this.snapshot
  }

  get signedIn(): boolean {
    return this.snapshot?.state.status === "signed-in"
  }

  onChange(listener: (snapshot: CursorSdkAuthSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The environment an SDK child runs with: the host's, plus the resolved key
   * as `CURSOR_API_KEY` when Mako or the CLI holds one. No network here — a
   * thread's first prompt must not wait on a verification round trip.
   */
  async childEnv(): Promise<NodeJS.ProcessEnv> {
    const env = await this.options.env()
    const resolved = await this.resolve(env)
    if (resolved.apiKey) return { ...env, CURSOR_API_KEY: resolved.apiKey }
    return env
  }

  /** The remembered answer while it is fresh; otherwise a new verification. */
  async status(force = false): Promise<CursorSdkAuthSnapshot> {
    const now = this.now()
    if (!force && this.snapshot) {
      const ttl = this.snapshot.state.status === "signed-in" ? CURSOR_SDK_AUTH_TTL_MS : CURSOR_SDK_AUTH_RETRY_MS
      if (now - this.snapshot.checkedAt < ttl) return this.snapshot
    }
    if (this.inflight) return this.inflight
    this.inflight = this.probe().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /**
   * Signs in through the browser. The SDK mints a named, expiring key and
   * hands it back without persisting it; Mako verifies nothing further —
   * the mint is the proof — and stores it encrypted.
   */
  async signInWithBrowser(signal?: AbortSignal): Promise<CursorSdkAuthSnapshot> {
    const env = await this.options.env()
    const client = await this.spawn(env, (event) => {
      if (event.event === "login-url") void this.options.openUrl(event.url)
    })
    try {
      await client.hello()
      const cancelled = () => new Error("Cursor sign-in was cancelled")
      if (signal?.aborted) throw cancelled()
      const aborted = new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(cancelled()), { once: true })
      })
      const result = await Promise.race([client.request("login", undefined), aborted])
      const credential: StoredCursorCredential = {
        version: 1,
        apiKey: result.apiKey,
        method: "browser",
        email: result.email,
        keyName: "Mako",
        expiresAt: new Date(result.apiKeyExpiresAtMs).toISOString(),
        savedAt: new Date(this.now()).toISOString(),
      }
      await this.options.credentials.save(credential)
      hostLog("cursor-sdk", "signed in through the browser", { email: result.email ?? "" })
      return this.record(this.stateOf("mako", credential))
    } finally {
      await client.close(2_000)
    }
  }

  /**
   * Signs in with a key from the dashboard. Cursor is asked who the key
   * belongs to before anything is saved, so a mistyped key is refused with
   * Cursor's own reason and the previous key, if any, stays in place.
   */
  async signInWithKey(value: string): Promise<CursorSdkAuthSnapshot> {
    const apiKey = parseCursorApiKey(value)
    const env = await this.options.env()
    const identity = await this.verify({ ...env, CURSOR_API_KEY: apiKey })
    const credential: StoredCursorCredential = {
      version: 1,
      apiKey,
      method: "pasted",
      email: identity.email,
      keyName: identity.apiKeyName,
      savedAt: new Date(this.now()).toISOString(),
    }
    await this.options.credentials.save(credential)
    hostLog("cursor-sdk", "signed in with a pasted key", { email: identity.email ?? "", keyName: identity.apiKeyName })
    return this.record(this.stateOf("mako", credential))
  }

  /**
   * Forgets Mako's key and the SDK's own file. The host's `CURSOR_API_KEY`
   * and the CLI's keychain key are not Mako's to remove; if either remains,
   * the next status says so and the row shows which is in use.
   */
  async signOut(): Promise<CursorSdkAuthSnapshot> {
    await this.options.credentials.clear()
    const env = await this.options.env()
    const client = await this.spawn(env, () => undefined)
    try {
      await client.hello()
      await client.request("logout", undefined)
    } catch (error) {
      hostWarn("cursor-sdk", "the SDK's own sign-out failed", { error: errorMessage({ error }) })
    } finally {
      await client.close(2_000)
    }
    hostLog("cursor-sdk", "signed out")
    return this.status(true)
  }

  /**
   * A live session's word that Cursor refused its key. The state flips to
   * signed-out with the reason at once, every window hears it, and the next
   * status re-verifies rather than trusting the remembered answer.
   */
  reportRejected(message: string): void {
    const source = this.snapshot?.state.status === "signed-in" ? this.snapshot.state.source : "mako"
    hostWarn("cursor-sdk", "Cursor rejected the key a session ran under", { source, error: message })
    this.record({ status: "signed-out", problem: { source, message: rejectionText(source, message) } })
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async resolve(env: NodeJS.ProcessEnv): Promise<ResolvedKey> {
    if (env.CURSOR_API_KEY) return { source: "env", apiKey: env.CURSOR_API_KEY }
    try {
      const credential = await this.options.credentials.load()
      if (credential) return { source: "mako", apiKey: credential.apiKey, credential }
    } catch (error) {
      // A saved key this host cannot open is reported by the probe; a child
      // spawned now runs on whatever else is available.
      hostWarn("cursor-sdk", "saved credential unavailable", { error: errorMessage({ error }) })
    }
    const cli = await (this.options.cliKey ?? readCursorCliApiKey)()
    if (cli) return { source: "cli", apiKey: cli }
    return { source: "sdk" }
  }

  private async spawn(env: NodeJS.ProcessEnv, onEvent: (event: SdkEvent) => void): Promise<CursorSdkProbeClient> {
    const spawn = { owner: "cursor-sdk-auth", cwd: process.cwd(), env, onEvent }
    return this.options.client ? this.options.client(spawn) : new CursorSdkClient(spawn)
  }

  /** Who a key belongs to, by Cursor's answer; throws the SDK's own error when it is refused. */
  private async verify(env: NodeJS.ProcessEnv): Promise<{ email?: string; apiKeyName: string }> {
    const client = await this.spawn(env, () => undefined)
    try {
      await client.hello()
      return await client.request("me", undefined)
    } finally {
      await client.close(2_000)
    }
  }

  private stateOf(source: CursorKeySource, credential?: StoredCursorCredential, identity?: { email?: string; apiKeyName?: string }): CursorSdkAuthState {
    const state: CursorSdkAuthState = { status: "signed-in", source }
    if (credential?.method) state.method = credential.method
    const email = identity?.email ?? credential?.email
    if (email) state.email = email
    const keyName = identity?.apiKeyName ?? credential?.keyName
    if (keyName) state.keyName = keyName
    if (credential?.expiresAt) state.expiresAt = credential.expiresAt
    return state
  }

  private async probe(): Promise<CursorSdkAuthSnapshot> {
    const env = await this.options.env()
    let storeProblem: { source: CursorKeySource; message: string } | undefined
    let resolved: ResolvedKey
    try {
      const credential = await this.options.credentials.load()
      resolved = env.CURSOR_API_KEY
        ? { source: "env", apiKey: env.CURSOR_API_KEY }
        : credential
          ? { source: "mako", apiKey: credential.apiKey, credential }
          : await this.resolve(env)
    } catch (error) {
      if (error instanceof CursorCredentialStoreError) storeProblem = { source: "mako", message: error.message }
      resolved = await this.resolve(env)
    }
    try {
      if (resolved.apiKey) {
        const identity = await this.verify({ ...env, CURSOR_API_KEY: resolved.apiKey })
        return this.record(this.stateOf(resolved.source, resolved.credential, identity))
      }
      // No key of Mako's, the host's or the CLI's: the SDK's own file decides.
      const client = await this.spawn(env, () => undefined)
      try {
        await client.hello()
        const status = await client.request("authStatus", undefined)
        if (status.status === "logged-in") {
          const state: CursorSdkAuthState = { status: "signed-in", source: "sdk" }
          if (status.email) state.email = status.email
          if (status.apiKeyExpiresAtMs) state.expiresAt = new Date(status.apiKeyExpiresAtMs).toISOString()
          return this.record(state)
        }
      } finally {
        await client.close(2_000)
      }
      return this.record(storeProblem ? { status: "signed-out", problem: storeProblem } : { status: "signed-out" })
    } catch (error) {
      if (error instanceof CursorSdkError && error.kind === "authentication") {
        hostWarn("cursor-sdk", "Cursor rejected the key", { source: resolved.source, error: error.message })
        return this.record({
          status: "signed-out",
          problem: { source: resolved.source, message: rejectionText(resolved.source, error.message) },
        })
      }
      // A failed probe is not "signed out": the last verified answer stands
      // and the log names the failure; a fresh host reports it as unchecked.
      hostWarn("cursor-sdk", "auth probe failed", { source: resolved.source, error: errorMessage({ error }) })
      if (this.snapshot) {
        // Backdated so the next `status` re-asks after the retry window, not the full TTL.
        this.snapshot = { state: this.snapshot.state, checkedAt: this.now() - CURSOR_SDK_AUTH_TTL_MS + CURSOR_SDK_AUTH_RETRY_MS }
        return this.snapshot
      }
      return this.record({
        status: "signed-out",
        problem: { source: resolved.source, message: `Cursor could not be reached to check the key: ${errorMessage({ error })}` },
      })
    }
  }

  private record(state: CursorSdkAuthState): CursorSdkAuthSnapshot {
    const snapshot = { state, checkedAt: this.now() }
    const changed = JSON.stringify(this.snapshot?.state) !== JSON.stringify(state)
    this.snapshot = snapshot
    if (changed) for (const listener of this.listeners) listener(snapshot)
    return snapshot
  }
}

/** The refusal, said in terms of where the key came from and what fixes it. */
export function rejectionText(source: CursorKeySource, detail: string): string {
  const reason = detail.replace(/\s+/g, " ").trim().slice(0, 200)
  switch (source) {
    case "env":
      return `Cursor rejected the CURSOR_API_KEY in Mako's environment (${reason}). Fix or unset it, then restart Mako.`
    case "mako":
      return `Cursor rejected the saved key (${reason}). It may have expired or been revoked; sign in again.`
    case "cli":
      return `Cursor rejected the key cursor-agent is signed in with (${reason}). Run cursor-agent login again, or sign in here.`
    case "sdk":
      return `Cursor rejected the SDK's own stored login (${reason}). Sign in again.`
  }
}
