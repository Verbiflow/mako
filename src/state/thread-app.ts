import { z } from "zod"
import { attachmentReference } from "@/lib/attachment-references"
import type { Attachment } from "@/lib/attachments"
import { getMako } from "@/lib/bridge"
import { actions } from "@/state/session"
import { createHook, createStore } from "@/state/store"
import { stage } from "@/state/stage"
import type { AppCheckView, AppOutputKey, AppPrepareView, AppProcessView, ThreadAppView } from "../../electron/contracts/thread-app"

/**
 * A folder's app, as the strip and the terminal dock show it. Keyed by the
 * checkout. A driver (the host, or the fixture desk's simulation) supplies
 * the views and carries out the actions; without one, nothing here shows.
 */

export type {
  AppCheckView,
  AppOutputKey,
  AppPhase,
  AppPrepareView,
  AppProcessView,
  ThreadAppView,
} from "../../electron/contracts/thread-app"

export interface ThreadAppDriver {
  start(cwd: string): void
  stop(cwd: string): void
  restart(cwd: string): void
  runCheck(cwd: string, tier: "quick" | "full"): void
  /** Stop the other apps counted in `room`, then start this one. */
  makeRoom(cwd: string): void
  /** Everything the output holds now, to hand to an agent. */
  readOutput(cwd: string, key: AppOutputKey): Promise<string>
  /** The output as it grows: first all of it so far, then what's added. `reset` means start over. */
  subscribeOutput(cwd: string, key: AppOutputKey, listener: (text: string, reset: boolean) => void): () => void
  /** Keep the app in this folder current while something shows it. */
  watch?(cwd: string): () => void
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
    const parsed = z.array(z.string()).safeParse(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]"))
    return parsed.success ? parsed.data : []
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
    ...(view.prepare ? [{ key: "prepare" as const, label: "Install", mark: view.prepare.exit ? ("failed" as const) : ("running" as const) }] : []),
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
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}\u00a0GB` : `${Math.round(bytes / 1024 ** 2)}\u00a0MB`
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

export type AppFailure = { process: AppProcessView } | { check: AppCheckView } | { prepare: AppPrepareView }

function failureKey(failed: AppFailure): AppOutputKey {
  if ("process" in failed) return processKey(failed.process.name)
  if ("check" in failed) return `check:${failed.check.tier}`
  return "prepare"
}

function failureName(failed: AppFailure): string {
  if ("process" in failed) return failed.process.name
  if ("check" in failed) return checkTitle(failed.check.tier)
  return "Install"
}

/** What went wrong, what it printed, and what to ask for, worded once for every place it goes. */
async function failureReport(cwd: string, failed: AppFailure) {
  const output = (await driver?.readOutput(cwd, failureKey(failed)).catch(() => "")) ?? ""
  // Terminal colours and cursor codes mean nothing to the agent.
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "")
  const tail = plain.trimEnd().split("\n").slice(-400).join("\n")
  const name = failureName(failed)
  let what: string
  let ask: string
  if ("process" in failed) {
    const exit = failed.process.exit
    what = `The app's ${name} process stopped with code ${exit?.code ?? "unknown"}${exit ? `, ${formatDuration(exit.afterMs)} after it started` : ""}.`
    ask = "Find out why, fix it, and start the app again to show it stays up."
  } else if ("prepare" in failed) {
    what = `Installing before the app starts (\`${failed.prepare.command}\`) failed${failed.prepare.exit ? ` with code ${failed.prepare.exit.code}` : ""}, so the app didn't start.`
    ask = "Find out why, fix it, and start the app again to show it installs and stays up."
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
export async function sendToAgent(cwd: string, failed: AppFailure): Promise<void> {
  const report = await failureReport(cwd, failed)
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
  const report = await failureReport(cwd, failed)
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
