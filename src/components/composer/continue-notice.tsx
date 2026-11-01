import { CloudIcon, CloudOffIcon } from "lucide-react"
import { toast } from "sonner"
import { continueLostDetail, continueRefusalShown, continueStepDetail, continueStepWords, CONTINUE_STEPS, continueTitle, continueWords } from "@mako/host/contracts/cloud-continues"
import type { ListedContinueChoice } from "@mako/host/contracts/live-conversations"
import type { ThreadContinueStep } from "@mako/host/contracts/cloud-threads"
import { continueRefusalText } from "@mako/protocol/continues"
import type { ComposerNotice } from "@/extend/notices"
import { harnessLabel } from "@/lib/harness-label"
import { copyAge } from "@/lib/format"
import { activeAcp, useAcp } from "@/state/acp"
import { askContinueOffer, continueInCloud, dismissContinue, useCloudContinues } from "@/state/cloud-continues"
import { confirmAction } from "@/state/confirm"
import { shallowEqual } from "@/state/store"
import { MoveSteps as Steps } from "./move-steps"

/**
 * Above the composer, while the conversation on screen is another device's, read from its copy because that device is
 * off: Continue in the cloud, as every device offers it (`@mako/protocol/continues`). The offer when its Thread may go;
 * why not yet when the person can change that; a continue under way, pressed here or anywhere, step by step; one that
 * failed, with the account's reason and another try. The host carries the press (`mako:thread-continue`).
 */
export function useContinueNotice(): ComposerNotice | null {
  const copy = useAcp((state) => {
    const active = activeAcp(state)
    return active?.kind === "live" && active.copy && active.cloudContinue ? { key: active.key, device: active.elsewhere ?? "Its computer", choice: active.cloudContinue } : undefined
  }, shallowEqual)
  const pressed = useCloudContinues((state) => (copy ? state.continuing[copy.key] : undefined))
  if (!copy) return null
  const { key, device, choice } = copy
  if (pressed) return pressedNotice(key, device, pressed.step, choice)
  return listedNotice(key, device, choice)
}

/** A continue pressed in this window, as the host carries it. */
function pressedNotice(key: string, device: string, step: ThreadContinueStep, choice: ListedContinueChoice): ComposerNotice | null {
  switch (step.kind) {
    case "asking":
    case "making":
    case "arriving":
      return underWay(device, step.kind, { "data-continue": step.kind })
    case "unconfirmed":
      return {
        id: "cloud-continue",
        tone: "caution",
        title: continueTitle(undefined),
        description: "Not confirmed · asking your account again",
        detail: <p>{continueLostDetail("This Mac", step.reason)}</p>,
        data: { "data-continue": "unconfirmed" },
      }
    case "failed":
      return failedNotice(key, device, step.reason, choice, () => dismissContinue(key))
    case "continued":
      return null
  }
}

/** What the account's list says of the Thread: a continue pressed elsewhere, or whether it may continue now. */
function listedNotice(key: string, device: string, choice: ListedContinueChoice): ComposerNotice | null {
  const continued = choice.continued
  if (continued && (continued.phase === "making" || continued.phase === "arriving")) return underWay(device, continued.phase, { "data-continue": continued.phase, "data-continue-listed": true })
  if (continued?.phase === "failed") return failedNotice(key, device, continued.reason ?? "It didn't continue in the cloud.", choice)
  if (choice.refusal === undefined)
    return {
      id: "cloud-continue",
      tone: "info",
      icon: <CloudIcon className="text-muted-foreground" />,
      title: "Continue in the cloud",
      description: `Pick up where ${device} left off, on a cloud machine.`,
      actions: [{ label: "Continue", primary: true, onClick: () => void confirmContinue(key, device) }],
      data: { "data-continue": "offer" },
    }
  if (!continueRefusalShown(choice.refusal)) return null
  return {
    id: "cloud-continue",
    tone: "info",
    icon: <CloudOffIcon className="text-muted-foreground" />,
    title: "It can't continue in the cloud yet",
    description: continueRefusalText(choice.refusal, device),
    data: { "data-continue": choice.refusal },
  }
}

function underWay(device: string, step: "asking" | "making" | "arriving", data: ComposerNotice["data"]): ComposerNotice {
  const at = CONTINUE_STEPS.findIndex((each) => each.kind === step)
  return {
    id: "cloud-continue",
    tone: "progress",
    title: continueTitle(undefined),
    description: continueStepWords(step),
    detail: (
      <>
        <p>{continueStepDetail(step, device)}</p>
        <Steps steps={CONTINUE_STEPS} at={at} />
      </>
    ),
    data,
  }
}

function failedNotice(key: string, device: string, reason: string, choice: ListedContinueChoice, dismiss?: () => void): ComposerNotice {
  return {
    id: "cloud-continue",
    tone: "caution",
    title: continueTitle("failed"),
    description: reason,
    detail: <p>{reason}</p>,
    ...(choice.refusal === undefined && { actions: [{ label: "Continue in the cloud", primary: true, onClick: () => void confirmContinue(key, device) }] }),
    ...(dismiss && { onDismiss: dismiss }),
    data: { "data-continue": "failed" },
  }
}

/**
 * What the continue takes, in the account's words, before the press: its branch and that unpushed changes stay on the
 * device, its sessions as the device last sent them, the messages that go with it. Then the press, if the person says so.
 */
async function confirmContinue(key: string, device: string): Promise<void> {
  let asked
  try {
    asked = await askContinueOffer(key)
  } catch (error) {
    toast.error("Couldn't ask your account", { description: error instanceof Error ? error.message : String(error) })
    return
  }
  const { offer, waiting } = asked
  if (!offer.offer) {
    toast.message("It can't continue in the cloud now", { description: offer.detail })
    return
  }
  const behind = offer.sessions.some((each) => each.freshness.behind)
  const confirmed = await confirmAction({
    title: "Continue in the cloud?",
    body: continueWords.carried(device),
    confirm: "Continue in the cloud",
    subjects: [
      { kind: "branch", name: offer.repository.branch ?? "Its branch", detail: "As pushed" },
      ...offer.sessions.map((each) => ({ kind: "session" as const, id: each.session, name: each.title ?? harnessLabel(each.harness), ...(each.freshness.originalsAt && { detail: `Sent ${copyAge(Date.parse(each.freshness.originalsAt))}` }) })),
    ],
    note: [continueWords.branch(device), waiting ? continueWords.waiting(waiting) : undefined, continueWords.letsGo(device), behind ? continueWords.behind(device) : undefined].filter(Boolean).join(" "),
  })
  if (confirmed) await continueInCloud(key)
}
