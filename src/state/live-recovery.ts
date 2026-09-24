import { acknowledgeComposerSettings } from "@/state/composer-settings"
import { playFeedback } from "@/state/feedback"
import { getMako, hasBridge } from "@/lib/bridge"
import type { LiveBatch, LiveSnapshot, LiveSummary } from "@/lib/types"
import { acpStore, carriedFailureSeen, replaceAcpConversation, updateAcpConversation } from "@/state/acp-state"
import { syncThreadStatus } from "@/state/acp-live"
import { threadsStore } from "@/state/thread-store"
import { reduceLiveUpdates } from "../../electron/contracts/live-content"
import { projectLive } from "@/state/live-projection"
import { toast } from "sonner"
import { settleMessage } from "@/state/message-outbox"
import { isHostReconnectingError } from "../../electron/contracts/host-connection"
import { prependLiveHistory, readLiveSnapshot, readLiveValue, retainLiveDetails } from "@/state/live-history"
import type { LiveHistoryPage } from "../../electron/contracts/live-history"

const fetching = new Map<string, Promise<boolean>>()
const pending = new Map<string, LiveBatch[]>()
// Invalid/oversized snapshots cannot be repaired by refetching on every token.
// Activation and reconnect retry them. Transient outages may recover on a later
// batch even if the independent event stream stayed connected throughout.
const failed = new Map<string, { description: string; reconnecting: boolean }>()

function restoredLive(id: string): void {
  if (failed.delete(id)) toast.dismiss(`live-restore:${id}`)
}

/**
 * Whether `incoming` continues the numbering `held` was built on. Revisions
 * compare only within one host epoch; across epochs the newer snapshot wins
 * outright, because the host that wrote it may have rewritten what it reopened
 * at the same revision.
 */
function sameEpoch(held: { epoch?: string } | undefined, incoming: { epoch?: string }): boolean {
  return held?.epoch === undefined || incoming.epoch === undefined || held.epoch === incoming.epoch
}

export function applyLiveSnapshot(snapshot: LiveSnapshot, replyBindingId?: string | null): void {
  restoredLive(snapshot.session.id)
  for (const request of snapshot.requests) settleMessage(request.id, true)
  for (const transfer of snapshot.control?.transfers ?? []) settleMessage(transfer.input.id, true)
  const id = snapshot.session.id
  const existing = acpStore.get().conversations[id]
  if (existing?.hydrated && sameEpoch(existing, snapshot) && (existing.revision ?? 0) > snapshot.revision) {
    if (replyBindingId !== undefined) updateAcpConversation(id, (current) => ({ ...current, replyBindingId: replyBindingId ?? undefined }))
    return
  }
  const pendingPrompts = existing?.pendingPrompts?.filter(
    (prompt) => !snapshot.requests.some((request) => request.id === prompt.id) &&
      !snapshot.control?.transfers.some((transfer) => transfer.input.id === prompt.id)
  )
  const observedChange = existing?.kind === "live" && sameEpoch(existing, snapshot) &&
    pending.get(id)?.some(batch => sameEpoch(batch, snapshot) && batch.revision > (existing.revision ?? 0) && batch.revision <= snapshot.revision)
  snapshot = retainLiveDetails(snapshot)
  replaceAcpConversation(id, {
    key: id,
    replyBindingId: replyBindingId === undefined ? existing?.replyBindingId : replyBindingId ?? undefined,
    draftKey: existing?.draftKey ?? id,
    harness: snapshot.session.harness,
    cwd: snapshot.session.cwd,
    title: snapshot.session.title,
    threadPath: snapshot.threadPath,
    createdAt: snapshot.createdAt,
    updatedAt: Date.now(),
    kind: "live",
    session: snapshot.session,
    nativePaths: snapshot.control?.bindings.flatMap((binding) =>
      binding.path ? [binding.path] : []
    ),
    control: snapshot.control,
    nativeAgents: snapshot.nativeAgents,
    requests: snapshot.requests,
    pendingPrompts,
    base: snapshot.base,
    baseCoveredBlocks: snapshot.baseCoveredBlocks,
    blocks: snapshot.blocks,
    revision: snapshot.revision,
    epoch: snapshot.epoch ?? existing?.epoch,
    history: snapshot.history,
    hydrated: true,
    projection: projectLive(snapshot, existing?.projection, pendingPrompts),
    permission: snapshot.permissions[0] ?? null,
    queued: snapshot.requests.filter(
      (request) => request.status === "queued" || request.status === "held"
    ),
    hiddenUserPrompt: null,
    sending: false,
    canceling: false,
    failureSeen: carriedFailureSeen(
      existing?.kind === "live" ? existing : undefined,
      snapshot.session
    ),
  })
  const restored = acpStore.get().conversations[id]
  if (observedChange) notifyCompletion(existing.requests, snapshot.requests)
  if (restored?.kind === "live") acknowledgeComposerSettings(restored)
  if (restored?.kind === "live")
    syncThreadStatus(
      restored,
      existing?.kind === "live" ? existing.session.status : "starting",
      existing?.threadPath,
      observedChange ? undefined : "hydrate"
    )
  const buffered = pending.get(id) ?? []
  pending.delete(id)
  for (const batch of buffered) applyLiveBatch(batch)
}

