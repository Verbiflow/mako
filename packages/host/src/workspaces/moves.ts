import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import type { MoveShares, WorkspaceMoveAnswer, WorkspaceMoveHold, WorkspaceMoveRequest, WorkspaceMoves as WorkspaceMovesState } from "../contracts/workspace-moves.js"

export interface MoveSource {
  cwd: string
  harness: string
  title?: string
  /** In the middle of a turn, or holding prompts that will start one. */
  busy: boolean
  /** What else keeps it from moving as it is, read after its title; see `LiveConversations.relocation`. */
  waiting?: string
}

export type MovePlace = { project: string; joins?: string; changed: number; shares?: MoveShares } | { refused: string }

interface Deps {
  /** Where "Always allow" is remembered. */
  file: string
  source(conversationId: string): MoveSource | undefined
  /** The Thread's other open Sessions in the same checkout, which move with this one. */
  companions(conversationId: string): string[]
  place(conversationId: string, cwd: string): Promise<MovePlace>
  /**
   * Carry the Session onto its Thread's own branch; its turn has ended.
   * `bring`: the person chose to bring what might be its and what nobody
   * can be named for too. Returns the conversation it goes on as there.
   */
  move(conversationId: string, bring: boolean): Promise<string>
  /**
   * Carry a companion into the worktree the move made, after `lead`, the
   * conversation the move began with as it goes on there; `told` when its
   * agent had asked to move too, so it hears where it is.
   */
  follow(conversationId: string, told: boolean, lead: string): Promise<void>
  announce(state: WorkspaceMovesState): void
  failed(conversationId: string, message: string): void
  /** How long the person's move waits for what its Sessions are finishing; 15 s unless a test says otherwise. */
  settleMs?: number
}

const SETTLE_MS = 15_000

const Remembered = z.object({ alwaysAllowed: z.array(z.string()) })

function remembered(file: string): string[] {
  try {
    return Remembered.parse(JSON.parse(readFileSync(file, "utf8"))).alwaysAllowed
  } catch {
    return []
  }
}

/**
 * Agents' requests to go on on their Thread's own branch.
 *
 * An agent asks through Mako's workspace tools and gets its answer at once:
 * the tool never waits on the user, because harnesses give MCP calls a
 * minute or so. The user answers in the composer, once or for the whole
 * project. The whole Thread moves: an allowed move is carried out once the
 * agent's turn and every companion's have ended, so nothing is pulled from
 * under a running turn, and the companions follow into the same worktree.
 * The person moves the Thread from the composer the same way (`moveNow`).
 * An agent that makes its own worktree instead is left to it.
 */
export class WorkspaceMoves {
  private readonly requests = new Map<string, WorkspaceMoveRequest>()
  private readonly declined = new Set<string>()
  private readonly moving = new Set<string>()
  private readonly settling = new Set<() => void>()
  private readonly deps: Deps
  private alwaysAllowed: string[]

  constructor(deps: Deps) {
    this.deps = deps
    this.alwaysAllowed = remembered(deps.file)
  }

  state(): WorkspaceMovesState {
    for (const id of this.requests.keys()) if (!this.deps.source(id)) this.requests.delete(id)
    return { requests: [...this.requests.values()], alwaysAllowed: [...this.alwaysAllowed] }
  }

  /** Where this conversation's request stands, for the agent's status tool. */
  answerFor(conversationId: string): "asking" | "allowed" | "declined" | "moving" | undefined {
    if (this.moving.has(conversationId)) return "moving"
    if (this.declined.has(conversationId)) return "declined"
    return this.requests.get(conversationId)?.state
  }

  /** The agent asked; returns what the tool tells it. */
  async ask(conversationId: string): Promise<string> {
    const source = this.deps.source(conversationId)
    if (!source) throw new Error("Mako isn't running this conversation, so it can't move it.")
    if (this.moving.has(conversationId)) return "Mako is moving this Session into this Thread's worktree now."
    let request = this.requests.get(conversationId)
    if (!request) {
      const place = await this.deps.place(conversationId, source.cwd)
      if ("refused" in place) throw new Error(place.refused)
      this.declined.delete(conversationId)
      request = {
        id: randomUUID(),
        conversationId,
        harness: source.harness,
        project: place.project,
        changed: place.changed,
        state: this.alwaysAllowed.includes(place.project) ? "allowed" : "asking",
      }
      if (source.title) request.title = source.title
      if (place.joins) request.joins = place.joins
      if (place.shares) request.shares = place.shares
      const companions = this.deps.companions(conversationId).length
      if (companions) request.companions = companions
      this.requests.set(conversationId, request)
      this.announce()
    }
    const where = request.joins ? `into this Thread's worktree, on ${request.joins}` : "into a new worktree for this Thread, on a branch of its own"
    const carried = request.joins ? "" : carriedText(request)
    const others = request.companions ?? 0
    const when = others ? `When this turn and those of this Thread's ${others === 1 ? "other Session" : `${others} other Sessions`} here end, Mako moves them all` : "When this turn ends, Mako moves the Session"
    const then = `${when} ${where}${carried}, and sends you a message there to carry on. Finish this turn now: make no further edits here, and tell the user you'll continue in the worktree.`
    return request.state === "allowed"
      ? `Allowed: this project lets agents move without asking. ${then}`
      : `Asked the user. Their answer is in a card above the composer; worktree_status shows it. If they allow it: ${then} If they don't, keep working here.`
  }

