import type { ReactNode } from "react"
import { Notice } from "@/components/ui/notice"

/** Shared presentation: dismissal hides an occurrence, never changes delivery. */
export function RecoveryNotice({
  title,
  description,
  actions,
  children,
  onDismiss,
}: {
  title: string
  description: string
  actions: ReactNode
  children?: ReactNode
  onDismiss(): void
}) {
  return (
    <Notice
      tone="caution"
      label="Message recovery"
      title={title}
      description={description}
      actions={actions}
      onDismiss={onDismiss}
      dismissLabel="Dismiss error"
      className="mx-3 mb-2"
      data-recovery-notice
    >
      {children}
    </Notice>
  )
}