export async function hydrateLive(id: string, quiet = false): Promise<boolean> {
  if (!hasBridge()) return false
  const existing = fetching.get(id)
  if (existing) return existing
  let restored = false
  const fetch = readLiveSnapshot(id, true)
    .then((snapshot) => {
      restored = true
      if (snapshot && "kind" in snapshot) restoredLive(id)
      else if (snapshot) applyLiveSnapshot(snapshot)
      else {
        pending.delete(id)
        restoredLive(id)
      }
      return snapshot !== null
    })
    .catch((error) => {
      const description = error instanceof Error ? error.message : String(error)
      const previous = failed.get(id)
      // Transport outages belong to the shared reconnect/owner state. They
      // are not a new conversation failure on every refresh or in every tab.
      const reconnecting = error instanceof Error && isHostReconnectingError(error)
      if (!quiet && !reconnecting && previous?.description !== description)
        toast.error("Conversation could not refresh", { id: `live-restore:${id}`, description })
      // A quiet probe must not consume the user's first visible error.
      failed.set(id, { description: quiet && !reconnecting ? previous?.description ?? "" : description, reconnecting })
      return false
    })
    .finally(() => {
      fetching.delete(id)
      if (restored && pending.get(id)?.length)
        queueMicrotask(() => {
          void hydrateLive(id)
        })
    })
  fetching.set(id, fetch)
  return fetch
}

