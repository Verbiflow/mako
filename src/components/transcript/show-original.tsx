import { Suspense, use, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { CheckIcon, CopyIcon, FileCode2Icon } from "lucide-react"
import type { Entry, RecordRef } from "@mako/sessions/entries"
import type { OriginalPart, OriginalValue } from "@mako/sessions/record-original"
import { HighlightedCode } from "@/components/transcript/code-preview"
import { ChangingLabel } from "@/components/ui/changing-label"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useCopy } from "@/components/ui/use-copy"
import { formatBytes } from "@/lib/format"
import { homeRelative } from "@/lib/skill-matrix"
import type { MessageOrigin, OriginEntry } from "@/lib/types"
import { cn } from "@/lib/utils"
import { canReadOriginals, readEntryOriginal, readStreamLines, type OriginalReading } from "@/state/thread-viewing"
import { readLiveOriginal } from "@/state/live-history"
import { useTranscriptSource } from "./source-context"

/**
 * Past this many characters a part shows its head and offers the rest, so a
 * tool output of tens of megabytes opens at once. Copy always takes all of it.
 */
const SHOWN_CHARS = 200_000
/** A text streamed as hundreds of deltas opens on its first rows; the rest are one press away. */
const SHOWN_PARTS = 24

const KIND_WORDS = {
  user: "Prompt",
  text: "Text",
  thinking: "Thinking",
  tool: "Tool call",
  attachment: "Attachment",
  "proposed-plan": "Plan",
  plan: "To-do list",
  "provider-turn": "Turn the agent began",
  event: "Marker",
  unread: "Unread record",
} satisfies Record<Entry["type"], string>

/** An entry with the bytes it names: the session whose record files those are, and the live conversation that holds it. */
interface Recorded { path?: string; live?: string; entry: OriginEntry }

function recorded(origins: readonly (MessageOrigin | undefined)[], live: string | undefined): Recorded[] {
  return origins.flatMap((origin) => origin?.entries.flatMap((entry): Recorded[] => {
    const inLive = live !== undefined && entry.at !== undefined && Boolean(entry.record || entry.stream)
    // A record known only by the stream line it came in (a live record no decoder read, in Settings › Diagnostics) is read from the stream.
    const streamOnly = !inLive && !origin.path && entry.at === undefined && entry.stream !== undefined
    if (!inLive && !streamOnly && !(origin.path && entry.id && entry.record)) return []
    return [{ ...origin.path && { path: origin.path }, ...inLive && { live }, entry }]
  }) ?? [])
}

/**
 * "Original": the records a prompt, an answer or a marker was read from, as
 * the harness wrote them, and in a live conversation the lines of its
 * transport Mako recorded it from as it streamed. Only entries that name
 * their bytes offer it: what Mako read from its own older copy has no
 * original to show. Each is read when it is selected: a record from the
 * harness's file, or from Mako's copy when the harness has deleted the
 * session; a live entry by its host, from the view this window holds.
 */
