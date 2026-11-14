import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ThreadId } from "../contracts/thread-identity.js"
import { childSince, childState, type ChildThread, type ChildJournal } from "../contracts/agents.js"
import type { SessionMemory, ThreadStore } from "../threads/index.js"
import { storedRetirementState } from "./live-journal.js"

interface Deps {
  store: ThreadStore
  dataRoot: string
  memory?: Pick<SessionMemory, "routeForConversation" | "runtimeLaunch" | "hostDataRoots"> | null
  /** Current host state takes precedence over historical records. */
  busy?(conversation: string): boolean
  fin?(thread: ThreadId): number | undefined
}

/** Every Thread's own records, not a roster scoped to the calling Apex or the visible rail. */
export class WorktreeThreadState {
  private readonly deps: Deps

  constructor(deps: Deps) { this.deps = deps }

  finished(thread: ThreadId): number | undefined {
    try {
      const { store } = this.deps
      const record = store.thread(thread)
      if (!record) return undefined
      const edge = store.edges().of(thread)
      const conversations = store.threadConversations([thread]).get(thread) ?? []
      if (conversations.flat().some(id => this.deps.busy?.(id))) return undefined
      const ends: number[] = []
      for (const session of conversations) {
        const id = session.at(-1)
        if (!id) continue
        const endpoint = this.deps.memory?.routeForConversation(id)
        const launch = endpoint && this.deps.memory?.runtimeLaunch(endpoint.socket)
        const roots = launch ? [launch.dataRoot] : [...new Set([this.deps.dataRoot, ...this.deps.memory?.hostDataRoots() ?? []])]
        const homes = roots.map(root => join(root, "conversations")).filter(root => existsSync(join(root, `${id}.sqlite`)))
        // Multiple unowned copies are not a license to choose whichever one looks finished.
        if (homes.length !== 1) return undefined
        const state = storedRetirementState(homes[0]!, id)
        if (!state?.finished) return undefined
        ends.push(state.at)
      }
      // Pending records on another profile must not be hidden by this host's in-memory Fin reading.
      if (edge && this.deps.fin) {
        const at = this.deps.fin(thread)
        return at === undefined ? undefined : Math.max(at, ...ends)
      }
      if (edge) {
        if (store.queuedSpawns().some(queued => queued.op === edge.op) || edge.run?.stopping?.unconfirmed) return undefined
        const latest = store.reportsOf(thread).at(-1)
        const answer = latest && store.answerOf(latest.id)
        const end = edge.run?.ended
        const reading: ChildThread = {
          source: edge.placed ? "placed" : edge.run ? "followed" : "live",
          ...(edge.placed?.working && { working: true }),
          ...(edge.run && !end && (!latest || latest.at < edge.run.startedAt) && { working: true }),
          ...(end && { ended: { outcome: end.kind, at: end.at } }),
        }
        const journal: ChildJournal = { latest, ...(answer && { answered: { by: answer.by, answer: answer.answer, ask: answer.ask, at: answer.at, ...(answer.delivered && { delivered: true as const }) } }) }
        const state = childState(edge, reading, journal)
        if (state.kind !== "ended") return undefined
        return Math.max(childSince(edge, reading, journal, state) ?? 0, ...ends)
      }
      // Native-only or empty Threads without a terminal lifecycle record stay unknown.
      return ends.length ? Math.max(...ends) : undefined
    } catch { return undefined }
  }
}
