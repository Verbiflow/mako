import { useMemo } from "react"
import { useAccountList } from "./account-list"
import { foldThreads, type WebThread } from "./threads"

/** The Thread a route names, as the list stands now: one listed, or archived. */
export function useThread(id: string): WebThread | undefined {
  const list = useAccountList((state) => state)
  return useMemo(() => {
    const { threads, archived } = foldThreads(list)
    // By its Mako Thread ID, or by the cloud Thread one of its Sessions runs on (a start from here names that one).
    const named = (thread: WebThread) => thread.id === id || thread.sessions.some((session) => session.row.runsOn.kind === "cloud" && session.row.runsOn.threadId === id)
    return threads.find(named) ?? archived.find(named)
  }, [list, id])
}

