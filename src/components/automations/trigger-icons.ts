import { BellRingIcon, CalendarClockIcon, CircleAlertIcon, GitCommitHorizontalIcon, GitMergeIcon, HandIcon, MessageSquareIcon, WebhookIcon, type LucideIcon } from "lucide-react"
import type { AutomationTriggerKind } from "@mako/host/contracts/automations"

/** Each trigger kind's mark, beside its sentence and on the rows it leads. */
export const TRIGGER_ICONS = {
  schedule: CalendarClockIcon,
  commit: GitCommitHorizontalIcon,
  manual: HandIcon,
  github: GitMergeIcon,
  slack: MessageSquareIcon,
  linear: BellRingIcon,
  sentry: CircleAlertIcon,
  webhook: WebhookIcon,
  unsupported: CircleAlertIcon,
} satisfies Record<AutomationTriggerKind, LucideIcon>
