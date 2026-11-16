import { RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { REMOTE_APP_RENEW_MS, RemoteAppReplySchema, type RemoteAppDemand, type RemoteAppHint, type RemoteAppSnapshot } from "@mako/host/contracts/remote-app"
import type { RefetchClock, RefetchLease, ViewRefetch } from "@/lib/view-refetch"
import { pageRefetch } from "@/state/view-refetch"
import { appsStore, readApp, appReadFailure, serversOf, settling, APP_STARTING_MS, APP_SETTLED_MS, appKey, type AppReader } from "./previews"
import { ownerCall, type Owner } from "./start"

const CLOCK: RefetchClock = { now: Date.now, after: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer) } }
const place = (owner: Owner) => `${owner.kind}:${owner.kind === "cloud" ? owner.threadId : owner.deviceId}`
interface View {
  conversation: string
  owner: Owner
  folder: string
  key: string
  scope: string
  view: string
  refs: number
  generation: number
  mode: "unknown" | "following" | "legacy"
  sent: boolean
  hearing: boolean
  proof?: string
  visible: boolean
  epoch?: string
  revision: number
  heard: number
  retired: Set<string>
  lease?: RefetchLease
  cancel?: () => void
}

/** One passive app follower per complete query, shared by all preview surfaces in this browser. */
export class RemoteAppViews {
  private readonly client: AppReader
  private readonly reads: ViewRefetch
  private readonly clock: RefetchClock
  private readonly views = new Map<string, View>()
  private readonly unsubscribe: () => void
  private closed = false
  private readonly counts = { demandCalls: 0, dataReads: 0, fallbacks: 0, hints: 0, staleHints: 0, reconciled: 0, releaseFailures: 0 }

