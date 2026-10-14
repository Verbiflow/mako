import type { ReportedCall } from "@mako/protocol"
import type { ChildSource, Thread } from "@mako/sessions"
import { savedToolEffects } from "@mako/sessions/tool-effect-reading"
import { callId } from "./child-calls.js"
import { reportedEffect } from "./live-activity.js"
import { within } from "./paths.js"

/*
 * Uncommitted lines nobody is sure of, given to the session whose record
 * shows it wrote them. Every uncommitted line was written by the person or
 * by an agent; an agent's session leaves a record, and Mako's catalog knows
 * every session on this Mac and the Thread it's in, started in Mako or not.
 * So lines there before tracking, written while the host was away, through
 * a gap of lost events, or by a session Mako never ran are read back from
 * the records of the sessions that worked there, their child agents' too.
 *
 * Only sessions that worked in the checkout since its oldest such line are
 * opened, newest first, within a budget; a later pass opens only sessions
 * that moved since the last. Lines no record wrote are the person's, as far
 * as anyone can tell, and stay where they are.
 */

/** Sessions opened in one pass, at most. */
const MAX_SESSIONS = 48
/** A pass stops opening sessions after this long. */
const BUDGET_MS = 20_000
/** Lines there before tracking, or whose writer was never seen, could be this old: what Mako keeps. */
const LOOKBACK_MS = 14 * 86_400_000

/** What backfill reads of a catalogued session. */
export interface BackfillSession {
  harness: string
  nativeId: string
  path: string
  cwd?: string
  currentCwd?: string
  worktrees?: readonly { path: string }[]
  updatedAt?: string
  threadId?: string
  sessionId?: string
}

export interface BackfillDeps {
  sessions(): readonly BackfillSession[]
  records: ChildSource
  /** Text files with uncommitted lines nobody is sure of, each with its tracked root and its oldest such change's time (0: unknown). */
  unsure(): ReadonlyMap<string, { root: string; since: number }>
  reconcile(calls: readonly ReportedCall[]): Promise<{ entries: number; lines: number }>
  now(): number
  log?(message: string, facts: Readonly<Record<string, string | number | boolean>>): void
}

export interface BackfillResult {
  sessions: number
  calls: number
  entries: number
  lines: number
  ms: number
  /** The budget ran out before every session that could have was opened. */
  partial: boolean
}

export class Backfill {
  private readonly deps: BackfillDeps
  /** When each session was read last, by path, at the `updatedAt` it had then. */
  private readonly read = new Map<string, string>()
  /** The unsure files the last pass read for, with their oldest change's time. */
  private readonly readFor = new Map<string, number>()
  private running?: Promise<BackfillResult>

  constructor(deps: BackfillDeps) {
    this.deps = deps
  }

  /** Read back what sessions that worked in `folder` (every tracked folder when unset) wrote to its unsure lines. */
  run(folder?: string, budgetMs = BUDGET_MS): Promise<BackfillResult> {
    // One pass at a time: a second asked for meanwhile reads what moved since.
    const previous = this.running ?? Promise.resolve(undefined)
    const next = previous.then(() => this.pass(folder, budgetMs), () => this.pass(folder, budgetMs))
    this.running = next.finally(() => {
      if (this.running === next) this.running = undefined
    })
    return next
  }

  private async pass(folder: string | undefined, budgetMs: number): Promise<BackfillResult> {
    const started = this.deps.now()
    const result: BackfillResult = { sessions: 0, calls: 0, entries: 0, lines: 0, ms: 0, partial: false }
    const unsure = new Map([...this.deps.unsure()].filter(([path]) => !folder || within(folder, path)))
    if (!unsure.size) return result
    // Lines unsure since the last pass (a stash popped, a gap) may be any session's, however long it's been still.
    if ([...unsure].some(([path, file]) => this.readFor.get(path) !== file.since)) this.read.clear()
    for (const [path, file] of unsure) this.readFor.set(path, file.since)
    const oldest = Math.min(...[...unsure.values()].map((file) => file.since))
    const since = oldest === 0 ? started - LOOKBACK_MS : oldest
    const roots = new Set([...unsure.values()].map((file) => file.root))
    // A session in the repository, in a folder of it, or in a project folder holding it.
    const worked = (session: BackfillSession) =>
      [session.cwd, session.currentCwd, ...(session.worktrees ?? []).map((worktree) => worktree.path)]
        .some((at) => at !== undefined && [...roots].some((root) => within(root, at) || within(at, root)))
    const candidates = this.deps.sessions()
      .filter((session) => session.threadId && session.sessionId && session.updatedAt && Date.parse(session.updatedAt) >= since && worked(session))
      .filter((session) => this.read.get(session.path) !== session.updatedAt)
      .sort((left, right) => Date.parse(right.updatedAt!) - Date.parse(left.updatedAt!))
    const calls: ReportedCall[] = []
    for (const session of candidates) {
      if (result.sessions >= MAX_SESSIONS || this.deps.now() - started > budgetMs) {
        result.partial = true
        break
      }
      try {
        const own = await this.deps.records.open(session.path)
        if (own) calls.push(...this.calls(session, own, undefined, unsure))
        const children = await this.deps.records.children(session.path).catch(() => null)
        for (const child of children?.children ?? []) {
          if (!child.path || child.state.kind === "missing" || this.deps.now() - started > budgetMs) continue
          const thread = await this.deps.records.open(child.path).catch(() => null)
          if (thread) calls.push(...this.calls(session, thread, child.nativeId, unsure))
        }
        this.read.set(session.path, session.updatedAt!)
        result.sessions++
      } catch (error) {
        this.deps.log?.("a session's record could not be read back", { path: session.path, error: error instanceof Error ? error.message : String(error) })
      }
    }
    result.calls = calls.length
    if (calls.length) {
      const found = await this.deps.reconcile(calls)
      result.entries = found.entries
      result.lines = found.lines
    }
    result.ms = this.deps.now() - started
    if (result.sessions) this.deps.log?.("backfill", { ...result })
    return result
  }

  /** A record's calls that wrote to an unsure file, as the session's own. */
  private calls(session: BackfillSession, thread: Thread, child: string | undefined, unsure: ReadonlyMap<string, unknown>): ReportedCall[] {
    const out: ReportedCall[] = []
    for (const call of savedToolEffects(thread.ref.harness, thread.entries, thread.ref.cwd ?? session.cwd)) {
      const effects = call.effects.filter((effect) => (effect.kind === "create" || effect.kind === "write" || effect.kind === "modify") && unsure.has(effect.path))
      if (!effects.length) continue
      const reported: ReportedCall = {
        thread: session.threadId!,
        session: session.sessionId!,
        call: child ? callId(child, call.callId) : call.callId.slice(0, 200),
        status: call.status,
        effects: effects.map(reportedEffect),
      }
      if (call.startedAt !== undefined) reported.startedAt = call.startedAt
      if (call.endedAt !== undefined) reported.endedAt = call.endedAt
      out.push(reported)
    }
    return out
  }
}