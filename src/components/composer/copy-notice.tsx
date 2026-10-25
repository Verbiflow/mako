import { Notice } from "@/components/ui/notice"
import { copyAge } from "@/lib/format"
import { activeAcp, useAcp } from "@/state/acp"

/**
 * Above the composer, while the conversation on screen is another device's, read from the copy that device keeps in
 * the account because it's off: what this is, how old it is, and that a message waits for that device. Gone once the
 * device answers again, since its next snapshot carries no copy.
 */
export function CopyNotice() {
  const at = useAcp((state) => {
    const active = activeAcp(state)
    return active?.kind === "live" ? active.copy?.at : undefined
  })
  const where = useAcp((state) => activeAcp(state)?.elsewhere)
  if (at === undefined) return null
  const device = where ?? "Its computer"
  return (
    <Notice
      tone="info"
      data-copy-notice
      className="mb-1.5"
      title={`${device} is off`}
      description={`You're reading the copy it keeps in your account, from ${copyAge(at)}. Messages and answers go once ${device} is back.`}
    />
  )
}
