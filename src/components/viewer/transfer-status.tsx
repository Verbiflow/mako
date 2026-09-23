import { retryTransfer } from "@/state/live-transfers"
import { viewer } from "@/state/viewer"
import { useAcp, activeLiveAcp, acp } from "@/state/acp"
import { harnessLabel } from "@/components/rail/harness-meta"
import { Notice, NoticeAction, type NoticeTone } from "@/components/ui/notice"
import { describeTransferRecovery } from "../../../electron/contracts/operation-recovery"

/** Only transfer changes wake this row; token updates retain control identity. */
export function TransferStatus({ history = false }: { history?: boolean }) {
  const bindings = useAcp((state) => activeLiveAcp(state)?.control?.bindings)
  const id = useAcp((state) => state.activeKey)
  const transfer = useAcp((state) =>
    activeLiveAcp(state)?.control?.transfers.at(-1)
  )
  const request = useAcp((state) => activeLiveAcp(state)?.requests?.find((item) => item.id === transfer?.input.id))
  if (!transfer) return null
  if (!history && transfer.state.kind === "accepted") return null
  const provider = harnessLabel(transfer.input.provider)
  const state = transfer.state
  const recovery = describeTransferRecovery(transfer, provider, request)
  const troubled = state.kind === "failed" || state.kind === "uncertain"
  const tone: NoticeTone =
    state.kind === "accepted"
      ? "success"
      : state.kind === "failed"
        ? "danger"
        : state.kind === "uncertain"
          ? "caution"
          : "progress"
  return (
    <Notice
      tone={tone}
      surface={history ? "flush" : "card"}
      className={history ? undefined : "mx-3 mb-2"}
      data-transfer-recovery={transfer.input.id}
      title={recovery.title}
      description={recovery.guidance}
      detailsOpen={troubled}
      actions={
        state.kind === "accepted" ? (
          <>
            <NoticeAction
              quiet
              onClick={() =>
                void viewer.open(state.manifest.file, undefined, undefined, id ?? undefined)
              }
            >
              Inspect transferred context
            </NoticeAction>
            {bindings
              ?.filter((binding) => binding.path)
              .map((binding) => (
                <NoticeAction
                  key={binding.id}
                  quiet
                  onClick={() => binding.path && acp.viewProviderHistory(binding.path)}
                >
                  {harnessLabel(binding.provider)} history
                </NoticeAction>
              ))}
          </>
        ) : troubled && recovery.retryLabel ? (
          <NoticeAction
            disabled={!id}
            onClick={() => id && void retryTransfer(id, transfer.input.id)}
          >
            {recovery.retryLabel}
          </NoticeAction>
        ) : null
      }
      details={
        state.kind === "accepted" ? (
          <p>
            {state.manifest.fromBlock > 0
              ? "Prepared context added since this provider last ran."
              : "Prepared the captured conversation as context."}{" "}
            {state.manifest.losses.join(" ")}
          </p>
        ) : troubled ? (
          <>
            <p className="text-faint">{state.error}</p>
            <p className="mt-1.5 whitespace-pre-wrap">{transfer.input.text}</p>
          </>
        ) : undefined
      }
    />
  )
}