export function applyLiveBatch(batch: LiveBatch): void {
  for (const request of batch.requests ?? []) settleMessage(request.id, true)
  for (const transfer of batch.control?.transfers ?? []) settleMessage(transfer.input.id, true)
  const current = acpStore.get().conversations[batch.id]
  if (current?.kind === "live" && sameEpoch(current, batch) && batch.revision <= (current.revision ?? 0)) return
  if (
    current?.kind === "live" &&
    !current.hydrated &&
    !batch.historyChanged &&
    acpStore.get().activeKey !== batch.id &&
    !fetching.has(batch.id)
  ) {
    if (sameEpoch(current, batch) && batch.revision <= (current.revision ?? 0)) return
    const session = batch.session ?? current.session
    const next = {
      ...current,
      session,
      harness: session.harness,
      cwd: session.cwd,
      title: session.title,
      control: batch.control ?? current.control,
      nativePaths: batch.control
        ? batch.control.bindings.flatMap((binding) =>
            binding.path ? [binding.path] : []
          )
        : current.nativePaths,
      nativeAgents: batch.nativeAgents ?? current.nativeAgents,
      requests: batch.requests ?? current.requests,
      permission: batch.permissions
        ? (batch.permissions[0] ?? null)
        : current.permission,
      threadPath:
        batch.threadPath === undefined
          ? current.threadPath
          : (batch.threadPath ?? undefined),
      revision: batch.revision,
      updatedAt: Date.now(),
      failureSeen: carriedFailureSeen(current, session),
    }
    replaceAcpConversation(batch.id, next)
    notifyCompletion(current.requests, batch.requests)
    if (batch.session || batch.permissions || batch.requests)
      syncThreadStatus(next, current.session.status, current.threadPath)
    return
  }
  if (
    !current?.hydrated ||
    current.kind !== "live" ||
    // A gap in the numbering, or numbering from another host: the blocks on
    // screen are not what this batch was reduced against, so it is buffered
    // and a fresh snapshot is taken rather than merged onto the wrong state.
    !sameEpoch(current, batch) ||
    batch.historyChanged ||
    (current.history && (batch.base !== undefined || batch.baseCoveredBlocks !== undefined ||
      (batch.changedFrom !== undefined && batch.changedFrom < current.history.blockStart) ||
      batch.updates.some(update => update.kind === "tool-update" && current.blocks.some(block =>
        block.type === "tool" && block.id === update.id && block.historyRest)))) ||
    batch.revision > (current.revision ?? 0) + 1
  ) {
    // A bounded buffer is only an optimization. The host snapshot remains authoritative.
    const buffered = pending.get(batch.id) ?? []
    pending.set(batch.id, [...buffered.slice(-127), batch])
    const failure = failed.get(batch.id)
    if (!failure || failure.reconnecting) void hydrateLive(batch.id)
    return
  }
  if (batch.revision <= (current.revision ?? 0)) return
  const session = batch.session ?? current.session
  const blocks = reduceLiveUpdates(current.blocks, batch.updates)
  const history = current.history ? { ...current.history,
    blockEnd: batch.blockCount ?? current.history.blockStart + blocks.length } : undefined
  const base = batch.base === undefined ? (current.base ?? null) : batch.base
  const baseCoveredBlocks = batch.baseCoveredBlocks ?? current.baseCoveredBlocks
  const requests = batch.requests ?? current.requests
  const pendingPrompts = batch.requests || batch.control
    ? current.pendingPrompts?.filter(
        (prompt) => !requests?.some((request) => request.id === prompt.id) &&
          !(batch.control ?? current.control)?.transfers.some((transfer) => transfer.input.id === prompt.id)
      )
    : current.pendingPrompts
  replaceAcpConversation(batch.id, {
    ...current,
    control: batch.control ?? current.control,
    nativeAgents: batch.nativeAgents ?? current.nativeAgents,
    nativePaths: batch.control
      ? batch.control.bindings.flatMap((binding) =>
          binding.path ? [binding.path] : []
        )
      : current.nativePaths,
    harness: session.harness,
    requests,
    pendingPrompts,
    blocks,
    history,
    session,
    revision: batch.revision,
    epoch: batch.epoch ?? current.epoch,
    base,
    baseCoveredBlocks,
    threadPath:
      batch.threadPath === undefined
        ? current.threadPath
        : (batch.threadPath ?? undefined),
    sending: batch.session || (pendingPrompts?.length ?? 0) < (current.pendingPrompts?.length ?? 0)
      ? false : current.sending,
    canceling: session.status === "running" ? current.canceling : false,
    permission: batch.permissions
      ? (batch.permissions[0] ?? null)
      : current.permission,
    queued: batch.requests
      ? batch.requests.filter(
          (request) => request.status === "queued" || request.status === "held"
        )
      : current.queued,
    projection:
      requests === current.requests &&
      pendingPrompts === current.pendingPrompts &&
      blocks === current.blocks &&
      base === current.base &&
      baseCoveredBlocks === current.baseCoveredBlocks &&
      session.status === current.session.status &&
      session.harness === current.session.harness
        ? current.projection
        : acpStore.get().activeKey === batch.id
          ? projectLive(
              { blocks, base, baseCoveredBlocks, history, session, requests },
              current.projection,
              pendingPrompts
            )
          : undefined,
    updatedAt: Date.now(),
    failureSeen: carriedFailureSeen(current, session),
  })
  notifyCompletion(current.requests, batch.requests)
  const next = acpStore.get().conversations[batch.id]
  if (next && batch.session?.settings) acknowledgeComposerSettings(next)
  if (
    next?.kind === "live" &&
    (batch.session || batch.permissions || batch.requests)
  )
    syncThreadStatus(next, current.session.status, current.threadPath)
}

function notifyCompletion(
  previous: LiveSnapshot["requests"] | undefined,
  next: LiveSnapshot["requests"] | undefined
): void {
  if (
    next?.some(
      (request) =>
        request.status === "completed" &&
        previous?.some(
          (old) => old.id === request.id && old.status === "dispatching"
        )
    )
  )
    playFeedback("complete")
}

