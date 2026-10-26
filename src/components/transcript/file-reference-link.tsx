import { useContext, useState, type ReactElement, type ReactNode } from "react"
import type { FileCandidate } from "@mako/host/contracts/file-references"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { countedChanges } from "@mako/host/contracts/turn-changes"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { FileCitation } from "@/lib/file-citations"
import { cn } from "@/lib/utils"
import { useAcp } from "@/state/acp"
import { chooseFileReference, useFileReference } from "@/state/file-references"
import { formatAgo } from "@/state/thread-app"
import { viewer } from "@/state/viewer"
import { AnswerRequestContext, useReferenceSource } from "./source-context"

const linkClass = "font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
/** Past this many candidates, a filter narrows them, as branch search does. */
const FILTER_FROM = 7

const nameOf = (path: string) => path.split("/").at(-1) ?? path

/** Where a file is, as the person knows it: the checkout's name, then the folder inside it. */
function whereOf(file: FileCandidate): string {
  if (file.place) return [file.place.name, file.place.folder].filter(Boolean).join(" › ")
  return file.path.split("/").slice(0, -1).join("/").replace(/^\/Users\/[^/]+/, "~") || "/"
}

/** What the answer's own turn did to a file, from its recorded changes: "+12 −3"; empty when it changed no lines of it. */
type ChangedHere = string | undefined

/** Why a file is listed, in plain words. */
function whyOf(file: FileCandidate, now: number, here?: ChangedHere): string {
  const when = file.touch ? ` · ${formatAgo(file.touch.at, now)}` : ""
  const touched =
    here !== undefined ? `Changed in this answer${here ? ` (${here})` : ""}`
    : file.touch?.kind === "wrote" ? `Changed by this thread${when}`
    : file.touch?.kind === "read" ? `Read by this thread${when}`
    : file.touch?.kind === "named" ? `Named by this thread${when}`
    : "Not touched by this thread"
  if (file.reason === "renamed" && file.was) return `Renamed since from ${nameOf(file.was)} · ${touched.toLowerCase()}`
  if (file.reason === "twin") return `In the checkout this thread works in now · ${touched.toLowerCase()}`
  if (file.reason === "chosen") return `You picked this · ${touched.toLowerCase()}`
  return touched
}

/** Where the line the answer named is now, when the file changed since: "Line 120 then, 134 now". */
function movedLine(file: FileCandidate): string | undefined {
  const line = file.line
  if (!line || line.now === line.was) return undefined
  return line.now === null ? `Line ${line.was} was removed since` : `Line ${line.was} then, ${line.now} now`
}

/** A hover line for a found file: where it is, why this file, and where its line went. */
function titleOf(file: FileCandidate, now: number, here?: ChangedHere): string {
  return [`${whereOf(file)}/${nameOf(file.path)}`, whyOf(file, now, here), movedLine(file)].filter(Boolean).join("\n")
}

/**
 * The file's net lines in the answer's own turn, as its request's record
 * has them: a string, so a token streaming elsewhere moves nothing here.
 * Undefined when the turn didn't change the file for sure.
 */
function useChangedHere(liveId: string | undefined, path: string | undefined): ChangedHere {
  const requestId = useContext(AnswerRequestContext)
  return useAcp((state) => {
    const live = liveId && requestId && path ? state.conversations[liveId] : undefined
    const request = live?.kind === "live" ? live.requests?.find((each) => each.id === requestId) : undefined
    return path && request?.changes ? changedFiles(request.changes).get(path) : undefined
  })
}

/** A turn's record as each file's words, made once per record however many links read it. */
const changedWords = new WeakMap<object, Map<string, string>>()
function changedFiles(changes: NonNullable<LiveRequest["changes"]>): Map<string, string> {
  let words = changedWords.get(changes)
  if (!words) {
    words = new Map()
    for (const file of countedChanges(changes)?.files ?? []) {
      if (file.own === undefined) continue
      words.set(file.path, [file.own?.added ? `+${file.own.added.toLocaleString()}` : "", file.own?.removed ? `−${file.own.removed.toLocaleString()}` : ""].filter(Boolean).join(" "))
    }
    changedWords.set(changes, words)
  }
  return words
}

