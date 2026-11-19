import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"
import { hostWarn } from "../base/host-log.js"
import { SnapshotBudgetSettingsSchema, type SnapshotBudgetEntry, type SnapshotBudgetReport, type SnapshotBudgetSettings, type SnapshotSettlement } from "../contracts/snapshot-budget.js"
import { snapshotPayloadBytes } from "./snapshot-git.js"
import type { SnapshotRecord } from "./snapshot-retention.js"
import type { ReclaimClass, ReclaimItem } from "../contracts/storage.js"

interface Deps {
  root: string
  records(): SnapshotRecord[]
  /** Includes running turns, preview leases, pending restores and retirement intents. */
  protectedIds(): ReadonlySet<string>
  settlement(): SnapshotSettlement | Promise<SnapshotSettlement>
  expand(ids: readonly string[]): Set<string>
  /** Revalidates the same record, live holds and journal evidence under its existing repository lock. */
  remove(record: SnapshotRecord, authorised: () => Promise<boolean>, enabled: () => boolean): Promise<boolean>
}
/**
 * Evicting by default: Rewind reaches a turn only while its checkpoint is kept, and the newest 8 GiB keep every recent
 * turn of every conversation; preview-only, one Mac's checkpoints reached 20.6 GB, mostly of turns weeks old.
 */
const defaults: SnapshotBudgetSettings = { mode: "evict", maxBytes: 8 * 1024 ** 3 }

