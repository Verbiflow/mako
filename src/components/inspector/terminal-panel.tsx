import { useCallback, useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  QuoteIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalSquareIcon,
  XIcon,
} from "lucide-react"
import { Blank } from "@/components/ui/kit"
import { cn } from "@/lib/utils"
import { desktop } from "@/state/desktop"
import { detectMacOptionIsMeta } from "@/lib/mac-option-meta"
import { createTerminalFileLinks } from "@/lib/terminal-links"
import {
  createTerminalWriter,
  type TerminalWriter,
} from "@/lib/terminal-writer"
import { prefsStore, setPref, usePrefs } from "@/state/prefs"
import { useWorkspaceFocus } from "@/components/stage/workspace-focus-context"
import { createHook } from "@/state/store"
import { viewer } from "@/state/viewer"
import {
  replayTerminalOutput,
  subscribeTerminalOutput,
  terminalActions,
  terminalStore,
  type TerminalOutput,
} from "@/state/terminal"
import type { TerminalSession } from "@/lib/types"

const useTerminal = createHook(terminalStore)

export function TerminalPanel() {
  const { cwd } = useWorkspaceFocus()
  const phase = useTerminal((state) => state.phase)
  const sessions = useTerminal((state) => state.sessions)
  const activeId = useTerminal((state) => state.activeId)
  const fault = useTerminal((state) => state.fault)
  const titles = usePrefs((prefs) => prefs.terminalTitles)
  const active = sessions.find((session) => session.id === activeId)

  useEffect(() => terminalActions.mount(), [])
  useEffect(() => {
    if (cwd) void terminalActions.ensureWorkspace(cwd)
  }, [cwd, phase])

  if (phase === "connecting" && sessions.length === 0) {
    return (
      <Blank
        icon={<TerminalSquareIcon />}
        title="Connecting to terminals"
        body="The local terminal service is starting. Existing shells will reattach automatically."
      />
    )
  }

  if (phase === "error" && sessions.length === 0) {
    return (
      <Blank
        icon={<TerminalSquareIcon />}
        title="Terminal unavailable"
        body={fault ?? "The local terminal service disconnected."}
        action={
          <Action
            label="Retry"
            onClick={() => void terminalActions.refresh()}
          />
        }
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center border-b border-hairline">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex h-9 min-w-max items-center px-1">
            {sessions.map((session) => (
              <SessionTab
                key={session.id}
                session={session}
                title={titles[session.id] ?? session.title}
                active={session.id === activeId}
                onSelect={() => terminalActions.activate(session.id)}
                onClose={() => void terminalActions.kill(session.id)}
              />
            ))}
          </div>
        </div>
        {active ? (
          <button
            type="button"
            title="Search terminal"
            aria-label="Search terminal"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("mako:terminal-search"))
            }
            className="pressable flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <SearchIcon className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          title="New terminal"
          disabled={!cwd}
          onClick={() => cwd && void terminalActions.create(cwd)}
          className="pressable mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-faint hover:bg-fill-hover hover:text-foreground disabled:opacity-40"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>

      {active ? (
        <TerminalViewport key={active.id} session={active} />
      ) : (
        <Blank
          icon={<TerminalSquareIcon />}
          title="No terminals"
          body="Start a shell in the current workspace. It will keep running if this window closes."
          action={
            cwd ? (
              <Action
                label="New terminal"
                onClick={() => void terminalActions.create(cwd)}
              />
            ) : undefined
          }
        />
      )}

      {fault && active ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-negative/30 bg-negative/10 px-2.5 py-1.5 text-label text-negative">
          <span className="min-w-0 flex-1 truncate">{fault}</span>
          <button
            type="button"
            onClick={() => void terminalActions.refresh()}
            className="pressable flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-negative/10"
          >
            <RefreshCwIcon className="size-3" />
            Reconnect
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SessionTab({
  session,
  title,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalSession
  title: string
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const save = () => {
    const next = draft.trim()
    const titles = { ...prefsStore.get().terminalTitles }
    if (next && next !== session.title) titles[session.id] = next
    else delete titles[session.id]
    setPref("terminalTitles", titles)
    setEditing(false)
  }
  return (
    <div
      className={cn(
        "group flex h-7 max-w-44 items-center rounded-md text-label",
        active
          ? "bg-fill-selected text-foreground"
          : "text-faint hover:text-muted-foreground"
      )}
    >
      <span
        className={cn(
          "mr-1.5 ml-2 size-1.5 shrink-0 rounded-full",
          session.status === "running"
            ? "bg-positive"
            : session.status === "interrupted"
              ? "bg-caution"
              : "bg-faint"
        )}
      />
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") save()
            if (event.key === "Escape") setEditing(false)
          }}
          onBlur={save}
          className="mx-1 h-5 min-w-20 flex-1 rounded bg-background/40 px-1 text-label text-foreground focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.stopPropagation()
            setDraft(title)
            setEditing(true)
          }}
          className="h-full min-w-0 flex-1 truncate text-left"
        >
          {title}
        </button>
      )}
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={onClose}
        className="pressable mr-1 flex size-4 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-background/40 focus:opacity-100"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

function TerminalViewport({ session }: { session: TerminalSession }) {
  const sessionId = session.id
  const sessionCwd = session.cwd
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const writerRef = useRef<TerminalWriter | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const resizeFrame = useRef<number | undefined>(undefined)
  const receivedSequence = useRef(0)
  const [rendererAttempt, setRendererAttempt] = useState(0)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const [selection, setSelection] = useState("")
  const snapshot = useTerminal((state) =>
    state.activeId === session.id ? state.snapshot : undefined
  )
  const theme = usePrefs((prefs) => prefs.theme)
  const optionAsMeta = usePrefs((prefs) => prefs.terminalOptionAsMeta)

  const fit = useCallback(() => {
    const terminal = terminalRef.current
    const addon = fitRef.current
    if (!terminal || !addon || !hostRef.current?.isConnected) return
    const buffer = terminal.buffer.active
    const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY)
    addon.fit()
    if (distanceFromBottom === 0) terminal.scrollToBottom()
    else
      terminal.scrollToLine(
        Math.max(0, terminal.buffer.active.baseY - distanceFromBottom)
      )
    terminalActions.resize(terminal.cols, terminal.rows)
  }, [])

  const writeOutput = useCallback(
    (output: TerminalOutput) => {
      if (output.sessionId !== sessionId) return
      if (output.sequence <= receivedSequence.current) return
      if (output.sequence !== receivedSequence.current + 1) {
        terminalActions.resync()
        return
      }
      receivedSequence.current = output.sequence
      writerRef.current?.push(output)
    },
    [sessionId]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const style = getComputedStyle(host)
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: style.getPropertyValue("--font-mono"),
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5_000,
      allowTransparency: true,
      macOptionIsMeta: false,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      theme: terminalTheme(style),
    })
    const addon = new FitAddon()
    const searchAddon = new SearchAddon()
    terminal.loadAddon(addon)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(
      new WebLinksAddon(
        (_event, uri) => void openTerminalLink(sessionCwd, uri),
        // The addon adds `g` itself (`new RegExp(source, flags + "g")`); a
        // global regex here made every link hover throw "Invalid flags 'gg'".
        { urlRegex: /\b(?:https?:\/\/|file:\/\/\/)[^\s"'<>]+/ }
      )
    )
    terminal.registerLinkProvider(
      createTerminalFileLinks(terminal, (link) => {
        const prefix = `${sessionCwd.replace(/\/$/, "")}/`
        const path = link.path.startsWith(prefix)
          ? link.path.slice(prefix.length)
          : link.path
        if (path.startsWith("/")) void desktop.revealPath(path)
        else void viewer.open(path, link.line)
      })
    )
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = addon
    searchAddonRef.current = searchAddon
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        !event.isComposing &&
        event.type === "keydown" &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f"
      ) {
        setSearching(true)
        return false
      }
      return true
    })
    const selectionChange = terminal.onSelectionChange(() =>
      setSelection(terminal.getSelection())
    )
    const writer = createTerminalWriter({
      write: (data, done) => terminal.write(data, done),
      replace: (data, done) => {
        terminal.reset()
        terminal.write(data, done)
      },
      onRendered: (sequence) =>
        terminalActions.acknowledge(sessionId, sequence),
      onError: () => {
        setRendererAttempt((attempt) => attempt + 1)
        terminalActions.resync()
      },
    })
    writerRef.current = writer
    const input = terminal.onData((data) => terminalActions.write(data))
    const removeClipboard = installTerminalClipboard(host, terminal)
    const observer = new ResizeObserver(() => {
      if (resizeFrame.current !== undefined)
        cancelAnimationFrame(resizeFrame.current)
      resizeFrame.current = requestAnimationFrame(fit)
    })
    observer.observe(host)
    fit()
    terminal.focus()
    return () => {
      observer.disconnect()
      removeClipboard()
      if (resizeFrame.current !== undefined)
        cancelAnimationFrame(resizeFrame.current)
      input.dispose()
      selectionChange.dispose()
      writer.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      searchAddonRef.current = null
      writerRef.current = null
    }
  }, [fit, rendererAttempt, sessionCwd, sessionId])

  useEffect(() => {
    const host = hostRef.current
    const terminal = terminalRef.current
    if (!host || !terminal) return
    terminal.options.theme = terminalTheme(getComputedStyle(host))
  }, [theme])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    if (optionAsMeta !== "auto") {
      terminal.options.macOptionIsMeta = optionAsMeta === "on"
      return
    }
    let cancelled = false
    void detectMacOptionIsMeta().then((enabled) => {
      if (!cancelled) terminal.options.macOptionIsMeta = enabled
    })
    return () => {
      cancelled = true
    }
  }, [optionAsMeta])

  useEffect(() => {
    const recover = (force = false) => {
      if (!force && document.visibilityState === "hidden") return
      requestAnimationFrame(() => {
        fit()
        const terminal = terminalRef.current
        if (terminal) terminal.refresh(0, terminal.rows - 1)
        terminalActions.resync()
      })
    }
    const onVisibility = () => recover()
    const onInteraction = () => {
      if (document.visibilityState === "hidden") recover(true)
    }
    window.addEventListener("focus", onVisibility)
    window.addEventListener("pageshow", onVisibility)
    document.addEventListener("visibilitychange", onVisibility)
    document.addEventListener("keydown", onInteraction, true)
    document.addEventListener("pointerdown", onInteraction, true)
    return () => {
      window.removeEventListener("focus", onVisibility)
      window.removeEventListener("pageshow", onVisibility)
      document.removeEventListener("visibilitychange", onVisibility)
      document.removeEventListener("keydown", onInteraction, true)
      document.removeEventListener("pointerdown", onInteraction, true)
    }
  }, [fit])

  useEffect(() => {
    const writer = writerRef.current
    if (!writer || !snapshot) return
    receivedSequence.current = snapshot.sequence
    writer.replace({ data: snapshot.data, sequence: snapshot.sequence })
    replayTerminalOutput(writeOutput)
  }, [snapshot, writeOutput])

  useEffect(() => subscribeTerminalOutput(writeOutput), [writeOutput])

  useEffect(() => {
    const show = () => {
      setSearching(true)
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
    window.addEventListener("mako:terminal-search", show)
    return () => window.removeEventListener("mako:terminal-search", show)
  }, [])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={hostRef} className="h-full bg-surface p-2 font-mono" />
      {searching ? (
        <div className="overlay-panel absolute top-2 right-3 z-20 flex h-8 items-center gap-0.5 rounded-md p-1">
          <SearchIcon className="mx-1 size-3.5 text-faint" />
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            placeholder="Search terminal"
            onChange={(event) => {
              const next = event.target.value
              setQuery(next)
              if (next)
                searchAddonRef.current?.findNext(next, { incremental: true })
              else searchAddonRef.current?.clearDecorations()
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                if (event.shiftKey) searchAddonRef.current?.findPrevious(query)
                else searchAddonRef.current?.findNext(query)
              }
              if (event.key === "Escape") {
                event.preventDefault()
                setSearching(false)
                searchAddonRef.current?.clearDecorations()
                terminalRef.current?.focus()
              }
            }}
            className="h-6 w-48 rounded px-1 text-ui text-foreground placeholder:text-faint focus:bg-raised focus:ring-1 focus:ring-hairline focus:outline-none"
          />
          <button
            type="button"
            aria-label="Previous result"
            onClick={() => searchAddonRef.current?.findPrevious(query)}
            className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <ChevronUpIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next result"
            onClick={() => searchAddonRef.current?.findNext(query)}
            className="pressable flex size-6 items-center justify-center rounded text-faint hover:bg-fill-hover hover:text-foreground"
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close terminal search"
            onClick={() => {
              setSearching(false)
              searchAddonRef.current?.clearDecorations()
              terminalRef.current?.focus()
            }}
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
        <div className="absolute inset-x-2 bottom-2 flex items-center justify-between rounded-md border border-hairline bg-raised px-2.5 py-1.5 text-label text-muted-foreground">
          <span>
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
            className="pressable rounded px-1.5 py-0.5 text-foreground hover:bg-background/30"
          >
            New shell
          </button>
        </div>
      ) : null}
    </div>
  )
}

