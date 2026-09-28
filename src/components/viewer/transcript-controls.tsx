import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { AtSignIcon, CopyIcon } from "lucide-react"
import { IconAction, Segmented } from "@/components/ui/kit"
import { HarnessIcon } from "@/components/ui/provider-icon"
import { threadReferenceId, threadToken } from "@/lib/mentions"
import { selectAcpPresence } from "@/state/acp-presence"
import { useAcp } from "@/state/acp-state"
import { threadsStore, useThreads } from "@/state/threads"
import { viewer, type ViewerDocument } from "@/state/viewer"

/** How often an open transcript of a working Session is read again, at most. */
const FOLLOW_MS = 1000

/**
 * A transcript tab's header: its Session, whether it's still going, how much
 * to show, and copying or mentioning it. While shown, the tab reads its
 * Session again as that Session changes.
 */
export function TranscriptControls({ document }: { document: ViewerDocument }) {
  const of = document.transcript
  const live = of?.live
  const path = of?.path
  const running = useAcp((state) => {
    const status = live ? selectAcpPresence(state).find((presence) => presence.key === live)?.status : undefined
    return status === "running" || status === "starting" || status === "needs-permission"
  })
  const liveChange = useAcp((state) => {
    const conversation = live ? state.conversations[live] : undefined
    return conversation ? `${conversation.revision ?? 0}:${conversation.updatedAt}` : ""
  })
  const fileChange = useThreads((state) => {
    const ref = path ? state.threads.find((candidate) => candidate.path === path) : undefined
    return ref ? `${ref.bytes ?? ""}:${ref.updatedAt ?? ""}` : ""
  })
  useFollow(document.id, `${liveChange}|${fileChange}`)
  if (!of) return null
  const mention = () => {
    const ref = path ? threadsStore.get().threads.find((candidate) => candidate.path === path) : undefined
    if (!ref) { toast.info("This session has no saved record to mention yet"); return }
    window.dispatchEvent(new CustomEvent("mako:insert", { detail: `${threadToken(ref.harness, threadReferenceId(ref))} ` }))
  }
  const copy = () => {
    const text = document.file?.contents
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => toast(of.depth === "concise" ? "Copied the concise transcript" : "Copied the full transcript"))
  }
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-label text-muted-foreground" title={path ?? document.title}>
        {of.harness ? <HarnessIcon harness={of.harness} className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{document.title}</span>
        {running ? (
          <span className="flex shrink-0 items-center gap-1 text-faint" title="Still running. This updates as it goes.">
            <span className="size-1.5 animate-pulse rounded-full bg-added" aria-hidden />
            Live
          </span>
        ) : null}
      </span>
      <Segmented
        label="How much of the transcript to show"
        value={of.depth}
        options={[{ value: "concise", label: "Concise" }, { value: "full", label: "With tools" }]}
        onChange={(depth) => viewer.setTranscriptDepth(document.id, depth)}
      />
      <IconAction label="Copy the transcript" size="xs" disabled={!document.file} onClick={copy}>
        <CopyIcon />
      </IconAction>
      <IconAction label="Mention this session in the composer" size="xs" disabled={!path} onClick={mention}>
        <AtSignIcon />
      </IconAction>
    </>
  )
}

/** Read the tab again after its Session changes: once per `FOLLOW_MS` at most, never on first show. */
function useFollow(id: string, change: string) {
  const seen = useRef(change)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (seen.current === change) return
    seen.current = change
    if (pending.current) return
    pending.current = setTimeout(() => {
      pending.current = null
      void viewer.readTranscript(id)
    }, FOLLOW_MS)
  }, [id, change])
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current)
  }, [])
}
