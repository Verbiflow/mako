import { MCP_SERVER_FAILED, type TranscriptEvent, type TurnCause } from "@mako/sessions/events"
import { Prose } from "@/components/transcript/markdown"
import { eventWords, limitWords, setupWords } from "@/lib/transcript-events"
import { textOf } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Exchange } from "@/lib/exchanges"
import type { ChatMessage } from "@/lib/types"
import { EventLine } from "./event-line"

/**
 * A provider's markers between content: one quiet line each, in the
 * transcript's own column. Setup notices that arrive together (servers that
 * did not start, configuration warnings) read as one line that opens. A
 * usage limit opens onto the work it refused, `refused` by its note's id.
 */
export function EventNotes({ messages, inline, refused }: { messages: readonly ChatMessage[]; inline?: boolean; refused?: Exchange["refused"] }) {
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
        "notes" in run ? (
          <SetupNotes key={run.id} notes={run.notes} />
        ) : refused?.[run.id] ? (
          <LimitNote key={run.id} note={run.note} refused={refused[run.id]!} />
        ) : (
          <EventNote key={run.id} note={run.note} />
        )
      )}
    </div>
  )
}

/** The words a marker reads as, and what opens under it: its body, or its own words when the line may not fit them. */
function EventNote({ note }: { note: TranscriptEvent }) {
  const words = eventWords(note)
  // A long line may not fit, so its whole opens under it. A cause words the
  // line from what settled, and the provider's sentence would only repeat it.
  const quoted = note.cause === undefined && words.title.length + (words.detail?.length ?? 0) > LONG_LINE
  return (
    <EventLine words={words} data-event={note.label}>
      {note.body || quoted ? <NoteBody note={note} quoted={quoted} /> : null}
    </EventLine>
  )
}

/** A usage limit and each turn it refused, by what that turn was about. */
function LimitNote({ note, refused }: { note: TranscriptEvent; refused: readonly ChatMessage[] }) {
  const causes = refused.flatMap((opener): TurnCause[] => (opener.note?.cause ? [opener.note.cause] : []))
  return (
    <EventLine words={limitWords(note, causes)} data-event={note.label} data-event-refused={refused.length}>
      <div className="flex flex-col gap-2">
        {note.body ? <Prose text={note.body} className="event-prose" /> : null}
        <ul className="flex flex-col gap-1">
          {refused.map((opener) => {
            const words = eventWords(opener.note ?? { label: textOf(opener.blocks) })
            return (
              <li key={opener.id} className="flex min-w-0 gap-2">
                <span className="shrink-0 text-foreground">{words.title}</span>
                {words.detail ? <span className="min-w-0 truncate text-faint">{words.detail}</span> : null}
              </li>
            )
          })}
        </ul>
      </div>
    </EventLine>
  )
}

/** Past this many characters a line may be cut at the transcript's narrowest. */
const LONG_LINE = 96

function NoteBody({ note, quoted }: { note: TranscriptEvent; quoted: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      {quoted ? <p className="text-faint">{note.detail ? `${note.label} — ${note.detail}` : note.label}</p> : null}
      {note.body ? <Prose text={note.body} className="event-prose" /> : null}
    </div>
  )
}

const SERVER_SEPARATOR = " · "

function SetupNotes({ notes }: { notes: readonly TranscriptEvent[] }) {
  if (notes.length === 1) return <EventNote note={notes[0]!} />
  return (
    <EventLine words={setupWords(notes)} data-event-setup={notes.length}>
      <ul className="flex flex-col gap-2">
        {notes.map((note, index) => {
          const server = note.label === MCP_SERVER_FAILED
          const [name, ...reason] = server ? (note.detail ?? "").split(SERVER_SEPARATOR) : []
          const words = server ? undefined : eventWords(note)
          return (
            <li key={index} className="flex flex-col gap-0.5">
              <span className="flex min-w-0 gap-2">
                <span className={cn("shrink-0", note.tone === "error" ? "text-negative" : "text-foreground")}>{server ? name : words!.title}</span>
                {note.body ? null : (
                  <span className="min-w-0 truncate text-faint">{server ? reason.join(SERVER_SEPARATOR) : words!.detail}</span>
                )}
              </span>
              {note.body ? <span className="whitespace-pre-wrap text-faint">{note.body}</span> : null}
            </li>
          )
        })}
      </ul>
    </EventLine>
  )
}
