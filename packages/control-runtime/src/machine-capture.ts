import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { BrowserConnection, type BrowserProtocolEvent } from "./browser-connection.js"
import type { VideoSource } from "./browser-video.js"
import { decodeControlVideo, type ControlVideoPacket } from "./contracts/control-video.js"

/**
 * The machine browser's capture extension: live video of a tab encoded inside the machine's own Chromium, with its
 * WebCodecs, so no screencast JPEG and no encoder process. Its offscreen document runs the page script the host
 * builds (`src/live-video/machine-capture.ts`); its service worker names a tab's stream with `chrome.tabCapture`,
 * which Chromium allows without a gesture only for the extension the browser was started allowlisting.
 *
 * The key fixes the extension's id, which the launch flags name.
 */
const KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlOM76uxn6r87F7Enj20vPwhmRsJLp3NwQblCsQnzOQt/tmjXLQ45TOPCrICPyMXJQ+NRga/3LfWZX1GwGyY/7Ah7Gfz+G30jzBoV/ASq3BXsou/k8HBi/vCmceusQpsilOpoDOqjVUO5Yb36pFuuLmicbT07xE4mdX9p6kNiQnxB5Gio1epTxKAUpWXBg+4FMrDdll3zPjKi/ubg0xbEPGU82rnBPEo/60870FmCIXB51vLxsGIHJisIRLvaCtfOZyiJFLRujSNBtZ750XcMbtrIuv5W7WZzOaZ05xFS45EgnQeGmeUN8oITACOLi8Psx2wE8+oHVaTCgJRAFsI5zwIDAQAB"
/** Chromium's id for an extension with this key: the first 128 bits of the key's SHA-256, each hex digit as a letter a–p. */
export const MACHINE_CAPTURE_EXTENSION_ID = createHash("sha256").update(Buffer.from(KEY, "base64")).digest("hex").slice(0, 32)
  .replace(/./g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)))
const OFFSCREEN_URL = `chrome-extension://${MACHINE_CAPTURE_EXTENSION_ID}/offscreen.html`

/** Pages of the extension's own: never a tab an agent sees or picks. */
export const MACHINE_CAPTURE_PAGES = `chrome-extension://${MACHINE_CAPTURE_EXTENSION_ID}/`

const MANIFEST = {
  manifest_version: 3,
  name: "Mako live video",
  version: "1",
  key: KEY,
  permissions: ["tabCapture", "offscreen", "debugger"],
  background: { service_worker: "worker.js" },
}

/**
 * The service worker: it opens the offscreen document when it starts (with the browser) and names a tab's stream when
 * the document asks, by the tab's DevTools target id. It sleeps between asks; an ask wakes it.
 */
const WORKER = `const ready = () => chrome.offscreen.hasDocument().then((has) => has || chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"], justification: "Live video of the agent's tab" }))
ready()
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (typeof message?.tab !== "string") return
  chrome.debugger.getTargets().then((targets) => {
    const tab = targets.find((target) => target.id === message.tab)?.tabId
    if (tab === undefined) throw new Error("That tab is gone")
    return chrome.tabCapture.getMediaStreamId({ targetTabId: tab })
  }).then((id) => reply({ id }), (error) => reply({ error: error.message }))
  return true
})
`
const OFFSCREEN = `<!doctype html><meta charset="utf-8"><title>Mako live video</title><script type="module" src="capture.js"></script>\n`

/** Writes the extension to `directory` around the built capture script; returns what the launch flags need. */
export async function writeMachineCaptureExtension(directory: string, script: string): Promise<{ directory: string; id: string }> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(join(directory, "manifest.json"), `${JSON.stringify(MANIFEST)}\n`),
    writeFile(join(directory, "worker.js"), WORKER),
    writeFile(join(directory, "offscreen.html"), OFFSCREEN),
    writeFile(join(directory, "capture.js"), script),
  ])
  return { directory, id: MACHINE_CAPTURE_EXTENSION_ID }
}

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("unit"), session: z.string(), packet: z.string() }),
  z.object({ type: z.literal("ended"), session: z.string(), reason: z.string() }),
  z.object({ type: z.literal("opened"), session: z.string() }),
  z.object({ type: z.literal("accepted"), session: z.string() }),
  z.object({ type: z.literal("dropped"), session: z.string() }),
])
const attached = z.object({ sessionId: z.string() })
const targets = z.object({ targetInfos: z.array(z.object({ targetId: z.string(), url: z.string() })) })
const evaluated = z.object({
  result: z.object({ value: z.json().optional() }).optional(),
  exceptionDetails: z.object({ text: z.string(), exception: z.object({ description: z.string().optional() }).optional() }).optional(),
})

interface Listener {
  link: Link
  unit(packet: ControlVideoPacket): void
  ended(reason: string): void
}

interface Link {
  connection: BrowserConnection
  /** The DevTools session attached to the offscreen document. */
  session: string
}

/** How long the extension's offscreen document, and its page, may take to appear after the browser starts. */
const OFFSCREEN_WAIT_MS = 10_000

/**
 * Live video of the machine browser's tabs, through its capture extension, on a DevTools connection of its own (the
 * agents' connection carries no video). One connection and one attachment to the offscreen document serve every tab
 * watched; they close when the last capture stops.
 */
export class MachineTabVideo {
  readonly #endpoint: () => Promise<string>
  readonly #listeners = new Map<string, Listener>()
  #link?: Promise<Link>
  #current?: Link
  /** Captures waiting for the link: it stays open for them. */
  #opening = 0
  #sessions = 0

  constructor(endpoint: () => Promise<string>) {
    this.#endpoint = endpoint
  }

