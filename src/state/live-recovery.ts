import { acknowledgeComposerSettings } from "@/state/composer-settings"
import { playFeedback } from "@/state/feedback"
import { getMako, hasBridge } from "@/lib/bridge"
import type { LiveBatch, LiveSnapshot, LiveSummary } from "@/lib/types"
import { acpStore, carriedFailureSeen, replaceAcpConversation } from "@/state/acp-state"
import { syncThreadStatus } from "@/state/acp-live"
import { threadsStore } from "@/state/thread-store"
import { reduceLiveUpdates } from "../../electron/contracts/live-content"
import { projectLive } from "@/state/live-projection"
import { toast } from "sonner"

const fetching = new Map<string, Promise<void>>()
const pending = new Map<string, LiveBatch[]>()

/**
 * Whether `incoming` continues the numbering `held` was built on. Revisions
 * compare only within one host epoch; across epochs the newer snapshot wins
 * outright, because the host that wrote it may have rewritten what it reopened
 * at the same revision.
 */
function sameEpoch(held: { epoch?: string } | undefined, incoming: { epoch?: string }): boolean {
  return held?.epoch === undefined || incoming.epoch === undefined || held.epoch === incoming.epoch
}

export function applyLiveSnapshot(snapshot: LiveSnapshot): void {
  const id = snapshot.session.id
  const existing = acpStore.get().conversations[id]
  if (existing?.hydrated && sameEpoch(existing, snapshot) && (existing.revision ?? 0) > snapshot.revision) return
  const pendingPrompts = existing?.pendingPrompts?.filter(
    (prompt) => !snapshot.requests.some((request) => request.id === prompt.id)
  )
  replaceAcpConversation(id, {
    key: id,
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
    blocks: snapshot.blocks,
    revision: snapshot.revision,
    epoch: snapshot.epoch ?? existing?.epoch,
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
  if (restored?.kind === "live") acknowledgeComposerSettings(restored)
  if (restored?.kind === "live")
    syncThreadStatus(
      restored,
      existing?.kind === "live" ? existing.session.status : "starting",
      existing?.threadPath,
      "hydrate"
    )
  const buffered = pending.get(id) ?? []
  pending.delete(id)
  for (const batch of buffered) applyLiveBatch(batch)
}

export async function hydrateLive(id: string): Promise<void> {
  if (!hasBridge()) return
  const existing = fetching.get(id)
  if (existing) return existing
  let restored = false
  const fetch = getMako()
    .liveSnapshot(id)
    .then((snapshot) => {
      restored = true
      if (snapshot) applyLiveSnapshot(snapshot)
      else pending.delete(id)
    })
    .catch((error) => {
      toast.error("The live conversation could not be restored", {
        description: error instanceof Error ? error.message : String(error),
      })
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
  const current = acpStore.get().conversations[batch.id]
  if (
    current?.kind === "live" &&
    !current.hydrated &&
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
    batch.revision > (current.revision ?? 0) + 1
  ) {
    // A bounded buffer is only an optimization. The host snapshot remains authoritative.
    const buffered = pending.get(batch.id) ?? []
    pending.set(batch.id, [...buffered.slice(-127), batch])
    void hydrateLive(batch.id)
    return
  }
  if (batch.revision <= (current.revision ?? 0)) return
  const session = batch.session ?? current.session
  const blocks = reduceLiveUpdates(current.blocks, batch.updates)
  const base = batch.base === undefined ? (current.base ?? null) : batch.base
  const requests = batch.requests ?? current.requests
  const pendingPrompts = batch.requests
    ? current.pendingPrompts?.filter(
        (prompt) => !batch.requests?.some((request) => request.id === prompt.id)
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
    session,
    revision: batch.revision,
    epoch: batch.epoch ?? current.epoch,
    base,
    threadPath:
      batch.threadPath === undefined
        ? current.threadPath
        : (batch.threadPath ?? undefined),
    sending: batch.session ? false : current.sending,
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
      session.status === current.session.status &&
      session.harness === current.session.harness
        ? current.projection
        : acpStore.get().activeKey === batch.id
          ? projectLive(
              { blocks, base, session, requests },
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
  const snapshot = await getMako().liveEarlier(id)
  applyLiveSnapshot(snapshot)
}
