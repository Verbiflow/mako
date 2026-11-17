import type { MakoBridge } from "@mako/host/contracts/renderer-bridge"
import type { AppKey } from "@mako/host/contracts/thread-environments"
import { AppSamplingReplySchema } from "@mako/host/contracts/thread-app"
import { ViewHintSchema, ViewHintsStatusSchema, type ViewDomain } from "@mako/host/contracts/view-hints"
import { getMako } from "@/lib/bridge"
import type { ViewRefetch } from "@/lib/view-refetch"
import { pageRefetch } from "@/state/view-refetch"

export type DeskHintBridge = Pick<MakoBridge, "onEvent"> & Partial<Pick<MakoBridge, "viewHints" | "followThreadApps">>

export const DESK_SCOPE = "local-host"

/** Capability, hint and demand ownership for this bridge; values stay in their existing stores. */
export class DeskRefetch {
  readonly reads: ViewRefetch
  private closed = false
  private readonly releaseState: () => void
  private readonly releaseEvents: () => void
  private domains = new Set<ViewDomain>()
  private epoch: string | undefined
  private lastEpoch: string | undefined
  private readonly retiredEpochs = new Set<string>()
  private queued = false
  private revision = -1
  private checking = false
  private checked = false
  private lifecycle = 0
  private binding: string | undefined
  private outputReady = false
  private outputHeard = false
  private wantedApps = false
  private wantedOutputs: AppKey[] = []
  private readonly outputs = new Map<AppKey, number>()
  private wanted: boolean | undefined
  private wantedRevision = 0
  private generation = 0
  private following = false
  private retry: ReturnType<typeof setTimeout> | undefined
  private retryMs = 1_000
  private readonly counters = { hints: 0, ignoredHints: 0, invalidHints: 0, demandSends: 0 }
  private readonly bridge: DeskHintBridge

