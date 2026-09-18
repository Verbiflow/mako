import { useAcp, activeLiveAcp } from "@/state/acp"
import { acknowledgeLiveAction } from "@/state/live-actions"

/** Commands change independently of streaming tokens. */
export function LiveActionStatus({ history = false }: { history?: boolean }) {
  const id = useAcp((state) => state.activeKey)
  const action = useAcp((state) =>
    activeLiveAcp(state)?.control?.actions?.at(-1)
  )
  if (!id || !action || action.state.kind === "acknowledged") return null
  if (
    !history &&
    (action.state.kind === "completed" ||
      (action.state.kind === "accepted" && action.input.kind === "steer"))
  )
    return null
  const state = action.state
  const label =
    action.input.kind === "steer" ? "Steering message" : "Compaction"
  const status =
    state.kind === "dispatching"
      ? "awaiting confirmation"
      : state.kind === "accepted"
        ? action.input.kind === "compact" ? "in progress" : "accepted"
        : state.kind === "completed"
          ? "completed"
          : state.kind === "not-accepted"
            ? "not accepted"
            : state.kind === "failed" ? "failed" : "outcome unknown"
  return (
    <details
      className="shrink-0 border-t border-hairline px-3.5 py-2 text-label text-muted-foreground"
      open={state.kind === "uncertain" || state.kind === "not-accepted" || state.kind === "failed"}
    >
      <summary className="pressable cursor-pointer">
        {label} {status}
      </summary>
      {action.input.kind === "steer" ? (
        <p className="mt-2 whitespace-pre-wrap">{action.input.text}</p>
      ) : null}
      {state.kind === "uncertain" || state.kind === "not-accepted" || state.kind === "failed" ? (
        <p className="mt-2">{state.reason}</p>
      ) : null}
      {state.kind === "uncertain" ? (
        <button
          type="button"
          className="pressable mt-2 rounded border border-hairline px-2 py-1 hover:bg-fill-hover"
          onClick={() => void acknowledgeLiveAction(id, action.input.id)}
        >
          {action.input.kind === "compact"
            ? "Disconnect and keep history"
            : "Acknowledge without resending"}
        </button>
      ) : null}
    </details>
  )
}
