import {
  byDefault,
  harnessLacks,
  implemented,
  makoLacks,
  noOp,
  type Capability,
  type LiveCapabilities,
} from "../contracts/harness-capabilities.js"
import type { DriverAbsent, ProviderLiveDriver } from "./live-driver.js"

export {
  byDefault,
  capabilityText,
  harnessLacks,
  implemented,
  LIVE_CAPABILITY_KEYS,
  LIVE_CAPABILITY_LABELS,
  makoLacks,
  noOp,
  type Capability,
  type LiveCapabilities,
  type LiveCapabilityKey,
} from "../contracts/harness-capabilities.js"

const absent = (value: DriverAbsent): Extract<Capability, { state: "absent" }> =>
  ({ state: "absent", by: value.kind === "unavailable" ? "harness" : "mako", reason: value.reason })

/**
 * Every capability of one harness, read from its live driver alone. Mako's
 * idle policy is the same for every harness: the process of a conversation
 * idle past the timeout, or beyond the warm pool, is closed exactly when its
 * session can be reopened, and never while a turn, approval, background task
 * or subagent runs.
 */
export function liveCapabilities(driver: ProviderLiveDriver): LiveCapabilities {
  const { resume, fork, steering, questions, nativeAgents, contextBreakdown, compaction, modeSwitching } = driver
  const { planning, approvalEvidence: approvals, backgroundStop: background, turnRecovery: recovery } = driver
  return {
    resume: resume.kind === "native" ? implemented(resume.via) : absent(resume),
    residency: resume.kind === "native"
      ? implemented(`Mako closes the process of an idle conversation, past the idle timeout or the warm pool, and never while a turn, approval, background task or subagent runs. ${resume.wake}`)
      : harnessLacks("Its sessions can't be reopened in a new process, so Mako keeps the process for as long as the conversation is open."),
    turnRecovery: recovery.kind === "continues" ? implemented(`Accepted: ${recovery.accepted} Exit: ${recovery.exit}`) : makoLacks(recovery.reason),
    fork: fork.kind === "native" || fork.kind === "import" ? implemented(fork.via) : absent(fork),
    steering: steering.kind === "supported" ? { state: "implemented", via: steering.via, lands: steering.lands } : absent(steering),
    compaction: compaction.kind === "supported" ? implemented("The harness's own compaction, started by Mako's Compact action.")
      : compaction.kind === "automatic" ? byDefault(compaction.reason)
        : harnessLacks(compaction.reason),
    planning: implemented(`${planning.via === "mode" ? `Its ${planning.mode} mode` : `The ${planning.option} setting`}; the plan reaches Mako through ${planning.proposal}. ${
      planning.feedback.kind === "in-refusal" ? `A reply to it goes with the refusal, in ${planning.feedback.via}.` : `A reply to it is the next message: ${planning.feedback.reason}`}`),
    approvals: approvals.kind === "no-interactive-requests" ? harnessLacks(approvals.reason)
      : implemented(approvals.kind === "native-decisions" ? "The harness asks and reports each decision it applied." : "The harness asks; Mako sees only that its answer was submitted."),
    questions: questions.kind === "request" || questions.kind === "session" ? { state: "implemented", via: questions.via, asks: questions.kind } : absent(questions),
    modes: modeSwitching.kind === "native" ? implemented(modeSwitching.via) : noOp(modeSwitching.reason),
    nativeAgents: nativeAgents.kind === "observed" ? implemented(nativeAgents.via) : absent(nativeAgents),
    backgroundStop: background.kind === "ends-on-stop" ? implemented(background.how) : byDefault(background.evidence),
    contextBreakdown: contextBreakdown.kind === "itemized" ? implemented(contextBreakdown.via) : absent(contextBreakdown),
  }
}

/** Whether the harness reopens its sessions in a new process; the host's one question about resume. */
export function resumes(driver: ProviderLiveDriver | undefined): boolean {
  return driver?.resume.kind === "native"
}
