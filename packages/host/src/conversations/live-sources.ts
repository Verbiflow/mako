import { statSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { nativeRecord } from "../harnesses/index.js"
import type { ThreadPage } from "@mako/sessions"
import { currentRecordPath } from "@mako/sessions/record-files"
import type { BaseSource, BaseSpan, LiveSnapshot } from "../contracts/live-conversations.js"
import type { LiveSessionState } from "../contracts/providers-acp.js"
import { capturedThread } from "./live-context.js"
import { copiedBaseBytes, journalIds, LiveJournal } from "./live-journal.js"
import { activeBinding, bindingPath, conversationControl, noteCarriedFolders, residentOf, type Dependencies, type LiveAccess, type Resident } from "./live-runtime.js"
import { captureNativeHistory, withSeed } from "./native-history.js"
import { baseKeptBecause, baseKeptOnceHeld, baseUnread, samePlace, sourceOfPage, spanIds, spanOf } from "./base-source.js"
import { cutOffRequests, firstLiveStart, mergedBase } from "./stream-merging.js"
import { forkHistory } from "./live-forks.js"
import { ForkPointSchema } from "../contracts/conversation-control.js"
import type { Entry } from "@mako/sessions/entries"
import { retainMismatches } from "../base/stream-mismatches.js"

/**
 * Waits before reading an unread base again after an error: the catalog
 * restarting or a store mid-write passes in seconds. A session neither its
 * harness nor the record store has is not retried until the next load.
 */
const BASE_READ_RETRIES = [500, 2_000, 8_000]

/** `settleBases` lets the host breathe this long between journals, and checks this often whether work it waits on finished. */
const SETTLE_PAUSE_MS = 2_000

/** What `settleBases` did: each journal that kept a copy, how long it took, and why the copy stays when it does. */
export interface SettledBases {
  copies: number
  moved: number
  freed: number
  ms: number
  journals: { id: string; bytes: number; ms: number; keptBecause?: string }[]
}

type SourcesAccess = Pick<LiveAccess,
  "dependencies" | "admission" | "load" | "require" | "resident" | "residents" | "add" | "actor" | "register" |
  "stamp" | "snapshot" | "summaries" | "sameSession" | "flush" | "pending" | "reconcileQuestions" | "scheduleHibernation" |
  "release" | "hasActiveWork">

/**
 * Where each conversation's history comes from and where its native session
 * is: captured from a provider's store, read back when the store moves on,
 * paged further back, and found again when the provider names it anew.
 */
export class LiveSources {
  private readonly access: SourcesAccess
  private readonly captures = new Map<string, Promise<LiveSnapshot>>()
  // Refresh reads an already durable conversation; unlike an initial capture,
  // it must not hold shutdown open while waiting on an external native store.
  private readonly refreshes = new Map<string, Promise<LiveSnapshot>>()
  private readonly baseReads = new WeakMap<Resident, Promise<void>>()
  private readonly baseHolds = new WeakMap<Resident, Promise<void>>()
  /** Why a history that went on in several sessions keeps its copy though its first session is held: its reading wasn't found exact. */
  private readonly unspanned = new WeakMap<Resident, string>()
  /** Conversations whose session neither its harness nor the record store had when a refresh asked for it. */
  private readonly missing = new WeakSet<Resident>()
  /** Each journal's stamp (`journalStamp`) when a sweep last found it without a copy or kept the copy it has. */
  private readonly settledAt = new Map<string, string>()
  private settling: Promise<SettledBases> | undefined

  constructor(access: SourcesAccess) {
    this.access = access
  }

  /** The native paths being captured into a journal now. */
  capturing(): IterableIterator<string> {
    return this.captures.keys()
  }

  refreshing(id: string): boolean {
    return this.refreshes.has(id)
  }

  capture(id: string, path: string): Promise<LiveSnapshot> {
    this.access.admission.assert()
    z.string().uuid().parse(id)
    const owned = this.access.summaries().find(
      (summary) =>
        summary.threadPath === path || summary.nativePaths?.includes(path)
    )
    if (owned) return Promise.resolve(this.access.require(owned.session.id).snapshot)
    const pending = this.captures.get(path)
    if (pending) return pending
    const work = this.captureNative(id, path)
    this.captures.set(path, work)
    void work.finally(() => this.captures.delete(path)).catch(() => {})
    return work
  }

  private async captureNative(id: string, path: string): Promise<LiveSnapshot> {
    const { dependencies } = this.access
    const existing = this.access.load(id)
    if (existing) {
      const recorded = existing.snapshot.base?.ref.path ?? existing.snapshot.baseSource?.path
      if (!recorded || !samePlace(recorded, path))
        throw new Error("This conversation ID belongs to another source")
      return existing.snapshot
    }
    const before = await dependencies.checkpoint?.(path)
    const base = await captureNativeHistory(path, dependencies.history)
    if (!base) throw new Error("The source history could not be captured")
    const owned = this.access.summaries().find((summary) =>
      summary.session.harness === base.ref.harness &&
      summary.session.nativeId === base.ref.nativeId &&
      this.access.sameSession(summary.session.id, { harness: base.ref.harness, nativeId: base.ref.nativeId, identity: base.ref.identity, path })
    )
    if (owned) return this.access.require(owned.session.id).snapshot
    const after = await dependencies.checkpoint?.(path, base.ref.harness)
    const checkpoint = before === after ? after : undefined
    const snapshot: LiveSnapshot = {
      session: {
        id,
        harness: base.ref.harness,
        nativeId: base.ref.nativeId,
        settings: base.ref.settings,
        cwd: base.ref.cwd ?? "",
        title: base.ref.title,
        status: "ready",
        connection: "disconnected",
        modes: [],
        currentMode: null,
        configOptions: [],
      },
      revision: 0,
      createdAt: Date.now(),
      threadPath: path,
      base,
      blocks: [],
      permissions: [],
      requests: [],
      control: {
        merges: [],
        activeBindingId: id,
        bindings: [
          {
            id,
            provider: base.ref.harness,
            nativeId: base.ref.nativeId,
            path,
            checkpoint,
            tuning: base.ref.settings,
            coveredBlocks: 0,
            includesBase: true,
          },
        ],
        transfers: [],
      },
    }
    const journal = new LiveJournal(dependencies.root, id)
    try {
      journal.commit(snapshot)
    } catch (error) {
      journal.close()
      throw error
    }
    this.access.add(residentOf(snapshot, journal))
    this.access.register(snapshot, this.access.actor())
    try { await this.access.reconcileQuestions(this.access.require(id)) } catch (error) {
      hostLog("live", "native question import deferred", { conversation: id, error: errorMessage({ error }) })
    }
    void this.holdBase(this.access.require(id))
    return this.access.require(id).snapshot
  }

  /**
   * Reads the history the journal names by `baseSource` instead of keeping:
   * once per resident, from the view an earlier build decoded when there is
   * one (refresh reads it again for this build), else from the session, or
   * the record store when its harness no longer has it. Every route that
   * tells a harness something new waits for it, so the session is still the
   * history the live blocks continue when it is read.
   */
  readBase(resident: Resident): Promise<void> {
    if (!baseUnread(resident.snapshot)) return Promise.resolve()
    const running = this.baseReads.get(resident)
    if (running) return running
    const work = this.readBaseNow(resident).finally(() => this.baseReads.delete(resident))
    this.baseReads.set(resident, work)
    return work
  }

  private async readBaseNow(resident: Resident): Promise<void> {
    const { dependencies } = this.access
    const id = resident.snapshot.session.id
    const source = resident.snapshot.baseSource
    if (!source) return
    const started = performance.now()
    let page: ThreadPage | null = null
    let failure: string | undefined
    for (const wait of [...BASE_READ_RETRIES, undefined]) {
      try {
        const path = this.located(source)
        page = (dependencies.staleHistory && await captureNativeHistory(path, dependencies.staleHistory)) ||
          await captureNativeHistory(path, dependencies.history)
        failure = page ? undefined : "Neither its harness nor Mako's record store has this session any more."
        // A span of its session: as it begins now, else as Mako had captured it when the journal let its copy go.
        const span = source.span
        if (span) {
          const asOf = dependencies.historyAsOf
          const pinned = (page && spanOf(page, span)) ??
            (asOf ? await captureNativeHistory(path, (at, before) => asOf(at, span.heldAt, before)).then((read) => read && spanOf(read, span)) : null)
          if (pinned) page = pinned
          else {
            page = null
            failure = "Its session has been rewritten since this conversation went on in another, and Mako's records don't hold the part it continues as it was."
          }
        }
        break
      } catch (error) {
        failure = errorMessage({ error })
        if (wait === undefined || this.access.admission.closed) break
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    if (page && (page.ref.harness !== source.harness || page.ref.nativeId !== source.nativeId)) {
      failure = "The session at its path is another one now."
      page = null
    }
    if (this.access.resident(id) !== resident || resident.snapshot.base || resident.snapshot.baseSource !== source) return
    const ms = Math.round(performance.now() - started)
    if (!page) {
      hostWarn("live", "a conversation's history could not be read from its session", { conversation: id, harness: source.harness, ms, error: failure })
      resident.snapshot = { ...resident.snapshot, historyFailure: failure }
    } else {
      hostLog("live", "history read from its session", {
        conversation: id, harness: source.harness, ms, entries: page.entries.length,
        translator: page.translator ?? "none", restored: page.ref.archived === true,
      })
      const snapshot = resident.snapshot
      const recordStart = recordLiveStart(snapshot)
      // The record holds a fork's inherited turns as its harness copied them; its parent's history gives them back what the parent's stream said.
      const inherited = recordStart && isFork(snapshot) ? await this.parentHistory(snapshot) : undefined
      if (this.access.resident(id) !== resident || resident.snapshot !== snapshot) return
      const merged = mergedBase(page, snapshot.blocks, snapshot.baseCoveredBlocks ?? 0, recordStart, { inherited, cutOff: cutOffRequests(snapshot.requests) })
      resident.snapshot = {
        ...snapshot, base: merged.base, historyFailure: undefined,
        // Read again, the inherited turns hold what the parent's history gives them now, or nothing when it gives none.
        ...recordStart !== undefined && snapshot.baseSupplied !== merged.supplied && {
          baseLiveStart: merged.liveStart ?? recordStart, baseSupplied: merged.supplied ?? (snapshot.baseSupplied === undefined ? undefined : 0),
        },
      }
    }
    this.access.flush(resident)
  }

  /**
   * The history fork `snapshot` went on from, as its parent shows it now
   * (`forkHistory`). Undefined, with a line in the host log, when its parent
   * is gone or no longer holds that point; its record then stands alone for
   * the turns it inherited.
   */
  private async parentHistory(snapshot: LiveSnapshot): Promise<Entry[] | undefined> {
    const ancestry = snapshot.control?.ancestry
    if (ancestry?.kind !== "fork") return undefined
    const loaded = Boolean(this.access.resident(ancestry.parentId))
    const parent = this.access.load(ancestry.parentId)
    try {
      if (!parent) throw new Error("its parent's journal can't be opened")
      await this.readBase(parent)
      return forkHistory(parent.snapshot, ForkPointSchema.parse(JSON.parse(ancestry.point)))
    } catch (error) {
      hostLog("live", "a fork's inherited turns read as its record has them", { conversation: snapshot.session.id, parent: ancestry.parentId, error: errorMessage({ error }) })
      return undefined
    } finally {
      if (parent && !loaded) this.access.release(ancestry.parentId)
    }
  }

  /**
   * Drops the journal's copy of an idle conversation's base once its
   * session's records are in the record store, so the history can be read
   * again from them whatever its harness does with its own.
   */
  holdBase(resident: Resident): Promise<void> {
    const running = this.baseHolds.get(resident)
    if (running) return running
    const work = this.holdBaseNow(resident).finally(() => this.baseHolds.delete(resident))
    this.baseHolds.set(resident, work)
    return work
  }

  private async holdBaseNow(resident: Resident): Promise<void> {
    const snapshot = resident.snapshot
    const base = snapshot.base
    const hold = this.access.dependencies.holdHistory
    const source = base && sourceOfPage(base)
    if (!hold || !base || !source || snapshot.baseSource || baseKeptOnceHeld(snapshot) !== null) return
    const id = snapshot.session.id
    const path = this.located(source)
    const held = await hold(path).catch((error) => {
      hostLog("live", "a session's records could not be held; its journal keeps the history", { conversation: id, harness: source.harness, error: errorMessage({ error }) })
      return false
    })
    if (!held) {
      // A session its harness has deleted, which the store never took: the journal's copy is all that's left.
      if (!(await this.access.dependencies.history(path).catch(() => null))) this.missing.add(resident)
      return
    }
    const heldAt = Date.now()
    // Gone on in more than one session, its history is part of the first: read back and found exact before the copy goes.
    const spanned = (snapshot.control?.bindings.length ?? 0) > 1
    const proven = spanned ? await this.provenSpan(snapshot, base, path, heldAt) : undefined
    const span = proven && "span" in proven ? proven.span : undefined
    if (proven && "why" in proven) this.unspanned.set(resident, proven.why)
    const now = resident.snapshot
    if (this.access.resident(id) !== resident || now.base !== base || now.baseSource || (spanned && !span)) return
    resident.snapshot = { ...now, baseSource: { ...source, path, ...span && { span } } }
    this.access.flush(resident)
    hostLog("live", "history kept by its session's records instead of the journal", { conversation: id, harness: source.harness, entries: base.entries.length, span: span?.entries })
  }

  /**
   * The span of its session a conversation's history is, when the session
   * read now begins with it: the record's entries the history holds, which
   * merged with the live blocks as the journal merged them give the history
   * it keeps, turn for turn (`sameTurns`). A newer decoder may name or cite
   * them otherwise, as it may any history it reads again. Why not, with a
   * line in the host log, when they don't, and the journal keeps its copy.
   */
  private async provenSpan(snapshot: LiveSnapshot, base: ThreadPage, path: string, heldAt: number): Promise<{ span: BaseSpan } | { why: string }> {
    const id = snapshot.session.id
    const keep = (why: string) => {
      hostLog("live", "a history that went on in several sessions keeps its copy", { conversation: id, why })
      return { why }
    }
    if (isFork(snapshot) && (snapshot.baseSupplied ?? 0) > 0) return keep("a fork whose inherited turns its parent's history adds to")
    const read = await captureNativeHistory(path, this.access.dependencies.history).catch(() => null)
    if (!read || read.entries.length < base.total) return keep("its session no longer holds what the history read")
    const entries = read.entries.slice(0, base.total)
    const span: BaseSpan = { entries: base.total, ids: spanIds(entries), heldAt }
    const rebuilt = mergedBase({ ...read, entries, total: base.total, hasEarlier: false }, snapshot.blocks, snapshot.baseCoveredBlocks ?? 0, recordLiveStart(snapshot), { cutOff: cutOffRequests(snapshot.requests) })
    return sameTurns(rebuilt.base.entries, base.entries) ? { span } : keep("its session, read again, holds other turns than the history it keeps")
  }

  /** Where `source`'s session is now, by its identity; its harness may have moved it, as Codex compresses an idle rollout in place. */
  private located(source: BaseSource): string {
    return bindingPath(this.access.dependencies, { harness: source.harness, nativeId: source.nativeId }, source.path) ?? source.path
  }

  /**
   * Moves journals that still keep a copy of their history onto their
   * sessions' records (`holdBase`), newest first and one at a time while
   * nothing runs. One whose session is gone, or whose live blocks continue a
   * reading only it has, keeps its copy as the history it shows. A journal
   * unchanged since a sweep found it without a copy, or keeping its copy for
   * a reason of its own, is skipped; one sweep runs at a time.
   */
  settleBases(pauseMs = SETTLE_PAUSE_MS): Promise<SettledBases> {
    this.settling ??= this.settleNow(pauseMs).finally(() => { this.settling = undefined })
    return this.settling
  }

  /** The journal's file and its write-ahead log as they stand: a write to either changes it. */
  private journalStamp(id: string): string {
    const { root } = this.access.dependencies
    const at = (path: string) => { try { return statSync(path).mtimeMs } catch { return 0 } }
    return `${at(join(root, `${id}.sqlite`))}:${at(join(root, `${id}.sqlite-wal`))}`
  }

  private async settleNow(pauseMs: number): Promise<SettledBases> {
    const { root } = this.access.dependencies
    const started = performance.now()
    const copies = journalIds(root).flatMap((id) => {
      try {
        const stamp = this.journalStamp(id)
        if (this.settledAt.get(id) === stamp) return []
        const bytes = copiedBaseBytes(root, id)
        if (!bytes) this.settledAt.set(id, stamp)
        return bytes ? [{ id, bytes, changed: statSync(join(root, `${id}.sqlite`)).mtimeMs }] : []
      } catch (error) {
        hostWarn("live", "a journal's copy of its history could not be measured", { conversation: id, error: errorMessage({ error }) })
        return []
      }
    }).sort((a, b) => b.changed - a.changed)
    const journals: SettledBases["journals"] = []
    for (const { id, bytes } of copies) {
      while (!this.access.admission.closed && this.access.hasActiveWork())
        await new Promise((resolve) => setTimeout(resolve, SETTLE_PAUSE_MS))
      if (this.access.admission.closed) break
      const began = performance.now()
      const loaded = Boolean(this.access.resident(id))
      const resident = this.access.load(id)
      if (!resident) {
        journals.push({ id, bytes, ms: Math.round(performance.now() - began), keptBecause: "Mako could not open its journal" })
        this.settledAt.set(id, this.journalStamp(id))
        continue
      }
      let keptBecause: string | null
      // A reason of the journal's own holds until it changes; a hold the record store refused is asked again next time.
      let ownReason = false
      try {
        // A conversation whose last turn ended before this build took coverage then may not have taken it: it does now.
        await this.checkpointIdle(resident)
        await this.refreshedSnapshot(id)
        await this.holdBase(resident)
        const onceHeld = baseKeptOnceHeld(resident.snapshot)
        keptBecause = baseKeptBecause(resident.snapshot) && (onceHeld ?? this.unspanned.get(resident) ?? baseKeptBecause(resident.snapshot))
        // Gone from its harness, and never captured: the journal's copy is all that's left of it.
        if (keptBecause && !resident.snapshot.baseSource && this.missing.has(resident))
          keptBecause = "its session is gone from its harness, and Mako's records never held it: the copy is all there is"
        ownReason = onceHeld !== null
      } catch (error) {
        keptBecause = errorMessage({ error })
        hostWarn("live", "a journal's history stays in it", { conversation: id, error: keptBecause })
      }
      if (!loaded && !this.access.release(id)) hostLog("live", "a journal the sweep opened stays open; it compacts when it is let go", { conversation: id })
      const settled: SettledBases["journals"][number] = { id, bytes, ms: Math.round(performance.now() - began) }
      if (keptBecause) settled.keptBecause = keptBecause
      if (keptBecause && ownReason) this.settledAt.set(id, this.journalStamp(id))
      journals.push(settled)
      if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs))
    }
    const why = new Map<string, number>()
    let freed = 0
    for (const journal of journals) {
      if (journal.keptBecause) why.set(journal.keptBecause, (why.get(journal.keptBecause) ?? 0) + 1)
      else freed += journal.bytes
    }
    const moved = journals.filter((journal) => !journal.keptBecause).length
    const ms = Math.round(performance.now() - started)
    if (copies.length)
      hostLog("live", "journals moved onto their sessions' records", {
        copies: copies.length, moved, kept: journals.length - moved, freed, ms,
        why: [...why].map(([reason, count]) => `${count}: ${reason}`).join("; ") || undefined,
      })
    return { copies: copies.length, moved, freed, ms, journals }
  }

  /** Observe native history independently of whether another client owns execution.
   * A single binding records which retained live blocks its native store covers. */
  async refreshedSnapshot(id: string): Promise<LiveSnapshot | null> {
    const resident = this.access.load(id)
    if (!resident) return null
    if (baseUnread(resident.snapshot)) {
      await this.readBase(resident)
      if (this.access.resident(id) !== resident) return this.access.snapshot(id)
    }
    try {
      const catchup = this.access.reconcileQuestions(resident)
      if (catchup) await catchup
    } catch (error) {
      hostLog("live", "native question refresh deferred", { conversation: id, error: errorMessage({ error }) })
    }
    this.access.flush(resident)
    const base = resident.snapshot.base
    const bindings = resident.snapshot.control?.bindings ?? []
    const binding = bindings.length === 1 ? bindings[0] : undefined
    const recorded = binding?.path ?? base?.ref.path
    const nativeId = binding?.nativeId ?? base?.ref.nativeId
    const provider = binding?.provider ?? base?.ref.harness
    const path = recorded && nativeId && provider ? this.located({ harness: provider, nativeId, path: recorded }) : recorded
    const covered = binding?.coveredBlocks ?? 0
    // Past what the record covers, only the notices a session gives as it opens (Codex's sandbox warning on every
    // Linux start) can stand while it's read: no turn wrote them, so the record hasn't moved past them.
    const uncovered = resident.snapshot.blocks.slice(covered)
    const onlyOpening = uncovered.every((block) => block.type === "event" && block.setup === true)
    // A fork that hasn't opened a session of its own has only the copy it began from: its parent's record goes on past the fork.
    if (!path || !nativeId || resident.opening || resident.transferring || (isFork(resident.snapshot) && !binding) ||
        resident.snapshot.session.status === "running" ||
        resident.snapshot.requests.some((request) => request.status === "dispatching") ||
        (resident.snapshot.blocks.length > 0 && (!binding?.includesBase || !onlyOpening)))
      return this.access.snapshot(id)
    const pending = this.refreshes.get(id)
    if (pending) return pending
    const { dependencies } = this.access
    const before = resident.snapshot
    const generation = resident.generation
    const work = (async (): Promise<LiveSnapshot> => {
      try {
        const latest = await dependencies.history(path)
        if (!latest) this.missing.add(resident)
        else this.missing.delete(resident)
        if (!latest || latest.ref.nativeId !== nativeId || latest.ref.harness !== provider)
          return this.access.stamp(resident.snapshot)
        const sameRevision = base && (resident.snapshot.baseCoveredBlocks ?? 0) === covered && latest.checkpoint !== undefined && latest.checkpoint === base.checkpoint &&
          latest.translator === base.translator &&
          latest.ref.bytes === base.ref.bytes && latest.ref.revision === base.ref.revision &&
          latest.ref.updatedAt === base.ref.updatedAt && latest.total === base.total &&
          // A fork an earlier build merged left its inherited turns as its record has them; they read once more, with its parent's history.
          !(isFork(resident.snapshot) && resident.snapshot.baseSupplied === undefined && (recordLiveStart(resident.snapshot) ?? 0) > 0)
        if (sameRevision) return this.access.stamp(resident.snapshot)
        const read = await captureNativeHistory(path, (path, before) =>
          before === undefined ? Promise.resolve(latest) : dependencies.history(path, before))
        const seeded = read && binding?.seeded
          ? withSeed(read, capturedThread(before, 0, true).entries, binding.seeded) ?? read
          : read
        // Until the base first covers live blocks, it is the history they
        // continue; a base read from another store says nothing of where.
        const first = (before.baseCoveredBlocks ?? 0) === 0
        const recordStart = !seeded || covered === 0 ? undefined
          : first ? firstLiveStart(base, seeded, before.blocks.slice(0, covered))
            : base?.ref.nativeId === seeded.ref.nativeId ? recordLiveStart(before) : undefined
        // A fork's own record holds the turns it inherited; they merge with
        // its parent's history: the copy it began from, then the reading
        // that merge left (`inheritedOf`).
        const inherited = !recordStart || !base || !isFork(before) ? undefined
          : first ? base.entries : before.baseSupplied !== undefined ? inheritedOf(before) : await this.parentHistory(before)
        const merged = seeded && mergedBase(seeded, before.blocks, covered, recordStart, { inherited, cutOff: cutOffRequests(before.requests) })
        const baseLiveStart = merged?.liveStart ?? recordStart
        // A fork whose parent can't give its inherited turns back has them as its record does: nothing supplied.
        const baseSupplied = merged?.supplied ?? (recordStart && isFork(before) ? 0 : undefined)
        const refreshed = merged && merged.base
        if (refreshed && this.access.resident(id) === resident &&
            resident.snapshot === before && resident.generation === generation &&
            !resident.opening && !resident.transferring && !this.access.admission.closed &&
            ((before.baseCoveredBlocks ?? 0) !== covered || before.baseSupplied !== baseSupplied || !isDeepStrictEqual(base, refreshed))) {
          // The journal keeps a new reading until the record store holds what
          // it adds (`holdBase`); the same history, moved or decoded by
          // another build, is still the one it holds.
          const sameHistory = base !== null && (before.baseCoveredBlocks ?? 0) === covered && isDeepStrictEqual(base.entries, refreshed.entries)
          resident.snapshot = { ...before, base: refreshed, baseCoveredBlocks: covered, baseLiveStart, baseSupplied, baseSource: sameHistory ? before.baseSource : undefined }
          this.access.flush(resident)
          // A block the record held before was compared then; the record standing alone is one finding.
          const known = before.baseCoveredBlocks ?? 0
          if (merged.merge && covered > known) {
            // A conversation continued in another harness reports that one's runtime, which wrote neither side.
            const context = before.session.harness === refreshed.ref.harness ? binding?.executionContext ?? before.session.executionContext : undefined
            retainMismatches({
              harness: refreshed.ref.harness, version: context?.runtime.kind === "reported" ? context.runtime.version : undefined, conversation: id, path: refreshed.ref.path,
              mismatches: merged.merge.unaligned ? merged.merge.mismatches : merged.merge.mismatches.filter((mismatch) => mismatch.at >= known),
            })
          }
        }
        void this.holdBase(resident)
      } catch (error) {
        hostLog("live", "native history refresh deferred", { conversation: id, error: errorMessage({ error }) })
      }
      return this.access.stamp(resident.snapshot)
    })()
    this.refreshes.set(id, work)
    void work.finally(() => this.refreshes.delete(id)).catch(() => {})
    return work
  }

  /**
   * The harness dropped its history from native run `run` on, as OpenCode's
   * revert does, whoever asked for it. The live blocks still hold what it
   * dropped; its store holds what remains, so the transcript is read back.
   */
  nativeRewound(resident: Resident, run: string): void {
    const id = resident.snapshot.session.id
    const request = resident.snapshot.requests.find((candidate) => candidate.nativeRun?.runId === run)
    hostLog("live", "native history rewound", { conversation: id, request: request?.id ?? "none" })
    const before = resident.snapshot.base
    void this.refreshedSnapshot(id).then(() => {
      if (this.access.resident(id) !== resident || resident.snapshot.base !== before) return
      const binding = activeBinding(resident)
      hostWarn("live", "a native rewind stays drawn until the store is read again", {
        conversation: id, status: resident.snapshot.session.status,
        covered: binding?.coveredBlocks ?? 0, blocks: resident.snapshot.blocks.length,
      })
    })
  }

  async earlier(id: string): Promise<LiveSnapshot> {
    const resident = this.access.require(id)
    await this.readBase(resident)
    if (this.access.pending(resident))
      throw new Error(
        "Wait for the provider switch before loading earlier history"
      )
    const base = resident.snapshot.base
    if (!base?.hasEarlier) return resident.snapshot
    const earlier = await this.access.dependencies.history(base.ref.path, base.start)
    if (
      earlier &&
      JSON.stringify([
        earlier.checkpoint,
        earlier.ref.revision,
        earlier.ref.bytes,
        earlier.ref.updatedAt,
      ]) !==
        JSON.stringify([
          base.checkpoint,
          base.ref.revision,
          base.ref.bytes,
          base.ref.updatedAt,
        ])
    )
      throw new Error(
        "The native history changed since this capture. Open the current provider history to read earlier turns."
      )
    if (this.access.pending(resident))
      throw new Error("History loading was superseded by a provider switch")
    // Another caller may already have prepended this page.
    if (
      earlier &&
      resident.snapshot.base === base &&
      earlier.total >= base.total &&
      earlier.start < base.start
    ) {
      resident.snapshot = {
        ...resident.snapshot,
        control: {
          ...conversationControl(resident),
          bindings: conversationControl(resident).bindings.map((binding) => ({
            ...binding,
            includesBase: false,
          })),
        },
        // Its live part may begin in the page before, when the base began after it.
        base: mergedBase({
          ...base,
          entries: [...earlier.entries, ...base.entries],
          start: earlier.start,
          hasEarlier: earlier.hasEarlier,
        }, resident.snapshot.blocks, resident.snapshot.baseCoveredBlocks ?? 0, resident.snapshot.baseLiveStart, { cutOff: cutOffRequests(resident.snapshot.requests) }).base,
      }
      this.access.flush(resident)
    }
    return resident.snapshot
  }

  async bind(id: string, path: string): Promise<LiveSnapshot> {
    const resident = this.access.require(id)
    await this.readBase(resident)
    const page = await this.access.dependencies.history(path)
    if (
      !page ||
      page.ref.nativeId !== resident.snapshot.session.nativeId ||
      page.ref.harness !== resident.snapshot.session.harness
    )
      throw new Error(
        "That native session does not belong to this conversation"
      )
    resident.snapshot = {
      ...resident.snapshot,
      threadPath: path,
      control: {
        ...conversationControl(resident),
        bindings: conversationControl(resident).bindings.map((binding) =>
          binding.id === conversationControl(resident).activeBindingId
            ? { ...binding, path }
            : binding
        ),
      },
    }
    this.access.flush(resident)
    void this.checkpointIdle(resident)
    return resident.snapshot
  }

  /** Native identity belongs to the host, including sessions never opened in a renderer. */
  discoverNativePaths(): void {
    for (const resident of this.access.residents()) {
      if (resident.opening || resident.transferring) continue
      this.discoverNativePath(resident)
    }
  }

  discoverNativePath(resident: Resident): void {
    const binding = activeBinding(resident)
    if (!binding?.nativeId) return
    const session = { ...resident.snapshot.session, harness: binding.provider, nativeId: binding.nativeId, nativePath: binding.path }
    // A driver's session keeps the file it reports, under whichever encoding that file is in now.
    const path = resident.driver && binding.path ? currentRecordPath(binding.path) : bindingPath(this.access.dependencies, session, binding.path)
    if (!path || path === binding.path) return
    updateBinding(this.access.dependencies, resident, { ...session, nativePath: path })
    this.access.flush(resident)
    void this.checkpointIdle(resident)
    this.access.scheduleHibernation(resident)
  }

  /** `discoverNativePath`, then the driver's own lookup by native ID when the catalog doesn't list the session. */
  async locateNativePath(resident: Resident): Promise<void> {
    this.discoverNativePath(resident)
    const binding = activeBinding(resident)
    if (!binding?.nativeId || binding.path) return
    const { dependencies } = this.access
    const resume = dependencies.driver(binding.provider)?.resume
    const locate = resume?.kind === "native" ? resume.locate : undefined
    const env = locate ? await (dependencies.accountEnv?.(binding) ?? Promise.resolve(process.env)) : process.env
    const path = await locate?.(binding, resident.snapshot.session.cwd, env).catch((error) => {
      hostWarn("recovery", "native session lookup failed", { harness: binding.provider, binding: binding.id, error: errorMessage({ error }) })
      return undefined
    })
    const current = activeBinding(resident)
    if (!path || current?.id !== binding.id || current.nativeId !== binding.nativeId || current.path) return
    hostLog("recovery", "native session located by its ID", { harness: binding.provider, binding: binding.id })
    updateBinding(dependencies, resident, { ...resident.snapshot.session, harness: binding.provider, nativeId: binding.nativeId, nativePath: path })
    this.access.flush(resident)
  }

  /** Records where the native store stands once an idle conversation's turn is in it, so a later read knows what it covers. */
  /** Records, once the session is quiet, which live blocks its record covers: they are what a refresh merges. Resolves when that's settled. */
  checkpointIdle(resident: Resident): Promise<void> {
    const { dependencies } = this.access
    const bindingId = conversationControl(resident).activeBindingId
    const path = resident.snapshot.threadPath
    const blocks = resident.snapshot.blocks
    if (
      !path ||
      !settled(resident.snapshot.session.status) ||
      !dependencies.checkpoint
    )
      return Promise.resolve()
    // Where the session is now, by its identity: Codex compresses an idle rollout in place.
    const binding = activeBinding(resident)
    const at = binding?.nativeId ? this.located({ harness: binding.provider, nativeId: binding.nativeId, path }) : path
    return dependencies
      .checkpoint(at, resident.snapshot.session.harness)
      .then((checkpoint) => {
        if (
          !checkpoint ||
          this.access.resident(resident.snapshot.session.id) !== resident ||
          conversationControl(resident).activeBindingId !== bindingId ||
          !settled(resident.snapshot.session.status) ||
          resident.snapshot.blocks !== blocks ||
          resident.snapshot.threadPath !== path ||
          resident.snapshot.requests.some(
            (request) => request.status === "dispatching"
          )
        )
          return
        const control = conversationControl(resident)
        resident.snapshot = {
          ...resident.snapshot,
          control: {
            ...control,
            bindings: control.bindings.map((binding) =>
              binding.id === bindingId
                ? { ...binding, checkpoint, coveredBlocks: blocks.length }
                : binding
            ),
          },
        }
        this.access.flush(resident)
      })
      .catch(() => {})
  }
}

/** The active binding as the connected `session` reports it: its native ID, record, account and settings. */
export function updateBinding(dependencies: Pick<Dependencies, "driver" | "nativePath" | "noteCarried">, resident: Resident, session: LiveSessionState): void {
  const control = conversationControl(resident)
  const active = activeBinding(resident)
  // A session a switch opened learns its native id after it opens: its transcript is the record store's to keep from then.
  if (active && session.nativeId && session.nativeId !== active.nativeId)
    noteCarriedFolders(dependencies, resident.snapshot, { id: active.id, provider: active.provider, nativeId: session.nativeId })
  const reported = session.nativePath ?? resident.snapshot.threadPath
  // A session that changes native ID (Claude's /clear) can still report the
  // previous session's source; that pairing would reopen the wrong record.
  const renamed = Boolean(active?.nativeId && session.nativeId && session.nativeId !== active.nativeId)
  const driver = resident.driver ?? dependencies.driver(session.harness)
  const before = renamed && active?.path ? nativeRecord(driver, active.path, active.nativeId) : undefined
  const after = renamed && reported ? nativeRecord(driver, reported, session.nativeId) : undefined
  const stale = renamed && Boolean(reported) && (!after || (before?.path === after.path && before.record === after.record))
  const path = bindingPath(dependencies, session, stale ? undefined : reported)
  if (renamed)
    hostLog("live", "a session changed native ID", {
      conversation: resident.snapshot.session.id, harness: session.harness,
      source: path ? (stale ? "found by catalog" : "reported") : "awaiting location",
    })
  const context = session.executionContext && {
    ...session.executionContext,
    store: path ? { kind: "located" as const, path }
      : stale ? { kind: "unavailable" as const, reason: "The session's new native source has not been located yet" }
      : session.executionContext.store,
  }
  resident.snapshot = {
    ...resident.snapshot,
    session: { ...resident.snapshot.session, executionContext: context },
    threadPath: path,
    control: {
      ...control,
      bindings: control.bindings.map((binding) =>
        binding.id === control.activeBindingId
          ? {
              ...binding,
              nativeId: session.nativeId ?? binding.nativeId,
              executionContext: context ?? binding.executionContext,
              path: renamed ? path : path ?? binding.path,
              tuning: session.settings ?? binding.tuning,
              modeId:
                session.currentMode ?? binding.modeId,
            }
          : binding
      ),
    },
  }
}

function isFork(snapshot: LiveSnapshot): boolean {
  return snapshot.control?.ancestry?.kind === "fork"
}

/** Where the live blocks begin in the base's record: the live start, less what a fork's inherited turns gained from its parent's history. */
function recordLiveStart(snapshot: LiveSnapshot): number | undefined {
  return snapshot.baseLiveStart === undefined ? undefined : snapshot.baseLiveStart - (snapshot.baseSupplied ?? 0)
}

/** The turns before the live blocks, as the base shows them: a fork's inherited turns, merged with its parent's history when they were read. */
function inheritedOf(snapshot: LiveSnapshot): Entry[] | undefined {
  const { base, baseLiveStart } = snapshot
  return base && baseLiveStart !== undefined && baseLiveStart >= base.start ? base.entries.slice(0, baseLiveStart - base.start) : undefined
}

/**
 * A session whose last turn ended, as it ended: its record holds all it
 * will of the turns so far. A failed turn's session says `failed` until the
 * next prompt, and one Mako closed says `closed`; what its record never kept
 * of a turn cut off is the stream's (`cutOffRequests`), so covering it loses
 * nothing.
 */
export function settled(status: LiveSnapshot["session"]["status"]): boolean {
  return status === "ready" || status === "failed" || status === "closed"
}

/**
 * Whether two readings of a history hold the same turns: entry for entry the
 * same kind, the same words (whitespace aside) and the same calls, whatever
 * ids or bytes each names, which a decoder change may move.
 */
function sameTurns(left: readonly Entry[], right: readonly Entry[]): boolean {
  return left.length === right.length && left.every((entry, index) => turnItem(entry) === turnItem(right[index]!))
}

function turnItem(entry: Entry): string {
  switch (entry.type) {
    case "user":
    case "text":
    case "thinking":
      return `${entry.type}\0${entry.text.replace(/\s+/g, "")}`
    case "tool":
      return `tool\0${entry.id}`
    case "event":
      return `event\0${entry.label}\0${entry.detail ?? ""}`
    default:
      return entry.type
  }
}
