import { COPY_PAGE, CopyHistory, copySnapshot, copyThreadPage, type CopyAnswer, type CopyCapture } from "@mako/host/contracts/copy-history"
import { recordsOverHttp } from "@mako/protocol/records-http"
import type { RecordRemote } from "@mako/protocol/records"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { WaitingListSchema, type WaitingMessage } from "@mako/protocol/waiting"
import { CopyReader, type CopyRead } from "@mako/sessions/copy-reader"
import { createHook, createStore } from "@/state/store"
import { accountListStore } from "./account-list"
import { CONSOLE_LOG, type Gateway } from "./gateway"
import { IndexedCopyStore } from "./copy-store"
import { sessionOf } from "./threads"

/** The copies this page read lately, newest last: what Diagnostics says of how the last one was read. */
export const copyReadsStore = createStore<{ reads: readonly CopyRead[] }>({ reads: [] })
export const useCopyReads = createHook(copyReadsStore)
const READS_SAID = 4

/**
 * Conversations of Macs that are off whose copy this page can't show: `none`, the account has none yet; `unreadable`,
 * neither the account nor this browser's storage could give it. Their screen says why instead (`QuietSession`).
 */
export const copyMissingStore = createStore<{ missing: ReadonlyMap<string, "none" | "unreadable"> }>({ missing: new Map() })
export const useCopyMissing = createHook(copyMissingStore)

function missing(conversation: string, why: "none" | "unreadable" | undefined): void {
  const held = copyMissingStore.get().missing
  if (held.get(conversation) === why) return
  const next = new Map(held)
  if (why) next.set(conversation, why)
  else next.delete(conversation)
  copyMissingStore.set({ missing: next })
}

/**
 * The conversations this browser reads from their devices' copies while those devices are off: each copy read from the
 * device's records in the account (`/v1/devices/<id>/records`, as this browser's device, which reads every device of
 * its account), kept here for opening offline (`IndexedCopyStore`), and answered as a Mac answers it (`CopyHistory`).
 * A message sent to one waits in the account for its device, by the same routes a Mac's window uses.
 */
export class WebCopies {
  readonly #gateway: Gateway
  readonly #reader: CopyReader
  readonly #history = new CopyHistory()
  readonly #remotes = new Map<string, RecordRemote>()
  /** What the account answered last of a Session's waiting messages, until its list says it again. */
  readonly #answered = new Map<string, readonly WaitingMessage[]>()
  /** How many times each Session's waiting messages changed here: a copy's revision moves with them. */
  readonly #changes = new Map<string, number>()
  readonly #retold: (conversation: string) => void

