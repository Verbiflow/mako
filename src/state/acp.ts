import { durableAttachments, saveMessage, settleMessage } from "@/state/message-outbox"
import { stagePrompt } from "@/state/acp-pending"
import { autoContinuePending } from "@/state/prompt-delivery"
import { projectAcp } from "@/state/live-projection"
import {
  chooseProviderMode,
  providerDefaultMode,
  providerAccessModes,
  savedProviderMode,
  threadAccessMode,
} from "@/state/provider-access"
import { descriptorFor } from "@/state/descriptors"
import {
  currentSettingsTarget,
  threadSettingsTarget,
  settingsForSend,
} from "@/state/composer-settings"
import { leaveViewerForLive } from "@/state/thread-viewing"
import { performLiveAction } from "@/state/live-actions"
import { applyLiveSnapshot, hydrateLive } from "@/state/live-recovery"
import { getMako, hasBridge } from "@/lib/bridge"
import type {
  ContinuationResolution,
  PromptAttachment,
  ThreadRef,
  TransferInput,
  RewindInput,
  RewindPreview,
} from "@/lib/types"
import { activeIs, updateLive } from "@/state/acp-live"
import { editQueuedPrompt, sendTo } from "@/state/acp-queue"
import {
  beginStart,
  failStart,
  launch,
  updateStarting,
  waitForPromotion,
  type AcpStartOptions,
  titleFromPrompt,
} from "@/state/acp-start"
import {
  acpForThread,
  acpStore,
  activeAcp,
  activeLiveAcp,
  liveAcpConversations,
  liveAcpForThread,
  removeAcpConversation,
  replaceAcpConversation,
  updateAcpConversation,
  useAcp,
  type AcpConversation,
  type AcpQueuedPrompt,
  type AcpState,
  type LiveAcpConversation,
  type StartingAcpConversation,
} from "@/state/acp-state"
import { prefsStore } from "@/state/prefs"
import {
  markThreadReviewed,
  setThreadAttention,
  setThreadRunning,
  threadsStore,
  threads,
  withConversion,
} from "@/state/threads"
import { toast } from "sonner"

export {
  acpForThread,
  acpStore,
  activeAcp,
  activeLiveAcp,
  liveAcpConversations,
  liveAcpForThread,
  useAcp,
}
export type {
  AcpConversation,
  AcpQueuedPrompt,
  AcpState,
  LiveAcpConversation,
  StartingAcpConversation,
}

