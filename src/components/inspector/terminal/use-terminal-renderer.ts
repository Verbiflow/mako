import { useCallback, useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { WebLinksAddon } from "@xterm/addon-web-links"
import "@xterm/xterm/css/xterm.css"
import { desktop } from "@/state/desktop"
import { viewer } from "@/state/viewer"
import { detectMacOptionIsMeta } from "@/lib/mac-option-meta"
import { createTerminalFileLinks } from "@/lib/terminal-links"
import {
  createTerminalWriter,
  type TerminalWriter,
} from "@/lib/terminal-writer"
import { usePrefs } from "@/state/prefs"
import { createHook } from "@/state/store"
import {
  replayTerminalOutput,
  subscribeTerminalOutput,
  terminalActions,
  terminalStore,
  type TerminalOutput,
} from "@/state/terminal"
import type { TerminalSession } from "@/lib/types"
import { terminalTheme } from "@/lib/terminal-theme"
const useTerminal = createHook(terminalStore)

export function useTerminalRenderer(
  session: TerminalSession,
  visible: boolean,
  focused: boolean
) {
  const sessionId = session.id
  const sessionCwd = session.cwd
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const writerRef = useRef<TerminalWriter | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const lastSize = useRef<{ cols: number; rows: number } | undefined>(undefined)
  const resizeFrame = useRef<number | undefined>(undefined)
  const receivedSequence = useRef(0)
  const [rendererAttempt, setRendererAttempt] = useState(0)
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState("")
  const [selection, setSelection] = useState("")
  const [clipboardError, setClipboardError] = useState("")
  const snapshot = useTerminal((state) =>
    visible ? state.snapshots[session.id] : undefined
  )
  const fontSize = usePrefs((prefs) => prefs.terminalFontSize)
  const fontFamily = usePrefs((prefs) => prefs.terminalFontFamily)
  const theme = usePrefs((prefs) => prefs.theme)
  const optionAsMeta = usePrefs((prefs) => prefs.terminalOptionAsMeta)

  const fit = useCallback(() => {
    const terminal = terminalRef.current
    const addon = fitRef.current
    if (!terminal || !addon || !hostRef.current?.isConnected) return
    if (!hostRef.current.clientWidth || !hostRef.current.clientHeight) return
    const proposed = addon.proposeDimensions()
    if (!proposed || proposed.cols < 2 || proposed.rows < 1) return
    if (
      lastSize.current?.cols === proposed.cols &&
      lastSize.current.rows === proposed.rows
    )
      return
    const buffer = terminal.buffer.active
    const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY)
    addon.fit()
    if (distanceFromBottom === 0) terminal.scrollToBottom()
    else
      terminal.scrollToLine(
        Math.max(0, terminal.buffer.active.baseY - distanceFromBottom)
      )
    lastSize.current = { cols: terminal.cols, rows: terminal.rows }
    terminalActions.resize(terminal.cols, terminal.rows, sessionId)
  }, [sessionId])

  const writeOutput = useCallback(
    (output: TerminalOutput) => {
      if (output.sessionId !== sessionId) return
      if (output.sequence <= receivedSequence.current) return
      if (output.sequence !== receivedSequence.current + 1) {
        terminalActions.resync(sessionId)
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
    lastSize.current = undefined
    receivedSequence.current = 0
    const style = getComputedStyle(host)
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      fontFamily: style.getPropertyValue("--font-mono"),
      fontSize: 12,
      lineHeight: 1.4,
      scrollback: 5_000,
      allowTransparency: false,
      macOptionIsMeta: false,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      // xterm sizes its scrollbar from the overview ruler (14px otherwise).
      overviewRuler: { width: 8 },
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
        event.preventDefault()
        setSearching(true)
        requestAnimationFrame(() => searchInputRef.current?.focus())
        return false
      }
      return true
    })
    const selectionChange = terminal.onSelectionChange(() =>
      setSelection(terminal.getSelection())
    )
    let writeTimer: ReturnType<typeof setTimeout> | undefined
    let replaying = false
    const writer = createTerminalWriter({
      schedule: (flush) => {
        writeTimer = setTimeout(flush, 8)
      },
      write: (data, done) => terminal.write(data, done),
      replace: (data, done) => {
        const buffer = terminal.buffer.active
        const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY)
        replaying = true
        terminal.options.disableStdin = true
        terminal.reset()
        terminal.write(data, () => {
          replaying = false
          terminal.options.disableStdin = false
          if (distanceFromBottom > 0)
            terminal.scrollToLine(
              Math.max(0, terminal.buffer.active.baseY - distanceFromBottom)
            )
          done()
        })
      },
      onRendered: (sequence) =>
        terminalActions.acknowledge(sessionId, sequence),
      onError: () => {
        setRendererAttempt((attempt) => attempt + 1)
        terminalActions.resync(sessionId)
      },
    })
    writerRef.current = writer
    const input = terminal.onData((data) => {
      if (!replaying) terminalActions.write(data, sessionId)
    })
    const removeClipboard = installTerminalClipboard(host, terminal)
    const observer = new ResizeObserver(() => {
      if (resizeFrame.current !== undefined) return
      resizeFrame.current = requestAnimationFrame(() => {
        resizeFrame.current = undefined
        fit()
      })
    })
    observer.observe(host)
    fit()
    return () => {
      observer.disconnect()
      removeClipboard()
      if (resizeFrame.current !== undefined)
        cancelAnimationFrame(resizeFrame.current)
      resizeFrame.current = undefined
      input.dispose()
      selectionChange.dispose()
      if (writeTimer !== undefined) clearTimeout(writeTimer)
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
    const update = () => {
      terminal.options.theme = terminalTheme(getComputedStyle(host))
    }
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [theme, rendererAttempt])

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
  }, [optionAsMeta, rendererAttempt])

  useEffect(() => {
    if (!visible) return
    fit()
    let frame: number | undefined
    const recover = (force = false) => {
      if (!force && document.visibilityState === "hidden") return
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        fit()
        const terminal = terminalRef.current
        if (terminal) terminal.refresh(0, terminal.rows - 1)
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
      if (frame !== undefined) cancelAnimationFrame(frame)
      window.removeEventListener("focus", onVisibility)
      window.removeEventListener("pageshow", onVisibility)
      document.removeEventListener("visibilitychange", onVisibility)
      document.removeEventListener("keydown", onInteraction, true)
      document.removeEventListener("pointerdown", onInteraction, true)
    }
  }, [visible, fit])

  useEffect(() => {
    const writer = writerRef.current
    if (!writer || !snapshot) return
    receivedSequence.current = snapshot.sequence
    writer.replace({ data: snapshot.data, sequence: snapshot.sequence })
    replayTerminalOutput(sessionId, writeOutput)
  }, [snapshot, writeOutput, rendererAttempt, sessionId])

  useEffect(() => {
    if (visible) return subscribeTerminalOutput(sessionId, writeOutput)
  }, [visible, sessionId, writeOutput])

  useEffect(() => {
    if (!focused) return
    const show = () => {
      setSearching(true)
      requestAnimationFrame(() => searchInputRef.current?.focus())
    }
    window.addEventListener("mako:terminal-search", show)
    return () => window.removeEventListener("mako:terminal-search", show)
  }, [focused])

  useEffect(() => {
    const terminal = terminalRef.current
    const host = hostRef.current
    if (!terminal || !host) return
    terminal.options.fontSize = fontSize
    terminal.options.fontFamily =
      fontFamily || getComputedStyle(host).getPropertyValue("--font-mono")
    lastSize.current = undefined
    fit()
    let disposed = false
    void document.fonts.ready.then(() => {
      if (!disposed) {
        lastSize.current = undefined
        fit()
      }
    })
    return () => {
      disposed = true
    }
  }, [fontSize, fontFamily, fit, rendererAttempt])

  useEffect(() => {
    if (focused && document.activeElement?.getAttribute("role") !== "tab")
      terminalRef.current?.focus()
  }, [focused])

  const closeSearch = () => {
    setSearching(false)
    searchAddonRef.current?.clearDecorations()
    terminalRef.current?.focus()
  }
  const search = (next: string) => {
    setQuery(next)
    if (next) searchAddonRef.current?.findNext(next, { incremental: true })
    else searchAddonRef.current?.clearDecorations()
  }
  const findNext = () => {
    searchAddonRef.current?.findNext(query)
  }
  const findPrevious = () => {
    searchAddonRef.current?.findPrevious(query)
  }
  return {
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
    copy: async () => {
      try {
        await navigator.clipboard.writeText(
          terminalRef.current?.getSelection() ?? ""
        )
        setClipboardError("")
      } catch {
        setClipboardError(
          "Clipboard unavailable. Use your keyboard shortcut to copy."
        )
      }
    },
    paste: async () => {
      const terminal = terminalRef.current
      try {
        const text = await navigator.clipboard.readText()
        // Clipboard permission can settle after focus moves or the pane closes.
        if (
          terminal &&
          terminal === terminalRef.current &&
          terminalStore.get().activeId === sessionId
        ) {
          terminal.paste(text)
          terminal.focus()
          setClipboardError("")
        }
      } catch {
        setClipboardError(
          "Clipboard unavailable. Use your keyboard shortcut to paste."
        )
      }
    },
    clear: () => terminalRef.current?.clear(),
    selectAll: () => terminalRef.current?.selectAll(),
    focus: () => terminalRef.current?.focus(),
  }
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