/** One payload budget over all conversations/repositories in this host profile. */
export class SnapshotBudget {
  readonly store = "snapshots"
  readonly #deps: Deps
  #settings: SnapshotBudgetSettings = { ...defaults }
  #load: Promise<void> | undefined
  #configuring = 0
  #untracked = new Map<string, number>()
  #inventoryKnown = false
  #legacyBytes = new Map<string, number>()
  #writes: Promise<void> = Promise.resolve()
  #pass: Promise<SnapshotBudgetReport> | undefined
  #reservedBytes = 0
  #closed = false
  #timer: NodeJS.Timeout | undefined
  constructor(deps: Deps) { this.#deps = deps }
  async settings(): Promise<SnapshotBudgetSettings> {
    this.#load ??= (async () => {
      const text = await readFile(join(this.#deps.root, "budget.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error })
      this.#settings = text === null ? { ...defaults } : SnapshotBudgetSettingsSchema.parse(JSON.parse(text))
    })()
    await this.#load
    return { ...this.#settings }
  }
  configure(value: SnapshotBudgetSettings): Promise<void> {
    const next = SnapshotBudgetSettingsSchema.parse(value)
    this.#configuring++
    const write = this.#writes.then(async () => {
      await this.settings()
      await this.#pass
      if (next.mode === "evict") await this.#inventory()
      const path = join(this.#deps.root, "budget.json"), temporary = `${path}.${randomUUID()}.tmp`
      try { await writeFile(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 }); await rename(temporary, path) }
      finally { await rm(temporary, { force: true }) }
      this.#settings = next
    }).finally(() => { this.#configuring-- })
    this.#writes = write.catch(() => undefined)
    return write
  }
  async #inventory(): Promise<void> {
    try {
    const records = this.#deps.records(), known = new Set(records.map(row => row.id)), untracked = new Map<string, number>()
    for (const entry of await readdir(this.#deps.root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Linked checkpoint storage needs review before budget enforcement.")
      if (entry.isFile()) {
        if (!["snapshots.sqlite", "snapshots.sqlite-wal", "snapshots.sqlite-shm", "budget.json"].includes(entry.name) && !/^budget\.json\.[0-9a-f-]{36}\.tmp$/.test(entry.name)) untracked.set(entry.name, await snapshotPayloadBytes(join(this.#deps.root, entry.name)))
        continue
      }
      if (!entry.isDirectory()) throw new Error("Unknown checkpoint storage needs review before budget enforcement.")
      if (known.has(entry.name) || (entry.name.startsWith(".budget-retiring-") && known.has(entry.name.slice(17)))) continue
      untracked.set(entry.name, await snapshotPayloadBytes(join(this.#deps.root, entry.name)))
    }
    const legacy = new Map<string, number>()
    for (const record of records) if (!record.storage) legacy.set(record.id, await snapshotPayloadBytes(join(this.#deps.root, record.id)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return 0; throw error }))
    this.#legacyBytes = legacy; this.#untracked = untracked; this.#inventoryKnown = true
    } catch (error) { this.#inventoryKnown = false; throw error }
  }
  #untrackedBytes(except?: string): number {
    const known = new Set(this.#deps.records().map(row => row.id))
    return [...this.#untracked].reduce((sum, [id, bytes]) => sum + (id === except || known.has(id) ? 0 : bytes), 0)
  }
  #eligible(record: SnapshotRecord, proof: SnapshotSettlement, settled: ReadonlySet<string>, held: ReadonlySet<string>): string | undefined {
    if (this.#closed || this.#configuring) return "The host is stopping."
    if (!proof.valid) return "Conversation settlement evidence is unavailable."
    if (!record.storage) return "Legacy Git-backed checkpoint; retained for its repository."
    if (!settled.has(record.id)) return "No settled owning turn is proven."
    if (held.has(record.id)) return "An active turn, rewind, preview or retirement holds this checkpoint."
    if (proof.blockedScopes.some(scope => overlaps(scope, record.scope))) return "A conversation in this workspace has pending or active work."
    return undefined
  }
  preview(): Promise<SnapshotBudgetReport> { return this.#plan(0) }
  /**
   * Settings › Storage's rows, one per workspace and class: `now` the oldest settled checkpoints over the budget,
   * `approve` the other settled ones (Rewind no longer reaches their turns once they go), `keep` what a running turn,
   * a rewind or unproven settlement holds.
   */
  async items(): Promise<ReclaimItem[]> {
    const report = await this.preview()
    const groups = new Map<string, ReclaimItem>()
    for (const entry of report.entries) {
      const verdict: ReclaimClass = entry.selected ? "now" : entry.eligible ? "approve" : "keep"
      const key = `${entry.scope}\0${verdict}`
      const item = groups.get(key) ?? {
        id: `snapshots:${verdict}:${entry.scope}`, store: "snapshots" as const, path: entry.scope, label: `Rewind checkpoints in ${basename(entry.scope) || entry.scope}`,
        project: basename(entry.scope), parts: [], bytes: 0, class: verdict,
        reason: verdict === "now" ? "Settled turns past the rewind budget, oldest first." : verdict === "approve" ? "Settled turns; Rewind no longer reaches them once they go." : entry.reason,
      }
      item.parts!.push(join(this.#deps.root, entry.id))
      item.bytes = (item.bytes ?? 0) + entry.bytes
      item.usedAt = Math.max(item.usedAt ?? 0, entry.createdAt)
      groups.set(key, item)
    }
    return [...groups.values()].filter((item) => (item.bytes ?? 0) > 0)
  }
  /** Evicts the checkpoints of the items asked for, each only while it is still settled and nothing holds it. */
  async reclaim(items: readonly ReclaimItem[], consent: "now" | "approve"): Promise<Map<string, true | string>> {
    const outcome = new Map<string, true | string>()
    for (const item of items) {
      if (item.class === "keep" || (item.class === "approve" && consent === "now")) { outcome.set(item.id, item.reason); continue }
      let removed = 0
      for (const part of item.parts ?? []) {
        const record = this.#deps.records().find((row) => join(this.#deps.root, row.id) === part)
        if (!record) continue
        const authorised = async () => {
          const proof = await this.#deps.settlement()
          return !this.#eligible(record, proof, this.#deps.expand(proof.settledIds), this.#deps.protectedIds())
        }
        try {
          if (await this.#deps.remove(record, authorised, () => !this.#closed && !this.#configuring)) removed++
        } catch (error) { hostWarn("checkpoints", "A checkpoint asked to be freed was kept.", { error: error instanceof Error ? error.message : String(error) }) }
      }
      outcome.set(item.id, removed ? true : "A running turn, a rewind or unproven settlement holds these checkpoints.")
    }
    return outcome
  }
  async #plan(reservedBytes: number): Promise<SnapshotBudgetReport> {
    const settings = await this.settings()
    await this.#inventory()
    const records = this.#deps.records(), proof = await this.#deps.settlement()
    const settled = this.#deps.expand(proof.settledIds), held = this.#deps.protectedIds()
    const entries: SnapshotBudgetEntry[] = records.map(record => {
      const reason = this.#eligible(record, proof, settled, held)
      return { id: record.id, scope: record.scope, createdAt: record.createdAt, bytes: record.storage?.bytes ?? this.#legacyBytes.get(record.id) ?? 0, eligible: !reason, reason: reason ?? "Settled turn, oldest first.", selected: false }
    }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const untrackedBytes = this.#untrackedBytes(), payloadBytes = untrackedBytes + entries.reduce((sum, row) => sum + row.bytes, 0)
    let remainingBytes = payloadBytes, selectedBytes = 0
    for (const entry of entries) {
      if (remainingBytes <= Math.max(0, settings.maxBytes - reservedBytes)) break
      if (!entry.eligible) continue
      entry.selected = true; selectedBytes += entry.bytes; remainingBytes -= entry.bytes
    }
    return { settings, at: Date.now(), payloadBytes, untrackedBytes, inventoryKnown: this.#inventoryKnown, remainingBytes, selectedBytes, entries }
  }
  run(reservedBytes = 0): Promise<SnapshotBudgetReport> {
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) throw new Error("Invalid checkpoint reservation.")
    this.#reservedBytes = Math.max(this.#reservedBytes, reservedBytes)
    this.#pass ??= this.#run().finally(() => { this.#pass = undefined; this.#reservedBytes = 0 })
    return this.#pass
  }
  async #run(): Promise<SnapshotBudgetReport> {
    const reserved = this.#reservedBytes
    let report = await this.#plan(reserved)
    if (this.#reservedBytes > reserved) report = await this.#plan(this.#reservedBytes)
    if (report.settings.mode !== "evict" || this.#closed) return report
    for (const entry of report.entries.filter(row => row.selected).slice(0, 64)) {
      const record = this.#deps.records().find(row => row.id === entry.id)
      if (!record) continue
      const authorised = async () => {
        const proof = await this.#deps.settlement()
        return this.#settings.mode === "evict" && !this.#configuring && !this.#eligible(record, proof, this.#deps.expand(proof.settledIds), this.#deps.protectedIds()) &&
          this.#deps.records().reduce((sum, row) => sum + (row.storage?.bytes ?? this.#legacyBytes.get(row.id) ?? 0), 0) + this.#untrackedBytes() > Math.max(0, this.#settings.maxBytes - this.#reservedBytes)
      }
      try {
        entry.removed = await this.#deps.remove(record, authorised, () => !this.#closed && !this.#configuring && this.#settings.mode === "evict")
        if (!entry.removed) { entry.eligible = false; entry.reason = "A current guard changed or no more eviction is needed." }
      }
      catch { entry.reason = "Eviction was refused or is unconfirmed; retained for review."; entry.eligible = false }
    }
    report.remainingBytes = this.#deps.records().reduce((sum, row) => sum + (row.storage?.bytes ?? this.#legacyBytes.get(row.id) ?? 0), 0) + this.#untrackedBytes()
    if (report.remainingBytes > this.#settings.maxBytes && report.entries.some(row => row.removed)) this.changed()
    return report
  }
  /** Eviction is best effort. Missing evidence or overage never denies a new rewind point. */
  async prepareCapture(additionalBytes: number): Promise<void> {
    try {
      if ((await this.settings()).mode === "evict" && !this.withinTarget(additionalBytes, "")) await this.run(additionalBytes)
    } catch {
      hostWarn("checkpoints", "Rewind eviction is unavailable; retaining the new checkpoint over budget.")
    }
  }
  /** Advisory at publication, including concurrent captures and retained unknown payload. */
  withinTarget(additionalBytes: number, currentId: string): boolean {
    return this.#settings.mode !== "evict" || (this.#inventoryKnown && this.#deps.records().every(row => Boolean(row.storage) || this.#legacyBytes.has(row.id)) &&
      this.#deps.records().reduce((sum, row) => sum + (row.storage?.bytes ?? this.#legacyBytes.get(row.id) ?? 0), 0) + this.#untrackedBytes(currentId) + additionalBytes <= this.#settings.maxBytes)
  }
  changed(): void {
    if (this.#closed || this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.settings().then(settings => settings.mode === "evict" ? this.run() : undefined).catch(() => undefined)
    }, 60_000)
    this.#timer.unref()
  }
  close(): void { this.#closed = true; clearTimeout(this.#timer); this.#timer = undefined }
}
function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}