/**
 * A file link in an answer, drawn only once the host finds the file the
 * spelling meant: a link to it, a chooser when several fit equally well,
 * and plain text when nothing does. `bare` names link only through the
 * host; others fall back to today's unchecked link when it can't say.
 */
export function FileReferenceLink({ href, target, bare, children }: { href: string; target: FileCitation; bare: boolean; children: ReactNode }) {
  const source = useReferenceSource()
  // With its line, so the host says where that line is now.
  const spelling = target.line ? `${target.path}:${target.line}` : target.path
  const answer = useFileReference(source, spelling)
  const here = useChangedHere(source.liveId, answer?.kind === "file" ? answer.file.path : undefined)
  // "3 min ago" as of when the answer was drawn; the chooser takes its own time when it opens.
  const [drawn] = useState(() => Date.now())
  const open = (path: string, line = target.line) => void viewer.open(path, line, source.threadPath, source.liveId, target.anchor)
  if (answer === undefined || answer?.kind === "none" || (answer === null && bare)) return <span data-file-reference={answer === undefined ? "asking" : "none"}>{children}</span>
  if (answer === null)
    return (
      <a href={href} title={target.purpose ? `${target.purpose}: ${target.path}` : target.path} onClick={(event) => { event.preventDefault(); open(target.path) }} className={linkClass}>
        {children}
      </a>
    )
  const choose = (file: FileCandidate, candidates: readonly FileCandidate[]) => {
    chooseFileReference(source, spelling, { kind: "file", file: { ...file, reason: "chosen" }, others: candidates.filter((other) => other.path !== file.path) })
    open(file.path)
  }
  if (answer.kind === "file" && answer.others?.length) {
    const candidates = [answer.file, ...answer.others]
    return (
      <FileChooser spelling={target.path} candidates={candidates} picked={answer.file} drawn={drawn} onOpen={open} onChoose={(file) => choose(file, candidates)}>
        {children}
      </FileChooser>
    )
  }
  if (answer.kind === "file") {
    const file = answer.file
    const line = file.line
    const tip = [target.purpose, `${whereOf(file)}/${nameOf(file.path)}`, whyOf(file, drawn, here), movedLine(file)].filter((part) => part !== undefined)
    // The line it named is gone: plain text that says so, not a link to wherever the file is now.
    if (line?.now === null)
      return (
        <LinkTip lines={tip}>
          <span data-file-reference="line-gone" data-file-tip={tip.join("\n")} className="cursor-default underline decoration-border decoration-dotted underline-offset-2">{children}</span>
        </LinkTip>
      )
    return (
      <LinkTip lines={tip}>
        <a
          href={href}
          data-file-reference="file"
          data-file-reason={file.reason}
          data-file-line={line ? `${line.was}:${line.now}` : undefined}
          data-file-tip={tip.join("\n")}
          onClick={(event) => { event.preventDefault(); open(file.path, line?.now ?? target.line) }}
          className={linkClass}
        >
          {children}
        </a>
      </LinkTip>
    )
  }
  return (
    <FileChooser spelling={target.path} candidates={answer.candidates} drawn={drawn} onOpen={open} onChoose={(file) => choose(file, answer.candidates)}>
      {children}
    </FileChooser>
  )
}

/**
 * What a found file is, on hover: where it is, why this file, and where the
 * line the answer named went. The first line is the file, the rest quieter.
 */
