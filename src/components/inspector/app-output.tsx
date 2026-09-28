import { useEffect, useRef, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { Shimmer } from "@/components/ui/shimmer"
import { terminalTheme } from "@/lib/terminal-theme"
import { cn } from "@/lib/utils"
import { usePrefs } from "@/state/prefs"
import {
  checkTitle,
  formatAgo,
  formatDuration,
  outputsOf,
  sendToAgent,
  showAppOutput,
  threadAppDriver,
  useThreadApp,
  type AppOutputKey,
  type ThreadAppView,
} from "@/state/thread-app"
import { dockButton, dockTab } from "./terminal/dock-tab-style"

/** The app's outputs as tabs at the head of the terminal dock, before the shells. */
export function AppOutputTabs({ cwd, shown }: { cwd: string | undefined; shown: AppOutputKey | undefined }) {
  const view = useThreadApp((state) => (cwd ? state.byCwd[cwd] : undefined))
  if (!cwd || view?.kind !== "ready") return null
  const outputs = outputsOf(view)
  if (!outputs.length) return null
  return (
    <div role="tablist" aria-label="The app's output" className="flex h-full shrink-0 items-stretch">
      {outputs.map((output) => (
        <button
          key={output.key}
          type="button"
          role="tab"
          aria-selected={shown === output.key}
          data-dock-tab
          data-app-output={output.key}
          data-mark={output.mark}
          onClick={() => showAppOutput(cwd, output.key)}
          className={cn(
            dockTab(shown === output.key),
            output.mark === "failed" && "text-negative hover:text-negative",
            output.mark === "waiting" && "text-faint"
          )}
        >
          {output.mark === "running" ? <Shimmer text={output.label} /> : output.label}
        </button>
      ))}
    </div>
  )
}

/** What one of the app's processes or checks printed, read-only, in the terminal's own renderer. */
export function AppOutputView({ cwd, outputKey }: { cwd: string; outputKey: AppOutputKey }) {
  const host = useRef<HTMLDivElement>(null)
  const fontSize = usePrefs((prefs) => prefs.terminalFontSize)
  const fontFamily = usePrefs((prefs) => prefs.terminalFontFamily)
  const theme = usePrefs((prefs) => prefs.theme)
  const view = useThreadApp((state) => state.byCwd[cwd])

  useEffect(() => {
    const element = host.current
    const driver = threadAppDriver()
    if (!element || !driver) return
    const style = getComputedStyle(element)
    const terminal = new Terminal({
      disableStdin: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
      fontFamily: fontFamily || style.getPropertyValue("--font-mono"),
      fontSize,
      lineHeight: 1.4,
      scrollback: 5_000,
      convertEol: true,
      overviewRuler: { width: 8 },
      theme: terminalTheme(style),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    terminal.write("\x1b[?25l")
    terminal.write(driver.output(cwd, outputKey))
    const unsubscribe = driver.subscribeOutput(cwd, outputKey, (chunk) => terminal.write(chunk))
    const resize = new ResizeObserver(() => {
      if (element.isConnected && element.clientWidth > 0) fit.fit()
    })
    resize.observe(element)
    fit.fit()
    return () => {
      unsubscribe()
      resize.disconnect()
      terminal.dispose()
    }
  }, [cwd, outputKey, fontSize, fontFamily, theme])

  return (
    <div data-app-output-view={outputKey} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FailureBar cwd={cwd} view={view} outputKey={outputKey} />
      <div className="terminal-viewport min-h-0 flex-1 bg-terminal py-2.5 pr-1 pl-3">
        <div ref={host} className="h-full" />
      </div>
    </div>
  )
}

/** One line over a crashed process's or failed check's output, with the two things worth doing next. */
function FailureBar({ cwd, view, outputKey }: { cwd: string; view: ThreadAppView | undefined; outputKey: AppOutputKey }) {
  const failure = failureOf(view, outputKey)
  if (!failure) return null
  return <Failure key={`${outputKey}:${failure.at}`} cwd={cwd} failure={failure} />
}

function Failure({ cwd, failure }: { cwd: string; failure: NonNullable<ReturnType<typeof failureOf>> }) {
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    if (!asked) return
    const timer = setTimeout(() => setAsked(false), 2_400)
    return () => clearTimeout(timer)
  }, [asked])
  return (
    <div role="alert" className="dock-alert flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-terminal pr-2 pl-3">
      <p className="mr-2 min-w-0 flex-1 truncate text-ui">
        <span className="font-medium text-negative">{failure.title}</span>
        <span className="text-muted-foreground"> {failure.detail}</span>
      </p>
      <button
        type="button"
        data-app-action="restart"
        className={dockButton("plain")}
        onClick={() => {
          if ("process" in failure) threadAppDriver()?.restart(cwd)
          else threadAppDriver()?.runCheck(cwd, failure.check.tier)
        }}
      >
        {"process" in failure ? "Restart" : "Run again"}
      </button>
      <button
        type="button"
        data-app-action="send-to-agent"
        data-asked={asked || undefined}
        disabled={asked}
        className={cn(dockButton("primary"), "disabled:opacity-100 data-asked:bg-fill-selected data-asked:text-foreground")}
        onClick={() => {
          sendToAgent(cwd, failure)
          setAsked(true)
        }}
      >
        <span key={String(asked)} className="changing-label">
          {asked ? "Added to your message" : "Ask the agent to fix it"}
        </span>
      </button>
    </div>
  )
}

function failureOf(view: ThreadAppView | undefined, key: AppOutputKey) {
  if (view?.kind !== "ready") return undefined
  if (key.startsWith("process:")) {
    const process = view.processes.find((entry) => `process:${entry.name}` === key)
    if (!process?.exit || process.exit.code === 0) return undefined
    return {
      process,
      at: process.exit.at,
      title: `${process.name} stopped`,
      detail: `with code ${process.exit.code}, ${formatDuration(process.exit.afterMs)} after it started`,
    }
  }
  if (key.startsWith("check:")) {
    const check = view.checks.find((entry) => `check:${entry.tier}` === key)
    if (check?.state !== "failed") return undefined
    return { check, at: check.at, title: `${checkTitle(check.tier)} failed`, detail: check.at ? formatAgo(check.at, Date.now()) : "" }
  }
  return undefined
}