export const acp = {
  canSteer(): boolean {
    const live = activeLiveAcp(acpStore.get())
    return Boolean(
      live &&
      live.session.status === "running" &&
      descriptorFor(threadsStore.get(), live.harness)?.canSteer
    )
  },

  /**
   * Send a queued message into the running turn instead of after it. The
   * queue entry leaves only once the provider has accepted the steer, so a
   * refused steer costs nothing and the message stays in line.
   */
  async steerQueued(requestId: string): Promise<boolean> {
    const live = activeLiveAcp(acpStore.get())
    const queued = live?.requests?.find(
      (item) =>
        item.id === requestId &&
        (item.status === "queued" || item.status === "held")
    )
    if (!live || !queued) return false
    const accepted = await acp.steer(queued.text, queued.attachments)
    if (!accepted) return false
    await editQueuedPrompt(
      { kind: "live", id: live.key },
      { id: queued.id, text: queued.text, attachments: queued.attachments },
      { kind: "remove" }
    )
    return true
  },

  async steer(
    text: string,
    attachments: PromptAttachment[] = []
  ): Promise<boolean> {
    const live = activeLiveAcp(acpStore.get())
    const request = live?.requests?.find(
      (item) => item.status === "dispatching"
    )
    if (!live || !request) return false
    return performLiveAction(live.key, {
      kind: "steer",
      id: crypto.randomUUID(),
      requestId: request.id,
      text,
      attachments,
    })
  },

  async compact(requestId?: string): Promise<boolean> {
    const live = activeLiveAcp(acpStore.get())
    if (!live) return false
    return performLiveAction(live.key, {
      kind: "compact",
      id: crypto.randomUUID(),
      requestId,
    })
  },

  async recoverFresh(conversationId: string, requestId: string): Promise<boolean> {
    const current = acpStore.get().conversations[conversationId]
    if (current?.kind !== "live") return false
    const request = current.requests?.find((item) => item.id === requestId && item.status === "failed")
    if (!request) return false
    return acp.startFresh(current.harness, current.cwd, request.text, request.attachments)
  },

  activate(key: string, refresh = true): boolean {
    const conversation = acpStore.get().conversations[key]
    if (!conversation) return false
    if (conversation.hydrated && !conversation.projection)
      replaceAcpConversation(key, {
        ...conversation,
        projection: projectAcp(conversation),
      })
    acpStore.set({ activeKey: key })
    if (conversation.kind === "live" && refresh)
      void hydrateLive(key)
    threadsStore.set({ composerHarness: conversation.control?.bindings.find((binding) => binding.id === conversation.replyBindingId)?.provider ?? conversation.harness })
    // Opening the conversation acknowledges its failure, the way opening a
    // thread acknowledges an unread answer; the rail row and its folder's
    // chip go back to showing time.
    if (
      conversation.kind === "live" &&
      conversation.session.status === "failed" &&
      !conversation.failureSeen
    )
      updateLive(key, (current) => ({ ...current, failureSeen: true }))
    const path = conversation.threadPath
    if (path) markThreadReviewed(path)
    if (threadsStore.get().viewing?.ref.path === path) return true
    threadsStore.set({
      viewing: null,
      opening: null,

      run: null,
    })
    return true
  },

  activateThread(ref: ThreadRef | { path: string }): boolean {
    const conversation = acpForThread(acpStore.get(), ref)
    return conversation ? acp.activate(conversation.key) : false
  },

  deactivate(): void {
    acpStore.set({ activeKey: null })
  },

  bindThreads(refs: ThreadRef[]): void {
    const state = acpStore.get()
    const active = activeLiveAcp(state)
    if (active && active.session.status !== "running") {
      const ref = refs.find((candidate) => candidate.path === (active.threadPath ?? active.base?.ref.path))
      if (ref && (!active.base || ref.revision !== active.base.ref.revision ||
          ref.bytes !== active.base.ref.bytes || ref.updatedAt !== active.base.ref.updatedAt))
        void hydrateLive(active.key)
    }
    const claimedPaths = new Set(
      liveAcpConversations(state)
        .map((conversation) => conversation.threadPath)
        .filter((path): path is string => Boolean(path))
    )
    for (const conversation of Object.values(state.conversations)) {
      if (
        conversation.kind !== "live" ||
        conversation.threadPath ||
        !conversation.session.nativeId
      )
        continue
      const ref = refs.find(
        (candidate) =>
          candidate.harness === conversation.session.harness &&
          candidate.nativeId === conversation.session.nativeId
      )
      if (!ref || claimedPaths.has(ref.path)) continue
      claimedPaths.add(ref.path)
      void getMako()
        .liveBind(conversation.key, ref.path)
        .then(applyLiveSnapshot)
        .catch((error) => toast.error(String(error)))
      const next = updateLive(conversation.key, (current) => ({
        ...current,
        threadPath: ref.path,
        title: ref.title ?? current.title,
        updatedAt: Date.now(),
      }))
      if (!next) continue
      const continuing = autoContinuePending(next.requests)
      setThreadRunning(ref.path, next.session.status === "running" || continuing)
      if (next.session.status === "failed")
        setThreadAttention(
          ref.path,
          activeIs(next.key) || next.failureSeen || continuing
            ? null
            : { kind: "failed", at: Date.now(), detail: next.session.error }
        )
      else if (
        next.session.status === "ready" &&
        next.session.lastStop &&
        !/(?:cancel|interrupt|abort)/i.test(next.session.lastStop)
      )
        setThreadAttention(
          ref.path,
          activeIs(next.key)
            ? null
            : { kind: "review", at: Date.now(), unread: true }
        )
    }
  },

  async openInteractive(ref: ThreadRef): Promise<boolean> {
    if (!hasBridge()) return false
    let canResume: boolean
    try {
      const resolved = await getMako().resolveContinuation(ref.path)
      if (resolved.transport === "attached") {
        applyLiveSnapshot(resolved.snapshot, resolved.bindingId ?? null)
        return acp.activate(resolved.conversationId, false)
      }
      if (resolved.transport === "refused" || resolved.transport === "unavailable") throw new Error(resolved.reason)
      canResume = resolved.transport === "live"
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
    const harness = canResume ? ref.harness : threadsStore.get().composerHarness
    const starting = beginStart({
      settingsTarget: canResume
        ? threadSettingsTarget(ref)
        : { kind: "new", harness, cwd: ref.cwd ?? "" },
      harness,
      cwd: ref.cwd ?? "",
      title: ref.title,
      threadPath: ref.path,
      blocks: [],
      hiddenUserPrompt: null,
    })
    try {
      let contextPrompt: string | null = null
      if (!canResume) {
        const prepared = await withConversion(
          ref.harness,
          harness,
          ref.title,
          async () => {
            const [artifact] = await getMako().threadContexts([ref.path])
            return artifact
          }
        )
        if (!prepared)
          throw new Error("This conversation could not be prepared")
        contextPrompt = `Read ${prepared.file} in full before continuing. It is ordered newest turn first.`
        updateStarting(starting.key, { hiddenUserPrompt: contextPrompt })
      }
      const options: AcpStartOptions = {
        title: ref.title,
      }
      if (canResume) options.resume = ref.nativeId
      return launch(starting, options, contextPrompt ?? undefined)
    } catch (error) {
      failStart(starting.key)
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async resumeAndSend(
    ref: ThreadRef,
    prompt: string,
    attachments: PromptAttachment[] = [],
    resolution?: ContinuationResolution
  ): Promise<boolean> {
    if (!hasBridge()) return false
    try {
      const resolved = resolution ?? await getMako().resolveContinuation(ref.path)
      if (resolved.transport === "attached") {
        applyLiveSnapshot(resolved.snapshot, resolved.bindingId ?? null)
        acp.activate(resolved.conversationId, false)
        return sendTo(resolved.conversationId, prompt, attachments, undefined, resolved.bindingId)
      }
      if (resolved.transport !== "live") {
        if (resolved.transport === "refused" || resolved.transport === "unavailable") throw new Error(resolved.reason)
        return false
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
    setThreadRunning(ref.path, true)
    const starting = beginStart({
      settingsTarget: threadSettingsTarget(ref),
      harness: ref.harness,
      cwd: ref.cwd ?? "",
      title: ref.title,
      threadPath: ref.path,
      blocks: [{ type: "user", text: prompt }],
      hiddenUserPrompt: null,
    })
    // The tier the thread last ran under travels with the reply; the host
    // applies its own memory of it too, so a stale ref cannot lose it.
    const modeId = threadAccessMode(
      ref,
      providerAccessModes(threadsStore.get(), ref.harness),
      ref.harness
    )
    const options: AcpStartOptions = { title: ref.title, resume: ref.nativeId }
    if (modeId) options.modeId = modeId
    const sent = await launch(starting, options, prompt, attachments)
    if (!sent) setThreadRunning(ref.path, false)
    return sent
  },

  async startFresh(
    harness: string,
    cwd: string,
    prompt: string,
    attachments: PromptAttachment[] = [],
    displayPrompt = prompt,
    threadPath?: string
  ): Promise<boolean> {
    if (!hasBridge()) return false
    const existing = threadPath
      ? acpForThread(acpStore.get(), { path: threadPath })
      : null
    if (existing) {
      acp.activate(existing.key)
      return acp.send(prompt, attachments)
    }
    // Named from the first prompt, the way every other thread is; the
    // provider's own title replaces it once the session file reports one.
    const title = displayPrompt ? titleFromPrompt(displayPrompt) : undefined
    const starting = beginStart({
      harness,
      cwd,
      title,
      threadPath,
      blocks: displayPrompt ? [{ type: "user", text: displayPrompt }] : [],
      hiddenUserPrompt: displayPrompt === prompt ? null : prompt,
    })
    return launch(starting, title ? { title } : {}, prompt, attachments)
  },

  async delegate(provider: string, task: string): Promise<boolean> {
    const parent = activeLiveAcp(acpStore.get())
    if (!parent || !hasBridge()) return false
    const id = crypto.randomUUID()
    try {
      applyLiveSnapshot(
        await getMako().liveDelegate(parent.key, { id, provider, task })
      )
      return true
    } catch (error) {
      const snapshot = await getMako()
        .liveSnapshot(parent.key)
        .catch(() => null)
      if (snapshot?.control?.children.some((child) => child.id === id)) {
        applyLiveSnapshot(snapshot)
        return true
      }
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async cancelChild(childId: string): Promise<void> {
    const parent = activeLiveAcp(acpStore.get())
    if (!parent || !hasBridge()) return
    try {
      applyLiveSnapshot(await getMako().liveCancelChild(parent.key, childId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async openRelated(id: string): Promise<void> {
    await hydrateLive(id)
    acp.activate(id)
  },

  async mergeFork(): Promise<void> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return
    const id = crypto.randomUUID()
    try {
      applyLiveSnapshot(await getMako().liveMergeFork(current.key, id))
      toast("Fork findings will be included in the parent's next turn")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async fork(requestId: string): Promise<boolean> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return false
    try {
      const snapshot = await getMako().liveFork(current.key, {
        id: crypto.randomUUID(),
        provider: current.harness,
        point: { kind: "run", requestId },
      })
      applyLiveSnapshot(snapshot)
      acp.activate(snapshot.session.id)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async previewRewind(
    requestId: string,
    position: "before" | "after"
  ): Promise<{ sourceId: string; preview: RewindPreview }> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge())
      throw new Error("Open the conversation before rewinding")
    return {
      sourceId: current.key,
      preview: await getMako().liveRewindPreview(
        current.key,
        requestId,
        position
      ),
    }
  },

  async rewind(sourceId: string, input: RewindInput): Promise<void> {
    const snapshot = await getMako().liveRewind(sourceId, input)
    applyLiveSnapshot(snapshot)
    if (activeLiveAcp(acpStore.get())?.key === sourceId)
      acp.activate(snapshot.session.id)
  },

  async recoverRewinds(): Promise<number> {
    const snapshots = await getMako().liveRecoverRewinds()
    for (const snapshot of snapshots) applyLiveSnapshot(snapshot)
    return snapshots.length
  },

  viewProviderHistory(path: string): void {
    const ref = threadsStore
      .get()
      .threads.find((candidate) => candidate.path === path)
    if (ref) void threads.view(ref, "native")
    else toast.error("This provider history is not available in the catalog")
  },

  async handoff(
    harness: string,
    prompt: string,
    attachments: PromptAttachment[] = [],
    tuning?: TransferInput["tuning"]
  ): Promise<boolean> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return false
    const id = crypto.randomUUID()
    try {
      const state = threadsStore.get()
      const modes = providerAccessModes(state, harness)
      const modeId =
        savedProviderMode(
          prefsStore.get().providerModes,
          modes,
          harness
        ) ?? providerDefaultMode(state, modes, harness)
      const input: TransferInput = {
        id,
        provider: harness,
        text: prompt,
        attachments,
        tuning:
          tuning ?? (await settingsForSend(currentSettingsTarget(harness))),
      }
      if (modeId) input.modeId = modeId
      const snapshot = await getMako().liveTransfer(current.key, input)
      applyLiveSnapshot(snapshot, null)
      leaveViewerForLive(harness)
      return true
    } catch (error) {
      const snapshot = await getMako()
        .liveSnapshot(current.key)
        .catch(() => null)
      if (
        snapshot?.control?.transfers.some(
          (transfer) => transfer.input.id === id
        )
      ) {
        applyLiveSnapshot(snapshot)
        return true
      }
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async send(text: string, attachments: PromptAttachment[] = []): Promise<boolean> {
    const current = activeAcp(acpStore.get())
    if (!current) return Promise.resolve(false)
    if (current.kind === "starting") {
      const requestId = crypto.randomUUID()
      attachments = durableAttachments(attachments)
      const tuning = await settingsForSend(current.settingsTarget)
      const deliver = (promoted: LiveAcpConversation) => {
        updateAcpConversation(promoted.key, (conversation) => ({ ...conversation,
          pendingPrompts: conversation.pendingPrompts?.filter((prompt) => prompt.id !== requestId),
        }))
        stagePrompt(promoted.key, { id: requestId, text, attachments,
          bindingId: promoted.replyBindingId, delivery: { tuning } })
        return sendTo(promoted.key, text, attachments, requestId, promoted.replyBindingId)
      }
      const promoted = Object.values(acpStore.get().conversations).find((item) => item.draftKey === current.draftKey && item.kind === "live")
      if (promoted?.kind === "live") return deliver(promoted)
      if (!acpStore.get().conversations[current.key]) return false
      saveMessage({ kind: "queued", startId: current.key, requestId, text, attachments, tuning })
      stagePrompt(current.key, { id: requestId, text, attachments, delivery: { tuning } })
      return waitForPromotion(current.draftKey).then((ready) => {
        const promoted = Object.values(acpStore.get().conversations).find((item) => item.draftKey === current.draftKey && item.kind === "live")
        if (!ready || promoted?.kind !== "live") { settleMessage(requestId); return false }
        return deliver(promoted)
      })
    }
    return sendTo(current.key, text, attachments, undefined, current.replyBindingId)
  },

  async cancel(): Promise<boolean> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return false
    updateLive(current.key, (conversation) => ({
      ...conversation,
      canceling: true,
    }))
    try {
      await getMako().liveCancel(current.key)
      return true
    } catch (error) {
      updateLive(current.key, (conversation) => ({
        ...conversation,
        canceling: false,
      }))
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  answerPermission(
    optionId: string | null,
    answers?: Record<string, string[]>
  ): void {
    const current = activeLiveAcp(acpStore.get())
    if (!current?.permission || !hasBridge()) return
    void getMako()
      .livePermission(
        current.key,
        current.permission.id,
        answers ? { kind: "answers", answers } : { kind: "choice", optionId }
      )
      .catch((error) => toast.error(String(error)))
  },

  async setMode(modeId: string): Promise<void> {
    const current = activeLiveAcp(acpStore.get())
    if (!current || !hasBridge()) return
    try {
      await getMako().liveSetMode(current.key, modeId)
      chooseProviderMode(current.harness, modeId)
    } catch (error) {
      toast.error(String(error))
    }
  },

  async unqueue(): Promise<void> {
    const current = activeLiveAcp(acpStore.get())
    if (current) applyLiveSnapshot(await getMako().liveClearQueue(current.key))
  },

  close(): boolean {
    const active = activeAcp(acpStore.get())
    if (!active) return false
    if (active.kind === "starting") {
      if (active.threadPath) setThreadRunning(active.threadPath, false)
      removeAcpConversation(active.key)
      return true
    }
    if (hasBridge()) void getMako().liveClose(active.session.id)
    if (active.threadPath) {
      setThreadRunning(active.threadPath, false)
      setThreadAttention(active.threadPath, null)
    }
    removeAcpConversation(active.key)
    return true
  },
}