  constructor(options: { gateway: Gateway; retold: (conversation: string) => void }) {
    this.#gateway = options.gateway
    this.#retold = options.retold
    this.#reader = new CopyReader({
      remote: (device) => this.#remote(device),
      store: new IndexedCopyStore(),
      // Read with the first chunk that needs it, so a page that never opens a copy never loads the decoder.
      decode: async (frame) => (await import("fzstd")).decompress(frame),
      log: (level, message, fields) => CONSOLE_LOG[level](`copies: ${message}`, fields),
      // A copy opened from this browser's storage, and the account's newer: an open window reads it again, in place.
      changed: (device, harness, nativeId) => {
        const row = accountListStore.get().rows.find((each) => each.runsOn.kind === "device" && each.runsOn.deviceId === device && each.harness === harness && each.nativeId === nativeId)
        if (row) this.#retold(row.conversation)
      },
    })
    let before = accountListStore.get().waiting
    accountListStore.subscribe(() => {
      const { waiting } = accountListStore.get()
      if (waiting === before) return
      const changed = [...waiting].flatMap(([session, messages]) => (before.get(session) !== messages ? [session] : []))
      for (const session of before.keys()) if (!waiting.has(session)) changed.push(session)
      before = waiting
      for (const session of changed) this.#heard(session)
    })
  }

  /** A call to conversation `row`, whose device is off: answered from its copy, or waiting in the account for it. */
  call(row: ListedSession, channel: string, args: readonly unknown[]): Promise<CopyAnswer> {
    const where = this.#where(row)
    const session = row.session
    return this.#history.call(channel, args, {
      conversationId: row.conversation,
      where,
      capture: () => this.#capture(row, where),
      waiting: {
        wait: (requestId, text) => this.#waited(session, this.#gateway.rest("PUT", `/v1/sessions/${encodeURIComponent(session)}/waiting/${encodeURIComponent(requestId)}`, { conversation: row.conversation, text })),
        edit: (requestId, expectedText, text) => this.#waited(session, this.#gateway.rest("POST", `/v1/sessions/${encodeURIComponent(session)}/waiting/${encodeURIComponent(requestId)}/edit`, { expectedText, text })),
        remove: (requestId) => this.#waited(session, this.#gateway.rest("DELETE", `/v1/sessions/${encodeURIComponent(session)}/waiting/${encodeURIComponent(requestId)}`)),
      },
      retold: () => {
        this.#changes.set(session, (this.#changes.get(session) ?? 0) + 1)
        this.#retold(row.conversation)
      },
    })
  }

  /** Its device is back: windows read the conversation there, and its views of the copy go. */
  released(conversation: string): void {
    this.#history.released(conversation)
    missing(conversation, undefined)
  }

  async #capture(row: ListedSession, where: string): Promise<CopyCapture | null> {
    try {
      const captured = await this.#captured(row, where)
      missing(row.conversation, captured ? undefined : "none")
      return captured
    } catch (error) {
      missing(row.conversation, "unreadable")
      throw error
    } finally {
      copyReadsStore.set({ reads: this.#reader.reads().slice(-READS_SAID) })
    }
  }

  async #captured(row: ListedSession, where: string): Promise<CopyCapture | null> {
    if (row.runsOn.kind !== "device" || !row.nativeId) return null
    const copy = await this.#reader.open(row.runsOn.deviceId, row.harness, row.nativeId)
    if (!copy) return null
    const page = await copy.page(undefined, COPY_PAGE)
    // Paging back, or opening it offline later, reads what this fills in once its newest page is drawn.
    void copy.fill()
    const listed = sessionOf(row, accountListStore.get()).summary
    const snapshot = copySnapshot(
      {
        conversationId: row.conversation,
        harness: row.harness,
        createdAt: Date.parse(row.createdAt),
        listed: { ...listed, elsewhere: where },
        waiting: this.#answered.get(row.session) ?? accountListStore.get().waiting.get(row.session) ?? [],
        waitingChanges: this.#changes.get(row.session) ?? 0,
      },
      copyThreadPage(page, `copy:${row.conversation}`)
    )
    return { snapshot, source: { page: (before, limit) => copy.page(before, limit) } }
  }

  async #waited(session: string, answer: Promise<unknown>): Promise<void> {
    this.#answered.set(session, WaitingListSchema.parse(await answer).messages)
  }

  /** The account's list says a Session's waiting messages again: its word from now, and its conversation read again. */
  #heard(session: string): void {
    this.#answered.delete(session)
    this.#changes.set(session, (this.#changes.get(session) ?? 0) + 1)
    const row = accountListStore.get().rows.find((each) => each.session === session)
    if (row) this.#retold(row.conversation)
  }

  #where(row: ListedSession): string {
    return (row.runsOn.kind === "device" ? accountListStore.get().devices.get(row.runsOn.deviceId)?.name : undefined) ?? "Its computer"
  }

  #remote(device: string): RecordRemote {
    let remote = this.#remotes.get(device)
    if (!remote) {
      const base = new URL(`/v1/devices/${encodeURIComponent(device)}/records`, this.#gateway.origin).toString()
      remote = recordsOverHttp({ id: base, base, authorization: async () => `Bearer ${(await this.#gateway.connection()).token}` })
      this.#remotes.set(device, remote)
    }
    return remote
  }
}
