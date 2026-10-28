import { useElementPickNotice } from "@/components/composer/element-pick-notice"
import { useProviderConnectionNotice } from "@/components/composer/connection-notice"
import { useAccountLimitNotice, useAccountSwitchNotice } from "@/components/composer/account-notice"
import { useModelChoiceNotice } from "@/components/composer/model-notice"
import { useRuntimeVersionNotice } from "@/components/composer/runtime-version-notice"
import { useRestoreVersionNotice } from "@/components/composer/restore-version-notice"
import { useLedgerNotice } from "@/components/composer/ledger-notice"
import { useCopyNotice } from "@/components/composer/copy-notice"
import { useThreadMoveNotice } from "@/components/composer/thread-move-notice"
import { useMachineNotice } from "@/components/composer/machine-notice"
import { useSignInRecoveryNotice } from "@/components/composer/sign-in-recovery"
import { useMovedReviewNotice } from "@/components/composer/moved-review-notice"
import { useWorkspaceMoveNotice } from "@/components/composer/workspace-move-card"
import { useInterruptedSendsNotice, useRejectedDraftsNotice } from "@/components/composer/unsent-notices"
import { useFailureNotice } from "@/components/viewer/failure-notice"
import { useTransferNotice } from "@/components/viewer/transfer-notice"
import { useLiveActionNotice } from "@/components/viewer/live-action-notice"
import { useApprovalStatusNotice } from "@/components/viewer/approval-status-notice"
import { registerNotice } from "@/extend/notices"

/**
 * The desk's notices above the composer, one line each (`ComposerNotices`), the most urgent in front. Among equals,
 * `order` says which goes first: a harness too old to run before sign-in, since signing in won't help it. Returns
 * their disposers; a fixture page that draws the composer installs these alone.
 */
export function installComposerNotices(): Array<() => void> {
  return [
    registerNotice("element-pick", useElementPickNotice),
    registerNotice("runtime-version", useRuntimeVersionNotice, -10),
    registerNotice("restore-version", useRestoreVersionNotice, -9),
    registerNotice("newer-ledger", useLedgerNotice, -8),
    registerNotice("device-copy", useCopyNotice),
    registerNotice("provider-connection", useProviderConnectionNotice, -7),
    registerNotice("sign-in-recovery", useSignInRecoveryNotice, -6),
    registerNotice("message-failure", useFailureNotice, -5),
    registerNotice("account-limit", useAccountLimitNotice, -4),
    registerNotice("account-switch", useAccountSwitchNotice),
    registerNotice("model-choice", useModelChoiceNotice),
    registerNotice("interrupted-sends", useInterruptedSendsNotice),
    registerNotice("rejected-drafts", useRejectedDraftsNotice),
    registerNotice("transfer-status", useTransferNotice),
    registerNotice("live-action-status", useLiveActionNotice),
    registerNotice("approval-status", useApprovalStatusNotice),
    registerNotice("workspace-move", useWorkspaceMoveNotice),
    registerNotice("thread-move", useThreadMoveNotice),
    registerNotice("cloud-machine", useMachineNotice),
    registerNotice("moved-review", useMovedReviewNotice),
  ]
}
