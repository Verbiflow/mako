import type { ThreadPage } from "@mako/sessions"
import type { CopyPage } from "@mako/sessions/copy-reader"
import type { WaitingMessage } from "@mako/protocol/waiting"
import { HostCallInputs } from "./host-call-inputs.js"
import { HistoryRecords, HistoryVersions, historyCapture, historyPage, historyRange, isPartial } from "./history-pages.js"
import type { LiveRequest, LiveSnapshot, LiveSummary } from "./live-conversations.js"
import { HISTORY_VIEW_EXPIRED, LiveHistoryReadSchema, type LiveHistoryChunk, type LiveHistoryCursor, type LiveHistoryRead } from "./live-history.js"

/**
 * A conversation whose device is off, read from the copy that device keeps of it in the account (`ReadingCopies`):
 * the same answers to the same calls on a Mac (`CloudConversations`) and in a browser (`WebConversations`), each
 * reading the copy its own way (`CopySource`). A copy is the conversation's history as Mako drew it and nothing at
 * work: its snapshot is all saved entries, paged as a host pages its own (`history-pages.ts`). Messages sent to it
 * wait in the account for its device (`CopyWaiting`), shown as queued requests, and the rest needs the device.
 */

/** Entries a copy's snapshot holds at first, and each earlier page read for it. */
export const COPY_PAGE = 100
/** Copy views held at once, the most recently read kept: a window or two each reading a conversation or two. */
const COPY_VIEWS = 8

/** The calls a copy answers: reading the conversation, and a message to it or one waiting changed. */
const COPY_READS = new Set(["mako:live-snapshot", "mako:live-read"])
const COPY_WAITS = new Set(["mako:live-prompt", "mako:live-edit-queued"])

/** What a device that's off can't do, said the same everywhere: `where` names it ("Studio"). */
export const copyRefusals = {
  changes: (where: string) => `${where} is off, so this conversation can't be changed from here until it's back.`,
  files: (where: string) => `${where} is off. A message with files can't wait for it: send it once ${where} is back, or without them.`,
  none: (where: string) => `${where} is off, and the account has no copy of this conversation yet.`,
  original: (where: string) => `${where} is off: its copy holds what Mako drew of this conversation, not the records it was read from.`,
}

/** One version of a conversation's copy, as a reader reads it: pages back from its newest. */
export interface CopySource {
  page(before: number | undefined, limit: number): Promise<CopyPage | null>
}

/** What a conversation's copy is read as: whose it is, and what waits in the account for its device. */
export interface CopyConversation {
  conversationId: string
  harness: string
  createdAt: number
  /** The conversation as its device last listed it, when it did. */
  listed?: LiveSummary
  /** What waits in the account for its device, oldest first. */
  waiting: readonly WaitingMessage[]
  /** How many times its waiting messages changed here: its snapshot's revision moves with them. */
  waitingChanges: number
}

/** The account's waiting messages for a conversation's Session, by the routes every client calls (`/v1/sessions/<id>/waiting`). */
export interface CopyWaiting {
  wait(requestId: string, text: string): Promise<void>
  edit(requestId: string, expectedText: string, text: string): Promise<void>
  remove(requestId: string): Promise<void>
}

/** What a copy answers a call with: a snapshot, a read of its history, or a message now waiting. */
export type CopyAnswer = LiveSnapshot | LiveHistoryChunk | LiveRequest

/** A copy's page as a page of the conversation's history (`ThreadPage`), at `path`: its revision is the copy's records' stamp. */
export function copyThreadPage(page: CopyPage, path: string): ThreadPage {
  const { header } = page
  const ref: ThreadPage["ref"] = { harness: header.harness, nativeId: header.nativeId, path, revision: header.stamp, updatedAt: new Date(header.at).toISOString() }
  if (header.title) ref.title = header.title
  if (header.cwd) ref.cwd = header.cwd
  if (header.model) ref.model = header.model
  return { ref, entries: page.entries, start: page.start, total: page.total, hasEarlier: page.start > 0, translator: header.translator }
}

