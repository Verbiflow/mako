import { useAcp, activeLiveAcp } from "@/state/acp"
import { describeActionRecovery } from "../../../electron/contracts/operation-recovery"
import { acknowledgeLiveAction } from "@/state/live-actions"
import { Notice, NoticeAction, type NoticeTone } from "@/components/ui/notice"

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
  const recovery = describeActionRecovery(action)
  const troubled =
    state.kind === "uncertain" || state.kind === "not-accepted" || state.kind === "failed"
  const tone: NoticeTone =
    state.kind === "completed" || (state.kind === "accepted" && action.input.kind === "steer")
      ? "success"
      : state.kind === "failed" || state.kind === "not-accepted"
        ? "danger"
        : state.kind === "uncertain"
          ? "caution"
          : "progress"
  return (
    <Notice
      tone={tone}
      surface={history ? "flush" : "card"}
      className={history ? undefined : "mx-3 mb-2"}
      data-action-recovery={action.input.id}
      title={recovery.title}
      description={recovery.guidance}
      actions={
        state.kind === "uncertain" ? (
          <NoticeAction onClick={() => void acknowledgeLiveAction(id, action.input.id)}>
            {action.input.kind === "compact"
              ? "Disconnect and keep history"
              : "Acknowledge without resending"}
          </NoticeAction>
        ) : null
      }
      details={
        troubled || action.input.kind === "steer" ? (
          <>
            {troubled ? <p className="text-faint">{state.reason}</p> : null}
            {action.input.kind === "steer" ? <p className="mt-1.5 whitespace-pre-wrap">{action.input.text}</p> : null}
          </>
        ) : undefined
      }
    />
  )
}