  /** The tab, by its DevTools target id, as a source of encoded units. */
  source(tab: string): VideoSource {
    return async (consumer) => {
      const session = `tab-${++this.#sessions}`
      const box = () => consumer.size() ?? null
      this.#opening++
      let link: Link
      try {
        link = await this.#attach()
      } finally {
        this.#opening--
      }
      this.#listeners.set(session, { link, unit: consumer.unit, ended: consumer.ended })
      try {
        await this.#call(link, "open", [session, tab, consumer.fps, box()])
      } catch (error) {
        this.#listeners.delete(session)
        this.#release(link)
        throw error
      }
      return {
        key: () => void this.#call(link, "key", [session]).catch(() => {}),
        rate: (bitrate) => void this.#call(link, "rate", [session, bitrate]).catch(() => {}),
        resized: async () => {
          await this.#call(link, "resize", [session, box()])
        },
        stop: async () => {
          if (!this.#listeners.delete(session)) return
          await this.#call(link, "close", [session]).catch(() => {})
          this.#release(link)
        },
      }
    }
  }

  async #call(link: Link, method: "open" | "key" | "rate" | "resize" | "close", args: unknown[]): Promise<void> {
    const reply = evaluated.parse(await link.connection.send("Runtime.evaluate", {
      expression: `makoCapture.${method}(...${JSON.stringify(args)})`,
      awaitPromise: true,
      returnByValue: true,
    }, AbortSignal.timeout(15_000), link.session))
    if (reply.exceptionDetails)
      throw new Error(reply.exceptionDetails.exception?.description?.split("\n")[0] ?? reply.exceptionDetails.text)
  }

  #attach(): Promise<Link> {
    if (!this.#link) {
      const attaching = this.#connect().then((link) => (this.#current = link))
      // A failed attach isn't kept: the next capture tries again.
      attaching.catch(() => {
        if (this.#link === attaching) this.#link = undefined
      })
      this.#link = attaching
    }
    return this.#link
  }

  async #connect(): Promise<Link> {
    const connection = await BrowserConnection.connect(await this.#endpoint(), AbortSignal.timeout(15_000))
    try {
      const target = await this.#offscreen(connection)
      const { sessionId } = attached.parse(
        await connection.send("Target.attachToTarget", { targetId: target, flatten: true }, AbortSignal.timeout(5_000))
      )
      const link: Link = { connection, session: sessionId }
      connection.onEvent((event) => this.#heard(link, event))
      connection.onClose(() => this.#gone(link, "The machine's browser closed"))
      await connection.send("Runtime.enable", {}, AbortSignal.timeout(5_000), sessionId)
      await connection.send("Runtime.addBinding", { name: "makoVideo" }, AbortSignal.timeout(5_000), sessionId)
      // The document is a target before its module has run: a slow machine's first capture asked before it had.
      for (const deadline = performance.now() + OFFSCREEN_WAIT_MS; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
        const ready = evaluated.parse(await connection.send("Runtime.evaluate", { expression: "typeof makoCapture", returnByValue: true }, AbortSignal.timeout(5_000), sessionId))
        if (ready.result?.value === "object") break
        if (performance.now() > deadline) throw new Error("The machine browser's capture extension didn't load its page")
      }
      return link
    } catch (error) {
      connection.close()
      throw error
    }
  }

  /** The offscreen document's target, once the extension's worker has opened it. */
  async #offscreen(connection: BrowserConnection): Promise<string> {
    const deadline = performance.now() + OFFSCREEN_WAIT_MS
    for (;;) {
      const { targetInfos } = targets.parse(
        await connection.send("Target.getTargets", {}, AbortSignal.timeout(5_000))
      )
      const found = targetInfos.find((target) => target.url === OFFSCREEN_URL)
      if (found) return found.targetId
      if (performance.now() > deadline) throw new Error("The machine browser's capture extension isn't running")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  #heard(link: Link, event: BrowserProtocolEvent): void {
    if (event.method === "Target.detachedFromTarget" && event.params.sessionId === link.session)
      return this.#gone(link, "The machine browser's capture extension stopped")
    if (event.method !== "Runtime.bindingCalled" || event.sessionId !== link.session || event.params.name !== "makoVideo") return
    let parsed
    try {
      parsed = eventSchema.parse(JSON.parse(String(event.params.payload)))
    } catch {
      return
    }
    const listener = this.#listeners.get(parsed.session)
    if (listener?.link !== link) return
    if (parsed.type === "ended") return this.#end(parsed.session, listener, parsed.reason)
    if (parsed.type !== "unit") return
    let packet
    try {
      packet = decodeControlVideo(Buffer.from(parsed.packet, "base64"))
    } catch (error) {
      return this.#end(parsed.session, listener, error instanceof Error ? error.message : String(error))
    }
    listener.unit(packet)
  }

  #end(session: string, listener: Listener, reason: string): void {
    this.#listeners.delete(session)
    listener.ended(reason)
    this.#release(listener.link)
  }

  /** The connection or the attachment went: every capture on it ends. */
  #gone(link: Link, reason: string): void {
    for (const [session, listener] of this.#listeners) if (listener.link === link) this.#end(session, listener, reason)
    this.#release(link)
  }

  /** A link with no capture left closes; the offscreen document stays for the next one. */
  #release(link: Link): void {
    if (this.#current === link && this.#opening) return
    if ([...this.#listeners.values()].some((listener) => listener.link === link)) return
    if (this.#current === link) this.#link = this.#current = undefined
    link.connection.close()
  }

  close(): void {
    for (const [session, listener] of this.#listeners) this.#end(session, listener, "Live video ended")
  }
}
