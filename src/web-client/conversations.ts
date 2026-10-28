import type { Actor, Json, Subscription } from "@mako/protocol"
import { answerClientCall, isClientCall, openableLink, type ClientAnswers } from "@mako/host/contracts/client-calls"
import { HostCallInputs } from "@mako/host/contracts/host-call-inputs"
import { conversationCallId } from "@mako/host/contracts/conversation-calls"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import { createMakoBridge, type MakoBridge } from "@mako/host/contracts/renderer-bridge"
import { decodeRuntimeValue, splitRuntimeEventLine } from "@mako/host/contracts/runtime-value"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { listedOwner, type ListedOwner } from "@mako/host/contracts/listed-conversations"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { z } from "zod"
import { applyLiveBatch, hydrateLive, listLive } from "@/state/live-recovery"
import { acp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { threadsStore } from "@/state/thread-store"
import { CONSOLE_LOG, type Gateway } from "./gateway"
import type { WebSession } from "./threads"
import { harnessDescriptors } from "@/dev/harness-descriptors"
import type { HarnessDescriptor } from "@/lib/types"

const RESUBSCRIBE_MS = [250, 1_000, 2_000, 5_000, 10_000] as const
/** What `mako:resolve-file-references` names first: the conversation whose transcript's words are being resolved. */
const FileReferencesSourceSchema = z.object({ liveId: z.string().optional() })
/** A file read's signed URLs: what a browser can't load as they are. */
const SignedFileSchema = z.object({ previewUrl: z.string().optional(), posterUrl: z.string().optional(), thumbnailUrl: z.string().optional() }).loose()
const SIGNED_FILES = "mako-file://asset/"
/** What `POST /v1/previews` answers. */
const FilesGrantSchema = z.object({ url: z.string().url() })
/** An address for an owner's files is asked again after this: it ends an hour after its last use. */
const FILES_KEPT_MS = 30 * 60_000
/** The head of an owner's stream line: which conversation's event it carries, and what kind. */
const LineHeadSchema = z.object({ channel: z.string().optional(), type: z.string().optional(), conversation: z.string().optional() })

/**
 * The browser's conversations, each answered by its owner through the gateway exactly as a Mac's window answers
 * another device's: the host's own operations, by the routing every client shares (`conversationCallId`), with the
 * same repeats (`sendWithRepeats`), and their live updates from the owner's stream. What the renderer asks of a host
 * that isn't a conversation's (a workspace, a terminal, a folder) has no host here and is refused by name.
 */
export class WebConversations {
  readonly bridge: MakoBridge
  readonly #gateway: Gateway
  readonly #deviceId: string
  readonly #row: (conversation: string) => ListedSession | undefined
  readonly #listeners = new Set<(event: HostEvent) => void>()
  /** Sessions a terminal or another app runs, opened on their owner as the list named them, by conversation. */
  readonly #captures = new Map<string, Promise<Json | undefined>>()
  /** Where each owner's signed files are served to this browser, by owner, and when that was asked. */
  readonly #files = new Map<string, { at: number; origin: Promise<string> }>()
  /** The owner streams followed, by stream: one follow per stream, however many of its conversations are open. */
  readonly #follows = new Map<string, { subscription?: Subscription; conversations: Set<string>; stopped: boolean }>()

  constructor(options: { gateway: Gateway; deviceId: string; row: (conversation: string) => ListedSession | undefined }) {
    this.#gateway = options.gateway
    this.#deviceId = options.deviceId
    this.#row = options.row
    const answers: ClientAnswers<undefined> = {
      "mako:open-url": (_page, url) => {
        const link = openableLink(url)
        if (!link) throw new Error("Mako opens only http and https links")
        window.open(link, "_blank", "noopener,noreferrer")
      },
      "mako:copy": (_page, text) => navigator.clipboard.writeText(text),
      // The phone's notifications come from the account (Web Push), never from a page: a page is the one in front.
      "mako:notify": () => ({ delivered: false, reason: "unsupported" }),
      "mako:notify-dismiss": () => undefined,
      "mako:set-badge-count": () => undefined,
      "mako:notification-permission": () => "unsupported",
      "mako:request-notification-permission": () => "unsupported",
      "mako:open-preview-window": () => {
        throw new Error("Previews open on a computer.")
      },
      "mako:quit-client": () => undefined,
      "mako:surface-window": () => undefined,
      "mako:appshot-shortcut": () => {
        throw new Error("Appshots are taken on a computer.")
      },
      "mako:appshot-feedback": () => undefined,
    }
    const inputs = new HostCallInputs()
    const answer = async (channel: string, args: unknown[]) => {
      if (isClientCall(channel)) return answerClientCall(answers, channel, undefined, inputs.of(channel).parse(args))
      if (channel === "mako:harness-descriptors") return webHarnessDescriptors()
      const conversation = conversationCallId(channel, args) ?? this.#ownerAsked(channel, args)
      if (conversation && channel === "mako:read-live-file") return this.#readable(conversation, await this.call(conversation, channel, args))
      if (conversation) return this.call(conversation, channel, args)
      // No owner to ask: the null the bridge declares, so links are drawn as they are, unchecked (`file-references.ts`).
      if (channel === "mako:resolve-file-references") return null
      console.warn(`[mako] ${channel} isn't offered in the browser`)
      throw new Error("That isn't offered in the browser.")
    }
    this.bridge = createMakoBridge({
      // SAFETY: each answer is the one the bridge's method for its channel declares, as with Electron's invoke: a client
      // call's is typed by its channel in `ClientAnswers`, the harnesses are the descriptors a window reads, and the rest
      // are the owner's host's own answers, or the null the bridge declares for unchecked file references.
      invoke: async <Result,>(channel: string, ...args: unknown[]) => (await answer(channel, args)) as Result,
      onEvent: (listener) => {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
      },
      onTerminalEvent: () => () => undefined,
      pathForFile: () => null,
      resolveFileUrl: (url) => url,
    })
  }

  /**
   * What only the computer a conversation runs on knows, asked there though the call names no conversation of its own:
   * which files a transcript's words name (by the conversation they're from), and its harness's models and settings in
   * its folder (by the conversation open, the one its composer sends to). A phone has neither files nor harnesses.
   */
  #ownerAsked(channel: string, args: readonly unknown[]): string | undefined {
    const listed = (conversation: string | null | undefined) => (conversation && this.#row(conversation) ? conversation : undefined)
    if (channel === "mako:resolve-file-references") return listed(FileReferencesSourceSchema.safeParse(args[0]).data?.liveId)
    if (channel === "mako:harness-tuning") return listed(acpStore.get().activeKey)
    return undefined
  }

  /**
   * One host call to the conversation's owner: a cloud Thread's machine, or another device's runtime. A Session its
   * owner's harness keeps that Mako there hasn't opened (a terminal's, `capture`) is opened there first, as the
   * conversation the list named, once, as a Mac's window does (`CloudConversations.#captureListed`).
   */
  async call(conversation: string, channel: string, args: readonly unknown[]): Promise<Json | undefined> {
    const row = this.#row(conversation)
    if (!row) throw new Error("This conversation isn't in your account's list any more.")
    const capture = row.capture?.path
    if (capture && channel !== "mako:live-capture") {
      let captured = this.#captures.get(conversation)
      if (!captured) {
        captured = this.call(conversation, "mako:live-capture", [conversation, capture])
        this.#captures.set(conversation, captured)
        // One that failed (its device asleep, say) is asked again by the next call.
        captured.catch(() => this.#captures.delete(conversation))
      }
      await captured
    }
    const owner = listedOwner(row)
    const actor: Actor = { kind: "client", client: "web", deviceId: this.#deviceId }
    const target = owner.kind === "cloud" ? { threadId: owner.threadId } : { runtimeId: owner.runtimeId }
    const send = gatewayHostCalls(this.#gateway.session, { ...target, actor, history: true, log: CONSOLE_LOG }).call(channel, args)
    const value = await sendWithRepeats(channel, send, { conversationId: conversation, ...(owner.kind === "cloud" ? { threadId: owner.threadId } : { runtime: owner.runtimeId }), log: CONSOLE_LOG })
    return decodeRuntimeValue(value)
  }

  /**
   * Archives a Session another device runs, by asking that device, as a Mac's window does
   * (`CloudConversations.archiveOnOwner`): its archive is its owner's word, and every device's list drops it once its
   * owner does. Throws, saying so, while its device is off.
   */
  async archiveOnOwner(conversation: string): Promise<void> {
    await this.call(conversation, "mako:thread-archive", [{ id: crypto.randomUUID(), target: { kind: "live", id: conversation }, archived: true }])
  }

  /**
   * Opens a Session on screen: listed as a window lists it, its owner's stream followed from now, its snapshot read
   * (the newest page; earlier ones by the page as the person scrolls), and made the active conversation, whose
   * transcript, approvals and composer the renderer draws. Returns how to let it go.
   */
  open(session: WebSession): () => void {
    const conversation = session.row.conversation
    threadsStore.set({ descriptors: webHarnessDescriptors() })
    listLive([session.summary])
    const stop = this.#follow(session.owner, conversation)
    acp.activate(conversation)
    return () => {
      stop()
      if (acpStore.get().activeKey === conversation) acp.deactivate()
    }
  }

  /**
   * A file its owner read, as this browser can load it: the owner signed its media for its own windows
   * (`mako-file://asset/…`, each URL a capability for one file), and the gateway serves them to this person from an
   * address of their own for that owner's files (`POST /v1/previews` with `files`), through the owner's link.
   */
  async #readable(conversation: string, value: Json | undefined): Promise<Json | undefined> {
    const read = SignedFileSchema.safeParse(value)
    if (!read.success) return value
    const signed = [read.data.previewUrl, read.data.posterUrl, read.data.thumbnailUrl].some((url) => url?.startsWith(SIGNED_FILES))
    const row = this.#row(conversation)
    if (!signed || !row) return value
    const origin = await this.#filesOrigin(listedOwner(row))
    const rewrite = (url: string | undefined) => (url?.startsWith(SIGNED_FILES) ? `${origin}file/asset/${url.slice(SIGNED_FILES.length)}` : url)
    // SAFETY: the same file the owner answered, its signed URLs only changed to where this browser reaches them.
    return { ...(value as Record<string, Json>), ...Object.fromEntries((["previewUrl", "posterUrl", "thumbnailUrl"] as const).flatMap((key) => (read.data[key] ? [[key, rewrite(read.data[key])!]] : []))) }
  }

  /** The address the gateway serves an owner's signed files from, asked once and kept a while: it lasts while it's used. */
  #filesOrigin(owner: ListedOwner): Promise<string> {
    const key = owner.kind === "cloud" ? `t:${owner.threadId}` : `d:${owner.deviceId}`
    const kept = this.#files.get(key)
    if (kept && Date.now() - kept.at < FILES_KEPT_MS) return kept.origin
    const origin = this.#gateway.rest("POST", "/v1/previews", owner.kind === "cloud" ? { threadId: owner.threadId, files: true } : { deviceId: owner.deviceId, files: true }).then((answer) => FilesGrantSchema.parse(answer).url)
    this.#files.set(key, { at: Date.now(), origin })
    origin.catch(() => this.#files.delete(key))
    return origin
  }

  /** Follows an owner's stream for one conversation's batches; the stream is shared by every open conversation on it. */
  #follow(owner: ListedOwner, conversation: string): () => void {
    let follow = this.#follows.get(owner.stream)
    if (!follow) {
      follow = { conversations: new Set(), stopped: false }
      this.#follows.set(owner.stream, follow)
      void this.#run(owner, follow)
    }
    follow.conversations.add(conversation)
    const held = follow
    return () => {
      held.conversations.delete(conversation)
      if (held.conversations.size) return
      held.stopped = true
      held.subscription?.close()
      this.#follows.delete(owner.stream)
    }
  }

  async #run(owner: ListedOwner, follow: { subscription?: Subscription; conversations: Set<string>; stopped: boolean }): Promise<void> {
    let failures = 0
    let first = true
    while (!follow.stopped) {
      try {
        // A cloud Thread's stream keeps its events: followed from its head, the snapshot covers what came before. A
        // device's conversation streams only while watched and keeps nothing: from now.
        const subscription = this.#gateway.session.subscribe({ stream: owner.stream, after: owner.kind === "cloud" ? Number.MAX_SAFE_INTEGER : 0 })
        follow.subscription = subscription
        // Followed again after the stream ended: what went by meanwhile is read as a snapshot.
        if (!first) for (const conversation of follow.conversations) void hydrateLive(conversation, true)
        first = false
        for (;;) {
          const frame = await subscription.next()
          failures = 0
          this.#heard(frame.event.text, follow.conversations)
        }
      } catch (error) {
        if (follow.stopped) return
        CONSOLE_LOG.warn("a conversation's stream ended; following it again", { stream: owner.stream, error: error instanceof Error ? error.message : String(error) })
      }
      await new Promise((resolve) => setTimeout(resolve, RESUBSCRIBE_MS[Math.min(failures++, RESUBSCRIBE_MS.length - 1)]))
    }
  }

  /** One line of an owner's stream: a batch of an open conversation goes to the renderer's live state. */
  #heard(line: string, open: ReadonlySet<string>): void {
    const parts = splitRuntimeEventLine(line)
    if (!parts) return
    const head = LineHeadSchema.safeParse(JSON.parse(parts.head)).data
    if (!head || head.channel !== "event" || head.type !== "live-batch" || !head.conversation || !open.has(head.conversation)) return
    // SAFETY: the owner's host encoded this line from its own `live-batch` event, as its windows read it.
    const event = JSON.parse(parts.payload) as Extract<HostEvent, { type: "live-batch" }>
    applyLiveBatch(event.batch)
    for (const listener of this.#listeners) listener(event)
  }

  /** After a sleep or a network change: every followed stream that went quiet is followed again at once. */
  wake(): void {
    this.#gateway.wake()
  }
}

/**
 * Every harness as the host describes it on any Mac, each runnable: what the renderer reads for a harness's name, mark
 * and what it can do (steering, modes). Generated from the harness definitions (`npm run harness:descriptors`).
 */
function webHarnessDescriptors(): HarnessDescriptor[] {
  return harnessDescriptors.map((descriptor) => ({ ...descriptor, live: true }))
}
