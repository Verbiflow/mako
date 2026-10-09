import { request } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { hostLog, hostWarn } from "./host-log.js"
import { wrappedKey } from "./secrets.js"
import type { SecretEncryption } from "./secure-storage.js"

const WantedSchema = z.object({ wanted: z.boolean() })
const ASK_TIMEOUT_MS = 5_000
const ATTACH_WAIT_MS = 10_000
const RETRY_FIRST_MS = 500
const RETRY_LAST_MS = 5_000

export type SecretKeyHandoverResult = "not-wanted" | "handed" | "unavailable"

function keyRequest(socket: string, method: "GET" | "POST", path: string, options: { body?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method, signal: options.signal, headers: options.body ? { "content-type": "application/json" } : {} }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
      response.on("error", reject)
    })
    if (options.timeoutMs) req.setTimeout(options.timeoutMs, () => req.destroy(new Error("The host didn't answer about its data key")))
    req.on("error", reject)
    req.end(options.body)
  })
}

async function wanted(socket: string, wait: boolean, signal?: AbortSignal): Promise<boolean> {
  const reply = await keyRequest(socket, "GET", wait ? "/secret-key?wait=1" : "/secret-key", { signal, timeoutMs: wait ? undefined : ASK_TIMEOUT_MS })
  // A host older than the handover has no route: it reaches the keychain itself.
  if (reply.status === 404) return false
  if (reply.status !== 200) throw new Error(`The host answered ${reply.status} about its data key`)
  return WantedSchema.parse(JSON.parse(reply.body)).wanted
}

async function offer(socket: string, keyPath: string, encryption: SecretEncryption): Promise<SecretKeyHandoverResult> {
  if (!(await encryption.available())) return "unavailable"
  // A new unwrap each time, so the key stays in this process only as long as the handover.
  const key = await wrappedKey(keyPath, encryption).key(true)
  if (!key) return "unavailable"
  const body = JSON.stringify({ key: key.toString("base64") })
  key.fill(0)
  const reply = await keyRequest(socket, "POST", "/secret-key", { body, timeoutMs: ASK_TIMEOUT_MS })
  if (reply.status !== 204) throw new Error(reply.body || `The host refused the data key (${reply.status})`)
  return "handed"
}

/**
 * Hands the host on `socket` the data key, unwrapped through this process's
 * keychain, when the host asks for it: a host under the Helper in Node mode
 * can't reach the keychain. Makes the key when the store has none.
 */
export async function handOverSecretKey(socket: string, keyPath: string, encryption: SecretEncryption): Promise<SecretKeyHandoverResult> {
  return (await wanted(socket, false)) ? offer(socket, keyPath, encryption) : "not-wanted"
}

/**
 * The desktop's side of the handover for as long as it runs. A window
 * attaching hands the key over at once. Between attaches a held request
 * answers the moment a host asks, so a host that starts with no window open
 * (a successor after a restart, or after a crash) gets its key too. Watching
 * never starts a host and never counts as one of its clients. After the
 * keychain refuses, it waits for the next window rather than asking again.
 */
export class SecretKeyLink {
  private readonly socket: string
  private readonly keyPath: string
  private readonly encryption: SecretEncryption
  private readonly stop = new AbortController()
  private watching = false
  /** The last handover wasn't made: the keychain isn't asked again before the next attach. */
  private paused = false
  private handing: Promise<SecretKeyHandoverResult | "failed"> | undefined
  private resume: (() => void) | undefined

  constructor(socket: string, keyPath: string, encryption: SecretEncryption) {
    this.socket = socket
    this.keyPath = keyPath
    this.encryption = encryption
  }

  /**
   * A window attached to the host, which may be a new one. Never throws. Waits
   * at most `waitMs`, since the keychain may be asking the person; the
   * handover carries on behind it.
   */
  async attached(waitMs = ATTACH_WAIT_MS): Promise<SecretKeyHandoverResult | "failed" | "pending"> {
    const handing = this.hand(() => handOverSecretKey(this.socket, this.keyPath, this.encryption)).then((result) => {
      this.paused = result !== "handed" && result !== "not-wanted"
      if (!this.paused) this.resume?.()
      if (!this.watching && !this.stop.signal.aborted) {
        this.watching = true
        void this.watch()
      }
      return result
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), waitMs)
      timer.unref()
    })
    try {
      return await Promise.race([handing, waited])
    } finally {
      clearTimeout(timer)
    }
  }

  dispose(): void {
    this.stop.abort()
    this.paused = false
    this.resume?.()
  }

  private hand(work: () => Promise<SecretKeyHandoverResult>): Promise<SecretKeyHandoverResult | "failed"> {
    this.handing ??= work()
      .then((result) => {
        if (result === "handed") hostLog("desktop", "secret key", { result })
        if (result === "unavailable") hostWarn("desktop", "secret key", { result })
        return result
      })
      .catch((error) => {
        hostWarn("desktop", "secret key", { result: "failed", reason: error instanceof Error ? error.message : String(error) })
        return "failed" as const
      })
      .finally(() => { this.handing = undefined })
    return this.handing
  }

  private async watch(): Promise<void> {
    let retry = RETRY_FIRST_MS
    while (!this.stop.signal.aborted) {
      if (this.paused) {
        await this.nextAttach()
        continue
      }
      let asked: boolean
      try {
        asked = await wanted(this.socket, true, this.stop.signal)
      } catch {
        await delay(retry, undefined, { signal: this.stop.signal }).catch(() => undefined)
        retry = Math.min(retry * 2, RETRY_LAST_MS)
        continue
      }
      retry = RETRY_FIRST_MS
      // Not asked: a host older than the handover answered at once. Asked and not handed: the keychain refused.
      const result = asked ? await this.hand(() => offer(this.socket, this.keyPath, this.encryption)) : "not-wanted"
      if (result !== "handed") this.paused = true
    }
  }

  private nextAttach(): Promise<void> {
    if (this.stop.signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => { this.resume = resolve }).finally(() => { this.resume = undefined })
  }
}