function installTerminalClipboard(
  host: HTMLElement,
  terminal: Terminal
): () => void {
  const copy = (event: ClipboardEvent) => {
    const selection = terminal.getSelection()
    if (!selection || !event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData("text/plain", selection)
  }
  const paste = (event: ClipboardEvent) => {
    const text =
      event.clipboardData?.getData("text/plain") ??
      event.clipboardData?.getData("text") ??
      ""
    if (!text) return
    event.preventDefault()
    event.stopPropagation()
    terminal.paste(text)
  }
  host.addEventListener("copy", copy, true)
  host.addEventListener("paste", paste, true)
  return () => {
    host.removeEventListener("copy", copy, true)
    host.removeEventListener("paste", paste, true)
  }
}

async function openTerminalLink(cwd: string, uri: string): Promise<void> {
  if (!uri.startsWith("file://")) {
    await desktop.openUrl(uri)
    return
  }
  try {
    const path = decodeURIComponent(new URL(uri).pathname)
    const prefix = `${cwd.replace(/\/$/, "")}/`
    if (path.startsWith(prefix)) {
      await viewer.open(path.slice(prefix.length))
    } else {
      await desktop.revealPath(path)
    }
  } catch {
    return
  }
}

function terminalTheme(style: CSSStyleDeclaration) {
  return {
    background: style.getPropertyValue("--surface"),
    foreground: style.getPropertyValue("--foreground"),
    cursor: style.getPropertyValue("--foreground"),
    cursorAccent: style.getPropertyValue("--surface"),
    selectionBackground: style.getPropertyValue("--fill-selected"),
    black: style.getPropertyValue("--background"),
    brightBlack: style.getPropertyValue("--faint"),
    white: style.getPropertyValue("--muted-foreground"),
    brightWhite: style.getPropertyValue("--foreground"),
    red: style.getPropertyValue("--negative"),
    brightRed: style.getPropertyValue("--removed"),
    green: style.getPropertyValue("--positive"),
    brightGreen: style.getPropertyValue("--added"),
    yellow: style.getPropertyValue("--caution"),
    brightYellow: style.getPropertyValue("--caution"),
    blue: style.getPropertyValue("--muted-foreground"),
    brightBlue: style.getPropertyValue("--foreground"),
    cyan: style.getPropertyValue("--muted-foreground"),
    brightCyan: style.getPropertyValue("--foreground"),
    magenta: style.getPropertyValue("--muted-foreground"),
    brightMagenta: style.getPropertyValue("--foreground"),
  }
}

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable mt-1 rounded-md bg-raised px-2.5 py-1.5 text-ui font-medium text-foreground hover:bg-foreground/15"
    >
      {label}
    </button>
  )
}
