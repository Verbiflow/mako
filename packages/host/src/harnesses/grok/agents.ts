import { open, opendir } from "node:fs/promises"
import { watch, type FSWatcher } from "node:fs"
import { dirname, join } from "node:path"
import { setImmediate as yieldToHost } from "node:timers/promises"
import { z } from "zod"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { NativeAgentObservation } from "../../contracts/native-agents.js"
import type { AcpAgentObserver } from "../acp-source.js"

const identity = z.string().uuid()
const metadata = z.object({
  subagent_id: identity,
  child_session_id: identity,
  parent_session_id: identity,
  attempt_id: z.string().min(1).max(512),
  status: z.enum(["running", "completed", "failed", "cancelled", "stopped"]),
  description: z.string(),
  subagent_type: z.string().nullish(),
  effective_model_id: z.string().nullish(),
})
const MAX_BYTES = 512 * 1024
interface GrokAgentInput {
  home: string
  cwd: string
  nativeId: string
  publish(agent: NativeAgentObservation): void
}

/** Read Grok's current attempt metadata, never execute a tool to discover child state. */
export class GrokAgents implements AcpAgentObserver {
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private reading = false
  private revision = 0
  private watcher: FSWatcher | undefined
  private watchingChildren = false
  private readonly emitted = new Map<string, string>()
  private readonly root: string
  private readonly input: GrokAgentInput
  readonly ready: Promise<void>
  constructor(input: GrokAgentInput) {
    this.input = input
    const workspace = encodeURIComponent(input.cwd).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    this.root = join(input.home, "sessions", workspace, input.nativeId, "subagents")
    this.ready = identity.safeParse(input.nativeId).success ? this.initialize() : Promise.resolve()
  }
  private async initialize(): Promise<void> {
    // Watch notifications may invalidate the first directory pass. Startup
    // must await its replacement, not admit work with a partial child set.
    while (!this.disposed) {
      const revision = this.revision
      await this.scan()
      if (revision === this.revision) return
    }
  }
  observe(notification: SessionNotification): void {
    if (notification.sessionId !== this.input.nativeId) return
    if (notification.update.sessionUpdate !== "tool_call" && notification.update.sessionUpdate !== "tool_call_update") return
    this.revision += 1
    this.schedule(0)
  }
  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.watcher?.close()
    this.watcher = undefined
    this.emitted.clear()
  }
  private schedule(ms: number): void {
    if (this.disposed || this.reading) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.scan() }, ms)
    this.timer.unref()
  }
  private watchChildren(): void {
    if (this.watchingChildren) return
    const changed = () => {
      this.revision += 1
      this.schedule(0)
    }
    const attach = (path: string, recursive: boolean) => {
      const watcher = watch(path, { recursive }, changed)
      watcher.unref()
      watcher.on("error", () => {
        if (this.watcher !== watcher) return
        watcher.close()
        this.watcher = undefined
        this.watchingChildren = false
        changed()
      })
      this.watcher?.close()
      this.watcher = watcher
    }
    try {
      attach(this.root, true)
      this.watchingChildren = true
    } catch {
      // The first spawn creates subagents after its launch notification. Watch
      // that creation too; otherwise an empty scan delays discovery by 30s.
      if (!this.watcher) {
        try { attach(dirname(this.root), false) } catch { /* Retry on fallback poll. */ }
      }
    }
  }
  private async scan(): Promise<void> {
    if (this.disposed || this.reading) return
    this.reading = true
    this.watchChildren()
    const revision = this.revision
    let active = false
    try {
      const directory = await opendir(this.root)
      let count = 0
      for await (const entry of directory) {
        if (count++ && count % 256 === 0) await yieldToHost()
        if (this.disposed || this.revision !== revision) break
        if (!entry.isDirectory() || !identity.safeParse(entry.name).success) continue
        try {
          const file = await open(join(this.root, entry.name, "meta.json"), "r")
          let value
          try {
            const size = (await file.stat()).size
            if (size > MAX_BYTES) continue
            const bytes = Buffer.allocUnsafe(size + 1)
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
            if (bytesRead !== size) continue
            value = metadata.safeParse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")))
          } finally { await file.close() }
          if (!value.success || this.disposed || revision !== this.revision) continue
          const data = value.data
          if (data.parent_session_id !== this.input.nativeId || data.subagent_id !== entry.name || data.child_session_id !== entry.name) continue
          active ||= data.status === "running"
          const agent: NativeAgentObservation = {
            nativeId: data.child_session_id,
            parentNativeId: data.parent_session_id,
            nativeRunId: data.attempt_id,
            title: data.description.slice(0, 512),
            role: data.subagent_type?.slice(0, 256),
            model: data.effective_model_id?.slice(0, 256),
            state: data.status === "running" ? { kind: "working" }
              : data.status === "completed" ? { kind: "completed" }
                : data.status === "failed" ? { kind: "failed", error: "Native child attempt failed" }
                  : { kind: "canceled" },
          }
          const key = JSON.stringify(agent)
          if (this.emitted.get(entry.name) === key) continue
          this.emitted.set(entry.name, key)
          // This is only a duplicate-emission cache, never retained authority.
          // Eviction may repeat current evidence; it must not skip a child read.
          if (this.emitted.size > 1024) {
            const oldest = this.emitted.keys().next().value
            if (oldest) this.emitted.delete(oldest)
          }
          this.input.publish(agent)
        } catch { active = true /* A failed read cannot settle an earlier observation. */ }
      }
    } catch { active = true }
    finally {
      this.reading = false
      this.schedule(revision !== this.revision ? 0 : active || !this.watchingChildren ? 2000 : 30_000)
    }
  }
}
