import { ContextMenu } from "radix-ui"
import { terminalGroupFor } from "@/lib/terminal-layout"
import { createHook } from "@/state/store"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  QuoteIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { TerminalSession } from "@/lib/types"
import { terminalActions, terminalStore } from "@/state/terminal"
import { useTerminalRenderer } from "./use-terminal-renderer"

const useTerminal = createHook(terminalStore)
const menuItem =
  "cursor-default rounded px-2 py-1.5 text-label outline-none data-[highlighted]:bg-fill-hover data-[disabled]:text-faint"

export function TerminalViewport({
  session,
  active,
  focused,
  split,
}: {
  session: TerminalSession
  active: boolean
  focused: boolean
  split: boolean
}) {
  const {
    hostRef,
    searchInputRef,
    searching,
    query,
    selection,
    closeSearch,
    search,
    findNext,
    findPrevious,
    clipboardError,
    copy,
    paste,
    clear,
    selectAll,
    focus,
  } = useTerminalRenderer(session, active, focused)
  const canSplit = useTerminal(
    (state) =>
      !state.creating &&
      (terminalGroupFor(state.groups, session.id)?.sessionIds.length ?? 4) < 4
  )
  const fault = useTerminal((state) => state.faults[session.id])
  return (
    <div
      data-terminal-session={session.id}
      data-terminal-active={active}
      className={cn("relative min-h-0 min-w-0 flex-1", !active && "hidden")}
    >
      <ContextMenu.Root
        onOpenChange={(open) => {
          if (open) terminalActions.activate(session.id)
        }}
      >
        <ContextMenu.Trigger asChild>
          <div
            ref={hostRef}
            className={cn(
              "terminal-viewport h-full bg-surface px-3 py-2.5 font-mono transition-opacity duration-150",
              split && !focused && "opacity-55"
            )}
          />
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              focus()
            }}
            className="overlay-panel z-50 min-w-44 rounded-lg p-1"
          >
            <ContextMenu.Item
              disabled={!selection}
              className={menuItem}
              onSelect={() => void copy()}
            >
              Copy
            </ContextMenu.Item>
            <ContextMenu.Item
              disabled={session.status !== "running"}
              className={menuItem}
              onSelect={() => void paste()}
            >
              Paste
            </ContextMenu.Item>
            <ContextMenu.Item className={menuItem} onSelect={selectAll}>
              Select all
            </ContextMenu.Item>
            <ContextMenu.Item
              disabled={!selection}
              className={menuItem}
              onSelect={() =>
                window.dispatchEvent(
                  new CustomEvent("mako:compose", {
                    detail: { text: `\n\`\`\`text\n${selection}\n\`\`\`\n` },
                  })
                )
              }
            >
              Reference selection
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-hairline" />
            <ContextMenu.Item
              className={menuItem}
              disabled={!canSplit}
              onSelect={() =>
                void terminalActions.split("horizontal", session.id)
              }
            >
              Split right
            </ContextMenu.Item>
            <ContextMenu.Item
              className={menuItem}
              disabled={!canSplit}
              onSelect={() =>
                void terminalActions.split("vertical", session.id)
              }
            >
              Split down
            </ContextMenu.Item>
            {split ? (
              <ContextMenu.Item
                className={menuItem}
                onSelect={() => terminalActions.unsplit(session.id)}
              >
                Move to separate tab
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Item className={menuItem} onSelect={clear}>
              Clear scrollback
            </ContextMenu.Item>
            <ContextMenu.Item
              className={menuItem}
              onSelect={() => terminalActions.requestClose(session.id)}
            >
              Close terminal
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {clipboardError ? (
        <div
          role="status"
          className="absolute inset-x-2 bottom-2 z-20 rounded border border-hairline bg-surface px-2 py-1 text-label text-muted-foreground"
        >
          {clipboardError}
        </div>
      ) : null}
      {fault ? (
        <div
          role="alert"
          className="absolute inset-x-2 bottom-2 z-20 flex items-center gap-2 rounded border border-negative/30 bg-surface px-2 py-1 text-label text-negative"
        >
          <span className="min-w-0 flex-1">{fault}</span>
          <button
            type="button"
            onClick={() => terminalActions.resync(session.id)}
            className="pressable rounded px-2 py-1 hover:bg-fill-hover"
          >
            Reconnect
          </button>
        </div>
      ) : null}
      {searching ? (
        <div className="overlay-panel absolute top-2 right-3 left-3 z-20 ml-auto flex h-9 max-w-96 items-center gap-0.5 rounded-md p-1">
          <SearchIcon className="mx-1 size-3.5 text-faint" />
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            placeholder="Find in terminal…"
            aria-label="Find in terminal"
            onChange={(event) => search(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === "Enter") {
                event.preventDefault()
                if (event.shiftKey) findPrevious()
                else findNext()
              }
              if (event.key === "Escape") {
                event.preventDefault()
                closeSearch()
              }
            }}
            className="h-7 min-w-0 flex-1 rounded px-1 text-label text-foreground placeholder:text-faint focus:bg-raised focus:ring-1 focus:ring-hairline focus:outline-none"
          />
          <button
            type="button"
            aria-label="Previous result"
            onClick={() => findPrevious()}
            className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <ChevronUpIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next result"
            onClick={() => findNext()}
            className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close terminal search"
            onClick={closeSearch}
            className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
      {selection ? (
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("mako:compose", {
                detail: { text: `\n\`\`\`text\n${selection}\n\`\`\`\n` },
              })
            )
          }
          className="pressable overlay-panel absolute right-3 bottom-3 z-10 flex h-7 items-center gap-1.5 rounded-md px-2 text-label text-muted-foreground hover:text-foreground"
        >
          <QuoteIcon className="size-3" />
          Reference selection
        </button>
      ) : null}
      {session.status !== "running" ? (
        <div className="absolute bottom-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg bg-raised py-1 pr-1 pl-2.5 text-label text-muted-foreground [box-shadow:inset_0_0_0_0.5px_var(--hairline)]">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              session.status === "interrupted"
                ? "bg-caution"
                : session.exitCode
                  ? "bg-negative"
                  : "bg-faint"
            )}
          />
          <span className="min-w-0 truncate">
            {session.status === "interrupted"
              ? "Shell stopped · scrollback restored"
              : `Shell exited${session.exitCode === undefined ? "" : ` with code ${session.exitCode}`}`}
          </span>
          <button
            type="button"
            onClick={() =>
              void terminalActions.create(
                session.cwd,
                session.cols,
                session.rows
              )
            }
            className="pressable shrink-0 rounded-md px-2 py-0.5 text-foreground hover:bg-fill-hover"
          >
            New shell
          </button>
        </div>
      ) : null}
    </div>
  )
}
