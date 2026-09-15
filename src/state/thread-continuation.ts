import { settingsForSend, threadSettingsTarget, currentSettingsTarget } from "@/state/composer-settings"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { acpForThread, acpStore } from "@/state/acp-state"
import { getMako, hasBridge } from "@/lib/bridge"
import type {
  ContinuationPlan,
  MessageAnchor,
  NativeRequest,
  PromptAttachment,
  ThreadRef,
} from "@/lib/types"
import { noteFolderUse, prefsStore } from "@/state/prefs"
import {
  appendOptimisticReply,
  removeOptimisticReply,
} from "@/state/thread-queue"
import { threadStatus } from "@/state/thread-status"
import { leaveViewerForLive, viewedThread } from "@/state/thread-viewing"
import { threadsStore } from "@/state/thread-store"
import { descriptorFor } from "@/state/descriptors"
import { harnessLabel } from "@/lib/harness-label"
import { toast } from "sonner"


/**
 * Show the translation while it happens, and for long enough to be seen.
 *
 * The emitters are fast — usually under a second — which is exactly why the
 * moment needs a floor: a conversation changing harnesses is the headline
 * act of this app, and a flicker would read as nothing having happened.
 */
export async function withConversion<T>(
  from: string,
  to: string,
  title: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  threadsStore.set({ converting: { from, to, title, done: false } })
  try {
    const result = await work()
    threadsStore.set({ converting: { from, to, title, done: true } })
    setTimeout(() => {
      if (threadsStore.get().converting?.done)
        threadsStore.set({ converting: null })
    }, 300)
    return result
  } catch (error) {
    threadsStore.set({ converting: null })
    throw error
  }
}

