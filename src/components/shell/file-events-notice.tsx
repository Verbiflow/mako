import { Notice, NoticeAction } from "@/components/ui/notice"
import { IfCanReveal } from "@/components/ui/machine-gate"
import { desktop } from "@/state/desktop"
import { fileEvents, useFileEvents } from "@/state/file-events"
import { degradedText, lagText, restartedText } from "@/lib/file-events-text"
import { DEGRADED_LAG_MS } from "@mako/host/contracts/file-events-service"

/**
 * macOS's file-change service, above the desk only when there's something
 * to do: degraded, with its numbers and the restart that fixes it; a
 * restart under way; and how the last one went, until it's read. A healthy
 * Mac shows nothing here.
 */
export function FileEventsNotice() {
  const service = useFileEvents((state) => state.service)
  const dismissed = useFileEvents((state) => state.dismissed)
  const seenRestart = useFileEvents((state) => state.seenRestart)
  const error = useFileEvents((state) => state.error)
  if (!service) return null
  if (service.restarting)
    return (
      <Notice
        data-file-events-notice="restarting"
        tone="progress"
        title="Restarting macOS's file-change service"
        description={service.restarting === "measuring"
          ? "Measuring how fast file changes arrive now."
          : "Enter your password in the macOS dialog. Mako saves what the service is doing first, which can take a minute."}
        className="mx-3 my-2"
      />
    )
  const restart = service.restart
  if (error || (restart && restart.at !== seenRestart && restart.outcome === "failed"))
    return (
      <Notice
        data-file-events-notice="failed"
        role="alert"
        tone="danger"
        title="Couldn't restart macOS's file-change service"
        description={error ?? restart?.message}
        className="mx-3 my-2"
        onDismiss={fileEvents.dismiss}
      />
    )
  if (restart && restart.at !== seenRestart && restart.outcome === "restarted") {
    const still = (restart.after?.lagMs ?? 0) > DEGRADED_LAG_MS
    return (
      <Notice
        data-file-events-notice="restarted"
        tone={still ? "caution" : "success"}
        title={still ? `Restarted, but file changes still arrive ${lagText(restart.after!.lagMs!)} late` : "macOS's file-change service restarted"}
        description={`${restartedText(restart)} Mako rescanned the folders it watches.`.trim()}
        className="mx-3 my-2"
        onDismiss={fileEvents.dismiss}
        actions={restart.evidence ? (
          <IfCanReveal>
            <NoticeAction quiet onClick={() => void desktop.revealPath(restart.evidence!)}>Show the evidence</NoticeAction>
          </IfCanReveal>
        ) : null}
      />
    )
  }
  if (service.state !== "degraded" || service.degraded?.since === dismissed) return null
  return (
    <Notice
      data-file-events-notice="degraded"
      role="alert"
      tone="caution"
      title="macOS's file-change service is degraded"
      description={`${degradedText(service)} Restarting it fixes this; macOS asks for your password.`}
      className="mx-3 my-2"
      actions={
        <>
          <NoticeAction onClick={() => void fileEvents.restart()}>Restart it</NoticeAction>
          <NoticeAction quiet onClick={fileEvents.dismiss}>Not now</NoticeAction>
        </>
      }
    />
  )
}
