import { Notice, NoticeAction } from "@/components/ui/notice"
import { threads, threadsStore } from "@/state/threads"
import { activeAcp, useAcp } from "@/state/acp"

export function CaptureNotice() {
  const path = useAcp((state) => activeAcp(state)?.threadPath)
  return (
    <Notice
      surface="flush"
      title="Saved conversation"
      description="Sending a message starts a provider connection from this captured history."
      actions={
        path ? (
          <NoticeAction
            quiet
            onClick={() => {
              const ref = threadsStore
                .get()
                .threads.find((item) => item.path === path)
              if (ref) void threads.view(ref, "native")
            }}
          >
            View current provider history
          </NoticeAction>
        ) : null
      }
    />
  )
}