  answer(id: string, answer: WorkspaceMoveAnswer): void {
    const request = [...this.requests.values()].find((candidate) => candidate.id === id)
    if (!request) return
    if (answer === "deny") {
      this.requests.delete(request.conversationId)
      this.declined.add(request.conversationId)
      this.announce()
      return
    }
    if (answer === "always" && !this.alwaysAllowed.includes(request.project)) {
      this.alwaysAllowed = [...this.alwaysAllowed, request.project]
      this.remember()
    }
    request.state = "allowed"
    this.announce()
    this.settled(request.conversationId)
  }

  /** The person chose whether the changes that might be the Thread's, and those nobody can be named for, come too. */
  bring(id: string, bring: boolean): void {
    const request = [...this.requests.values()].find((candidate) => candidate.id === id)
    if (!request || Boolean(request.bring) === bring) return
    if (bring) request.bring = true
    else delete request.bring
    this.announce()
  }

  /** Agents in this project ask again. */
  forget(project: string): void {
    if (!this.alwaysAllowed.includes(project)) return
    this.alwaysAllowed = this.alwaysAllowed.filter((candidate) => candidate !== project)
    this.remember()
    this.announce()
  }

  /**
   * The person moved the Thread from the composer, so nothing is asked. What
   * its Sessions are finishing, a turn or its checkpoint, gets a short wait;
   * anything still going on then refuses the move, saying what, and nothing
   * moves. `carry` moves this Session, `told` when its agent had asked to
   * move; the Thread's other Sessions here follow it, as `following`.
   */
  async moveNow<T extends { session: { id: string } }>(conversationId: string, carry: (told: boolean) => Promise<T>): Promise<{ moved: T; following: Promise<void> }> {
    const all = () => [conversationId, ...this.deps.companions(conversationId)]
    const already = () => {
      if (all().some((id) => this.moving.has(id))) throw new Error("Mako is already moving this Thread onto its own branch.")
    }
    already()
    const held = await this.heldWithin(conversationId, all, this.deps.settleMs ?? SETTLE_MS)
    if (held) throw new Error(`${held.charAt(0).toUpperCase()}${held.slice(1)}, so the Thread can't move onto its own branch yet. Move it once ${held.includes("; ") ? "they're" : "that's"} done.`)
    already()
    const [, ...companions] = all()
    const told = this.take([conversationId, ...companions])
    let moved: T
    try {
      moved = await carry(told.has(conversationId))
    } catch (error) {
      this.release([conversationId, ...companions])
      throw error
    }
    return { moved, following: this.follow(conversationId, moved.session.id, companions, told) }
  }

  /**
   * What the person's move of a Thread would meet now, for the composer to
   * say before it's chosen: the Sessions it brings along, and what holds it
   * as `moveNow` would refuse it. `lead` is the Session on screen, when it
   * is live; a Thread shown in the viewer has none yet.
   */
  hold(lead: string | undefined, companions: readonly string[]): WorkspaceMoveHold {
    const ids = lead ? [lead, ...companions] : [...companions]
    const hold: WorkspaceMoveHold = {
      companions: companions.map((id) => {
        const title = this.deps.source(id)?.title
        return title ? { id, title } : { id }
      }),
    }
    if (ids.some((id) => this.moving.has(id))) hold.moving = true
    const held = this.held(lead, ids, true)
    if (held) hold.held = held
    return hold
  }

  /** A conversation changed: an allowed move whose turns have all ended goes ahead, and a move waiting on it looks again. */
  settled(conversationId: string): void {
    for (const wake of this.settling) wake()
    for (const request of this.requests.values())
      if (request.state === "allowed" && (request.conversationId === conversationId || this.deps.companions(request.conversationId).includes(conversationId)))
        this.go(request.conversationId)
  }

