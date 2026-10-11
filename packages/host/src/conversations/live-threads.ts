import { errorMessage } from "../base/error-message.js"
import { hostWarn } from "../base/host-log.js"
import type { LiveSnapshot, LiveStartOptions, LiveSummary } from "../contracts/live-conversations.js"
import { SessionIdSchema, ThreadIdSchema, type Actor } from "../contracts/thread-identity.js"
import type { StartPurpose } from "../contracts/thread-purposes.js"
import type { JournalFacts, SourceRef } from "../threads/index.js"
import { threadIdentity } from "@mako/sessions"
import { snapshotFacts } from "./live-moves.js"
import type { Dependencies } from "./live-runtime.js"

type CapturedRef = NonNullable<LiveSnapshot["base"]>["ref"]

/**
 * A host's conversations in the Thread store: each journal registers into a
 * Session, and each request takes its actor's principal from it. Without the
 * store conversations run as before and carry no Thread identity.
 */
export class LiveThreads {
  private readonly dependencies: Pick<Dependencies, "threads" | "emit">
  /** What each journal last told the Thread store, so a flush registers only news. */
  private readonly registered = new Map<string, string>()
  private placementWarned = false

  constructor(dependencies: Pick<Dependencies, "threads" | "emit">) {
    this.dependencies = dependencies
  }

  /** The initiator of an admitted request: the local person unless a caller inside the host says otherwise. */
  actor(explicit?: Actor): Actor | undefined {
    return explicit ?? this.dependencies.threads?.person()
  }

  /**
   * Each host offers its journals to the Thread store at start, oldest
   * first. A journal registered before keeps its Session, so a restart
   * changes nothing; one written by a host without the store joins the
   * Session its paths and native IDs name.
   */
  registerJournals(journals: JournalFacts[]): void {
    const threads = this.dependencies.threads
    if (!threads || !journals.length) return
    try {
      threads.registerJournals(journals, { kind: "service", name: "migration" })
      for (const facts of journals) this.registered.set(facts.conversationId, registrationKey(facts))
    } catch (error) {
      hostWarn("threads", "journal registration failed", { error: errorMessage({ error }) })
    }
  }

  /** Register a journal when it is created or its bindings name something new. */
  register(snapshot: LiveSnapshot, actor: Actor | undefined): void {
    const threads = this.dependencies.threads
    if (!threads) return
    const facts = snapshotFacts(snapshot)
    const key = registrationKey(facts)
    if (this.registered.get(facts.conversationId) === key) return
    try {
      const placed = threads.registerJournal(facts, actor ?? { kind: "service", name: "catalog" })
      const first = !this.registered.has(facts.conversationId)
      this.registered.set(facts.conversationId, key)
      if (first && facts.session) this.announceGroup(placed.thread)
    } catch (error) {
      hostWarn("threads", "journal registration failed", { conversation: facts.conversationId, error: errorMessage({ error }) })
    }
  }

  /**
   * Only a new Thread is started for a purpose; a resume or a `+` tab joins
   * one that already is what it is. Written before the provider spawns, so
   * the row shows it from the first frame; a failure leaves it unmarked.
   */
  markPurpose(conversationId: string, purpose: StartPurpose, options: LiveStartOptions): void {
    const threads = this.dependencies.threads
    if (!threads || options.resume || options.session !== undefined) return
    try {
      const placed = threads.journalPlacement(conversationId)
      if (!placed) throw new Error("the conversation has no Thread yet")
      threads.markPurpose(placed.thread, purpose.kind, purpose.project)
      this.dependencies.emit({ type: "thread-purposes", purposes: threads.purposes() })
      // The name Mako gave the job stays the Thread's; no agent or model renames it.
      const kept = options.title ? threads.keepThreadTitle(placed.thread, options.title) : undefined
      if (kept) this.dependencies.emit({ type: "thread-titles", titles: [kept] })
    } catch (error) {
      hostWarn("threads", "a Thread's purpose could not be recorded", { conversation: conversationId, purpose: purpose.kind, error: errorMessage({ error }) })
    }
  }

  /**
   * A `+` tab's Session, checked before the journal exists: a tab left open
   * after its Session was merged away fails here and leaves no conversation.
   */
  startingSession(session: string): string {
    const id = SessionIdSchema.parse(session)
    if (this.dependencies.threads && !this.dependencies.threads.sessionPlacement(id))
      throw new Error("This tab's session no longer exists. Open a new tab and send again; your draft is kept.")
    return id
  }

  /**
   * Whether an existing journal is the same Session as the row being opened.
   * Two stores can share a native ID (a Cursor agent and its `chats/` copy);
   * the Thread store tells them apart. Without it, a journal captured from a
   * catalog row still names that row's identity (`captured`); one started
   * here does not, and its native ID decides.
   */
  sameSession(conversationId: string, ref: SourceRef, captured: () => CapturedRef | undefined): boolean {
    const threads = this.dependencies.threads
    if (!threads) {
      const source = captured()
      return !source || source.harness !== ref.harness || threadIdentity(source) === threadIdentity(ref)
    }
    try {
      const placed = threads.place(ref, { kind: "service", name: "catalog" })
      return threads.journalPlacement(conversationId)?.session === placed.session
    } catch (error) {
      hostWarn("threads", "capture ownership fell back to the native ID", { conversation: conversationId, error: errorMessage({ error }) })
      return true
    }
  }

  /**
   * The Thread and Session a window files this conversation under. Read at
   * the edge and never written into the journal: a merge or a move changes
   * it, and the store is the one place that knows.
   */
  placement(id: string): Pick<LiveSummary, "threadId" | "sessionId"> {
    try {
      const placed = this.dependencies.threads?.journalPlacement(id)
      return placed ? { threadId: placed.thread, sessionId: placed.session } : {}
    } catch (error) {
      if (!this.placementWarned) hostWarn("threads", "a conversation's Thread could not be read; it is served without one", { conversation: id, error: errorMessage({ error }) })
      this.placementWarned = true
      return {}
    }
  }

  /** Tell every window what a Thread's tabs are now, after a Session joined it. */
  announceGroup(thread: string): void {
    const threads = this.dependencies.threads
    if (!threads) return
    try {
      this.dependencies.emit({ type: "thread-group", change: { thread, group: threads.group(ThreadIdSchema.parse(thread)) ?? null } })
    } catch (error) {
      hostWarn("threads", "a Thread's tabs could not be announced", { thread, error: errorMessage({ error }) })
    }
  }
}

function registrationKey(facts: JournalFacts): string {
  return JSON.stringify([
    facts.threadPath ?? null,
    facts.ancestry?.parentId ?? null,
    facts.bindings.map((binding) => [binding.provider, binding.nativeId ?? null, binding.path ?? null]),
  ])
}
