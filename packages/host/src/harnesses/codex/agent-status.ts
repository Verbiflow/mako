import { z } from "zod"

export const CodexAgentRunSchema = z.object({
  id: z.string().min(1).max(512),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
})
export type CodexAgentRun = z.infer<typeof CodexAgentRunSchema>
export const CodexAgentRunsSchema = z.object({
  data: z.array(CodexAgentRunSchema.extend({
    itemsView: z.literal("notLoaded"),
    items: z.array(z.unknown()).max(0),
  })).max(1),
})

interface StatusSource {
  read(nativeId: string): Promise<CodexAgentRun | null>
  publish(nativeId: string, run: CodexAgentRun): void
}

interface Observation {
  revision: number
  pending: boolean
  failures: number
  polls: number
  due: number
}

/** Read current child turns, never execute/resume a child to discover its state. */
export class CodexAgentStatus {
  private readonly observations = new Map<string, Observation>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private active = 0

  private readonly source: StatusSource
  constructor(source: StatusSource) { this.source = source }

  observe(nativeId: string): void {
    if (this.disposed) return
    let observation = this.observations.get(nativeId)
    if (!observation) {
      if (this.observations.size >= 1024) {
        const settled = [...this.observations].find(([, entry]) => entry.due === Infinity && !entry.pending)
        if (!settled) return
        this.observations.delete(settled[0])
      }
      observation = { revision: 0, pending: false, failures: 0, polls: 0, due: 0 }
      this.observations.set(nativeId, observation)
    }
    observation.revision += 1
    observation.due = 0
    observation.polls = 0
    this.schedule()
  }

  forget(nativeId: string): void {
    this.observations.delete(nativeId)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.observations.clear()
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.active >= 4) return
    const next = Math.min(...[...this.observations.values()]
      .filter((entry) => !entry.pending).map((entry) => entry.due))
    if (!Number.isFinite(next)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const [nativeId, entry] of this.observations) {
        if (this.active >= 4) break
        if (!entry.pending && entry.due <= Date.now()) void this.refresh(nativeId, entry)
      }
      this.schedule()
    }, Math.max(0, next - Date.now()))
    this.timer.unref()
  }

  private async refresh(nativeId: string, entry: Observation): Promise<void> {
    entry.pending = true
    this.active += 1
    const revision = entry.revision
    try {
      const run = await this.source.read(nativeId)
      if (this.disposed || this.observations.get(nativeId) !== entry || entry.revision !== revision) return
      if (!run) throw new Error("Child has no observed turn")
      entry.failures = 0
      // Legacy servers can rebuild history even for a metadata-only page.
      // Native activity triggers immediate reads; missing events use a backing-off poll.
      entry.polls = Math.min(entry.polls + 1, 5)
      entry.due = run.status === "inProgress"
        ? Date.now() + Math.min(30_000, 1000 * 2 ** entry.polls) : Infinity
      this.source.publish(nativeId, run)
    } catch {
      if (!this.disposed && entry.revision === revision) {
        entry.failures = Math.min(entry.failures + 1, 4)
        entry.due = Date.now() + Math.min(30_000, 2000 * 2 ** entry.failures)
      }
      // Missing/unsupported/failed reads cannot manufacture terminal evidence.
    } finally {
      entry.pending = false
      this.active -= 1
      this.schedule()
    }
  }
}
