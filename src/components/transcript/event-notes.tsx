import { useState, type ReactNode } from "react"
import { ChevronRightIcon, CircleAlertIcon, TriangleAlertIcon } from "lucide-react"
import { MCP_SERVER_FAILED, type TranscriptEvent } from "@mako/sessions/events"
import { Collapse } from "@/components/ui/collapse"
import { Prose } from "@/components/transcript/markdown"
import { cn } from "@/lib/utils"
import type { ChatMessage } from "@/lib/types"

/**
 * A provider's markers between content: one quiet line each, in the
 * transcript's own column. Setup notices that arrive together (servers that
 * did not start, configuration warnings) read as one line that opens.
 */
export function EventNotes({ messages, inline }: { messages: readonly ChatMessage[]; inline?: boolean }) {
  const runs: Array<{ id: string; notes: TranscriptEvent[] } | { id: string; note: TranscriptEvent }> = []
  for (const message of messages) {
    const note = message.note
    if (!note) continue
    const last = runs.at(-1)
    if (note.setup && last && "notes" in last) last.notes.push(note)
    else if (note.setup) runs.push({ id: message.id, notes: [note] })
    else runs.push({ id: message.id, note })
  }
  if (!runs.length) return null
  return (
    <div className={cn("flex flex-col gap-1", inline ? "my-0.5" : "my-3")}>
      {runs.map((run) =>
        "notes" in run ? <SetupNotes key={run.id} notes={run.notes} /> : <EventNote key={run.id} note={run.note} />
      )}
    </div>
  )
}

function ToneIcon({ tone }: { tone: TranscriptEvent["tone"] }) {
  if (tone === "error") return <CircleAlertIcon className="size-3 shrink-0 text-negative" />
  if (tone === "warning") return <TriangleAlertIcon className="size-3 shrink-0 text-caution" />
  return null
}

/** The line every marker shares; it opens onto `children` when there is more to read. */
function NoteLine({
  tone,
  title,
  detail,
  children,
}: {
  tone: TranscriptEvent["tone"]
  title: string
  detail?: string
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const line = (
    <>
      <ToneIcon tone={tone} />
      <span className={cn("shrink-0", tone === "error" ? "text-negative" : "text-muted-foreground")}>{title}</span>
      {detail ? <span className="min-w-0 truncate text-faint">{detail}</span> : null}
    </>
  )
  if (!children)
    return <div className="flex min-w-0 items-center gap-1.5 py-0.5 text-label" title={detail}>{line}</div>
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="pressable group/note -mx-1.5 flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-label transition-colors duration-100 hover:bg-fill-hover"
      >
        {line}
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-faint opacity-0 [transition:transform_150ms_var(--ease-out),opacity_100ms_ease] group-hover/note:opacity-100",
            open && "rotate-90 opacity-100"
          )}
        />
      </button>
      <Collapse open={open}>
        <div className="mt-1 mb-1 max-h-80 overflow-y-auto rounded-lg border border-hairline px-3 py-2 text-label text-muted-foreground">
          {children}
        </div>
      </Collapse>
    </div>
  )
}

function EventNote({ note }: { note: TranscriptEvent }) {
  return (
    <NoteLine tone={note.tone} title={note.label} detail={note.detail?.slice(0, 200)}>
      {note.body ? <Prose text={note.body} /> : null}
    </NoteLine>
  )
}

const SERVER_SEPARATOR = " · "

/** What a run of setup notices says in one line. */
function setupSummary(notes: readonly TranscriptEvent[]) {
  const servers = notes.filter((note) => note.label === MCP_SERVER_FAILED)
  const others = notes.filter((note) => note.label !== MCP_SERVER_FAILED)
  const names = servers.map((note) => note.detail?.split(SERVER_SEPARATOR, 1)[0] ?? "")
  if (servers.length && !others.length)
    return {
      title: servers.length === 1 ? "MCP server didn't start" : `${servers.length} MCP servers didn't start`,
      detail: names.join(", "),
    }
  if (!servers.length && others.length === 1) return { title: others[0]!.label, detail: others[0]!.detail }
  const warnings = `${others.length} setup warning${others.length === 1 ? "" : "s"}`
  if (!servers.length) return { title: warnings, detail: undefined }
  return {
    title: `${servers.length} MCP server${servers.length === 1 ? "" : "s"} didn't start`,
    detail: `${names.join(", ")} · ${warnings}`,
  }
}

function SetupNotes({ notes }: { notes: readonly TranscriptEvent[] }) {
  if (notes.length === 1) return <EventNote note={notes[0]!} />
  const { title, detail } = setupSummary(notes)
  const tone = notes.some((note) => note.tone === "error") ? "error" : notes.some((note) => note.tone) ? "warning" : undefined
  return (
    <NoteLine tone={tone} title={title} detail={detail}>
      <ul className="flex flex-col gap-2">
        {notes.map((note, index) => {
          const server = note.label === MCP_SERVER_FAILED
          const [name, ...reason] = server ? (note.detail ?? "").split(SERVER_SEPARATOR) : []
          return (
            <li key={index} className="flex flex-col gap-0.5">
              <span className="flex min-w-0 gap-2">
                <span className="shrink-0 text-foreground">{server ? name : note.label}</span>
                {note.body ? null : (
                  <span className="min-w-0 truncate text-faint">{server ? reason.join(SERVER_SEPARATOR) : note.detail}</span>
                )}
              </span>
              {note.body ? <span className="whitespace-pre-wrap text-faint">{note.body}</span> : null}
            </li>
          )
        })}
      </ul>
    </NoteLine>
  )
}