  constructor(bridge: DeskHintBridge, reads: ViewRefetch = pageRefetch()) {
    this.bridge = bridge
    this.reads = reads
    this.releaseState = this.reads.onState(() => {
      if (this.queued) return
      this.queued = true
      queueMicrotask(() => { this.queued = false; this.changed() })
    })
    // Installed before the capability read or any initial snapshot.
    this.releaseEvents = bridge.onEvent((event) => {
      if (this.closed) return
      if (event.type === "host-disconnected") {
        this.retired()
        this.reads.setConnected(DESK_SCOPE, false)
      } else if (event.type === "host-reconnected") {
        this.retired()
        this.reads.setConnected(DESK_SCOPE, true)
        this.changed()
      } else if (event.type === "view-hint") {
        const parsed = ViewHintSchema.safeParse(event.hint)
        if (!parsed.success) { this.counters.invalidHints++; this.reads.invalidate(DESK_SCOPE, undefined); return }
        const hint = parsed.data
        if (this.retiredEpochs.has(hint.epoch)) { this.counters.ignoredHints++; return }
        if (this.epoch && this.epoch !== hint.epoch) {
          this.retired()
          this.reads.reset(DESK_SCOPE)
          this.changed()
        }
        if (hint.epoch === this.epoch && hint.revision <= this.revision) { this.counters.ignoredHints++; return }
        if (hint.epoch === this.epoch) this.revision = hint.revision
        this.counters.hints++
        if (hint.domain === "output" && hint.epoch === this.epoch) {
          if (hint.fields.includes("watch-unavailable")) { this.outputReady = false; this.outputHeard = false }
          if (hint.fields.includes("watch-ready")) this.outputHeard = true
          this.reads.reschedule(DESK_SCOPE, "output")
          if (this.wantedOutputs.length > 0 && !this.outputFollowing()) {
            if (this.outputHeard) this.retryMs = 1_000
            this.retryDemand(this.wantedRevision)
          }
          if (hint.fields.length && hint.fields.every(field => field === "watch-ready")) return
        }
        if (hint.domain === "apps") this.reads.invalidate(DESK_SCOPE, "output", hint.keys, ["state"])
        this.reads.invalidate(DESK_SCOPE, hint.domain, hint.keys, hint.fields)
      }
    })
    this.changed()
  }
  supports(domain: ViewDomain): boolean { return this.domains.has(domain) }
  appFollowing(): boolean { return this.following && this.wantedApps }
  outputFollowing(app?: AppKey): boolean { return this.following && this.wantedOutputs.length > 0 && (!app || this.wantedOutputs.includes(app)) && this.outputReady && this.outputHeard }
  watchOutput(app: AppKey): () => void {
    this.outputs.set(app, (this.outputs.get(app) ?? 0) + 1)
    this.changed()
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.outputs.get(app)! - 1
      if (count) this.outputs.set(app, count)
      else this.outputs.delete(app)
      this.changed()
    }
  }
  readings() { return { ...this.counters, ...this.reads.readings() } }

  close(): void {
    this.closed = true
    this.lifecycle++
    clearTimeout(this.retry)
    this.releaseState(); this.releaseEvents()
  }

  private retired() {
    this.lifecycle++
    this.domains.clear(); this.epoch = undefined; this.revision = -1
    this.outputReady = false; this.outputHeard = false
    this.wantedApps = false; this.wantedOutputs = []
    this.checked = false; this.checking = false; this.binding = undefined; this.wanted = undefined; this.following = false
    clearTimeout(this.retry); this.retry = undefined
    this.reads.reschedule(DESK_SCOPE)
  }
  private changed() {
    if (this.closed) return
    if (this.reads.visible && this.reads.connected(DESK_SCOPE) && !this.checked && !this.checking) void this.check()
    if (!this.supports("apps")) return
    const shown = this.reads.visible && this.reads.connected(DESK_SCOPE)
    const apps = shown && this.reads.count(DESK_SCOPE, "apps") > 0
    const outputs = shown && this.supports("output") ? [...this.outputs.keys()].sort().slice(0, 64) : []
    const wanted = apps || outputs.length > 0
    if (this.wanted === wanted && this.wantedApps === apps && this.wantedOutputs.join() === outputs.join()) return
    if (this.wantedOutputs.join() !== outputs.join()) { this.outputReady = false; this.outputHeard = false }
    this.wantedApps = apps; this.wantedOutputs = outputs
    this.wanted = wanted
    this.wantedRevision++
    clearTimeout(this.retry); this.retry = undefined
    void this.sendDemand(this.wantedRevision)
  }
  private async check() {
    this.checking = true
    const life = this.lifecycle
    try {
      const status = ViewHintsStatusSchema.safeParse(await this.bridge.viewHints?.())
      if (life !== this.lifecycle) return
      if (status?.success) {
        if (this.lastEpoch && this.lastEpoch !== status.data.epoch) {
          this.retiredEpochs.add(this.lastEpoch)
          if (this.retiredEpochs.size > 8) this.retiredEpochs.delete(this.retiredEpochs.values().next().value!)
        }
        this.domains = new Set(status.data.domains); this.epoch = status.data.epoch; this.lastEpoch = status.data.epoch
      }
    } catch {
      // An older or temporarily unavailable host retains the legacy visible-read policy until reconnect.
    } finally {
      if (life === this.lifecycle) { this.checked = true; this.checking = false; this.reads.reschedule(DESK_SCOPE); this.changed() }
    }
  }
  private retryDemand(revision: number) {
    if (revision !== this.wantedRevision || !this.supports("apps") || (!this.wanted && !this.binding)) return
    clearTimeout(this.retry)
    this.retry = setTimeout(() => { this.retry = undefined; void this.sendDemand(revision) }, this.retryMs)
    this.retryMs = Math.min(30_000, this.retryMs * 2)
  }
  private async sendDemand(revision: number) {
    const life = this.lifecycle
    const current = () => !this.closed && life === this.lifecycle && revision === this.wantedRevision
    try {
      if (!this.binding) {
        const reply = AppSamplingReplySchema.parse(await this.bridge.followThreadApps?.())
        if (!current()) return
        if (reply.kind !== "ready") { this.retryDemand(revision); return }
        this.binding = reply.connection
        this.generation = Math.max(this.generation, reply.generation)
      }
      if (!current()) return
      this.counters.demandSends++
      const reply = AppSamplingReplySchema.parse(await this.bridge.followThreadApps?.({ connection: this.binding, generation: ++this.generation, visible: this.wanted === true, ...(this.supports("output") && { apps: this.wantedApps, outputs: this.wantedOutputs }) }))
      if (!current()) return
      if (reply.kind === "following") {
        this.following = this.wanted === true
        this.outputReady = this.wantedOutputs.length > 0 && reply.outputs === true
        clearTimeout(this.retry); this.retry = undefined
        if (this.wantedOutputs.length > 0 && !this.outputFollowing()) this.retryDemand(revision)
        else this.retryMs = 1_000
        this.reads.reschedule(DESK_SCOPE, "apps")
        this.reads.reschedule(DESK_SCOPE, "output")
      } else {
        this.following = false
        this.binding = undefined
        this.retryDemand(revision)
      }
    } catch { if (current()) this.retryDemand(revision) }
  }
}

let current: { bridge: MakoBridge; owner: DeskRefetch } | undefined
export function deskRefetch(): DeskRefetch {
  const bridge = getMako()
  if (current?.bridge !== bridge) {
    current?.owner.close()
    current = { bridge, owner: new DeskRefetch(bridge) }
  }
  return current.owner
}
