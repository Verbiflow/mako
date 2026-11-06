import { useState } from "react"
import { InboxScreen } from "@/web-client/inbox-screen"
import { ThreadList } from "@/web-client/list"
import { ThreadScreen } from "@/web-client/thread"

/** The phone as `phone-apex-check.tsx` shows it: the list, the Inbox its chip opens, and the Thread a row opens, back returning to the list. */
export function PhoneApexScreen({ opened, inbox = false }: { opened?: string; inbox?: boolean }) {
  const [open, setOpen] = useState<string | undefined>(opened ?? (inbox ? "inbox" : undefined))
  return (
    <div className="web-app flex h-dvh flex-col bg-surface text-foreground">
      {open === "inbox" ? (
        <InboxScreen onBack={() => setOpen(undefined)} onOpen={(thread) => setOpen(thread.id)} />
      ) : open ? (
        <ThreadScreen threadId={open} onBack={() => setOpen(undefined)} onSession={() => undefined} wide={false} />
      ) : (
        <ThreadList onOpen={(thread) => setOpen(thread.id)} onNew={() => undefined} onSettings={() => undefined} onInbox={() => setOpen("inbox")} wide={false} />
      )}
    </div>
  )
}
