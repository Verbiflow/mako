import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { ChevronDownIcon, CheckIcon } from "lucide-react"
import type { TurnFileHunks } from "@mako/host/contracts/turn-review"
import { LineCounts, UnsureCount } from "@/components/inspector/change-marks"
import { lineWords, writerLabel } from "@/lib/turn-writers"
import { cn } from "@/lib/utils"
import { hunksReader, type HunksKey } from "./review-data"
import { fileView, largeByRecord, largeByView, sessionPath, splitPath, type DiffRow, type FileView, type ReviewFile, type RowPick } from "./review-model"
import { useReviewNotes } from "./review-notes"

/*
 * One file of a turn: a card whose header stays at the top while its lines
 * scroll under it (the path cut from its start so the name always shows,
 * its counts, Viewed), and its diff in stretches. Both line numbers stay
 * pinned at the left while the code scrolls sideways under them, on solid
 * colours so nothing shows through. A long file waits behind "Load diff".
 */

/** What the comment sheet is asked for: the rows picked in one file's diff. */
export interface CommentAsk {
  file: ReviewFile
  /** The path as the comment names it: relative to the Session's folder. */
  path: string
  view: FileView
  from: RowPick
  to: RowPick
}

/** How long a finger rests on a line before it starts a range. */
const HOLD_MS = 420
/** A finger that moves this far is scrolling, not holding. */
const SLOP_PX = 8
/** How far ahead of the screen a file's diff is read, so it's there before it scrolls in. */
const AHEAD = "1600px 0px"
/** The first files are read at once, before anything is measured. */
const FIRST = 3

type Read =
  | { kind: "waiting" }
  | { kind: "reading" }
  | { kind: "ready"; hunks: TurnFileHunks }
  | { kind: "failed"; message: string }

/** One file's card. Every prop is a value or a callback that keeps its identity, so a card redraws only for its own file. */
export const FileCard = memo(function FileCard({ index, file, conversation, requestId, journal, through, settled, cwd, viewed, onViewed, onComment }: {
  index: number
  file: ReviewFile
  conversation: string
  requestId: string
  journal: string
  through: number
  settled: boolean
  cwd: string | undefined
  viewed: boolean
  onViewed: (path: string, on: boolean) => void
  onComment: (ask: CommentAsk) => void
}) {
  const key = useMemo<HunksKey>(() => ({ conversation, requestId, path: file.path, journal, through, settled }), [conversation, requestId, file.path, journal, through, settled])
  const [read, setRead] = useState<Read>(() => {
    const held = hunksReader.held(key)
    return held ? { kind: "ready", hunks: held } : { kind: "waiting" }
  })
  // A long file is read only when asked; one read and found long is drawn only when asked.
  const [asked, setAsked] = useState(false)
  const [open, setOpen] = useState(!viewed)
  const card = useRef<HTMLElement>(null)
  const gated = !asked && largeByRecord(file)

  // Viewed folds the file; taking the mark off opens it again.
  const [wasViewed, setWasViewed] = useState(viewed)
  if (wasViewed !== viewed) {
    setWasViewed(viewed)
    setOpen(!viewed)
  }

  // Each try reads once; "Try again" after a failure is the next try.
  const [attempt, setAttempt] = useState(0)
  // Keyed on what to read, never on the read's own state: a read that lands mustn't end its own effect before it's drawn.
  useEffect(() => {
    if (gated || hunksReader.held(key)) return
    let current = true
    const start = () => {
      if (!current) return
      setRead((now) => (now.kind === "ready" ? now : { kind: "reading" }))
      hunksReader.read(key, index).then(
        (hunks) => current && setRead({ kind: "ready", hunks }),
        (error: Error) => current && setRead({ kind: "failed", message: error.message })
      )
    }
    const element = card.current
    if (index < FIRST || !element || !("IntersectionObserver" in window)) {
      start()
      return () => {
        current = false
      }
    }
    // What this device kept paints without waiting for the screen to reach it.
    void hunksReader.kept(key).then((kept) => {
      if (current && kept) setRead({ kind: "ready", hunks: kept })
    })
    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        watch.disconnect()
        start()
      },
      { rootMargin: AHEAD }
    )
    watch.observe(element)
    return () => {
      current = false
      watch.disconnect()
    }
  }, [gated, key, index, attempt])

  const view = useMemo(() => (read.kind === "ready" && read.hunks.kind === "text" ? fileView(read.hunks) : undefined), [read])
  const path = sessionPath(file, cwd)
  const { folder, name } = splitPath(path)
  const counted = file.added !== null || file.removed !== null
  return (
    <section ref={card} className="rv-file" data-file={file.path} data-viewed={viewed || undefined} data-open={open || undefined} aria-label={path}>
      <header className="rv-file-head">
        <button type="button" className="rv-file-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronDownIcon aria-hidden className="rv-chevron size-4 shrink-0" />
          <span className="rv-path" title={path}>
            {folder ? <span className="rv-folder"><bdi>{folder}</bdi></span> : null}
            <span className="rv-name">{name}</span>
          </span>
          {file.kind === "create" ? <span className="rv-kind">New</span> : file.kind === "delete" ? <span className="rv-kind">Deleted</span> : file.kind === "rename" ? <span className="rv-kind">Renamed</span> : null}
          {counted ? <LineCounts insertions={file.added} deletions={file.removed} className="text-label" /> : null}
          {file.unsure ? <UnsureCount unsure={{ lines: file.unsure, files: 0 }} className="shrink-0 text-label" /> : null}
        </button>
        <button type="button" role="checkbox" aria-checked={viewed} aria-label={`Viewed ${name}`} className="rv-viewed" onClick={() => onViewed(file.path, !viewed)}>
          <span className="rv-check" aria-hidden>
            {viewed ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
          </span>
          <span className="max-[359px]:hidden">Viewed</span>
        </button>
      </header>
      {open ? (
        <div className="rv-file-body">
          {file.from ? <p className="rv-note">{`Renamed from ${file.from}`}</p> : null}
          {gated ? (
            <Gate lines={(file.added ?? 0) + (file.removed ?? 0) + file.unsure} onLoad={() => setAsked(true)} />
          ) : read.kind === "ready" ? (
            read.hunks.kind === "binary" ? (
              <p className="rv-note">{binaryWords(read.hunks)}</p>
            ) : read.hunks.kind === "unavailable" ? (
              <p className="rv-note">{read.hunks.reason}</p>
            ) : view && largeByView(view) && !asked ? (
              <Gate lines={view.rows} onLoad={() => setAsked(true)} />
            ) : view ? (
              <DiffBody view={view} file={file} path={path} conversation={conversation} onComment={onComment} />
            ) : null
          ) : read.kind === "failed" ? (
            <p className="rv-note" role="alert">
              {read.message}
              <button type="button" className="rv-inline-action" onClick={() => setAttempt(attempt + 1)}>
                Try again
              </button>
            </p>
          ) : (
            <Reading />
          )}
        </div>
      ) : null}
    </section>
  )
})

