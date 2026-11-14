import { hostFetch } from "../base/host-stopping.js"
import { z } from "zod"
import type { FileOwner } from "../workspaces/index.js"
import { runtimeFile } from "../transport/index.js"

/** An address for an owner's files is asked again after this; the gateway ends one an hour after its last use. */
const ADDRESS_KEPT_MS = 30 * 60_000
const SIGNED_FILES = "mako-file://asset/"
/** What `POST /v1/previews` answers. */
const FilesGrantSchema = z.object({ url: z.url() })

export interface OwnerFilesOptions {
  /** The gateway's address, while this Mac is signed in to a cloud. */
  gateway(): URL | undefined
  /** A connection token, asked for each new address, so a renewed one is used at once. */
  token(): Promise<string | undefined>
  fetch?: typeof fetch
}

/**
 * Fetches a file another host signed from that host, as it serves it: a cloud Thread's machine or another device
 * through the address the gateway gives this person for its signed files (`POST /v1/previews` with `files`, which the
 * web client reads them from too), and another host on this Mac from its socket. The owner checks its own signature.
 */
export class OwnerFiles {
  readonly #options: OwnerFilesOptions
  readonly #addresses = new Map<string, { at: number; origin: Promise<string> }>()

  constructor(options: OwnerFilesOptions) {
    this.#options = options
  }

  async fetch(owner: FileOwner, url: string, init: { signal: AbortSignal; range?: string }): Promise<Response> {
    if (!url.startsWith(SIGNED_FILES)) throw new Error("Only a signed file is fetched from its owner")
    const headers = new Headers(init.range ? { range: init.range } : {})
    if (owner.kind === "socket") return runtimeFile(owner.socket, new Request(url, { headers, signal: init.signal }))
    const origin = await this.#origin(owner)
    const fetchFile = this.#options.fetch ?? hostFetch
    const answer = await fetchFile(`${origin}file/asset/${url.slice(SIGNED_FILES.length)}`, { headers, signal: init.signal })
    // The address ended (its grant ran out early, the account signed out): asked anew next time.
    if (answer.status === 401 || answer.status === 410) this.#addresses.delete(keyOf(owner))
    return answer
  }

  #origin(owner: Exclude<FileOwner, { kind: "socket" }>): Promise<string> {
    const key = keyOf(owner)
    const kept = this.#addresses.get(key)
    if (kept && Date.now() - kept.at < ADDRESS_KEPT_MS) return kept.origin
    const origin = this.#ask(owner)
    this.#addresses.set(key, { at: Date.now(), origin })
    origin.catch(() => this.#addresses.delete(key))
    return origin
  }

  async #ask(owner: Exclude<FileOwner, { kind: "socket" }>): Promise<string> {
    const gateway = this.#options.gateway()
    const token = await this.#options.token()
    if (!gateway || !token) throw new Error("This Mac isn't signed in to Mako, so another computer's files can't be reached")
    const body = owner.kind === "thread" ? { threadId: owner.threadId, files: true } : { deviceId: owner.deviceId, files: true }
    const fetchFile = this.#options.fetch ?? hostFetch
    const answer = await fetchFile(new URL("/v1/previews", gateway), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    })
    if (!answer.ok) throw new Error(`The gateway gave no address for its files (${answer.status})`)
    const { url } = FilesGrantSchema.parse(await answer.json())
    return url.endsWith("/") ? url : `${url}/`
  }
}

const keyOf = (owner: Exclude<FileOwner, { kind: "socket" }>) => (owner.kind === "thread" ? `t:${owner.threadId}` : `d:${owner.deviceId}`)
