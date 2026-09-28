import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { MessageSquareTextIcon, RotateCwIcon, XIcon } from "lucide-react"
import { AppMark } from "@/components/stage/app-control"
import { Action } from "@/components/ui/kit"
import { terminalTheme } from "@/lib/terminal-theme"
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
import { dockTab } from "./terminal/dock-tab-style"

/** The app's outputs as tabs at the head of the terminal dock, before the shells. */
export function AppOutputTabs({ cwd, shown }: { cwd: string | undefined; shown: AppOutputKey | undefined }) {
  const view = useThreadApp((state) => (cwd ? state.byCwd[cwd] : undefined))
  if (!cwd || view?.kind !== "ready") return null
  const outputs = outputsOf(view)
  if (!outputs.length) return null
  return (
    <>
      <div role="tablist" aria-label="The app's output" className="flex h-full shrink-0 items-stretch">
        {outputs.map((output) => (
          <div key={output.key} data-dock-tab className={dockTab(shown === output.key)}>
            <button
              type="button"
              role="tab"
              aria-selected={shown === output.key}
              data-app-output={output.key}
              onClick={() => showAppOutput(cwd, output.key)}
              className="flex h-full items-center gap-1.5"
            >
              <AppMark mark={output.mark} />
              {output.label}
            </button>
          </div>
        ))}
      </div>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 self-center bg-hairline" />
    </>
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
      <div ref={host} className="terminal-viewport min-h-0 flex-1 bg-surface px-3 py-2.5 font-mono" />
    </div>
  )
}

/** One line over a crashed process's or failed check's output, with the two things worth doing next. */
function FailureBar({ cwd, view, outputKey }: { cwd: string; view: ThreadAppView | undefined; outputKey: AppOutputKey }) {
  const failure = failureOf(view, outputKey)
  if (!failure) return null
  return (
    <div key={outputKey} role="alert" className="dock-alert flex h-10 shrink-0 items-center gap-2.5 border-b border-hairline bg-surface pr-2 pl-3">
      <span aria-hidden className="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-negative/15">
        <XIcon className="size-2.5 text-negative" strokeWidth={3} />
      </span>
      <p className="min-w-0 flex-1 truncate text-ui">
        <span className="font-medium text-foreground">{failure.title}</span>
        <span className="text-muted-foreground"> {failure.detail}</span>
      </p>
      <Action
        size="sm"
        tone="ghost"
        data-app-action="restart"
        onClick={() => {
          if ("process" in failure) threadAppDriver()?.restart(cwd)
          else threadAppDriver()?.runCheck(cwd, failure.check.tier)
        }}
      >
        <RotateCwIcon />
        {"process" in failure ? "Restart" : "Run again"}
      </Action>
      <Action size="sm" tone="solid" data-app-action="send-to-agent" onClick={() => sendToAgent(cwd, failure)}>
        <MessageSquareTextIcon />
        Ask the agent to fix it
      </Action>
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
      title: `${process.name} stopped`,
      detail: `with code ${process.exit.code}, ${formatDuration(process.exit.afterMs)} after it started`,
    }
  }
  if (key.startsWith("check:")) {
    const check = view.checks.find((entry) => `check:${entry.tier}` === key)
    if (check?.state !== "failed") return undefined
    return { check, title: `${checkTitle(check.tier)} failed`, detail: check.at ? formatAgo(check.at, Date.now()) : "" }
  }
  return undefined
}