function binaryWords(hunks: Extract<TurnFileHunks, { kind: "binary" }>): string {
  const size = (bytes: number) => (bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)
  if (hunks.before === null && hunks.after !== null) return `A binary file, ${size(hunks.after)}, added.`
  if (hunks.after === null && hunks.before !== null) return `A binary file, ${size(hunks.before)}, removed.`
  return `A binary file, ${hunks.before === null ? "?" : size(hunks.before)} before and ${hunks.after === null ? "?" : size(hunks.after)} after.`
}

function Gate({ lines, onLoad }: { lines: number; onLoad: () => void }) {
  return (
    <div className="rv-gate">
      <p className="text-label text-faint">{`${lineWords(lines)} changed: a long diff, drawn when you ask.`}</p>
      <button type="button" className="rv-load" data-load-diff="" onClick={onLoad}>
        Load diff
      </button>
    </div>
  )
}

/** Placeholder rows the height a few lines take, while the file is read. */
function Reading() {
  return (
    <div className="rv-reading" aria-label="Reading the diff" role="status">
      <span />
      <span />
      <span />
    </div>
  )
}

/**
 * The rows. Tap one to comment on it; hold one, then tap another, for a range. One scroller per file, so its lines
 * move sideways together under the pinned numbers.
 */
const DiffBody = memo(function DiffBody({ view, file, path, conversation, onComment }: { view: FileView; file: ReviewFile; path: string; conversation: string; onComment: (ask: CommentAsk) => void }) {
  const [anchor, setAnchor] = useState<RowPick | null>(null)
  const hold = useRef<{ timer: number; x: number; y: number; pick: RowPick; held: boolean } | null>(null)
  const notes = useReviewNotes(conversation)
  const commented = useMemo(() => {
    const lines = { old: new Set<number>(), new: new Set<number>() }
    for (const note of notes) {
      if (note.detail.path !== path) continue
      for (let line = note.detail.startLine; line <= note.detail.endLine; line++) lines[note.detail.side].add(line)
    }
    return lines
  }, [notes, path])

  const pickOf = (target: EventTarget | null): RowPick | null => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-row]") : null
    if (!element) return null
    return { hunk: Number(element.dataset["hunk"]), row: Number(element.dataset["index"]) }
  }
  const down = (event: ReactPointerEvent) => {
    const pick = pickOf(event.target)
    if (!pick || (event.pointerType === "mouse" && event.button !== 0)) return
    const timer = window.setTimeout(() => {
      if (!hold.current) return
      hold.current.held = true
      setAnchor(pick)
      navigator.vibrate?.(8)
    }, HOLD_MS)
    hold.current = { timer, x: event.clientX, y: event.clientY, pick, held: false }
  }
  const move = (event: ReactPointerEvent) => {
    const held = hold.current
    if (held && !held.held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > SLOP_PX) {
      clearTimeout(held.timer)
      hold.current = null
    }
  }
  const up = () => {
    const held = hold.current
    if (held) clearTimeout(held.timer)
  }
  const tap = (target: EventTarget | null) => {
    const held = hold.current
    hold.current = null
    // The hold that started a range isn't also a tap.
    if (held?.held) return
    const pick = pickOf(target)
    if (!pick) return
    const from = anchor ?? pick
    setAnchor(null)
    onComment({ file, path, view, from, to: pick })
  }

  return (
    <div
      className="rv-code web-scroll"
      // SAFETY: a custom property, which React passes through as written; its type has no index for them.
      style={{ "--rv-digits": `${view.digits}ch` } as React.CSSProperties}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        if (hold.current) clearTimeout(hold.current.timer)
        hold.current = null
      }}
      onClick={(event) => tap(event.target)}
      onContextMenu={(event) => {
        // A held line starts a range; the browser's own menu would cover it.
        if (event.target instanceof Element && event.target.closest("[data-row]")) event.preventDefault()
      }}
    >
      <div className="rv-rows" role="table" aria-label={`Changes to ${path}`}>
        {view.hunks.map((hunk, hunkIndex) => {
          const previous = view.hunks[hunkIndex - 1]
          const firstOld = hunk.rows.find((row) => row.old !== null)?.old ?? hunk.oldStart
          const gapStart = previous ? (previous.rows.findLast((row) => row.old !== null)?.old ?? previous.oldStart) + 1 : 1
          const hidden = Math.max(0, firstOld - gapStart)
          return (
            <div key={hunkIndex} role="rowgroup">
              {hidden ? <Gap lines={hidden} /> : null}
              {hunk.rows.map((row, rowIndex) => (
                <Row
                  key={rowIndex}
                  row={row}
                  hunk={hunkIndex}
                  index={rowIndex}
                  anchor={anchor !== null && anchor.hunk === hunkIndex && anchor.row === rowIndex}
                  commented={(row.kind === "-" ? commented.old.has(row.old!) : commented.new.has(row.new!)) || undefined}
                />
              ))}
            </div>
          )
        })}
        {view.limited ? <p className="rv-gap">The rest of this file’s changes are too long to read here.</p> : null}
      </div>
      {anchor ? (
        <div className="rv-range-hint" role="status">
          <span className="min-w-0 flex-1">Tap the last line of the range</span>
          <button
            type="button"
            className="rv-inline-action"
            onClick={(event) => {
              event.stopPropagation()
              setAnchor(null)
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  )
})

/** Unchanged lines between two stretches, said with their count. */
function Gap({ lines }: { lines: number }) {
  return (
    <div className="rv-gap" aria-hidden>
      <span className="rv-gap-text">{`⋯ ${lineWords(lines)} unchanged`}</span>
    </div>
  )
}

function Row({ row, hunk, index, anchor, commented }: { row: DiffRow; hunk: number; index: number; anchor: boolean; commented: true | undefined }) {
  return (
    <>
      <div
        role="row"
        className="rv-row"
        data-row=""
        data-hunk={hunk}
        data-index={index}
        data-kind={row.kind === "+" ? "add" : row.kind === "-" ? "remove" : "same"}
        data-writer={row.writer?.writer}
        data-anchor={anchor || undefined}
        data-commented={commented}
      >
        <span className="rv-gutter" aria-hidden>
          <span className="rv-number">{row.old ?? ""}</span>
          <span className="rv-number">{row.new ?? ""}</span>
          <span className="rv-sign">{row.kind === "+" ? "+" : row.kind === "-" ? "−" : ""}</span>
        </span>
        <span className="rv-text" role="cell">
          <Words row={row} />
        </span>
      </div>
      {row.writer?.lines ? <WriterLine writer={row.writer.writer} lines={row.writer.lines} /> : null}
    </>
  )
}

function Words({ row }: { row: DiffRow }): ReactNode {
  if (!row.words?.length) return row.text || " "
  const parts: ReactNode[] = []
  let at = 0
  row.words.forEach((range, index) => {
    if (range.start > at) parts.push(row.text.slice(at, range.start))
    parts.push(<mark key={index}>{row.text.slice(range.start, range.end)}</mark>)
    at = range.end
  })
  if (at < row.text.length) parts.push(row.text.slice(at))
  return parts
}

/** Who wrote the stretch just above, where another writer shares its block: a quiet line under it, as the desk's. */
function WriterLine({ writer, lines }: { writer: NonNullable<DiffRow["writer"]>["writer"]; lines: number }) {
  return (
    <div className={cn("rv-writer")} data-writer={writer} aria-label={`${writerLabel({ writer })}: ${lineWords(lines)}`}>
      <span className="rv-writer-text">{`${writerLabel({ writer })} · ${lineWords(lines)}`}</span>
    </div>
  )
}
