import { Notice, NoticeAction } from "@/components/ui/notice"
import { threads, useThreads } from "@/state/threads"

export function NativeRequestNotice({ path }: { path: string }) {
  const requests = useThreads((state) => state.nativeRequests)
  const retained = requests.filter(
    (request) =>
      request.input.path === path &&
      (request.status === "failed" || request.status === "uncertain")
  )
  if (!retained.length) return null
  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-2">
      {retained.slice(-10).map((request) => {
        const attachments = request.input.attachments.length
        return (
          <Notice
            key={request.input.id}
            tone={request.status === "uncertain" ? "caution" : "danger"}
            title={
              request.status === "uncertain"
                ? "Request not confirmed"
                : "Request failed"
            }
            description={`Your message is saved${attachments ? ` with ${attachments === 1 ? "1 attachment" : `${attachments} attachments`}` : ""}.`}
            onDismiss={() => void threads.dismissNative(request.input.id)}
            actions={
              <NoticeAction onClick={() => void threads.retryNative(request)}>
                Send as a new request
              </NoticeAction>
            }
            details={
              <>
                {request.error ? <p className="text-foreground/80">{request.error}</p> : null}
                <p className="contain-turn mt-1.5 whitespace-pre-wrap">{request.input.text}</p>
              </>
            }
          />
        )
      })}
    </div>
  )
}
