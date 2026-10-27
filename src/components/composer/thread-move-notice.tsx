import { useEffect } from "react"
import type { ThreadHarnessCheck } from "@mako/host/contracts/cloud-harnesses"
import type { ReturnProjectMissing, ThreadMoveStep, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import type { OutdatedRestore } from "@mako/host/contracts/restore-plan"
import type { ComposerNotice, ComposerNoticeAction } from "@/extend/notices"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { returnNotice } from "@/lib/restore-plan"
import { MoveSteps as Steps } from "./move-steps"
import { activeAcp, useAcp } from "@/state/acp"
import { application } from "@/state/application"
import { askReturnAgain, bringBack, bringBackFromChosenProject, checkHarnesses, dismissHarnessUpdate, dismissMissingProject, dismissOutdatedReturn, moveToCloud, updateThen, useCloudMoves, type HarnessUpdating } from "@/state/cloud-moves"

/** A move's steps in the order they're taken, each in the words its step says. */
const STEPS = [
  { kind: "packing", words: "Sending its work ahead" },
  { kind: "handing-over", words: "Handing over" },
  { kind: "resuming", words: "Resuming in the cloud" },
] as const

/** A handoff's steps: its running turn is paused between sending ahead and the hand-over, and goes on in the cloud. */
const HANDOFF_STEPS = [
  { kind: "packing", words: "Sending ahead" },
  { kind: "pausing", words: "Pausing the turn" },
  { kind: "handing-over", words: "Handing over" },
  { kind: "resuming", words: "Continuing there" },
] as const

/** What each step means for the person, under the title. */
function detail(step: ThreadMoveStep, handOff: boolean): string {
  switch (step.kind) {
    case "packing":
      return handOff ? "Its worktree and sessions go ahead while its agent keeps working here." : "Its worktree and sessions go ahead while it still runs here."
    case "pausing":
      return "Its turn stops where it is. What it did so far is saved and goes with it."
    case "handing-over":
      return "This Mac let go of it; nothing runs it until a cloud machine takes it."
    case "resuming":
      return handOff ? "A cloud machine took it. Its turn goes on there from where it paused, at the same folder." : "A cloud machine took it. Its sessions pick up where they left off, at the same folder."
    case "unsettled":
      return step.reason
    default:
      return ""
  }
}

/** The way back's steps, in the order they're taken. */
const RETURN_STEPS = [
  { kind: "packing", words: "Packing in the cloud" },
  { kind: "bringing", words: "Bringing it here" },
] as const

function returnDetail(step: ThreadReturnStep): string {
  switch (step.kind) {
    case "packing":
      return "Its cloud machine takes no new work and sends back its worktree and sessions. Until they're sent, it's still the cloud's."
    case "bringing":
      return "The cloud let go of it. Its worktree and sessions are arriving here; nothing runs it until they have."
    default:
      return ""
  }
}

/**
 * Above the composer while the Thread on screen moves to the cloud or comes back: where it is, step by step, and what
 * that means for the Thread. A move whose answer this Mac can't hear yet says so, in caution: the Thread runs nowhere
 * until it hears, and the host asks again. A way back that's unsettled says who it waits on, the cloud or this Mac,
 * and offers to ask again now.
 */
export function useThreadMoveNotice(): ComposerNotice | null {
  useHarnessIdentity()
  const key = useAcp((state) => activeAcp(state)?.key)
  const moving = useCloudMoves((state) => (key ? state.moving[key] : undefined))
  const returning = useCloudMoves((state) => (key ? state.returning[key] : undefined))
  const outdated = useCloudMoves((state) => (key ? state.outdated[key] : undefined))
  const missing = useCloudMoves((state) => (key ? state.missing[key] : undefined))
  const updating = useCloudMoves((state) => (key ? state.updating[key] : undefined))
  const check = useCloudMoves((state) => (key ? state.harnesses[key] : undefined))
  // A harness the person updates outside Mako (another app's, a command) is weighed again as they come back to the window.
  const waitsElsewhere = Boolean(outdated) || (check?.kind === "known" && check.behind.some((behind) => behind.offer.kind !== "update"))
  useEffect(() => {
    if (!key || !waitsElsewhere) return
    const again = () => void checkHarnesses(key)
    window.addEventListener("focus", again)
    return () => window.removeEventListener("focus", again)
  }, [key, waitsElsewhere])
  if (!key) return null
  if (updating && !moving && !returning) return harnessUpdate(key, updating)
  if (moving) {
    const unsettled = moving.step.kind === "unsettled"
    const handOff = moving.handOff === true
    const steps = handOff ? HANDOFF_STEPS : STEPS
    const at = steps.findIndex((each) => each.kind === moving.step.kind)
    return {
      id: "thread-move",
      tone: unsettled ? "caution" : "progress",
      title: unsettled ? "Waiting for the cloud's answer" : handOff ? "Handing off to the cloud" : "Moving to the cloud",
      description: unsettled ? undefined : steps[at]?.words,
      detail: (
        <>
          <p>{detail(moving.step, handOff)}</p>
          {!unsettled && <Steps steps={steps} at={at} />}
        </>
      ),
      data: { "data-thread-move": moving.step.kind, "data-thread-handoff": handOff || undefined },
    }
  }
  if (!returning) {
    if (missing) return missingProject(key, missing)
    return outdated ? outdatedReturn(key, outdated, check) : null
  }
  const step = returning.step
  if (step.kind === "unsettled") {
    const here = step.waitsOn === "here"
    return {
      id: "thread-move",
      tone: "caution",
      title: here ? "Couldn't finish coming back" : "Waiting for the cloud's answer",
      description: "Nothing runs it yet",
      detail: <p>{step.reason}</p>,
      actions: [{ label: "Ask again", primary: true, onClick: () => void askReturnAgain(key) }],
      data: { "data-thread-return": "unsettled", "data-waits-on": step.waitsOn },
    }
  }
  const at = RETURN_STEPS.findIndex((each) => each.kind === step.kind)
  return {
    id: "thread-move",
    tone: "progress",
    title: "Coming back to this Mac",
    description: RETURN_STEPS[at]?.words,
    detail: (
      <>
        <p>{returnDetail(step)}</p>
        <Steps steps={RETURN_STEPS} at={at} />
      </>
    ),
    data: { "data-thread-return": step.kind },
  }
}

/**
 * A way back refused before the cloud was asked, because the project the Thread's worktree was made from isn't on this
 * Mac: the host's words, and the one choice that brings it, the folder the project is in now. Putting it away keeps
 * the Thread in the cloud, where it goes on; its Cloud chip still brings it back.
 */
function missingProject(conversationId: string, entry: { missing: ReturnProjectMissing; reason: string }): ComposerNotice {
  return {
    id: "thread-move",
    tone: "caution",
    title: "Its project isn't on this Mac",
    description: "Still in the cloud",
    detail: (
      <>
        <p>{entry.reason}</p>
        <p>{`If you moved the project, locate it where it is now: Mako brings the Thread back into its worktree, ${entry.missing.folder}, as the cloud left it.`}</p>
      </>
    ),
    actions: [{ label: "Locate project…", primary: true, onClick: () => void bringBackFromChosenProject(conversationId) }],
    onDismiss: () => dismissMissingProject(conversationId),
    dismissLabel: "Keep in the cloud",
    data: { "data-thread-return": "missing-project" },
  }
}

/** Updating each harness before the Thread moves or comes back, then the move's or the way back's own first step. */
function updateSteps(updating: HarnessUpdating) {
  return [
    ...updating.harnesses.map((harness) => ({ kind: harness, words: `Updating ${harnessLabel(harness)}` })),
    updating.after === "move" ? { kind: "move", words: updating.handOff ? "Handing off to the cloud" : "Moving to the cloud" } : { kind: "back", words: "Bringing it back" },
  ]
}

/**
 * The one choice that updates this Mac's harnesses before a Thread moves or comes back: each update as it runs, then
 * the move's own steps. One that fails says which and why; the Thread stays where it is, and the person tries again,
 * moves anyway, or puts it away.
 */
function harnessUpdate(conversationId: string, updating: HarnessUpdating): ComposerNotice {
  const steps = updateSteps(updating)
  const failed = updating.failed
  const label = harnessLabel(failed?.harness ?? updating.harnesses[updating.at] ?? "")
  const where = updating.after === "move" ? "It's still on this Mac." : "It's still in the cloud, where it goes on."
  if (failed) {
    const retry: ComposerNoticeAction = { label: "Try again", primary: true, onClick: () => void updateThen(conversationId, updating.after, updating.handOff) }
    const anyway: ComposerNoticeAction = { label: updating.handOff ? "Hand off anyway" : "Move anyway", onClick: () => {
      dismissHarnessUpdate(conversationId)
      void moveToCloud(conversationId, updating.handOff)
    } }
    return {
      id: "thread-move",
      tone: "danger",
      icon: <HarnessIcon harness={failed.harness} />,
      title: `${label} wasn't updated`,
      description: failed.reason,
      detail: <p>{`${failed.reason} ${where}`}</p>,
      actions: updating.after === "move" ? [retry, anyway] : [retry],
      onDismiss: () => dismissHarnessUpdate(conversationId),
      data: { "data-harness-update": "failed" },
    }
  }
  return {
    id: "thread-move",
    tone: "progress",
    icon: <HarnessIcon harness={updating.harnesses[updating.at] ?? ""} />,
    title: `Updating ${label}`,
    description: updating.after === "move" ? (updating.handOff ? "Then it hands off to the cloud" : "Then it moves to the cloud") : "Then it comes back to this Mac",
    detail: (
      <>
        <p>{`Mako updates ${label} to the version the cloud runs, so the Thread can come back. ${where}`}</p>
        <Steps steps={steps} at={updating.at} />
      </>
    ),
    data: { "data-harness-update": "updating" },
  }
}

/**
 * A way back that stayed because a harness here is older than the one that wrote the Thread's sessions in the cloud:
 * which versions, and the one choice that settles it, updating the harness and bringing the Thread back. It stays
 * until that's done or the person puts it away; the Thread goes on in the cloud meanwhile.
 */
function outdatedReturn(conversationId: string, entry: { outdated: OutdatedRestore }, check: ThreadHarnessCheck | undefined): ComposerNotice {
  const label = harnessLabel(entry.outdated.harness)
  const words = returnNotice(label, entry.outdated)
  const offer = entry.outdated.offer
  // Weighed again since it stayed (an update elsewhere, seen as the window was focused): nothing here is older now.
  if (check?.kind === "known" && !check.behind.length && offer.kind !== "update") {
    return {
      id: "thread-move",
      tone: "info",
      icon: <HarnessIcon harness={entry.outdated.harness} />,
      title: "Ready to come back",
      description: `${label} here is as new as the cloud's now.`,
      actions: [{ label: "Bring it back", primary: true, onClick: () => {
        dismissOutdatedReturn(conversationId)
        void bringBack(conversationId)
      } }],
      onDismiss: () => dismissOutdatedReturn(conversationId),
      data: { "data-thread-return": "ready" },
    }
  }
  const action: ComposerNoticeAction | undefined =
    offer.kind === "update"
      ? { label: `Update ${label} and bring it back`, primary: true, onClick: () => void updateThen(conversationId, "back") }
      : offer.kind === "owner" && offer.owner === "Mako"
        ? { label: "Open Updates", onClick: () => application.openUpdates() }
        : offer.kind === "manual" && offer.command
          ? { label: "Copy command", onClick: () => void navigator.clipboard.writeText(offer.command ?? "") }
          : undefined
  // Updated outside Mako: weighed again as the window is focused, or now.
  const again: ComposerNoticeAction | undefined = offer.kind === "update" ? undefined : { label: "Check again", onClick: () => void checkHarnesses(conversationId) }
  const elsewhere = offer.kind === "update" ? "" : " Mako checks again when you come back to this window."
  return {
    id: "thread-move",
    tone: "caution",
    icon: <HarnessIcon harness={entry.outdated.harness} />,
    title: "It stayed in the cloud",
    // What to do leads where Mako can't do it; the versions lead where its update can.
    description: offer.kind === "update" ? words.line : words.detail,
    detail: <p>{`${words.line} ${words.detail}${elsewhere}`}</p>,
    actions: [action, again].filter((each) => each !== undefined),
    onDismiss: () => dismissOutdatedReturn(conversationId),
    data: { "data-thread-return": "outdated" },
  }
}
