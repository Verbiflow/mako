import { z } from "zod"
import { attachmentReference } from "@/lib/attachment-references"
import type { Attachment } from "@/lib/attachments"
import { getMako } from "@/lib/bridge"
import { actions } from "@/state/session"
import { createHook, createStore } from "@/state/store"
import { stage } from "@/state/stage"
import type { AppCheckStepView, AppCheckView, AppMark, AppOutputKey, AppPrepareView, AppProbeView, AppProcessView, ThreadAppView } from "../../electron/contracts/thread-app"
import type { ProjectAppSetup } from "../../electron/contracts/project-app"

/**
 * A folder's app, as the strip and the terminal dock show it. Keyed by the
 * checkout. A driver (the host, or the fixture desk's simulation) supplies
 * the views and carries out the actions; without one, nothing here shows.
 */

export type {
  AppCheckStepView,
  AppCheckView,
  AppMark,
  AppOutputKey,
  AppPhase,
  AppPrepareView,
  AppProbeView,
  AppProcessView,
  ThreadAppView,
} from "../../electron/contracts/thread-app"

/** Starts, restarts and full checks run the folder's picked target (`targetOf`), for a recipe with targets. */
export interface ThreadAppDriver {
  start(cwd: string): void
  stop(cwd: string): void
  restart(cwd: string): void
  /** `steps` runs only those of a check's named steps. */
  runCheck(cwd: string, tier: "quick" | "full", steps?: string[]): void
  /** Stop the other apps counted in `room`, then start this one. */
  makeRoom(cwd: string): void
  /** Stop the copy named in `elsewhere`, then start this one. */
  takeTurn(cwd: string): void
  /** Everything the output holds now, to hand to an agent. */
  readOutput(cwd: string, key: AppOutputKey): Promise<string>
  /** The output as it grows: first all of it so far, then what's added. `reset` means start over. */
  subscribeOutput(cwd: string, key: AppOutputKey, listener: (text: string, reset: boolean) => void): () => void
  /** Keep the app in this folder current while something shows it. */
  watch?(cwd: string): () => void
  /** Keep every checkout's mark current while the sidebar shows them. */
  watchMarks?(): () => void
  /** A project's recipe written out, with its credentials files, for Settings. */
  setup?(root: string): Promise<ProjectAppSetup>
  /** The person's answer on those files: new Threads get all of them, or none. */
  allowSecrets?(root: string, allow: boolean): Promise<ProjectAppSetup>
  /** What the app touches outside its checkout and ports, as an agent's app_probe sees it. */
  probe?(cwd: string): Promise<AppProbeView>
}

/** A folder's last look outside its checkout, kept while another look is under way. */
export interface AppProbeState {
  looking: boolean
  view?: AppProbeView
  error?: string
}

interface ThreadAppState {
  byCwd: Record<string, ThreadAppView>
  /** The sidebar's marks: every checkout whose app isn't stopped. */
  marks: Record<string, AppMark>
  /** Folders whose view the driver keeps current now; any other view may be old. */
  followed: string[]
  /** The app output in the terminal dock instead of a shell, if any. */
  shown?: { cwd: string; key: AppOutputKey }
  /** Projects whose people said the strip shouldn't offer setup, by root. */
  hidden: string[]
  /** The target each folder last picked to run, for a recipe with targets. */
  targets: Record<string, string>
  /** Each folder's look outside its checkout, by checkout. */
  probes: Record<string, AppProbeState>
}

const HIDDEN_KEY = "mako.thread-app-hidden.v1"
const TARGETS_KEY = "mako.thread-app-target.v1"

function readTargets(): Record<string, string> {
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(localStorage.getItem(TARGETS_KEY) ?? "{}"))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function readHidden(): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]"))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export const threadAppStore = createStore<ThreadAppState>({ byCwd: {}, marks: {}, followed: [], hidden: readHidden(), targets: readTargets(), probes: {} })
export const useThreadApp = createHook(threadAppStore)

export function putAppMarks(marks: readonly AppMark[]): void {
  const next = Object.fromEntries(marks.map((mark) => [mark.checkout, mark]))
  const current = threadAppStore.get().marks
  const same = Object.keys(next).length === Object.keys(current).length &&
    marks.every((mark) => current[mark.checkout]?.state === mark.state && current[mark.checkout]?.port === mark.port)
  if (!same) threadAppStore.set({ marks: next })
}

/**
 * A checkout's mark. The strip's own view of a folder, polled closely while
 * it shows, wins over the sidebar's slower look, so the two never disagree.
 */
export function appMarkOf(state: ThreadAppState, checkout: string): Omit<AppMark, "checkout"> | undefined {
  const view = state.followed.includes(checkout) ? state.byCwd[checkout] : undefined
  if (view?.kind !== "ready") return view ? undefined : state.marks[checkout]
  if (view.phase === "stopped") return undefined
  if (view.phase !== "running") return { state: view.phase === "preparing" ? "starting" : view.phase }
  const port = view.processes.find((process) => process.state === "running" && process.port !== undefined)?.port
  return port === undefined ? { state: "running" } : { state: "running", port }
}

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

