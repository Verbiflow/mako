import { LinkClosedError, NothingArrivedError, PROBE_ANSWER_MS, SILENT_WHILE_WORKING_MS, StreamCursor, followAgainInMs, sessionStream, type Actor, type Json, type Subscription } from "@mako/protocol"
import { answerClientCall, isClientCall, openableLink, UNOPENABLE_LINK, type ClientAnswers } from "@mako/host/contracts/client-calls"
import { HostCallInputs } from "@mako/host/contracts/host-call-inputs"
import { conversationCallId } from "@mako/host/contracts/conversation-calls"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import { createMakoBridge, type MakoBridge } from "@mako/host/contracts/renderer-bridge"
import { decodeRuntimeValue, readEventLine } from "@mako/host/contracts/runtime-value"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { isCompactBatch, type HeardLiveBatch } from "@mako/host/contracts/live-conversations"
import type { ThreadMoveStep, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import { listedOwner, type ListedOwner } from "@mako/host/contracts/listed-conversations"
import { OwnerUnavailableError } from "@mako/host/contracts/host-connection"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { z } from "zod"
import { applyLiveBatch, hydrateLive, listLive, unloadLive } from "@/state/live-recovery"
import { watchLiveResidency } from "@/state/live-residency"
import { acp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { threadsStore } from "@/state/thread-store"
import { CONSOLE_LOG, type Gateway } from "./gateway"
import { whileBusy } from "./busy"
import { syncingStore } from "./syncing"
import { webSync } from "./sync-readings"
import { answered, macPlace, reachLog, threadPlace } from "./reach"
import { stepHeard } from "./moves"
import { accountListStore } from "./account-list"
import type { WebSession } from "./threads"
import { webHarnessDescriptors } from "./descriptors"
import type { CopyAnswer } from "@mako/host/contracts/copy-history"
import { WebCopies } from "./copies"

/** What `mako:resolve-file-references` names first: the conversation whose transcript's words are being resolved. */
const FileReferencesSourceSchema = z.object({ liveId: z.string().optional() })
/** A file read's signed URLs: what a browser can't load as they are. */
const SignedFileSchema = z.object({ previewUrl: z.string().optional(), posterUrl: z.string().optional(), thumbnailUrl: z.string().optional() }).loose()
const SIGNED_FILES = "mako-file://asset/"
/** What `POST /v1/previews` answers. */
const FilesGrantSchema = z.object({ url: z.string().url() })
/** An address for an owner's files is asked again after this: it ends an hour after its last use. */
const FILES_KEPT_MS = 30 * 60_000
/**
 * The transcripts this browser keeps in memory besides the one on screen: the few read most recently, so going back to
 * one paints it at once and only catches up, within a bound a phone's page can hold. Hidden, it keeps only what's open.
 */
const RECENT_TRANSCRIPTS = { bytes: 32 * 1024 * 1024, recent: 4 }
/** A Mac found off by a call it couldn't take is read from its copy this long before it's asked again, as a Mac's window does. */
const ASLEEP_MS = 15_000

/** A move's step as its owner's stream carries it (`thread-move-step`, `thread-return-step`): read as far as its kind. */
const MoveStepEventSchema = z.object({ type: z.enum(["thread-move-step", "thread-return-step"]), move: z.string(), step: z.object({ kind: z.string() }).loose() })

/** One owner's stream as this browser follows it: its conversations, and how many follow each. */
type Follow = { subscription?: Subscription; conversations: Set<string>; holds: Map<string, number>; stopped: boolean }
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
  readonly #follows = new Map<string, Follow>()
  /** Follows waiting out a backoff before they follow again: a return cuts the wait short. */
  readonly #waits = new Set<() => void>()
  /** The conversations of Macs that are off, read from their copies in the account. */
  readonly #copies: WebCopies
  /** Macs a call found off though the account's list doesn't say so yet, by device, until when they're read from their copies. */
  readonly #asleep = new Map<string, number>()
  readonly #waking = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: { gateway: Gateway; deviceId: string; row: (conversation: string) => ListedSession | undefined }) {
    this.#gateway = options.gateway
    this.#deviceId = options.deviceId
    this.#row = options.row
    this.#copies = new WebCopies({ gateway: options.gateway, retold: (conversation) => this.#retold(conversation) })
    this.#watchQuiet()
    const answers: ClientAnswers<undefined> = {
      "mako:open-url": (_page, url) => {
        const link = openableLink(url)
        if (!link) throw new Error(UNOPENABLE_LINK)
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
      if (conversation) return this.#answerFor(conversation, channel, args)
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
    watchLiveResidency(RECENT_TRANSCRIPTS)
  }

  /**
   * A call for one conversation: its owner's answer, or while its Mac is off, its copy's (`WebCopies`), as a Mac's
   * window reads it. A Mac the account's list says is quiet isn't asked; one that refuses a call as off is read from
   * its copy for `ASLEEP_MS`, then asked again.
   */
  async #answerFor(conversation: string, channel: string, args: unknown[]): Promise<Json | CopyAnswer | null | undefined> {
    const row = this.#row(conversation)
    const mac = row?.runsOn.kind === "device" ? row.runsOn.deviceId : undefined
    if (row && mac && this.#isOff(mac)) return this.#fromCopy(row, channel, args)
    try {
      if (channel === "mako:read-live-file") return await this.#readable(conversation, await this.call(conversation, channel, args))
      return await this.call(conversation, channel, args)
    } catch (error) {
      if (!(error instanceof OwnerUnavailableError) || !row || !mac) throw error
      this.#asleep.set(mac, Date.now() + ASLEEP_MS)
      CONSOLE_LOG.info("a Mac is off; its conversation is read from its copy", { conversation, mac, channel })
      this.#watchForWaking(mac)
      return this.#fromCopy(row, channel, args)
    }
  }

  #isOff(mac: string): boolean {
    return accountListStore.get().quiet.has(mac) || (this.#asleep.get(mac) ?? 0) > Date.now()
  }

  #fromCopy(row: ListedSession, channel: string, args: unknown[]): Promise<CopyAnswer | null> {
    // Which files a transcript's words name is the Mac's to say: unchecked, as with no owner to ask.
    if (channel === "mako:resolve-file-references") return Promise.resolve(null)
    return this.#copies.call(row, channel, args)
  }

  /** The open conversations a Mac runs: the ones its going off or coming back reads again. */
  #openOn(mac: string): string[] {
    const { conversations } = acpStore.get()
    return [...this.#follows.values()].flatMap((follow) => [...follow.conversations]).filter((conversation) => {
      const row = this.#row(conversation)
      return row?.runsOn.kind === "device" && row.runsOn.deviceId === mac && conversations[conversation]?.kind === "live"
    })
  }

  /**
   * Follows the account's word on which Macs are quiet: one that goes quiet has its open conversations read from their
   * copies, so a message sent waits for it; one that's back has them read there again, live, the copy's view replaced
   * in place by the Mac's own (`applyLiveSnapshot` takes a new epoch whole).
   */
  #watchQuiet(): void {
    let before = new Set(accountListStore.get().quiet.keys())
    accountListStore.subscribe(() => {
      const now = new Set(accountListStore.get().quiet.keys())
      const back = [...before].filter((mac) => !now.has(mac))
      const off = [...now].filter((mac) => !before.has(mac))
      before = now
      for (const mac of back) this.#back(mac, "the account's list")
      for (const mac of off) for (const conversation of this.#openOn(mac)) this.#sync(conversation, true)
    })
  }

  #back(mac: string, heard: string): void {
    this.#asleep.delete(mac)
    clearTimeout(this.#waking.get(mac))
    this.#waking.delete(mac)
    const open = this.#openOn(mac)
    CONSOLE_LOG.info("a Mac is back; its conversations are read there again", { mac, heard, open: open.length })
    for (const conversation of open) {
      this.#copies.released(conversation)
      this.#sync(conversation, true)
    }
  }

  /**
   * A Mac a call found off though its list doesn't say it's quiet (Mako closed there, its connection just gone): asked
   * every `ASLEEP_MS` with the smallest read there is while one of its conversations is open, and read live once it answers.
   */
  #watchForWaking(mac: string): void {
    if (this.#waking.has(mac)) return
    this.#waking.set(mac, setTimeout(async () => {
      this.#waking.delete(mac)
      const asked = this.#openOn(mac)[0]
      if (!asked || accountListStore.get().quiet.has(mac)) return void this.#asleep.delete(mac)
      try {
        await this.call(asked, "mako:live-state", [asked])
      } catch (error) {
        if (!(error instanceof OwnerUnavailableError)) return
        this.#asleep.set(mac, Date.now() + ASLEEP_MS)
        this.#watchForWaking(mac)
        return
      }
      this.#back(mac, "a call it answered")
    }, ASLEEP_MS))
  }

  /** A conversation read from its copy changed in the account (a message waits, or one was taken back): read again if open. */
  #retold(conversation: string): void {
    if (acpStore.get().conversations[conversation]?.kind === "live" && [...this.#follows.values()].some((follow) => follow.conversations.has(conversation))) this.#sync(conversation, true)
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
    // What each call met is kept by the place it went to, for the diagnosis to say which hop failed.
    const place = owner.kind === "cloud" ? threadPlace(owner.threadId) : macPlace(owner.deviceId)
    const log = reachLog(place)
    const send = gatewayHostCalls(this.#gateway.session, { ...target, actor, history: true, log }).call(channel, args)
    const value = await sendWithRepeats(channel, send, { conversationId: conversation, ...(owner.kind === "cloud" ? { threadId: owner.threadId } : { runtime: owner.runtimeId }), log })
    answered(place)
    return decodeRuntimeValue(value)
  }

  /**
   * Archives a Session another device runs, by asking that device, as a Mac's window does
   * (`CloudConversations.archiveOnOwner`): its archive is its owner's word, and every device's list drops it once its
   * owner does. Throws, saying so, while its device is off.
   */
  async archiveOnOwner(conversation: string): Promise<void> {
    await whileBusy(this.call(conversation, "mako:thread-archive", [{ id: crypto.randomUUID(), target: { kind: "live", id: conversation }, archived: true }]))
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
    // What this page kept of it paints at once; the read that catches it up says "Syncing…" while it runs.
    acp.activate(conversation, false)
    this.#sync(conversation, false)
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

  /**
   * Follows a conversation's owner without opening it: what a move's card in its place reads, the move's steps as its
   * owner sends them to whoever watches it. Returns how to let it go.
   */
  followSteps(session: WebSession): () => void {
    return this.#follow(session.owner, session.row.conversation)
  }

  /**
   * Follows a Mac for one conversation it doesn't run now: a Thread it brings back from the cloud, whose steps it
   * sends to whoever watches that conversation there. Returns how to let it go.
   */
  followMac(deviceId: string, conversation: string): () => void {
    const runtimeId = `d-${deviceId}`
    return this.#follow({ kind: "device", deviceId, runtimeId, stream: sessionStream(runtimeId, conversation) }, conversation)
  }

  /**
   * Follows an owner's stream for one conversation's batches; the stream is shared by every open conversation on it, and
   * a conversation by everyone who follows it (an open Session and a move's strip above it): it's let go with the last.
   */
  #follow(owner: ListedOwner, conversation: string): () => void {
    let follow = this.#follows.get(owner.stream)
    if (!follow) {
      follow = { conversations: new Set(), holds: new Map(), stopped: false }
      this.#follows.set(owner.stream, follow)
      void this.#run(owner, follow)
    }
    follow.conversations.add(conversation)
    follow.holds.set(conversation, (follow.holds.get(conversation) ?? 0) + 1)
    const held = follow
    let letGo = false
    return () => {
      if (letGo) return
      letGo = true
      const holds = (held.holds.get(conversation) ?? 1) - 1
      if (holds > 0) return void held.holds.set(conversation, holds)
      held.holds.delete(conversation)
      held.conversations.delete(conversation)
      if (held.conversations.size) return
      held.stopped = true
      held.subscription?.close()
      this.#follows.delete(owner.stream)
    }
  }

  /**
   * Follows one owner's stream until it's let go. A cloud Thread's stream is its log: followed from its head the first
   * time (the snapshot covers what came before), and after the last event heard each time after. A device's conversation
   * streams while watched, and its gateway keeps the last few: followed again after the last update heard, a number
   * skipped is asked for again from there, and one too old to have is read again as a snapshot. A stream that ends is
   * followed again at once, then with a backoff (`followAgainInMs`); one silent while its conversation is at work has its
   * connection asked whether it's alive, so a stalled link is replaced in seconds.
   */
  async #run(owner: ListedOwner, follow: Follow): Promise<void> {
    let failures = 0
    let gapsInRow = 0
    let first = true
    const cursor = new StreamCursor(owner.kind === "cloud" ? "log" : "live")
    const readings = webSync.follow(owner.stream, this.#labelOf(follow.conversations))
    let probedAt: number | undefined
    while (!follow.stopped) {
      try {
        const resumes = owner.kind === "cloud" ? cursor.last !== undefined : cursor.numbered
        const subscription = this.#gateway.session.subscribe({ stream: owner.stream, after: owner.kind === "cloud" ? (cursor.last ?? Number.MAX_SAFE_INTEGER) : cursor.resumeAfter() })
        follow.subscription = subscription
        // Followed again where the stream can't be picked up (nothing heard yet, or a gateway that keeps nothing): what
        // went by meanwhile is read as a snapshot.
        if (!first && !resumes) for (const conversation of follow.conversations) this.#sync(conversation, true)
        first = false
        let gap = false
        while (!gap) {
          let frame
          try {
            frame = await subscription.next(this.#working(follow.conversations) ? SILENT_WHILE_WORKING_MS : undefined)
          } catch (error) {
            if (!(error instanceof NothingArrivedError)) throw error
            this.#gateway.session.probe(owner.stream, PROBE_ANSWER_MS)
            readings.probe()
            probedAt = Date.now()
            continue
          }
          const verdict = cursor.heard({ seq: frame.seq, text: frame.event.text })
          if (verdict.kind === "notice" || verdict.kind === "duplicate") continue
          if (verdict.kind === "reread") {
            readings.reread()
            for (const conversation of follow.conversations) this.#sync(conversation, true)
            continue
          }
          if (verdict.kind === "gap") {
            readings.gap()
            readings.followedAgain("gap")
            gap = true
            continue
          }
          failures = 0
          gapsInRow = 0
          // A Mac's update is the Mac answering, live: one streaming a turn isn't said to be unreachable. (A cloud Thread's
          // stream is its log, which a sleeping machine's past still fills.)
          if (owner.kind === "device") answered(macPlace(owner.deviceId))
          const heard = this.#heard(frame.event.text, follow.conversations)
          readings.heard(heard?.emittedAt, heard?.compact)
        }
        // A number skipped: asked for again at once after the last one heard. Gap after gap is a stream that fails.
        if (++gapsInRow <= 3) continue
      } catch (error) {
        if (follow.stopped) return
        readings.followedAgain(!(error instanceof LinkClosedError) ? "failed" : probedAt !== undefined && Date.now() - probedAt < PROBE_ANSWER_MS * 2 ? "silent" : "closed")
        probedAt = undefined
        CONSOLE_LOG.warn("a conversation's stream ended; following it again", { stream: owner.stream, error: error instanceof Error ? error.message : String(error) })
      }
      await this.#wait(followAgainInMs(failures++))
    }
  }

  /** A backoff before following again, which a return (`wake`) ends at once. */
  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.#waits.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.#waits.add(done)
    })
  }

  /**
   * Reads a conversation again from its owner, saying "Syncing…" while it's the one open: what's on screen stays as
   * it is meanwhile, never a skeleton. `quiet`: a failure isn't said, as for a read that only catches up.
   */
  #sync(conversation: string, quiet: boolean): void {
    if (acpStore.get().activeKey === conversation) syncingStore.set({ conversation })
    void hydrateLive(conversation, quiet).finally(() => {
      if (syncingStore.get().conversation === conversation) syncingStore.set({ conversation: undefined })
    })
  }

  /** Back after a while away: the open conversation is read again, as what it shows may be minutes old. */
  resync(): void {
    const open = acpStore.get().activeKey
    if (open && [...this.#follows.values()].some((follow) => follow.conversations.has(open))) this.#sync(open, true)
  }

  /**
   * The page went out of view: every transcript but the open one, and any at work or waiting on the person, goes back
   * to its listing, read again when it's opened. A hidden page that holds less is the last iOS ends for memory.
   */
  releaseHidden(): void {
    const { activeKey, conversations } = acpStore.get()
    for (const conversation of Object.values(conversations)) {
      if (conversation.kind !== "live" || !conversation.hydrated || conversation.key === activeKey) continue
      if (conversation.session.status === "running" || conversation.session.status === "starting" || conversation.permission || conversation.sending || conversation.pendingPrompts?.length) continue
      unloadLive(conversation.key)
    }
  }

  /** What Diagnostics calls a followed stream: its open conversation's title, when it has one. */
  #labelOf(conversations: ReadonlySet<string>): string | undefined {
    const held = acpStore.get().conversations
    for (const conversation of conversations) {
      const conversationState = held[conversation]
      if (conversationState?.kind === "live" && conversationState.session.title) return conversationState.session.title
    }
    return undefined
  }

  /** Whether one of a stream's open conversations is at work, so silence on it may be a stalled link. */
  #working(conversations: ReadonlySet<string>): boolean {
    const held = acpStore.get().conversations
    return [...conversations].some((conversation) => {
      const conversationState = held[conversation]
      return conversationState?.kind === "live" && conversationState.session.status === "running"
    })
  }

  /**
   * One line of an owner's stream: a batch of an open conversation goes to the renderer's live state. Returns when its
   * owner emitted it, for a traced batch, and logs its trace.
   */
  #heard(line: string, open: ReadonlySet<string>): { emittedAt?: number; compact: boolean } | undefined {
    const head = readEventLine(line)
    if (!head || head.channel !== "event" || !head.conversation || !open.has(head.conversation)) return undefined
    if (head.type === "thread-move-step" || head.type === "thread-return-step") {
      this.#moveStep(head.conversation, head.payload)
      return undefined
    }
    if (head.type !== "live-batch") return undefined
    // SAFETY: the owner's host encoded this line from its own `live-batch` event, as its windows read it: whole, or in
    // the compact live form this browser said it reads.
    const event = JSON.parse(head.payload) as { type: "live-batch"; batch: HeardLiveBatch }
    applyLiveBatch(event.batch)
    // SAFETY: as a desk window hears it from a host it said it reads the compact form to (`HostEvent`'s `live-batch`).
    const told = event as Extract<HostEvent, { type: "live-batch" }>
    for (const listener of this.#listeners) listener(told)
    if (event.batch.trace) CONSOLE_LOG.info("traced update heard", { trace: event.batch.trace, conversation: head.conversation, ...(event.batch.emittedAt !== undefined && { lagMs: Date.now() - event.batch.emittedAt }) })
    return { ...(event.batch.emittedAt !== undefined && { emittedAt: event.batch.emittedAt }), compact: isCompactBatch(event.batch) }
  }

  /** A move's step, as its owner sent it: the Thread's card follows it (`moves.ts`). */
  #moveStep(conversation: string, payload: string): void {
    const event = MoveStepEventSchema.safeParse(JSON.parse(payload)).data
    if (!event) return
    const row = this.#row(conversation)
    const deviceId = row?.runsOn.kind === "device" ? row.runsOn.deviceId : undefined
    const name = deviceId ? accountListStore.get().devices.get(deviceId)?.name : undefined
    stepHeard({
      conversation,
      move: event.move,
      way: event.type === "thread-move-step" ? "cloud" : "device",
      // SAFETY: the owner's host encoded this step from its own event, as its windows read it.
      step: event.step as ThreadMoveStep | ThreadReturnStep,
      thread: row?.thread,
      mac: deviceId ? { deviceId, name: name ?? "its Mac" } : undefined,
      listed: row?.move,
    })
  }

  /** After a sleep, a return or a network change: every followed stream that went quiet is followed again at once. */
  wake(): void {
    this.#gateway.wake()
    for (const done of this.#waits) done()
  }
}