export const threadContinuationActions = {
  /**
   * Send the next message through the harness that owns this session. The
   * reply streams back through the file tail — the same path a terminal run
   * takes — so nothing here waits on the process.
   */
  async reply(
    ref: ThreadRef,
    prompt: string,
    attachments: PromptAttachment[] = []
  ): Promise<boolean> {
    if (!hasBridge()) return false
    if (acpForThread(acpStore.get(), ref))
      return (await import("@/state/acp")).acp.resumeAndSend(ref, prompt, attachments)
    // A file that moved moments ago may still be mid-turn under a process the
    // host cannot see; that is a renderer heuristic, not a transport choice.
    if (threadStatus(ref).kind === "observed") {
      toast("Live activity detected", {
        description:
          "Wait for this turn to settle, or choose another agent to continue in a new thread.",
      })
      return false
    }
    noteFolderUse(ref.cwd)
    // Paint the message NOW. The plan, provider startup, session translation,
    // and the native tail all happen after the send is already visible.
    const echoed = appendOptimisticReply(ref, prompt)
    // The host decides the transport from what only it knows; a refusal
    // carries its reason, and a handoff names the provider it lands on.
    let plan: ContinuationPlan
    try {
      plan = await getMako().continuationPlan(ref.path)
    } catch (error) {
      if (echoed) removeOptimisticReply(ref, prompt)
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
    if (plan.transport === "refused") {
      if (echoed) removeOptimisticReply(ref, prompt)
      toast.error(plan.reason)
      return false
    }
    if (plan.transport === "handoff") {
      // moveAndSend paints its own echo on the conversation it opens.
      if (echoed) removeOptimisticReply(ref, prompt)
      return threadContinuationActions.moveAndSend(ref, plan.provider, prompt, attachments)
    }
    if (plan.transport === "live") {
      const resumed = await (
        await import("@/state/acp")
      ).acp.resumeAndSend(ref, prompt, attachments)
      if (!resumed && echoed) removeOptimisticReply(ref, prompt)
      return resumed
    }
    const requestId = crypto.randomUUID()
    try {
      // The composer's tuning rides on the reply: pick a different model or
      // effort while a conversation is open and the next turn uses it.
      const tuning = await settingsForSend(threadSettingsTarget(ref))
      await getMako().nativeSubmit({
        id: requestId,
        path: ref.path,
        text: prompt,
        attachments,
        tuning,
      })
      return true
    } catch (error) {
      const saved = await getMako()
        .nativeReceipt(requestId)
        .catch(() => null)
      if (saved) return true
      // The send failed: take the echo back out so the transcript stays true.
      if (echoed) removeOptimisticReply(ref, prompt)
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /** Move and send through the selected provider, using transcript replay by default. */
  async moveAndSend(
    ref: ThreadRef,
    harness: string,
    prompt: string,
    attachments: PromptAttachment[] = []
  ): Promise<boolean> {
    if (!hasBridge()) return false
    if (descriptorFor(threadsStore.get(), harness)?.live === true) {
      try {
        const snapshot = await getMako().liveCapture(
          crypto.randomUUID(),
          ref.path
        )
        const { acp } = await import("@/state/acp")
        applyLiveSnapshot(snapshot)
        acp.activate(snapshot.session.id)
        return acp.handoff(harness, prompt, attachments)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
        return false
      }
    }
    threadsStore.set({ composerHarness: harness })
    const echoed = appendOptimisticReply(ref, prompt)
    try {
      const mode = prefsStore.get().conversionMode
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getMako().continueThreadWith(ref.path, harness, prompt, mode)
      )
      if (result.kind === "emitted") {
        const thread = await getMako().openThread(result.path)
        if (thread) {
          threadsStore.set({ viewing: viewedThread(thread), run: null })
          void getMako().followThread(
            result.path,
            thread.checkpoint ?? thread.ref.bytes ?? 0
          )
          return threadContinuationActions.reply(
            thread.ref,
            prompt,
            attachments
          )
        }
      } else if (result.kind === "prepared") {
        const supportsLive = descriptorFor(threadsStore.get(), harness)?.live === true
        const ok = supportsLive
          ? await (
              await import("@/state/acp")
            ).acp.startFresh(
              harness,
              result.cwd,
              result.prompt,
              attachments,
              prompt,
              ref.path
            )
          : await threadContinuationActions.startNew(harness, result.prompt)
        if (ok && supportsLive && echoed) removeOptimisticReply(ref, prompt)
        if (!ok && echoed) removeOptimisticReply(ref, prompt)
        return ok
      }
      if (echoed) removeOptimisticReply(ref, prompt)
      return false
    } catch (error) {
      if (echoed) removeOptimisticReply(ref, prompt)
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /**
   * Fork after one completed answer, using the transcript bundle as context.
   * The answer is named by its anchor: the revision the transcript was read
   * at resolves the index at once when the store is unchanged, and the
   * provider's own message id or timestamp finds the answer when it moved.
   */
  async forkAt(
    ref: ThreadRef,
    anchor: MessageAnchor,
    harness: string
  ): Promise<boolean> {
    if (!hasBridge()) return false
    if (descriptorFor(threadsStore.get(), harness)?.live === true) {
      try {
        const source = await getMako().liveCapture(
          crypto.randomUUID(),
          ref.path
        )
        const fork = await getMako().liveFork(source.session.id, {
          id: crypto.randomUUID(),
          provider: harness,
          point: {
            kind: "native",
            index: anchor.index,
            revision: JSON.stringify([ref.revision, ref.bytes, ref.updatedAt]),
            anchor,
          },
        })
        const { acp } = await import("@/state/acp")
        applyLiveSnapshot(fork)
        acp.activate(fork.session.id)
        threadsStore.set({ composerHarness: harness })
        return true
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
        return false
      }
    }
    try {
      const prepared = await withConversion(
        ref.harness,
        harness,
        ref.title,
        () => getMako().forkThread(ref.path, anchor.index, harness, anchor)
      )
      threadsStore.set({ composerHarness: harness })
      const supportsLive = descriptorFor(threadsStore.get(), harness)?.live === true
      const ok = supportsLive
        ? await (
            await import("@/state/acp")
          ).acp.startFresh(harness, prepared.cwd, prepared.prompt, [], "")
        : await threadContinuationActions.startNew(harness, prepared.prompt)
      if (ok) {
        if (supportsLive) leaveViewerForLive(harness)
        toast("Forked", {
          description: `A new ${harnessLabel(harness)} conversation starts after that answer.`,
        })
      }
      return ok
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async retryNative(request: NativeRequest): Promise<void> {
    if (!hasBridge()) return
    try {
      await getMako().nativeSubmit({
        ...request.input,
        id: crypto.randomUUID(),
      })
      await getMako().nativeDismiss(request.input.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },
  async dismissNative(id: string): Promise<void> {
    if (!hasBridge()) return
    try {
      await getMako().nativeDismiss(id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  async abortReply(ref: ThreadRef) {
    if (!hasBridge()) return false
    try {
      await getMako().abortThreadRun(ref.path)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  /**
   * Interrupt and send: stop the current turn, and the message goes out on
   * the release. One gesture — the queue machinery does the sequencing.
   */
  async interruptAndSend(
    ref: ThreadRef,
    prompt: string,
    attachments: PromptAttachment[] = []
  ): Promise<boolean> {
    if (!hasBridge()) return false
    const ok = await threadContinuationActions.reply(ref, prompt, attachments)
    if (ok && threadsStore.get().working[ref.path]) {
      try {
        await getMako().abortThreadRun(ref.path)
      } catch {
        toast.error(
          "The turn could not be stopped; your message remains queued"
        )
      }
    }
    return ok
  },

  /**
   * A new conversation on another harness, straight from the composer. The
   * CLI runs headlessly in the active workspace; when its session file
   * appears, the conversation opens here and the reply bar carries the next
   * turn. Same chat column, different agent — which is the whole idea.
   */
  async startNew(harness: string, prompt: string) {
    if (!hasBridge()) return false
    try {
      const options = await settingsForSend(currentSettingsTarget(harness))
      await getMako().startHarness(harness, prompt, options)
      toast(`${harnessLabel(harness)} is on it`, {
        description:
          "Its native session will appear in the conversation list when the provider saves it.",
      })
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  async continueWith(ref: ThreadRef, harness: string, label: string) {
    if (!hasBridge()) return false
    try {
      const result = await withConversion(ref.harness, harness, ref.title, () =>
        getMako().continueThreadWith(
          ref.path,
          harness,
          undefined,
          prefsStore.get().conversionMode
        )
      )
      if (result.kind === "emitted") {
        const thread = await getMako().openThread(result.path)
        if (!thread) return false
        threadsStore.set({ viewing: viewedThread(thread), run: null })
        void getMako().followThread(
          result.path,
          thread.checkpoint ?? thread.ref.bytes ?? 0
        )
        toast(`${label} session imported`, {
          description: "Reply below when you are ready to continue.",
        })
        return true
      }
      threadsStore.set({ composerHarness: harness })
      const supportsLive = descriptorFor(threadsStore.get(), harness)?.live === true
      const ok = supportsLive
        ? await (
            await import("@/state/acp")
          ).acp.startFresh(harness, result.cwd, result.prompt, [], "")
        : await threadContinuationActions.startNew(harness, result.prompt)
      if (ok) {
        if (supportsLive) leaveViewerForLive(harness)
        toast(`${label} picked up the conversation`)
      }
      return ok
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  },
}
