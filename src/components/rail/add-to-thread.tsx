import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { SearchIcon } from "lucide-react"
import { FoldGlyph } from "@/components/rail/fold-glyph"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Eyebrow } from "@/components/ui/kit"
import { FOLD_GLYPHS } from "@/lib/thread-fold"
import { formatRelative, workspaceName } from "@/lib/format"
import { fuzzy } from "@/lib/fuzzy"
import { cn } from "@/lib/utils"
import { sameAcpPresence, selectAcpPresence } from "@/state/acp-presence"
import { useAcp } from "@/state/acp"
import { usePrefs } from "@/state/prefs"
import { useThreadGroups } from "@/state/thread-groups"
import { useThreadArchives } from "@/state/thread-lifecycle"
import {
  addToThread,
  closeAddToThread,
  threadChoices,
  useAddToThread,
  type AddToThreadRequest,
  type ThreadChoice,
} from "@/state/thread-regroup"
import { useThreads } from "@/state/threads"

const SHOWN = 100

/** The picker behind "Add to thread…": mounted once, opened from a row, a tab, or the palette. */
export function AddToThreadDialog() {
  const request = useAddToThread((state) => state.request)
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) closeAddToThread() }}>
      {request ? <AddToThreadPicker request={request} /> : null}
    </Dialog>
  )
}

function detail(choice: ThreadChoice, near: boolean): string {
  return [
    near ? undefined : choice.cwd ? workspaceName(choice.cwd) : undefined,
    choice.sessions > 1 ? `${choice.sessions} sessions` : undefined,
    choice.updatedAt ? formatRelative(choice.updatedAt) : undefined,
  ].filter(Boolean).join(" · ")
}

function AddToThreadPicker({ request }: { request: AddToThreadRequest }) {
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState("")
  const [cursor, setCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const refs = useThreads((state) => state.threads)
  const presences = useAcp(selectAcpPresence, sameAcpPresence)
  const groups = useThreadGroups((state) => state.groups)
  const threadOf = useThreadGroups((state) => state.threadOf)
  const archived = useThreadArchives((state) => state.keys)
  const overrides = usePrefs((prefs) => prefs.titleOverrides)
  const [since] = useState(() => performance.now())

  const choices = useMemo(
    () => threadChoices({ refs, presences, groups, threadOf, archived, overrides, exclude: request.from, cwd: request.cwd }),
    [refs, presences, groups, threadOf, archived, overrides, request.from, request.cwd]
  )
  const term = query.trim()
  const matching = useMemo(() => {
    if (!term) return choices
    return choices
      .flatMap((choice) => {
        const scores = [choice.title, choice.cwd ? workspaceName(choice.cwd) : ""].flatMap((text) => fuzzy(term, text)?.score ?? [])
        return scores.length ? [{ choice, score: Math.max(...scores) }] : []
      })
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.choice)
  }, [choices, term])
  const shown = matching.slice(0, SHOWN)
  const active = Math.min(cursor, Math.max(0, shown.length - 1))
  const isNear = (choice: ThreadChoice) => !term && Boolean(request.cwd) && choice.cwd === request.cwd

  useEffect(() => {
    list.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView({ block: "nearest" })
  }, [active])

  const pick = async (choice: ThreadChoice | undefined) => {
    if (!choice || busy) return
    setBusy(true)
    const added = await addToThread(request, { thread: choice.thread, title: choice.title })
    setBusy(false)
    if (added) closeAddToThread()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const delta = event.key === "ArrowDown" ? 1 : -1
      setCursor((active + delta + shown.length) % Math.max(shown.length, 1))
    } else if (event.key === "Enter") {
      event.preventDefault()
      void pick(shown[active])
    }
  }

  const one = request.sessions.length === 1
  let lastHeading: string | undefined
  return (
    <DialogContent className="max-w-dialog overflow-hidden">
      <div className="border-b border-hairline px-3.5 pt-3 pb-2.5">
        <DialogTitle className="truncate">Add “{request.title}” to a thread</DialogTitle>
        <p className="mt-0.5 text-label text-faint">
          {one ? "It becomes the last tab of the thread you pick." : `Its ${request.sessions.length} sessions become the last tabs of the thread you pick.`}
        </p>
      </div>
      <div className="flex h-10 items-center gap-2.5 border-b border-hairline px-3.5">
        <SearchIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={shown.length ? `${listId}-${active}` : undefined}
          aria-label="Search threads"
          placeholder="Search threads"
          maxLength={200}
          value={query}
          disabled={busy}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-ui placeholder:text-faint focus:outline-none"
        />
      </div>
      <div ref={list} id={listId} role="listbox" aria-label="Threads" className="max-h-[22rem] overflow-y-auto overscroll-contain p-1.5">
        {shown.length === 0 ? (
          <p className="px-2 py-8 text-center text-ui text-faint">{term ? "No threads match" : "No other threads yet"}</p>
        ) : (
          shown.map((choice, index) => {
            const near = isNear(choice)
            const heading = term ? undefined : near ? `In ${workspaceName(request.cwd)}` : "Other projects"
            const showHeading = heading !== lastHeading && (index > 0 || near)
            lastHeading = heading
            return (
              <div key={choice.thread}>
                {showHeading && heading ? <Eyebrow className="px-1.5 pt-2 pb-1">{heading}</Eyebrow> : null}
                <button
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  data-highlighted={index === active}
                  disabled={busy}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => { void pick(choice) }}
                  className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left", index === active && "bg-fill-selected")}
                >
                  <span className="flex w-9 shrink-0 items-center -space-x-1">
                    {choice.harnesses.slice(0, FOLD_GLYPHS).map((harness, position) => (
                      <FoldGlyph key={`${position}:${harness}`} harness={harness} live={false} rowSince={since} />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui text-foreground/90">{choice.title}</span>
                    <span className="block truncate text-label text-faint">{detail(choice, near)}</span>
                  </span>
                </button>
              </div>
            )
          })
        )}
      </div>
      {matching.length > SHOWN ? (
        <p className="border-t border-hairline px-3.5 py-1.5 text-label text-faint">Showing {SHOWN} of {matching.length}. Type to narrow the list.</p>
      ) : null}
    </DialogContent>
  )
}
