import { viewer } from "@/state/viewer"
import { useAcp, activeLiveAcp, acp } from "@/state/acp"
import { harnessLabel } from "@/components/rail/harness-meta"
import { describeProviderFailure } from "../../../electron/contracts/provider-failure"

/** Only transfer changes wake this row; token updates retain control identity. */
export function TransferStatus({ history = false }: { history?: boolean }) {
  const bindings = useAcp((state) => activeLiveAcp(state)?.control?.bindings)
  const id = useAcp((state) => state.activeKey)
  const transfer = useAcp((state) =>
    activeLiveAcp(state)?.control?.transfers.at(-1)
  )
  if (!transfer) return null
  if (!history && transfer.state.kind === "accepted") return null
  const provider = harnessLabel(transfer.input.provider)
  const state = transfer.state
  // The host's verdict on the error: a session the model provider rejected,
  // or one Mako could not reopen, is not fixed by switching again.
  const failure =
    state.kind === "failed" && state.failure
      ? describeProviderFailure(state.failure, provider)
      : null
  return (
    <details
      className="shrink-0 border-t border-hairline px-3.5 py-2 text-label text-muted-foreground"
      open={state.kind === "failed" || state.kind === "uncertain"}
    >
      <summary className="pressable cursor-pointer">
        {state.kind === "queued"
          ? `Switch to ${provider} after this turn`
          : state.kind === "preparing"
            ? `Preparing ${provider}; your source remains available`
            : state.kind === "accepted"
              ? `Continued with ${provider}`
              : `Could not switch to ${provider}`}
      </summary>
      {state.kind === "accepted" ? (
        <div className="mt-2">
          <p>
            {state.manifest.fromBlock > 0
              ? "Included context added since this provider last ran."
              : "Transferred the captured conversation."}{" "}
            {state.manifest.losses.join(" ")}
          </p>
          <button
            type="button"
            className="pressable mt-2 underline"
            onClick={() =>
              void viewer.open(
                state.manifest.file,
                undefined,
                undefined,
                id ?? undefined
              )
            }
          >
            Inspect transferred context
          </button>
          {bindings
            ?.filter((binding) => binding.path)
            .map((binding) => (
              <button
                key={binding.id}
                type="button"
                className="pressable mt-2 ml-3 underline"
                onClick={() =>
                  binding.path && acp.viewProviderHistory(binding.path)
                }
              >
                {harnessLabel(binding.provider)} history
              </button>
            ))}
        </div>
      ) : state.kind === "failed" || state.kind === "uncertain" ? (
        <div className="mt-2 space-y-2">
          {failure ? <p className="text-foreground/80">{failure.guidance}</p> : null}
          <p className={failure ? "text-faint" : undefined}>{state.error}</p>
          <p className="whitespace-pre-wrap">{transfer.input.text}</p>
          {failure?.retriable ?? true ? (
            <button
              type="button"
              className="pressable rounded border border-hairline px-2 py-1 hover:bg-fill-hover"
              onClick={() =>
                void acp.handoff(
                  transfer.input.provider,
                  transfer.input.text,
                  transfer.input.attachments,
                  transfer.input.tuning
                )
              }
            >
              Retry switch
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2">
          Your request and attachments are saved. The destination will receive
          them once it is ready.
        </p>
      )}
    </details>
  )
}
