import type { ThreadMachineNotice } from "@mako/host/contracts/cloud-threads"
import type { ComposerNotice } from "@/extend/notices"
import { formatTime } from "@/lib/format"
import { harnessLabel, useHarnessIdentity } from "@/lib/harness-label"
import { activeAcp, useAcp } from "@/state/acp"
import { dismissMachineNotice, useCloudMachines } from "@/state/cloud-machines"

/** Why the newest changes couldn't be kept, as the person reads it; nothing when no save said why. */
function reasonWords(reason: ThreadMachineNotice["reason"]): string {
  switch (reason) {
    case "too-large":
      return " They were too large to keep: over 96 MB of changed files, counting what Git doesn't ignore."
    case "conflicts":
      return " A merge was still in progress, so they couldn't be kept."
    default:
      return ""
  }
}

/**
 * Above the composer of a cloud Thread, on every device, only when the person's own work is affected (the gateway's
 * `cloud-machine-notice`): changes that couldn't be kept when the Thread was interrupted, said as what's missing; or a
 * Thread that can't carry on until they send a message. Everything else of the Thread's machine is routine and never
 * shown. A put-away word stays away; a newer one shows.
 */
export function useMachineNotice(): ComposerNotice | null {
  useHarnessIdentity()
  const key = useAcp((state) => activeAcp(state)?.key)
  const harness = useAcp((state) => (key ? state.conversations[key]?.harness : undefined))
  const held = useCloudMachines((state) => (key ? state.notices[key] : undefined))
  if (!key || !held || held.dismissed) return null
  const { notice } = held
  const agent = harness ? harnessLabel(harness) : "the agent"
  if (notice.state === "changes-lost") {
    const since = notice.savedAt !== undefined ? formatTime(notice.savedAt) : undefined
    return {
      id: "cloud-machine",
      tone: "caution",
      title: since ? `Changes after ${since} weren't kept` : "Changes not yet pushed weren't kept",
      detail: (
        <p>
          {since
            ? `This Thread was interrupted, and files changed after ${since} couldn't be brought back.${reasonWords(notice.reason)}`
            : "This Thread was interrupted, and changes that weren't pushed couldn't be brought back."}
          {` The conversation is all there: ask ${agent} to redo what's missing.`}
        </p>
      ),
      onDismiss: () => dismissMachineNotice(key),
      dismissLabel: "Got it",
      data: { "data-cloud-machine": "changes-lost" },
    }
  }
  return {
    id: "cloud-machine",
    tone: "danger",
    title: "This Thread couldn't start again",
    description: notice.savedAt !== undefined ? `Your work up to ${formatTime(notice.savedAt)} is safe` : "Your conversation is safe",
    detail: <p>Mako tried several times after an interruption and couldn't start it. Send a message to try again.</p>,
    data: { "data-cloud-machine": "failed" },
  }
}
