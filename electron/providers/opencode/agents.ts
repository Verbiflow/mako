import { Worker } from "node:worker_threads"
import { openCodeDatabasePaths } from "@mako/sessions"
import { z } from "zod"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { NativeAgentObservationSchema, type NativeAgentObservation } from "../../contracts/native-agents.js"
import type { AcpAgentObserver } from "../acp-source.js"

const reply = z.discriminatedUnion("kind", [z.object({ kind: z.literal("observed"), agents: z.array(NativeAgentObservationSchema) }), z.object({ kind: z.literal("unavailable") })])
const sessionId = z.string().regex(/^ses_[a-zA-Z0-9]+$/)
const resume = z.object({ sessionID: sessionId })
const result = z.object({ metadata: z.object({ sessionID: sessionId, status: z.string() }) })
interface Input {
  nativeId: string
  env: NodeJS.ProcessEnv
  observedAgents?: readonly NativeAgentObservation[]
  publish(agent: NativeAgentObservation): void
}
interface Admission { call: string; baseline?: string; previous?: NativeAgentObservation; previousAdmission?: Admission; ambiguous: boolean }

/** OpenCode v2 metadata observation. Legacy v1 evidence is a separate adapter gap. */
export class OpenCodeAgents implements AcpAgentObserver {
  private readonly input: Input
  private readonly worker: Worker
  private readonly current = new Map<string, NativeAgentObservation>()
  private readonly nativeRuns = new Map<string, string | undefined>()
  private readonly subagentTools = new Set<string>()
  private readonly admissions = new Map<string, Admission>()
  private readonly calls = new Map<string, string>()
  private timer?: ReturnType<typeof setTimeout>
  private reading = false
  private disposed = false
  private revision = 0
  private readingRevision = 0
  private readyResolve!: () => void
  readonly ready: Promise<void>

  constructor(input: Input) {
    this.input = input
    for (const agent of input.observedAgents ?? []) this.current.set(agent.nativeId, agent)
    this.worker = new Worker(new URL("./agent-worker.js", import.meta.url), {
      workerData: { paths: openCodeDatabasePaths(input.env), nativeId: input.nativeId },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    this.ready = new Promise(resolve => { this.readyResolve = resolve })
    this.worker.on("message", value => {
      this.reading = false
      const parsed = reply.safeParse(value)
      if (!this.disposed && this.readingRevision === this.revision && parsed.success && parsed.data.kind === "observed") {
        for (const agent of parsed.data.agents) {
          const pending = this.admissions.get(agent.nativeId)
          this.nativeRuns.set(agent.nativeId, agent.nativeRunId)
          if (pending && (pending.ambiguous || !agent.nativeRunId || agent.nativeRunId === pending.baseline)) continue
          this.admissions.delete(agent.nativeId)
          this.publish(agent)
        }
      }
      this.readyResolve()
      this.worker.unref()
      this.schedule(this.readingRevision === this.revision ? 1000 : 0)
    })
    this.worker.on("error", () => { this.reading = false; this.readyResolve(); this.dispose() })
    this.worker.on("exit", () => { this.readyResolve(); this.dispose() })
    this.scan()
  }

  observe(notification: SessionNotification): void {
    if (this.disposed || notification.sessionId !== this.input.nativeId) return
    const update = notification.update
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return
    this.revision++
    if (update.title === "subagent") this.subagentTools.add(update.toolCallId)
    const args = resume.safeParse(update.rawInput)
    const output = result.safeParse(update.rawOutput)
    const child = args.success && update.title === "subagent" ? args.data.sessionID : output.success && this.subagentTools.has(update.toolCallId) ? output.data.metadata.sessionID : undefined
    if (child && !this.calls.has(update.toolCallId)) {
      this.calls.set(update.toolCallId, child)
      const previous = this.current.get(child)
      if (args.success || !previous) {
        this.admissions.set(child, { call: update.toolCallId, baseline: this.nativeRuns.get(child), previous,
          previousAdmission: this.admissions.get(child),
          ambiguous: args.success && (!this.nativeRuns.has(child) || Boolean(previous && ["working", "waiting", "unknown"].includes(previous.state.kind))),
        })
        this.publish({ ...previous, nativeId: child, nativeRunId: update.toolCallId, toolId: update.toolCallId,
          parentNativeId: this.input.nativeId, title: previous?.title ?? "Subagent", state: { kind: "working" } })
      }
    }
    const id = this.calls.get(update.toolCallId)
    const pending = id ? this.admissions.get(id) : undefined
    if (id && pending?.call === update.toolCallId && update.status === "failed") {
      if (pending.previousAdmission) this.admissions.set(id, pending.previousAdmission)
      else this.admissions.delete(id)
      if (pending.previous) this.publish(pending.previous)
      else this.publish({ nativeId: id, nativeRunId: update.toolCallId, title: "Subagent", state: { kind: "failed", error: "Native child admission failed" } })
    }
    // A launch result only discovers the child; native current-input evidence
    // must establish completion independently of that tool's terminal status.
    this.schedule(0)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.readyResolve()
    void this.worker.terminate()
    this.current.clear(); this.nativeRuns.clear(); this.subagentTools.clear(); this.admissions.clear(); this.calls.clear()
  }
  private publish(agent: NativeAgentObservation): void {
    if (JSON.stringify(this.current.get(agent.nativeId)) === JSON.stringify(agent)) return
    this.current.set(agent.nativeId, agent)
    this.input.publish(agent)
  }
  private schedule(ms: number): void {
    if (this.disposed || this.reading) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.scan(), ms)
    this.timer.unref()
  }
  private scan(): void {
    if (this.disposed || this.reading) return
    this.reading = true
    this.readingRevision = this.revision
    this.worker.postMessage(null)
  }
}
