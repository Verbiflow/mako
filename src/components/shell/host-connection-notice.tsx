import { Notice, NoticeAction } from "@/components/ui/notice"
import { useHostConnection } from "@/state/host-connection"

export function HostConnectionNotice() {
  const connection = useHostConnection((state) => state)
  if (connection.kind === "connected") return null
  return (
    <Notice
      role="alert"
      tone="danger"
      title={connection.message}
      description="Showing the last known state. Your drafts are saved."
      className="mx-3 my-2"
      actions={<NoticeAction onClick={() => location.reload()}>Reconnect</NoticeAction>}
    />
  )
}