function LinkTip({ lines, children }: { lines: readonly string[]; children: ReactElement }) {
  return (
    <TooltipProvider delayDuration={350}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-sm flex-col items-start gap-0.5 text-left" data-file-tip-card="">
          {lines.map((text, i) => (
            <span key={i} className={cn("break-words", i > 0 && "text-background/70")}>
              {text}
            </span>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Mac and Linux name the key that picks again differently. */
const PICK_AGAIN = navigator.userAgent.includes("Mac") ? "Option" : "Alt"

/**
 * A spelling several files fit: a click opens the chooser. Once the person
 * has `picked` one, a click opens it and Option-click (Alt on Linux) asks again.
 */
function FileChooser({ spelling, candidates, picked, drawn, onOpen, onChoose, children }: {
  spelling: string
  candidates: readonly FileCandidate[]
  picked?: FileCandidate
  /** When the link was drawn, for its hover line's "3 min ago". */
  drawn: number
  onOpen(path: string): void
  onChoose(file: FileCandidate): void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(0)
  const [filter, setFilter] = useState("")
  const [now, setNow] = useState(0)
  const shown = filter ? candidates.filter((file) => `${whereOf(file)}/${nameOf(file.path)}`.toLowerCase().includes(filter.toLowerCase())) : candidates
  const choose = (file: FileCandidate | undefined) => {
    if (!file) return
    setOpen(false)
    onChoose(file)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setSelected((at) => (shown.length ? (at + step + shown.length) % shown.length : 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(shown[selected])
    } else if (!filter && /^[1-9]$/.test(event.key) && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      choose(shown[Number(event.key) - 1])
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setSelected(0)
          setFilter("")
          setNow(Date.now())
        }
      }}
    >
      <PopoverTrigger asChild>
        <a
          href="#"
          title={picked ? `${titleOf(picked, drawn)}\n${PICK_AGAIN}-click to pick another of ${candidates.length}` : `${candidates.length} files match ${spelling}`}
          data-file-reference={picked ? "file" : "choice"}
          data-file-reason={picked?.reason}
          // Keeping `#` from navigating also stops Radix's own toggle, so this one opens it.
          onClick={(event) => {
            event.preventDefault()
            if (picked && !event.altKey && !open) {
              onOpen(picked.path)
              return
            }
            if (!open) {
              setSelected(0)
              setFilter("")
              setNow(Date.now())
            }
            setOpen(!open)
          }}
          className={linkClass}
        >
          {children}
        </a>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] gap-1 p-1" onKeyDown={onKeyDown} data-file-chooser={spelling}>
        <p className="px-2 pt-1.5 pb-1 text-ui text-foreground">
          Which <code className="font-mono text-ui">{spelling}</code>?
        </p>
        {candidates.length >= FILTER_FROM ? (
          <input
            autoFocus
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value)
              setSelected(0)
            }}
            placeholder="Filter by folder"
            aria-label="Filter the files"
            className="mx-1 mb-1 h-7 rounded-md border border-hairline bg-transparent px-2 text-ui outline-none placeholder:text-faint focus:border-border"
          />
        ) : null}
        <div role="listbox" aria-label={`Files matching ${spelling}`} tabIndex={candidates.length >= FILTER_FROM ? -1 : 0} autoFocus={candidates.length < FILTER_FROM} className="flex max-h-80 flex-col overflow-y-auto outline-none">
          {shown.map((file, i) => (
            <button
              key={file.path}
              type="button"
              role="option"
              aria-selected={i === selected}
              aria-label={`${nameOf(file.path)}, ${whereOf(file)}, ${whyOf(file, now)}`}
              data-file-option={file.path}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(file)}
              className={cn("pressable flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left", i === selected ? "bg-fill-selected" : "hover:bg-fill-hover")}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-ui break-all text-foreground">{nameOf(file.path)}</span>
                <span className="text-label break-words text-faint">{whereOf(file)}</span>
                <span className={cn("text-label", file.touch ? "text-foreground/70" : "text-faint")}>{whyOf(file, now)}</span>
              </span>
              {i < 9 ? <span className="mt-0.5 font-mono text-label text-faint tabular">{i === selected ? "↵" : i + 1}</span> : null}
            </button>
          ))}
          {!shown.length ? <p className="px-2 py-1.5 text-label text-faint">No file there matches. Clear the filter to see all {candidates.length}.</p> : null}
        </div>
        <p className="mt-0.5 border-t border-hairline px-2 pt-1.5 pb-1 text-label text-faint">↑↓ to move · ↵ to open · esc</p>
      </PopoverContent>
    </Popover>
  )
}