export function ShowOriginal({ origins, className }: { origins: readonly (MessageOrigin | undefined)[]; className?: string }) {
  const [open, setOpen] = useState(false)
  const { liveId } = useTranscriptSource()
  const entries = useMemo(() => recorded(origins, liveId), [origins, liveId])
  if (!canReadOriginals() || !entries.length) return null
  return (
    <>
      <button
        type="button"
        data-show-original=""
        onClick={() => setOpen(true)}
        title="The bytes this was read from, as the harness wrote them"
        className={cn("pressable flex h-5 items-center gap-1 rounded px-1 hover:text-foreground focus-visible:text-foreground", className)}
      >
        <FileCode2Icon className="size-3" />
        <span>Original</span>
      </button>
      {open ? <OriginalDialog entries={entries} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

const keyOf = ({ path, entry }: Recorded) => `${path ?? ""}\u0000${entry.id ?? JSON.stringify(entry.at)}`

function read({ path, live, entry }: Recorded): Promise<OriginalReading> {
  const saved = path && entry.id && entry.record ? { path, id: entry.id } : undefined
  if (live && entry.at) return readLiveOriginal(live, { at: entry.at, type: entry.type, ...entry.stream && { stream: entry.stream } }, saved)
  if (!path && entry.stream) return readStreamLines(entry.stream)
  return saved ? readEntryOriginal(saved.path, saved.id) : Promise.resolve({ state: "read", original: { kept: false, parts: [] } })
}

function OriginalDialog({ entries, onClose }: { entries: readonly Recorded[]; onClose: () => void }) {
  const first = entries[0]!
  const [selected, setSelected] = useState(() => keyOf(first))
  const [reads, setReads] = useState(() => new Map([[keyOf(first), read(first)]]))
  const current = entries.find((each) => keyOf(each) === selected) ?? first
  const select = (each: Recorded) => {
    const key = keyOf(each)
    setSelected(key)
    if (reads.has(key)) return
    const next = new Map(reads)
    next.set(key, read(each))
    setReads(next)
  }
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = entries.indexOf(current)
    const to = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : undefined
    if (to === undefined) return
    event.preventDefault()
    const index = Math.max(0, Math.min(entries.length - 1, to))
    select(entries[index]!)
    event.currentTarget.querySelectorAll<HTMLElement>("[role=option]")[index]?.focus()
  }
  const listed = entries.length > 1
  const list = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLDivElement>(null)
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        data-original-dialog=""
        onOpenAutoFocus={(event) => {
          // Arrow keys move through the entries from the first moment; with one entry, they scroll its record.
          event.preventDefault()
          const target = list.current?.querySelector<HTMLElement>("[aria-selected=true]") ?? pane.current
          target?.focus()
        }}
        className="flex h-[min(80vh,760px)] w-[calc(100vw-32px)] max-w-content flex-col overflow-hidden p-0">
        <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hairline pr-3 pl-4">
          <DialogTitle className="shrink-0">Original</DialogTitle>
          {recordFile(current) ? <FilePath file={recordFile(current)!} /> : <div className="flex-1" />}
        </div>
        <div className={cn("grid min-h-0 flex-1", listed ? "grid-cols-[208px_minmax(0,1fr)]" : "grid-cols-1")}>
          {listed ? (
            <div ref={list} role="listbox" aria-label="Entries" onKeyDown={step} className="min-h-0 overflow-y-auto border-r border-hairline p-1.5">
              {entries.map((each) => {
                const key = keyOf(each)
                const chosen = key === keyOf(current)
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={chosen}
                    tabIndex={chosen ? 0 : -1}
                    data-original-option={key}
                    onClick={() => select(each)}
                    className={cn(
                      // Focus roves with the selection, so the selected fill is the focus mark.
                      "pressable flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui outline-none transition-colors duration-100",
                      chosen ? "bg-fill-selected text-foreground" : "text-muted-foreground hover:bg-fill-hover hover:text-foreground"
                    )}
                  >
                    <span className="shrink-0">{KIND_WORDS[each.entry.type]}</span>
                    {each.entry.label ? <span className="min-w-0 truncate font-mono text-label text-faint">{each.entry.label}</span> : null}
                    <span className="ml-auto shrink-0 pl-1 text-label text-faint tabular">{extent(each.entry.record ?? each.entry.stream)}</span>
                  </button>
                )
              })}
            </div>
          ) : null}
          <div ref={pane} tabIndex={-1} className="min-h-0 overflow-y-auto px-4 pt-3 pb-4 outline-none">
            <div className="pb-3">
              <p className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-ui text-foreground">{KIND_WORDS[current.entry.type]}</span>
                {current.entry.label ? <span className="min-w-0 truncate font-mono text-label text-muted-foreground">{current.entry.label}</span> : null}
              </p>
              {current.entry.id ? <p className="truncate font-mono text-label text-faint select-text" title="This entry's id">{current.entry.id}</p> : null}
            </div>
            <Suspense key={keyOf(current)} fallback={<p className="text-label text-faint">Reading the record…</p>}>
              <OriginalBody reading={reads.get(keyOf(current))!} recorded={current} />
            </Suspense>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A file's folder gives way before its name does. */
function FilePath({ file }: { file: string }) {
  const { copied, copy } = useCopy(file)
  const shown = homeRelative(file)
  const cut = shown.lastIndexOf("/") + 1
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 font-mono text-label" title={file}>
      <span className="min-w-0 truncate text-faint">{shown.slice(0, cut)}</span>
      <span className="shrink-0 text-muted-foreground">{shown.slice(cut)}</span>
      <button
        type="button"
        aria-label="Copy the file's path"
        onClick={() => { void copy() }}
        className="pressable ml-1 flex size-6 shrink-0 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
      >
        {copied ? <CheckIcon className="size-3 text-positive" /> : <CopyIcon className="size-3" />}
      </button>
    </div>
  )
}

function OriginalBody({ reading, recorded }: { reading: Promise<OriginalReading>; recorded: Recorded }) {
  const read = use(reading)
  if (read.state === "failed") return <p className="text-label text-negative">Couldn't read it: {read.message}</p>
  const original = read.original
  if (!original) return <p className="text-label text-faint">This entry is no longer in the session.</p>
  // A live entry names what it streamed; once its record lands, the record stands for it.
  if (!original.stream) {
    if (!original.parts.length) return <p className="text-label text-faint">No record names this entry.</p>
    return <Parts parts={original.parts} kept={original.kept} />
  }
  // A record known only by its stream line (a live one no decoder read) has no record side to speak of.
  const streamOnly = !recorded.path && !recorded.live && !original.parts.length
  return (
    <div className="flex flex-col gap-5">
      {streamOnly ? null : <section data-original-side="record" className="flex flex-col gap-2">
        <SideHead title="In the session's record" />
        {original.parts.length ? <Parts parts={original.parts} kept={original.kept} />
          : <p className="text-label text-faint">{recorded.entry.record ? "The record no longer holds these bytes." : recorded.path ? "The harness's record doesn't keep this; only its live stream said it." : "Not in the record yet: the harness hasn't written this turn."}</p>}
      </section>}
      <section data-original-side="stream" className="flex flex-col gap-2">
        <SideHead title="As it streamed" file={original.stream.find((part) => part.kind !== "row")?.file} />
        <Parts parts={original.stream} kept={false} />
      </section>
    </div>
  )
}

/** One side's title, and the file its bytes are in when it isn't the record's in the header. */
function SideHead({ title, file }: { title: string; file?: string }) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-2">
      <h3 className="shrink-0 text-label font-medium text-muted-foreground">{title}</h3>
      {file ? <FilePath file={file} /> : null}
    </div>
  )
}

