import type { ReviewTarget } from "@mako/host/contracts/live-reviews"
import { acp } from "@/state/acp"
import { descriptorFor } from "@/state/descriptors"
import { commandRoute, refuseCommand, type CommandWords } from "@/state/goal-commands"
import { createHook, createStore } from "@/state/store"
import { startInThread } from "@/state/thread-sessions"
import { threadsStore } from "@/state/thread-store"
import { harnessLabel } from "@/lib/harness-label"

/** The composer's own command, which opens the review picker. */
export const REVIEW_COMMAND = "/review"

/** True for a draft that is the review command alone. */
export function isReviewLine(draft: string): boolean {
  return draft.trim() === REVIEW_COMMAND
}

interface ReviewPickerState {
  open: boolean
}

export const reviewPickerStore = createStore<ReviewPickerState>({ open: false })
export const useReviewPicker = createHook(reviewPickerStore)

export function openReviewPicker(): void {
  reviewPickerStore.set({ open: true })
}

export function closeReviewPicker(): void {
  reviewPickerStore.set({ open: false })
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("mako:focus-composer")))
}

const REVIEW_WORDS: CommandWords = { act: "start the review", start: "a review", pick: "review the changes", feature: "review" }

/** Starts the review where the composer would send a message; false leaves the picker open. */
export async function startReview(target: ReviewTarget, cwd: string | undefined): Promise<boolean> {
  const route = commandRoute(cwd, REVIEW_WORDS)
  switch (route.kind) {
    case "elsewhere":
      refuseCommand(route)
      return false
    case "conversation":
      return acp.review(target, route.key)
    case "thread":
      return acp.resumeWith(route.ref, { review: target })
    case "tab":
      return startInThread(route.draft, route.harness, { review: target })
    case "new":
      return acp.startWith(route.harness, route.cwd, { review: target })
  }
}

/** Whether the harness runs its own review, or answers Mako's review prompt. */
export function reviewsNatively(harness: string): boolean {
  const review = descriptorFor(threadsStore.get(), harness)?.features.review.mako
  return review?.state === "implemented" && review.through === "harness"
}

/** Who reviews, in the words the picker and the transcript show. */
export function reviewer(harness: string): string {
  const name = harnessLabel(harness)
  return reviewsNatively(harness) ? `${name} runs its own review` : `Mako asks ${name} to review`
}
