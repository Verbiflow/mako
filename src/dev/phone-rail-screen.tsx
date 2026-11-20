import { useState } from "react"
import { useWebClient } from "@/web-client/client"
import { ThreadList } from "@/web-client/list"
import { ThreadScreen } from "@/web-client/thread"
import { useReadOnOwnerWhenOpened } from "@/web-client/thread-marks"
import { useThread } from "@/web-client/use-thread"
import { APEX_THREAD } from "./mock-apex-thread"

/** The open Thread is read on its owner, as the app does (`useReadOnOwnerWhenOpened`). */
function Opened({ threadId, wide, onBack }: { threadId: string; wide: boolean; onBack: () => void }) {
  useReadOnOwnerWhenOpened(useWebClient(), useThread(threadId))
  return <ThreadScreen key={threadId} threadId={threadId} onBack={onBack} onSession={() => undefined} wide={wide} />
}

/**
 * The list as `phone-rail-check.tsx` shows it: on a phone the list, a row opening its Thread over it and back returning;
 * on a tablet the rail beside the open Thread (the Apex, to begin with), as the app lays them out.
 */
export function RailScreen({ wide, opened }: { wide: boolean; opened?: string }) {
  const [open, setOpen] = useState<string | undefined>(opened ?? (wide ? APEX_THREAD : undefined))
  const list = <ThreadList wide={wide} selected={wide ? open : undefined} onOpen={(each) => setOpen(each.id)} onNew={() => undefined} onSettings={() => undefined} onInbox={() => undefined} />
  if (wide)
    return (
      <div className="web-app flex h-dvh w-full overflow-hidden bg-shell text-foreground" data-form="tablet">
        <div className="web-rail flex shrink-0 flex-col">{list}</div>
        <main className="relative flex min-w-0 flex-1 flex-col">{open ? <Opened threadId={open} wide onBack={() => setOpen(undefined)} /> : null}</main>
      </div>
    )
  return <div className="web-app flex h-dvh flex-col bg-surface text-foreground">{open ? <Opened threadId={open} wide={false} onBack={() => setOpen(undefined)} /> : list}</div>
}