function Parts({ parts, kept }: { parts: readonly OriginalPart[]; kept: boolean }) {
  const [shown, setShown] = useState(SHOWN_PARTS)
  const rest = parts.length - shown
  return (
    <div className="flex flex-col gap-2">
      {kept ? <p className="text-label text-muted-foreground">Read from the copy Mako kept: the harness no longer has this session.</p> : null}
      {parts.slice(0, shown).map((part, index) => <OriginalPartView key={index} part={part} />)}
      {rest > 0 ? (
        <button type="button" onClick={() => setShown(parts.length)} className="pressable self-start rounded px-1 text-label text-muted-foreground hover:text-foreground">
          Show {rest} more {parts[shown]!.kind === "row" ? "rows" : "parts"}
        </button>
      ) : null}
    </div>
  )
}

function OriginalPartView({ part }: { part: OriginalPart }) {
  switch (part.kind) {
    case "missing":
      return <p className="text-label text-faint"><span className="font-mono">{homeRelative(part.file)}</span>: {part.reason}</p>
    case "range":
      return <SourceBlock head={`bytes ${part.from.toLocaleString()}–${part.to.toLocaleString()} · ${formatBytes(part.to - part.from)}`} text={part.text} />
    case "row":
      if (!part.columns) return <p className="text-label text-faint">{part.table} · {keyWords(part.key)}: the database no longer has this row.</p>
      return <RowView table={part.table} rowKey={part.key} columns={part.columns} />
  }
}

/** A short scalar reads in a line of its own; a long or structured value gets a block. */
const SHORT_VALUE = 120

