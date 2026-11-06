import { useState } from "react"
import { InboxScreen } from "@/web-client/inbox"
import { ThreadList } from "@/web-client/list"
import { ThreadScreen } from "@/web-client/thread"

/** The phone as `phone-apex-check.tsx` shows it: the list, the Inbox, and the Thread a row opens, back returning to the list. */
export function PhoneApexScreen({ opened }: { opened?: string }) {
  const [open, setOpen] = useState(opened)
  const [inbox, setInbox] = useState(false)
  return (
    <div className="web-app flex h-dvh flex-col bg-surface text-foreground">
      {inbox ? (
        <InboxScreen
          onBack={() => setInbox(false)}
          onOpen={(thread) => {
            setInbox(false)
            setOpen(thread)
          }}
        />
      ) : open ? (
        <ThreadScreen threadId={open} onBack={() => setOpen(undefined)} onSession={() => undefined} wide={false} />
      ) : (
        <ThreadList onOpen={(thread) => setOpen(thread.id)} onNew={() => undefined} onInbox={() => setInbox(true)} onSettings={() => undefined} wide={false} />
      )}
    </div>
  )
}
