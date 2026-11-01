import { MoonIcon } from "lucide-react"
import type { ComposerNotice } from "@/extend/notices"
import { copyAge } from "@/lib/format"
import { quietLine } from "@/lib/quiet-device"
import { activeAcp, useAcp } from "@/state/acp"
import { shallowEqual } from "@/state/store"

/** The composer's placeholder while what it sends waits in the account (another device's copy on screen, named above it). */
export const WAITING_PLACEHOLDER = "Message — waits until it's back"

/**
 * The device whose copy the conversation on screen is read from, that device being off; null while it's live. A message
 * to it waits in the account as its words alone, so every composer (the desk's and the phone's dock) offers only that:
 * nothing to attach, and no model, effort or access to choose, since nothing runs it until the device is back.
 */
export function useReadingCopy(): string | null {
  return useAcp((state) => {
    const active = activeAcp(state)
    return active?.kind === "live" && active.copy ? (active.elsewhere ?? "Its computer") : null
  })
}

/**
 * Above the composer, while the conversation on screen is another device's, read from the copy that device keeps in
 * the account because it's off: that it's asleep or offline and since when, the copy's age where it misses something
 * (`quietLine`), and that a message sent now waits in the account and runs there once it's back. Gone once the device
 * answers again, since its next snapshot carries no copy.
 */
export function useCopyNotice(): ComposerNotice | null {
  const copy = useAcp((state) => {
    const active = activeAcp(state)
    return active?.kind === "live" && active.copy ? { at: active.copy.at, where: active.elsewhere, seenAt: active.quietSince, activityAt: active.movedAt } : undefined
  }, shallowEqual)
  if (!copy) return null
  const device = copy.where ?? "Its computer"
  const line = quietLine({ name: device, copyAt: copy.at, ...(copy.seenAt !== undefined && { seenAt: copy.seenAt }), ...(copy.activityAt !== undefined && { activityAt: copy.activityAt }) })
  return {
    id: "device-copy",
    tone: "info",
    icon: <MoonIcon className="text-muted-foreground" />,
    title: line.title,
    ...(line.description && { description: line.description }),
    detail: <p>{`You're reading the copy it keeps in your account, from ${copyAge(copy.at)}. A message you send waits in your account and runs on ${device} once it's back.`}</p>,
    data: { "data-copy-notice": true },
  }
}