export function hydrateLiveSummaries(
  summaries: LiveSummary[],
  reconnect = false
): void {
  for (const summary of summaries) {
    const previous = acpStore.get().conversations[summary.session.id]
    if (previous?.hydrated && !reconnect) continue
    if (reconnect && previous?.kind === "live") {
      replaceAcpConversation(summary.session.id, {
        ...previous,
        session: summary.session,
        hydrated: false,
        nativePaths: summary.nativePaths,
        permission: null,
        failureSeen: carriedFailureSeen(previous, summary.session),
      })
      // A turn that ended while this renderer was away is still an outcome:
      // the summary is the only word it gets, so the transition is read here
      // as a replay — recorded for the mark and the badge, never announced.
      // Only a turn's end is read this way; a permission the summary cannot
      // carry must not be taken for one that was answered.
      const restored = acpStore.get().conversations[summary.session.id]
      if (
        restored?.kind === "live" &&
        previous.session.status === "running" &&
        summary.session.status !== "running"
      )
        syncThreadStatus(restored, previous.session.status, previous.threadPath, "hydrate")
      continue
    }
    replaceAcpConversation(summary.session.id, {
      kind: "live",
      key: summary.session.id,
      draftKey: summary.session.id,
      session: summary.session,
      harness: summary.session.harness,
      cwd: summary.session.cwd,
      title: summary.session.title,
      nativePaths: summary.nativePaths,
      threadPath: summary.threadPath,
      revision: summary.revision,
      hydrated: false,
      createdAt: summary.createdAt,
      updatedAt: summary.createdAt,
      blocks: [],
      queued: [],
      hiddenUserPrompt: null,
      permission: null,
      sending: false,
      canceling: false,
    })
    const restored = acpStore.get().conversations[summary.session.id]
    if (restored?.kind === "live")
      syncThreadStatus(restored, "starting", undefined, "hydrate")
  }
  const active = acpStore.get().activeKey
  if (active && summaries.some((summary) => summary.session.id === active))
    void hydrateLive(active)
  if (reconnect) return
  const requested = globalThis.sessionStorage?.getItem(
    "mako:reload-conversation"
  )
  globalThis.sessionStorage?.removeItem("mako:reload-conversation")
  if (requested && requested !== "new" && !summaries.some((summary) => summary.session.id === requested) && !acpStore.get().activeKey) {
    // The selected conversation may belong to another host and therefore be
    // absent from this host's boot list. Its persisted route can restore it.
    acpStore.set({ activeKey: requested })
    void hydrateLive(requested).then(() => {
      if (acpStore.get().activeKey !== requested) return
      const restored = acpStore.get().conversations[requested]
      if (restored) threadsStore.set({ composerHarness: restored.harness })
      else acpStore.set({ activeKey: null })
    })
    return
  }
  const selected =
    summaries.find((summary) => summary.session.id === requested) ??
    summaries.toSorted((a, b) => b.createdAt - a.createdAt)[0]
  if (selected && requested !== "new" && !acpStore.get().activeKey) {
    acpStore.set({ activeKey: selected.session.id })
    threadsStore.set({ composerHarness: selected.session.harness })
    void hydrateLive(selected.session.id)
  }
}

export async function loadEarlierLive(id: string): Promise<void> {
  const held = acpStore.get().conversations[id]
  if (held?.kind === "live" && held.history) {
    const before = held.history.before
    if (!before) return
    const page = await readLiveValue<LiveHistoryPage>(id, { kind: "earlier", token: held.history.token, before })
    const current = acpStore.get().conversations[id]
    if (current?.kind !== "live" || current.history?.token !== held.history.token ||
        current.history.before?.blocks !== before.blocks || current.history.before?.base !== before.base) return
    const next = prependLiveHistory({ ...current, base: current.base ?? null }, page)
    replaceAcpConversation(id, { ...next, projection: projectLive({ ...next, base: next.base ?? null }, undefined, next.pendingPrompts) })
    return
  }
  const snapshot = await getMako().liveEarlier(id)
  applyLiveSnapshot(snapshot)
}

/** Losing a peer host affects only the conversations that it owns. */
export function markLiveOwnerDisconnected(ids: string[]): void {
  for (const id of ids) {
    const current = acpStore.get().conversations[id]
    if (current?.kind !== "live") continue
    replaceAcpConversation(id, {
      ...current,
      session: { ...current.session, connection: "disconnected" },
    })
  }
}