/** The conversation as its copy has it: its history, and nothing at work, since nothing runs while its device is off. */
export function copySnapshot(conversation: CopyConversation, base: ThreadPage): LiveSnapshot {
  const at = Date.parse(base.ref.updatedAt ?? "") || Date.now()
  const { listed } = conversation
  const snapshot: LiveSnapshot = {
    session: {
      ...(listed?.session ?? { harness: conversation.harness, cwd: base.ref.cwd ?? "", modes: [], currentMode: null, configOptions: [] }),
      id: conversation.conversationId,
      status: "ready",
      connection: "hibernated",
    },
    revision: at + conversation.waitingChanges,
    epoch: `copy-${at}`,
    createdAt: listed?.createdAt ?? conversation.createdAt,
    copy: { at },
    base,
    blocks: [],
    permissions: [],
    // What waits in the account for its device, as messages queued for it.
    requests: conversation.waiting.map((message): LiveRequest => {
      const request: LiveRequest = { id: message.id, text: message.text, attachments: [], status: "queued" }
      if (message.displayText) request.displayText = message.displayText
      return request
    }),
  }
  if (listed?.elsewhere) snapshot.elsewhere = listed.elsewhere
  if (listed?.threadId) snapshot.threadId = listed.threadId
  if (listed?.sessionId) snapshot.sessionId = listed.sessionId
  if (base.ref.title && !snapshot.session.title) snapshot.session.title = base.ref.title
  return snapshot
}

/** A conversation's copy as read now: its snapshot, and the version of the copy its pages come from. */
export interface CopyCapture {
  snapshot: LiveSnapshot
  source: CopySource
}

interface CopyView {
  id: string
  snapshot: LiveSnapshot
  source: CopySource
  used: number
}

/** How a call to a conversation whose device is off is answered, by whoever reads its copy. */
export interface CopyCall {
  conversationId: string
  /** The device, in words ("Studio"). */
  where: string
  /** Its copy as read now; null when the account has none. */
  capture: () => Promise<CopyCapture | null>
  /** The account's waiting messages for it; undefined where they can't be reached (no Session listed). */
  waiting?: CopyWaiting
  /** Its waiting messages changed here: every window reads it again. */
  retold: () => void
}

/**
 * The views windows read of conversations' copies, each pinned to the version of the copy it was captured from: an
 * earlier page, or an entry's whole, is read from that version, so a window paging back never meets a newer copy's
 * entries under its old cursor; once the copy moved on, a read names the view expired and the window reads it anew.
 */
export class CopyHistory {
  readonly #views = new Map<string, CopyView>()
  readonly #records = new HistoryRecords()
  readonly #versions = new HistoryVersions()
  readonly #inputs = new HostCallInputs()

  /**
   * A call to a conversation whose device is off: a read answered from its copy, a message or a change to one waiting
   * kept by the account for that device, and anything else refused, saying why.
   */
  async call(channel: string, args: readonly unknown[], call: CopyCall): Promise<CopyAnswer> {
    if (COPY_WAITS.has(channel)) return this.#wait(channel, args, call)
    if (!COPY_READS.has(channel)) throw new Error(copyRefusals.changes(call.where))
    if (channel === "mako:live-snapshot") return this.#capture(await this.#captured(call))
    return this.read(call.conversationId, LiveHistoryReadSchema.parse(args[1]), call)
  }