/** A look this recent stands when the menu opens again; Look again takes a new one. */
const PROBE_FRESH_MS = 15_000

/** Look at what the folder's app touches outside its checkout, unless a look is under way or, without `again`, recent. */
export function probeThreadApp(cwd: string, { again = false } = {}): void {
  const probe = driver?.probe
  const current = threadAppStore.get().probes[cwd]
  if (!probe || current?.looking) return
  if (!again && current?.view && !current.error && Date.now() - current.view.at < PROBE_FRESH_MS) return
  const put = (next: AppProbeState) => threadAppStore.set((state) => ({ probes: { ...state.probes, [cwd]: next } }))
  put({ ...current, looking: true })
  probe(cwd).then(
    (view) => put({ looking: false, view }),
    (error) => {
      const failed: AppProbeState = { looking: false, error: error instanceof Error ? error.message : String(error) }
      if (current?.view) failed.view = current.view
      put(failed)
    }
  )
}

export function hideSetupFor(root: string): void {
  saveHidden([...new Set([...threadAppStore.get().hidden, root])])
}

export function showSetupFor(root: string): void {
  saveHidden(threadAppStore.get().hidden.filter((hidden) => hidden !== root))
}

function saveHidden(hidden: string[]): void {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden))
  threadAppStore.set({ hidden })
}

/** The target a folder runs: the one last picked there while the recipe still has it, else the recipe's first. */
export function targetOf(state: ThreadAppState, cwd: string): string | undefined {
  const view = state.byCwd[cwd]
  const targets = view?.kind === "ready" ? view.targets : undefined
  if (!targets?.length) return view ? undefined : state.targets[cwd]
  const picked = state.targets[cwd]
  return picked !== undefined && targets.includes(picked) ? picked : targets[0]
}

export function pickTarget(cwd: string, target: string): void {
  const targets = { ...threadAppStore.get().targets, [cwd]: target }
  localStorage.setItem(TARGETS_KEY, JSON.stringify(targets))
  threadAppStore.set({ targets })
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

export function stepKey(tier: "quick" | "full", step: string): AppOutputKey {
  return `check:${tier}:${step}`
}

/** The tabs: every output there is, and of a check's steps, those that failed and the one shown. */
export function outputsOf(view: Extract<ThreadAppView, { kind: "ready" }>, shown?: AppOutputKey): { key: AppOutputKey; label: string; mark: Mark }[] {
  return [
    ...(view.prepare ? [{ key: "prepare" as const, label: "Install", mark: view.prepare.exit ? ("failed" as const) : ("running" as const) }] : []),
    ...view.processes
      .filter((process) => process.state !== "stopped" || process.exit)
      .map((process) => ({ key: processKey(process.name), label: process.name, mark: processMark(process) })),
    ...view.checks
      .filter((check) => check.state !== "never" || check.steps?.some((step) => step.state !== "never"))
      .flatMap((check) => [
        { key: `check:${check.tier}` as const, label: checkTitle(check.tier), mark: checkMark(check) },
        ...(check.steps ?? [])
          .filter((step) => step.state !== "never" && (step.state === "failed" || stepKey(check.tier, step.name) === shown))
          .map((step) => ({ key: stepKey(check.tier, step.name), label: step.name, mark: stepMark(step) })),
      ]),
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

export function stepMark(step: AppCheckStepView): Mark {
  return step.state === "passed" ? "done" : step.state === "failed" ? "failed" : step.state === "running" ? "running" : "waiting"
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

/** A check's failure is the whole check's, or with `step`, that step's alone. */
export type AppFailure = { process: AppProcessView } | { check: AppCheckView; step?: AppCheckStepView } | { prepare: AppPrepareView }

function failureKey(failed: AppFailure): AppOutputKey {
  if ("process" in failed) return processKey(failed.process.name)
  if ("check" in failed) return failed.step ? stepKey(failed.check.tier, failed.step.name) : `check:${failed.check.tier}`
  return "prepare"
}

function failureName(failed: AppFailure): string {
  if ("process" in failed) return failed.process.name
  if ("check" in failed) return failed.step ? `${checkTitle(failed.check.tier)} ${failed.step.name}` : checkTitle(failed.check.tier)
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
  } else if (failed.step) {
    what = `The ${failed.step.name} step of the ${checkTitle(failed.check.tier).toLowerCase()} (\`${failed.step.command}\`) failed.`
    ask = "Fix what it found and run that step again to show it passes."
  } else {
    const steps = failed.check.steps?.filter((step) => step.state === "failed")
    what = steps?.length
      ? `The ${name.toLowerCase()} failed at ${steps.map((step) => `${step.name} (\`${step.command}\`)`).join(" and ")}.`
      : `The ${name.toLowerCase()} (\`${failed.check.command}\`) failed.`
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