  constructor(client: AppReader, reads: ViewRefetch = pageRefetch(), clock: RefetchClock = CLOCK) {
    this.client = client; this.reads = reads; this.clock = clock
    this.unsubscribe = reads.onState(() => {
      for (const entry of this.views.values()) {
        if (entry.visible === reads.visible) continue
        entry.visible = reads.visible
        if (!entry.visible) this.release(entry)
        else entry.mode = "unknown"
        // The shared scheduler already owns the one snapshot on return, which reacquires demand.
      }
    })
  }
  readings() { return { ...this.counts, views: this.views.size } }
  watch(conversation: string, owner: Owner, folder: string): () => void {
    if (this.closed) return () => {}
    const id = JSON.stringify([place(owner), conversation, folder])
    let entry = this.views.get(id)
    if (entry) entry.refs++
    else {
      entry = { conversation, owner, folder, key: appKey(owner, folder), scope: `web:${this.client.deviceId}:${place(owner)}`, view: crypto.randomUUID(), refs: 1, generation: 0, mode: "unknown", sent: false, hearing: false, visible: this.reads.visible, revision: -1, heard: -1, retired: new Set() }
      this.views.set(id, entry)
      const held = entry
      held.lease = this.reads.watch(`remote-app:${this.client.deviceId}:${id}`, {
        scope: held.scope, domain: "preview", key: folder, fields: ["state", "recipe"],
        every: () => held.mode === "following" && held.hearing ? undefined : settling(appsStore.get().apps.get(held.key)) ? APP_STARTING_MS : APP_SETTLED_MS,
        read: (current) => this.read(held, current),
      })
    }
    const held = entry
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      if (--held.refs) return
      held.lease?.release()
      this.release(held)
      this.views.delete(id)
    }
  }
  heard(owner: Owner, hint: RemoteAppHint): void {
    for (const entry of this.views.values()) {
      if (place(entry.owner) !== place(owner) || entry.conversation !== hint.conversationId) continue
      if (entry.retired.has(hint.epoch)) { this.counts.staleHints++; continue }
      if (entry.sent && entry.visible) {
        entry.proof = hint.epoch
        if (entry.mode === "following" && entry.epoch === hint.epoch) { entry.hearing = true; this.reads.reschedule(entry.scope) }
      }
      if (hint.ready) continue // The accompanying demand reply owns revision reconciliation.
      if (entry.epoch === hint.epoch && hint.revision <= entry.heard) { this.counts.staleHints++; continue }
      if (entry.epoch === hint.epoch) entry.heard = hint.revision
      else entry.mode = "unknown"
      this.counts.hints++
      this.reads.invalidate(entry.scope, "preview", [entry.folder], hint.fields)
    }
  }
  reconnected(owner: Owner): void {
    for (const entry of this.views.values()) if (place(entry.owner) === place(owner)) {
      entry.mode = "unknown"
      entry.hearing = false; entry.proof = undefined
      entry.cancel?.(); entry.cancel = undefined
      entry.lease?.refresh({ immediate: true, invalidate: true })
    }
  }
  close(): void {
    if (this.closed) return
    for (const entry of this.views.values()) { entry.lease?.release(); this.release(entry) }
    this.closed = true
    this.views.clear(); this.unsubscribe()
  }
  private release(entry: View) {
    entry.cancel?.(); entry.cancel = undefined
    entry.hearing = false; entry.proof = undefined
    if (this.closed || !entry.sent) return
    entry.sent = false
    void this.control(entry, false).catch(() => { this.counts.releaseFailures++ })
  }
  private async control(entry: View, visible: boolean) {
    const generation = ++entry.generation
    if (visible) entry.sent = true
    const demand: RemoteAppDemand = { view: entry.view, generation, visible, confirm: visible && !entry.hearing }
    this.counts.demandCalls++
    const parsed = RemoteAppReplySchema.parse(await ownerCall(this.client.gateway, this.client.deviceId, entry.owner, "mako:conversation-app-demand", [entry.conversation, demand], { passive: true }))
    if (this.closed || generation !== entry.generation || visible !== this.reads.visible || !entry.refs) return undefined
    return parsed
  }
  private async following(entry: View) {
    const reply = await this.control(entry, true)
    if (!reply || reply.kind !== "following") return reply
    if (entry.epoch !== reply.epoch) {
      if (entry.epoch) entry.retired.add(entry.epoch)
      if (entry.retired.size > 8) entry.retired.delete(entry.retired.values().next().value!)
      entry.revision = -1; entry.heard = -1; entry.epoch = reply.epoch
    }
    entry.mode = "following"
    entry.hearing = entry.proof === reply.epoch
    entry.cancel?.()
    entry.cancel = this.clock.after(() => {
      entry.cancel = undefined
      if (!this.closed && entry.refs && this.reads.visible) void this.renew(entry)
    }, REMOTE_APP_RENEW_MS)
    return reply
  }
  private async renew(entry: View) {
    try {
      const reply = await this.following(entry)
      if (!reply) return
      if (reply.kind === "unavailable" || reply.revision > entry.revision) {
        this.counts.reconciled++
        entry.lease?.refresh()
      }
    } catch {
      if (this.closed || !entry.refs || !this.reads.visible) return
      entry.mode = "unknown"
      entry.lease?.refresh()
    }
  }
  private async read(entry: View, current: () => boolean) {
    if (entry.mode !== "legacy") {
      try {
        const reply = entry.mode === "following" && entry.epoch
          ? { kind: "following" as const, epoch: entry.epoch, revision: Math.max(entry.revision, entry.heard) }
          : await this.following(entry)
        if (!current() || !reply) return
        if (reply.kind === "following") {
          this.counts.dataReads++
          const snapshot = await ownerCall<RemoteAppSnapshot>(this.client.gateway, this.client.deviceId, entry.owner, "mako:conversation-app", [entry.conversation, entry.view], { passive: true })
          if (!current()) return
          if (snapshot.folder !== entry.folder) throw new Error("The Thread's app folder changed")
          const app = { ...serversOf(snapshot.app), at: this.clock.now() }
          const apps = new Map(appsStore.get().apps); apps.set(entry.key, app); appsStore.set({ apps })
          entry.revision = reply.revision
          return
        }
        entry.mode = "legacy"
      } catch (error) {
        if (!current()) return
        // Older owners have no such operation. Other failures keep the scheduler's bounded retry policy.
        if (!(error instanceof Error) || !error.message.includes("This host has no such call")) {
          entry.mode = "unknown"
          const apps = new Map(appsStore.get().apps)
          apps.set(entry.key, appReadFailure(entry.key, entry.owner.kind === "cloud" && error instanceof RuntimeDisconnectedError && !error.unconfirmed
            ? { kind: "asleep" }
            : { kind: "failed", message: error instanceof Error ? error.message : String(error) })); appsStore.set({ apps })
          throw error
        }
        entry.mode = "legacy"
        entry.sent = false
      }
      entry.cancel?.(); entry.cancel = undefined
      this.counts.fallbacks++
    }
    if (current()) { this.counts.dataReads++; await readApp(this.client, entry.owner, entry.folder, { passive: true, current }) }
  }
}