  private go(conversationId: string): void {
    if (this.moving.has(conversationId)) return
    const source = this.deps.source(conversationId)
    const companions = source ? this.deps.companions(conversationId).filter((id) => !this.moving.has(id)) : []
    if (source?.busy || companions.some((id) => this.deps.source(id)?.busy)) return
    const request = this.requests.get(conversationId)
    const waiting = source && this.held(conversationId, [conversationId, ...companions], false)
    if (waiting) {
      if (request && request.waiting !== waiting) {
        request.waiting = waiting
        this.announce()
      }
      return
    }
    this.requests.delete(conversationId)
    if (!source) {
      this.announce()
      return
    }
    const told = this.take([conversationId, ...companions])
    void this.deps.move(conversationId, request?.bring ?? false).then(
      (lead) => this.follow(conversationId, lead, companions, told),
      (error) => {
        this.deps.failed(conversationId, error instanceof Error ? error.message : String(error))
        this.release([conversationId, ...companions])
      })
  }

  /**
   * What keeps these Sessions from moving, each named, as in "this session
   * is running a turn; “Helper” has background tasks running"; empty when nothing does.
   * A running turn counts only when `turns`; the agent's own move waits on
   * those quietly.
   */
  private held(lead: string | undefined, ids: readonly string[], turns: boolean): string {
    return ids.flatMap((id) => {
      const source = this.deps.source(id)
      const why = turns && source?.busy ? "is running a turn" : source?.waiting
      return why ? [`${id === lead ? "this session" : source?.title ? `“${source.title}”` : "another session"} ${why}`] : []
    }).join("; ")
  }

  /** `held` once nothing holds these Sessions, or after `ms` as it is then; `settled` wakes it. */
  private async heldWithin(lead: string, ids: () => readonly string[], ms: number): Promise<string> {
    const deadline = Date.now() + ms
    let held = this.held(lead, ids(), true)
    while (held && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          this.settling.delete(done)
          resolve()
        }
        const timer = setTimeout(done, deadline - Date.now())
        this.settling.add(done)
      })
      held = this.held(lead, ids(), true)
    }
    return held
  }

  /** Mark these Sessions as moving; their own requests are answered by this move. Returns those that had asked. */
  private take(ids: readonly string[]): Set<string> {
    const told = new Set(ids.filter((id) => this.requests.has(id)))
    for (const id of ids) {
      this.moving.add(id)
      this.requests.delete(id)
      this.declined.delete(id)
    }
    this.announce()
    return told
  }

  private release(ids: readonly string[]): void {
    for (const id of ids) this.moving.delete(id)
    this.announce()
  }

  /** The companions follow the Session the move began with, one at a time; one that can't is reported, and the rest still go. */
  private async follow(from: string, lead: string, companions: readonly string[], told: ReadonlySet<string>): Promise<void> {
    try {
      for (const id of companions)
        await this.deps.follow(id, told.has(id), lead).catch((error) => this.deps.failed(id, error instanceof Error ? error.message : String(error)))
    } finally {
      this.release([from, ...companions])
    }
  }

  private announce(): void {
    this.deps.announce(this.state())
  }

  private remember(): void {
    const temporary = `${this.deps.file}.${process.pid}.tmp`
    mkdirSync(dirname(this.deps.file), { recursive: true })
    writeFileSync(temporary, JSON.stringify({ alwaysAllowed: this.alwaysAllowed }, null, 2))
    renameSync(temporary, this.deps.file)
  }
}

/**
 * What the agent hears comes along: the Thread's own changes, by the
 * journal's last writer of each line, and what stays.
 */
function carriedText(request: WorkspaceMoveRequest): string {
  const count = (n: number) => `${n} ${n === 1 ? "file" : "files"}`
  const shares = request.shares
  if (!shares) return request.changed ? `, taking only this Thread's own changes among the ${count(request.changed)} uncommitted in this checkout` : ""
  const parts = [`, taking this Thread's own uncommitted changes (${shares.thread.files ? count(shares.thread.files) : "none yet"})`]
  const others = shares.kept ?? shares.others.files + shares.person.files
  const unsure = shares.uncertain.files + shares.unattributed.files
  if (others) parts.push(`; other Threads' and the user's changes (${count(others)}) stay in the main checkout`)
  if (unsure) parts.push(request.bring
    ? `; the user chose to bring the ${count(unsure)} whose changes might be this Thread's or nobody can be named for`
    : `; ${count(unsure)} whose changes might be this Thread's or nobody can be named for stay unless the user brings them`)
  return parts.join("")
}