  /** A read of a copy's history, as `mako:live-read` answers one (`LiveHistoryReader.read`). */
  async read(id: string, input: LiveHistoryRead, call: CopyCall): Promise<LiveHistoryChunk> {
    this.#records.prune()
    if (input.kind === "part") return this.#records.part(id, input.record, input.offset)
    if (this.#records.busy()) throw new Error("Other history reads are still finishing. Try this read again shortly.")
    if (input.kind === "snapshot") {
      const captured = await call.capture()
      if (!captured) return this.#records.open(id, null)
      const held = input.ifCurrent && this.#views.get(input.ifCurrent.token)
      if (held?.id === id && input.epoch !== undefined && held.snapshot.epoch === input.epoch && captured.snapshot.epoch === input.epoch &&
        captured.snapshot.revision === input.ifCurrent?.revision) {
        this.#touch(input.ifCurrent!.token, held)
        return this.#records.open(id, { kind: "unchanged", token: input.ifCurrent!.token, revision: captured.snapshot.revision, epoch: captured.snapshot.epoch })
      }
      return this.#records.open(id, this.#capture(captured, input.epoch !== undefined && input.epoch === captured.snapshot.epoch ? input.from : undefined))
    }
    const view = this.#views.get(input.token)
    if (!view || view.id !== id) throw new Error(HISTORY_VIEW_EXPIRED)
    this.#touch(input.token, view)
    if (input.kind === "earlier") {
      await this.#reach(view, input.before.base === view.snapshot.base?.start ? input.before.base - 1 : input.before.base)
      return this.#records.open(id, historyPage(input.token, view.snapshot, input.before, this.#versions))
    }
    if (input.kind === "range") {
      await this.#reach(view, input.from.base)
      return this.#records.open(id, historyRange(input.token, view.snapshot, input.from, input.to, this.#versions))
    }
    if (input.kind === "original") throw new Error(copyRefusals.original(call.where))
    if (input.at.kind === "live") throw new Error("That retained history item is unavailable.")
    // The view holds each entry of the pages it served whole, as its copy has it: what a page cut, `detail` reads here.
    const entryId = input.at.id
    const held = view.snapshot.base?.entries.find((entry) => entry.id === entryId)
    if (!held) throw new Error("That retained history item is unavailable.")
    if (isPartial(held)) throw new Error(`The whole of this output isn't in ${call.where}'s copy: it's read there once it's back.`)
    return this.#records.open(id, held.type === "tool" ? { ...held, historyVersion: this.#versions.of(held) } : held)
  }

  /** A conversation's views let go: its device is back, and windows read it there. */
  released(id: string): void {
    for (const [token, view] of this.#views) if (view.id === id) this.#views.delete(token)
  }

  async #captured(call: CopyCall): Promise<CopyCapture> {
    const captured = await call.capture()
    if (!captured) throw new Error(copyRefusals.none(call.where))
    return captured
  }

  /** A capture held as a view, and its newest page (back to `from`, when a window held that far) as the snapshot answered. */
  #capture(captured: CopyCapture, from?: LiveHistoryCursor): LiveSnapshot {
    const { snapshot, source } = captured
    const held = [...this.#views].find(([, view]) => view.id === snapshot.session.id && view.snapshot.epoch === snapshot.epoch && view.snapshot.revision === snapshot.revision)
    const token = held?.[0] ?? crypto.randomUUID()
    const view = held?.[1] ?? { id: snapshot.session.id, snapshot, source, used: Date.now() }
    this.#touch(token, view)
    for (const [stale] of [...this.#views].slice(0, Math.max(0, this.#views.size - COPY_VIEWS))) this.#views.delete(stale)
    return historyCapture(token, view.snapshot, this.#versions, from)
  }

  /** The view's entries read back from its copy until they start at or before `index`. */
  async #reach(view: CopyView, index: number): Promise<void> {
    let base = view.snapshot.base
    while (base?.hasEarlier && base.start > Math.max(0, index)) {
      const page = await view.source.page(base.start, COPY_PAGE)
      if (!page || page.start + page.entries.length !== base.start || page.header.stamp !== base.ref.revision) throw new Error(HISTORY_VIEW_EXPIRED)
      // Another read of this page may have prepended it meanwhile.
      if (view.snapshot.base !== base) {
        base = view.snapshot.base
        continue
      }
      base = { ...base, entries: [...page.entries, ...base.entries], start: page.start, hasEarlier: page.start > 0 }
      view.snapshot = { ...view.snapshot, base }
    }
  }

  /**
   * A message for a conversation whose device is off: kept by the account until that device takes it, under the
   * request's own ID, so the device runs it once whichever way it hears of it. Text only: a file attached stays where
   * it was sent from. Editing or removing a queued one acts on the account's, while it still waits. Windows read the
   * conversation again, so every one shows it waiting.
   */
  async #wait(channel: string, args: readonly unknown[], call: CopyCall): Promise<LiveRequest | LiveSnapshot> {
    const { waiting, where } = call
    if (!waiting) throw new Error(copyRefusals.changes(where))
    if (channel === "mako:live-prompt") {
      const [, requestId, text, attachments] = this.#inputs.of("mako:live-prompt").parse(args)
      if (attachments?.length) throw new Error(copyRefusals.files(where))
      await waiting.wait(requestId, text)
      call.retold()
      const request: LiveRequest = { id: requestId, text, attachments: [], status: "queued" }
      return request
    }
    const [, edit] = this.#inputs.of("mako:live-edit-queued").parse(args)
    if (edit.change.kind === "remove") await waiting.remove(edit.requestId)
    else if (edit.change.kind === "edit") await waiting.edit(edit.requestId, edit.expectedText, edit.change.text)
    // Pausing and resuming a waiting message changes nothing: it waits for its device either way.
    call.retold()
    return (await this.#captured(call)).snapshot
  }

  #touch(token: string, view: CopyView): void {
    view.used = Date.now()
    this.#views.delete(token)
    this.#views.set(token, view)
  }
}
