import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import type { WorkspaceMoveAnswer, WorkspaceMoveRequest, WorkspaceMoves as WorkspaceMovesState } from "./contracts/workspace-moves.js"

export interface MoveSource {
  cwd: string
  harness: string
  title?: string
  /** In the middle of a turn, or holding prompts that will start one. */
  busy: boolean
}

export type MovePlace = { project: string; joins?: string; changed: number } | { refused: string }

interface Deps {
  /** Where "Always allow" is remembered. */
  file: string
  source(conversationId: string): MoveSource | undefined
  /** The Thread's other open Sessions in the same checkout, which move with this one. */
  companions(conversationId: string): string[]
  place(conversationId: string, cwd: string): Promise<MovePlace>
  /** Carry the Session onto its Thread's own branch; its turn has ended. */
  move(conversationId: string): Promise<void>
  /** Carry a companion into the worktree the move made, without starting a turn. */
  follow(conversationId: string): Promise<void>
  announce(state: WorkspaceMovesState): void
  failed(conversationId: string, message: string): void
}

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
 * An agent that makes its own worktree instead is left to it.
 */
export class WorkspaceMoves {
  private readonly requests = new Map<string, WorkspaceMoveRequest>()
  private readonly declined = new Set<string>()
  private readonly moving = new Set<string>()
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
      const companions = this.deps.companions(conversationId).length
      if (companions) request.companions = companions
      this.requests.set(conversationId, request)
      this.announce()
    }
    const where = request.joins ? `into this Thread's worktree, on ${request.joins}` : "into a new worktree for this Thread, on a branch of its own"
    const carried = request.changed ? `, with the ${request.changed === 1 ? "uncommitted file" : `${request.changed} uncommitted files`} in this checkout` : ""
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

  /** Agents in this project ask again. */
  forget(project: string): void {
    if (!this.alwaysAllowed.includes(project)) return
    this.alwaysAllowed = this.alwaysAllowed.filter((candidate) => candidate !== project)
    this.remember()
    this.announce()
  }

  /** A conversation changed: an allowed move whose turns have all ended goes ahead. */
  settled(conversationId: string): void {
    for (const request of this.requests.values())
      if (request.state === "allowed" && (request.conversationId === conversationId || this.deps.companions(request.conversationId).includes(conversationId)))
        this.go(request.conversationId)
  }

  private go(conversationId: string): void {
    if (this.moving.has(conversationId)) return
    const source = this.deps.source(conversationId)
    const companions = source ? this.deps.companions(conversationId).filter((id) => !this.moving.has(id)) : []
    if (source?.busy || companions.some((id) => this.deps.source(id)?.busy)) return
    this.requests.delete(conversationId)
    if (!source) {
      this.announce()
      return
    }
    const all = [conversationId, ...companions]
    for (const id of all) {
      this.moving.add(id)
      this.requests.delete(id)
    }
    this.announce()
    void (async () => {
      try {
        await this.deps.move(conversationId)
      } catch (error) {
        this.deps.failed(conversationId, error instanceof Error ? error.message : String(error))
        return
      }
      for (const id of companions)
        await this.deps.follow(id).catch((error) => this.deps.failed(id, error instanceof Error ? error.message : String(error)))
    })().finally(() => {
      for (const id of all) this.moving.delete(id)
      this.announce()
    })
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
