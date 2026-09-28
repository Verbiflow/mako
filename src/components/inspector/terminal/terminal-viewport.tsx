import { ContextMenu } from "radix-ui"
import { terminalGroupFor } from "@/lib/terminal-layout"
import { createHook } from "@/state/store"
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { TerminalSession } from "@/lib/types"
import { terminalActions, terminalStore } from "@/state/terminal"
import { dockButton } from "./dock-tab-style"
import { useTerminalRenderer } from "./use-terminal-renderer"

const useTerminal = createHook(terminalStore)
const menuItem =
  "cursor-default rounded px-2 py-1.5 text-ui outline-none data-[highlighted]:bg-fill-hover data-[disabled]:text-faint"
/** A notice across the foot of the pane, square to its edges. */
const bar =
  "absolute inset-x-0 bottom-0 flex h-10 items-center gap-3 border-t border-hairline bg-shell pr-1.5 pl-3 text-ui"
const searchTool =
  "pressable flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-fill-hover hover:text-foreground [&_svg]:size-4"

/** What the person selected, handed to the draft as a terminal attachment beside what they have written. */
function attachSelection(session: TerminalSession, selection: string): void {
  const label = `${session.title || "Terminal"} selection`
  window.dispatchEvent(
    new CustomEvent("mako:attach", {
      detail: {
        files: [{ file: new File([`${selection}\n`], `${label}.txt`, { type: "text/plain" }), contextLabel: label, origin: "terminal" }],
        text: (reference: string) => reference,
      },
    })
  )
}

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
            className={cn(
              "terminal-viewport h-full bg-terminal py-2.5 pr-1 pl-3 transition-opacity duration-150",
              split && !focused && "opacity-55"
            )}
          >
            {/* The fit addon measures the host's box without its padding, so the padding lives outside it. */}
            <div ref={hostRef} className="h-full" />
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              focus()
            }}
            className="overlay-panel z-50 min-w-44 p-1"
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
              onSelect={() => attachSelection(session, selection)}
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
        <div role="status" className={cn(bar, "z-20 text-muted-foreground")}>
          {clipboardError}
        </div>
      ) : null}
      {fault ? (
        <div role="alert" className={cn(bar, "z-20")}>
          <span className="min-w-0 flex-1 truncate text-negative">{fault}</span>
          <button
            type="button"
            onClick={() => terminalActions.resync(session.id)}
            className={dockButton("plain")}
          >
            Reconnect
          </button>
        </div>
      ) : null}
      {searching ? (
        <div className="dock-alert absolute top-0 right-0 z-20 flex h-9 w-[min(24rem,100%)] items-stretch border-b border-l border-hairline bg-shell">
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            placeholder="Find"
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
            className="min-w-0 flex-1 bg-transparent px-3 text-ui text-foreground placeholder:text-faint focus:outline-none"
          />
          <button
            type="button"
            aria-label="Previous result"
            onClick={() => findPrevious()}
            className={searchTool}
          >
            <ChevronUpIcon />
          </button>
          <button
            type="button"
            aria-label="Next result"
            onClick={() => findNext()}
            className={searchTool}
          >
            <ChevronDownIcon />
          </button>
          <button
            type="button"
            aria-label="Close terminal search"
            onClick={closeSearch}
            className={searchTool}
          >
            <XIcon />
          </button>
        </div>
      ) : null}
      {selection ? (
        <button
          type="button"
          onClick={() => attachSelection(session, selection)}
          className={cn(dockButton("plain"), "dock-alert absolute right-3 bottom-3 z-10 bg-shell")}
        >
          Add to message
        </button>
      ) : null}
      {session.status !== "running" ? (
        <div className={cn(bar, "dock-alert z-10")}>
          <span className="min-w-0 flex-1 truncate">
            {session.status === "interrupted" ? (
              <span className="text-caution">Shell stopped. Its scrollback was restored.</span>
            ) : (
              <>
                <span className="text-foreground">Shell exited</span>
                {session.exitCode === undefined ? null : (
                  <span className={session.exitCode ? "text-negative" : "text-muted-foreground"}>
                    {` with code ${session.exitCode}`}
                  </span>
                )}
              </>
            )}
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
            className={dockButton("plain")}
          >
            New shell
          </button>
        </div>
      ) : null}
    </div>
  )
}
