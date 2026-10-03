import { useState, type ReactNode } from "react"
import {
  ArrowLeftRightIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleStopIcon,
  FoldVerticalIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "lucide-react"
import {
  COMPACTION_FAILED,
  CONTEXT_COMPACTED,
  INTERRUPTED,
  MCP_SERVER_FAILED,
  type TranscriptEvent,
} from "@mako/sessions/events"
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
    <div className={cn("flex flex-col", !inline && "my-3")}>
      {runs.map((run) =>
        "notes" in run ? <SetupNotes key={run.id} notes={run.notes} /> : <EventNote key={run.id} note={run.note} />
      )}
    </div>
  )
}

/**
 * The note's glyph, in the slot a tool row keeps for its own, so a marker and
 * a tool line up down the column whatever their tone.
 */
function NoteIcon({ tone, label, className }: { tone: TranscriptEvent["tone"]; label: string; className: string }) {
  if (tone === "error") return <CircleAlertIcon className={cn(className, "text-negative")} />
  if (tone === "warning") return <TriangleAlertIcon className={cn(className, "text-caution")} />
  if (label === CONTEXT_COMPACTED || label === COMPACTION_FAILED) return <FoldVerticalIcon className={cn(className, "text-faint")} />
  if (label === INTERRUPTED) return <CircleStopIcon className={cn(className, "text-faint")} />
  if (/\bmodel\b/i.test(label)) return <ArrowLeftRightIcon className={cn(className, "text-faint")} />
  return <InfoIcon className={cn(className, "text-faint")} />
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
  const layer = "absolute inset-0 m-auto size-3.5 [transition:opacity_150ms_var(--ease-out),transform_150ms_var(--ease-out)]"
  const line = (
    <>
      <span className="relative size-3.5 shrink-0">
        <NoteIcon
          tone={tone}
          label={title}
          className={cn(layer, children && (open ? "opacity-0" : "group-hover/note:opacity-0"))}
        />
        {children ? (
          <ChevronRightIcon
            className={cn(layer, "text-faint", open ? "rotate-90 opacity-100" : "opacity-0 group-hover/note:opacity-100")}
          />
        ) : null}
      </span>
      <span className={cn("shrink-0", tone === "error" ? "text-negative" : "text-muted-foreground")}>{title}</span>
      {detail ? <span className="min-w-0 truncate text-faint">{detail}</span> : null}
    </>
  )
  const row = "flex h-7 min-w-0 items-center gap-2 text-ui"
  if (!children)
    return <div className={row} title={detail}>{line}</div>
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(row, "pressable group/note -mx-1.5 w-[calc(100%+12px)] rounded-md px-1.5 text-left transition-colors duration-100 hover:bg-fill-hover")}
      >
        {line}
      </button>
      <Collapse open={open}>
        <div className="ml-1.75 max-h-80 overflow-y-auto border-l border-hairline py-1.5 pl-3.75 text-ui text-muted-foreground">
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
