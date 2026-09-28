import { attachmentReference } from "@/lib/attachment-references"
import type { Attachment } from "@/lib/attachments"
import { getMako } from "@/lib/bridge"
import { actions } from "@/state/session"
import { createHook, createStore } from "@/state/store"
import { stage } from "@/state/stage"

/**
 * A Thread's own copy of its project's app, as the strip and the terminal
 * dock show it. Keyed by the Thread's checkout. A driver (the host, or the
 * fixture desk's simulation) supplies the views and carries out the actions;
 * without one, nothing here shows.
 */

export type AppPhase = "stopped" | "preparing" | "starting" | "running" | "crashed" | "waiting"

export interface AppProcessView {
  name: string
  state: "starting" | "running" | "exited" | "stopped"
  port?: number
  memoryBytes?: number
  exit?: { code: number | null; afterMs: number; at: number }
}

export interface AppCheckView {
  tier: "quick" | "full"
  command: string
  state: "never" | "running" | "passed" | "failed"
  at?: number
}

export interface SetupStepView {
  label: string
  state: "done" | "failed" | "running" | "waiting"
}

export type ThreadAppView =
  | { kind: "none"; project: string; root: string }
  | {
      kind: "setting-up"
      project: string
      thread: { title: string; harness: string }
      steps: SetupStepView[]
    }
  | {
      kind: "ready"
      project: string
      phase: AppPhase
      host: string
      port: number
      startedAt?: number
      processes: AppProcessView[]
      checks: AppCheckView[]
      prepare?: { command: string; reason: string }
      /** Set while waiting: the other Threads' apps that stopping would free. */
      room?: { apps: number; bytes: number }
    }

/** One output the dock can show: the install step, a process, or a check. */
export type AppOutputKey = "prepare" | `process:${string}` | `check:${"quick" | "full"}`

export interface ThreadAppDriver {
  start(cwd: string): void
  stop(cwd: string): void
  restart(cwd: string): void
  runCheck(cwd: string, tier: "quick" | "full"): void
  /** Stop the other Threads' apps counted in `room`, then start this one. */
  makeRoom(cwd: string): void
  openSetupThread(cwd: string): void
  output(cwd: string, key: AppOutputKey): string
  subscribeOutput(cwd: string, key: AppOutputKey, listener: (chunk: string) => void): () => void
}

interface ThreadAppState {
  byCwd: Record<string, ThreadAppView>
  /** The app output in the terminal dock instead of a shell, if any. */
  shown?: { cwd: string; key: AppOutputKey }
  /** Projects whose people said the strip shouldn't offer setup, by root. */
  hidden: string[]
}

const HIDDEN_KEY = "mako.thread-app-hidden.v1"

function readHidden(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]")
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

export const threadAppStore = createStore<ThreadAppState>({ byCwd: {}, hidden: readHidden() })
export const useThreadApp = createHook(threadAppStore)

let driver: ThreadAppDriver | undefined

export function installThreadAppDriver(next: ThreadAppDriver): void {
  driver = next
}

export function threadAppDriver(): ThreadAppDriver | undefined {
  return driver
}

export function putThreadApp(cwd: string, view: ThreadAppView | undefined): void {
  threadAppStore.set((state) => {
    const byCwd = { ...state.byCwd }
    if (view) byCwd[cwd] = view
    else delete byCwd[cwd]
    return { byCwd }
  })
}

export function hideSetupFor(root: string): void {
  const hidden = [...new Set([...threadAppStore.get().hidden, root])]
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden))
  threadAppStore.set({ hidden })
}

/** Put one of the app's outputs in the terminal dock, opening it if needed. */
export function showAppOutput(cwd: string, key: AppOutputKey): void {
  threadAppStore.set({ shown: { cwd, key } })
  stage.openDock("terminal")
}

export function hideAppOutput(): void {
  if (threadAppStore.get().shown) threadAppStore.set({ shown: undefined })
}

export function processKey(name: string): AppOutputKey {
  return `process:${name}`
}