function RowView({ table, rowKey, columns }: { table: string; rowKey: Readonly<Record<string, string | number>>; columns: Readonly<Record<string, OriginalValue>> }) {
  const all = Object.entries(columns)
  const short = all.filter(([, value]) => value.type === "null" || (value.type !== "blob" && value.text.length <= SHORT_VALUE && !value.text.includes("\n") && indented(value.text) === undefined))
  const long = all.filter((column) => !short.includes(column))
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-hairline px-3 py-2">
        <p className="pb-1 text-label text-muted-foreground">{table} · {keyWords(rowKey)}</p>
        <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-4 gap-y-0.5 font-mono text-label">
          {short.map(([column, value]) => (
            <div key={column} className="contents">
              <dt className="truncate text-faint">{column}</dt>
              <dd className={cn("min-w-0 break-all select-text", value.type === "null" ? "text-faint" : "text-foreground")}>{value.type === "null" ? "NULL" : value.text}</dd>
            </div>
          ))}
        </dl>
      </div>
      {long.map(([column, value]) => (
        <SourceBlock key={column} head={`${column} · ${valueWords(value)}`} text={value.type === "null" ? "NULL" : value.text} />
      ))}
    </div>
  )
}

/** One record's text: JSON shown indented when it parses, the bytes as written a toggle away. */
function SourceBlock({ head, text }: { head: string; text: string }) {
  const formatted = useMemo(() => indented(text), [text])
  const [raw, setRaw] = useState(false)
  const [whole, setWhole] = useState(false)
  const { copied, copy } = useCopy(text)
  const source = raw || formatted === undefined ? text : formatted
  const shown = whole || source.length <= SHOWN_CHARS ? source : source.slice(0, SHOWN_CHARS)
  return (
    // A record is read line by line, so its lines sit at the code's own leading, not the prose's.
    <div className="mako-prose min-w-0 [&_pre]:text-label [&_pre]:leading-[1.6] [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]">
      <div className="mako-code group">
        <div className="mako-code-head">
          <span className="min-w-0 truncate font-mono text-label text-faint tabular select-none">{head}</span>
          {formatted !== undefined ? (
            <button type="button" className="pressable shrink-0 rounded px-1 text-label text-faint hover:text-foreground" onClick={() => setRaw((value) => !value)}>
              {raw ? "Formatted" : "As written"}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Copy the record"
            onClick={() => { void copy() }}
            className="pressable ml-auto flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-label text-faint hover:text-foreground"
          >
            {copied ? <CheckIcon className="size-3 text-positive" /> : <CopyIcon className="size-3" />}
            <span role="status" className="min-w-8"><ChangingLabel text={copied ? "Copied" : "Copy"} /></span>
          </button>
        </div>
        <HighlightedCode source={shown} language={formatted !== undefined ? "json" : "text"} streaming={false} />
        {shown.length < source.length ? (
          <button type="button" className="pressable w-full border-t border-hairline py-1.5 text-label text-muted-foreground hover:text-foreground" onClick={() => setWhole(true)}>
            Show all {formatBytes(source.length)}
          </button>
        ) : null}
      </div>
    </div>
  )
}

/** JSON, or JSON lines (a call and its result can be two lines of one record), indented; undefined when it isn't. */
function indented(text: string): string | undefined {
  const lines = text.split("\n").filter((line) => line.trim())
  if (!lines.length || !lines.every((line) => /^\s*[[{]/.test(line))) return undefined
  try {
    return lines.map((line) => JSON.stringify(JSON.parse(line), null, 2)).join("\n\n")
  } catch {
    return undefined
  }
}

/** How much an entry's record holds, for the list: its size, or its rows when there are several. */
function extent(record: RecordRef | undefined): string {
  const ranges = record?.ranges ?? []
  if (ranges.length) return formatBytes(ranges.reduce((sum, [from, to]) => sum + to - from, 0))
  const rows = record?.rows?.length ?? 0
  return rows > 1 ? `${rows} rows` : ""
}

/** The file an entry's record names, as `recordFilePath` resolves it: its session's own (the path before `#`), or one beside it. */
function recordFile({ path, entry }: Recorded): string | undefined {
  if (!path || !entry.record) return undefined
  const own = path.split("#")[0]!
  const file = entry.record.file
  if (!file) return own
  return file.startsWith("/") ? file : `${own.slice(0, own.lastIndexOf("/") + 1)}${file}`
}

function keyWords(key: Readonly<Record<string, string | number>>): string {
  return Object.values(key).join(" · ")
}

function valueWords(value: OriginalValue): string {
  if (value.type === "blob") return `blob, ${formatBytes(value.bytes)}${value.encoding === "base64" ? ", base64" : ""}`
  return value.type
}
