import { useState } from "react"
import { ThreadList } from "@/web-client/list"
import { ThreadScreen } from "@/web-client/thread"

/** The phone as `phone-apex-check.tsx` shows it: the list, and the Thread a row opens, back returning to the list. */
export function PhoneApexScreen({ opened }: { opened?: string }) {
  const [open, setOpen] = useState(opened)
  return (
    <div className="web-app flex h-dvh flex-col bg-surface text-foreground">
      {open ? (
        <ThreadScreen threadId={open} onBack={() => setOpen(undefined)} onSession={() => undefined} wide={false} />
      ) : (
        <ThreadList onOpen={(thread) => setOpen(thread.id)} onNew={() => undefined} onSettings={() => undefined} wide={false} />
      )}
    </div>
  )
}