export function outputsOf(view: Extract<ThreadAppView, { kind: "ready" }>): { key: AppOutputKey; label: string; mark: Mark }[] {
  return [
    ...(view.phase === "preparing" && view.prepare ? [{ key: "prepare" as const, label: "Install", mark: "running" as const }] : []),
    ...view.processes
      .filter((process) => process.state !== "stopped" || process.exit)
      .map((process) => ({ key: processKey(process.name), label: process.name, mark: processMark(process) })),
    ...view.checks
      .filter((check) => check.state !== "never")
      .map((check) => ({ key: `check:${check.tier}` as const, label: checkTitle(check.tier), mark: checkMark(check) })),
  ]
}

/** The one mark every row uses: done, failed, working, or not yet. */
export type Mark = "done" | "failed" | "running" | "waiting" | "live"

export function processMark(process: AppProcessView): Mark {
  if (process.exit && process.exit.code !== 0) return "failed"
  if (process.state === "running") return "live"
  if (process.state === "starting") return "running"
  return "waiting"
}

export function checkMark(check: AppCheckView): Mark {
  return check.state === "passed" ? "done" : check.state === "failed" ? "failed" : check.state === "running" ? "running" : "waiting"
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return `${hours} h ago`
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`
}

export function checkTitle(tier: "quick" | "full"): string {
  return tier === "quick" ? "Quick check" : "Full check"
}

export type AppFailure = { process: AppProcessView } | { check: AppCheckView }

/** What went wrong, what it printed, and what to ask for, worded once for every place it goes. */
function failureReport(cwd: string, failed: AppFailure) {
  const key = "process" in failed ? processKey(failed.process.name) : (`check:${failed.check.tier}` as const)
  const output = driver?.output(cwd, key) ?? ""
  // Terminal colours and cursor codes mean nothing to the agent.
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "")
  const tail = plain.trimEnd().split("\n").slice(-400).join("\n")
  const name = "process" in failed ? failed.process.name : checkTitle(failed.check.tier)
  let what: string
  let ask: string
  if ("process" in failed) {
    const exit = failed.process.exit
    what = `The app's ${name} process stopped with code ${exit?.code ?? "unknown"}${exit ? `, ${formatDuration(exit.afterMs)} after it started` : ""}.`
    ask = "Find out why, fix it, and start the app again to show it stays up."
  } else {
    what = `The ${name.toLowerCase()} (\`${failed.check.command}\`) failed.`
    ask = "Fix what it found and run the check again to show it passes."
  }
  return {
    file: `${name} output.txt`,
    label: `${name} output`,
    output: `${tail}\n`,
    prompt: (reference: string) => `${what} What it printed is in ${reference}. ${ask}`,
    /** For anywhere outside Mako, where a staged file's path means nothing: the output goes inline. */
    standalone: () => {
      const fence = "`".repeat(Math.max(3, ...Array.from(tail.matchAll(/`+/g), (run) => run[0].length + 1)))
      return `${what} What it printed:\n\n${fence}text\n${tail}\n${fence}\n\n${ask}`
    },
  }
}

/**
 * Hand a crashed process's or failed check's output to the Thread's agent: the
 * output goes in as an attached file, the composer gets one sentence that
 * names it, and nothing is sent until the person sends it.
 */
export function sendToAgent(cwd: string, failed: AppFailure): void {
  const report = failureReport(cwd, failed)
  window.dispatchEvent(new CustomEvent("mako:attach", {
    detail: {
      files: [{ file: new File([report.output], report.file, { type: "text/plain" }), contextLabel: report.label, origin: "terminal" }],
      text: report.prompt,
    },
  }))
}

/**
 * The same request on the clipboard, to paste into any chat or anywhere else.
 * Pasted into a Mako composer it comes back as the attached output; pasted
 * elsewhere it is the sentence with the output written out.
 */
export async function copyAppFailure(cwd: string, failed: AppFailure, { notify = true } = {}): Promise<boolean> {
  const report = failureReport(cwd, failed)
  const bytes = new TextEncoder().encode(report.output)
  const staged = await getMako()
    .stageFile(report.file, btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")))
    .catch(() => null)
  if (!staged) return actions.copy(report.standalone(), { notify })
  const attachment: Attachment = {
    id: crypto.randomUUID(), index: 1, name: report.file, contextLabel: report.label, origin: "terminal",
    mimeType: "text/plain", kind: "text", size: bytes.length, stagedPath: staged.path,
  }
  return actions.copy(report.prompt(attachmentReference(attachment)), {
    attachments: [attachment],
    plainText: report.standalone(),
    notify,
  })
}
