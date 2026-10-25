import { retryTransfer } from "@/state/live-transfers"
import { useAcp, activeLiveAcp } from "@/state/acp"
import { useHarnessLabels } from "@/components/rail/harness-meta"
import { describeTransferRecovery } from "@mako/host/contracts/operation-recovery"
import type { ComposerNotice } from "@/extend/notices"

/** A provider switch above the composer while it is prepared or went wrong; once accepted it lives in the history. */
export function useTransferNotice(): ComposerNotice | null {
  const labels = useHarnessLabels()
  const id = useAcp((state) => state.activeKey)
  const transfer = useAcp((state) => activeLiveAcp(state)?.control?.transfers.at(-1))
  const request = useAcp((state) => activeLiveAcp(state)?.requests?.find((item) => item.id === transfer?.input.id))
  if (!transfer || transfer.state.kind === "accepted") return null
  const provider = labels[transfer.input.provider] ?? transfer.input.provider
  const state = transfer.state
  const recovery = describeTransferRecovery(transfer, provider, request)
  const troubled = state.kind === "failed" || state.kind === "uncertain"
  return {
    id: `transfer:${transfer.input.id}`,
    tone: state.kind === "failed" ? "danger" : state.kind === "uncertain" ? "caution" : "progress",
    title: recovery.title,
    description: recovery.guidance,
    detail: troubled ? (
      <>
        <p className="text-faint">{state.error}</p>
        <p className="mt-1.5 whitespace-pre-wrap">{transfer.input.text}</p>
      </>
    ) : undefined,
    actions: troubled && recovery.retryLabel
      ? [{ label: recovery.retryLabel, primary: true, disabled: !id, onClick: () => { if (id) void retryTransfer(id, transfer.input.id) } }]
      : undefined,
    data: { "data-transfer-recovery": transfer.input.id },
  }
}
