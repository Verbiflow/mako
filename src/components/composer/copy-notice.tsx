import type { ComposerNotice } from "@/extend/notices"
import { copyAge } from "@/lib/format"
import { activeAcp, useAcp } from "@/state/acp"

/** The composer's placeholder while what it sends waits in the account (another device's copy on screen, named above it). */
export const WAITING_PLACEHOLDER = "Message — waits until it's back"

/**
 * Above the composer, while the conversation on screen is another device's, read from the copy that device keeps in
 * the account because it's off: what this is, how old it is, and that a message sent now waits in the account and runs
 * there once it's back. Gone once the device answers again, since its next snapshot carries no copy.
 */
export function useCopyNotice(): ComposerNotice | null {
  const at = useAcp((state) => {
    const active = activeAcp(state)
    return active?.kind === "live" ? active.copy?.at : undefined
  })
  const where = useAcp((state) => activeAcp(state)?.elsewhere)
  if (at === undefined) return null
  const device = where ?? "Its computer"
  return {
    id: "device-copy",
    tone: "info",
    title: `${device} is off`,
    description: `reading its copy from ${copyAge(at)}`,
    detail: <p>{`You're reading the copy it keeps in your account, from ${copyAge(at)}. A message you send waits in your account and runs on ${device} once it's back.`}</p>,
    data: { "data-copy-notice": true },
  }
}
