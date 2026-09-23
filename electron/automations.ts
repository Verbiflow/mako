import { randomUUID } from "node:crypto"
import { watch, type FSWatcher } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { z } from "zod"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
import {
  automationTriggerAvailable,
  type Automation,
  type AutomationRun,
  type HostEvent,
} from "./shared.js"

/**
 * Saved prompts that can fire on their own.
 *
 * The triggers are chosen, not exhaustive, and the choices are worth stating:
 *
 *   * **Manual.** Always available. At minimum an automation is a prompt you
 *     do not have to retype, which is most of the value on its own.
 *   * **On file change**, matched by glob. This is the one people actually
 *     want — "when a migration lands, check the schema doc" — and it is the
 *     one that composes with an agent that edits files.
 *   * **On commit.** HEAD moving is the clearest "a unit of work finished"
 *     signal a repository has.
 *   * **External events.** Slack, Gmail, Calendar, and webhook definitions are
 *     preserved but cannot be enabled before their provider receiver exists.
 *
 * Deliberately **not** on a schedule. A desktop app that is closed cannot fire
 * one, so a scheduled automation is a promise the app cannot keep; and an app
 * that is open quietly running cron jobs against your repository is a surprise
 * nobody asked for. If it ever needs a schedule it needs a daemon, and that is
 * a different product decision.
 *
 * Everything here is off until switched on, one at a time. A file that arrives
 * with a repository must not start running an agent because you opened the
 * folder.
 */

/** Where they live: in the project, so they can be committed and shared. */
const FILE = join(".mako", "automations.json")

/**
 * The floor between two runs of the same automation.
 *
 * A file-change trigger watching a directory an agent is actively editing can
 * fire dozens of times a minute. This is not a nicety — without it, one
 * automation can spend real money in a loop.
 */
const MIN_INTERVAL_MS = 60_000

/** Editors write a file several times per save; wait for it to settle. */
const DEBOUNCE_MS = 1200
const OptionalTextSchema = z.string().max(500).optional()

interface Runtime {
  cwd: string
  watcher: FSWatcher | null
  timers: Map<string, NodeJS.Timeout>
  lastRun: Map<string, number>
  inFlight: Set<string>
  head: string | null
}

interface AutomationDocument {
  automations: Automation[]
}

let runtime: Runtime | null = null
let automations: Automation[] = []
let emit: (event: HostEvent) => void = () => {}
let launch:
  ((cwd: string, prompt: string, label: string) => Promise<void>) | null = null

export function automationList(): Automation[] {
  return automations
}

function publish() {
  emit({ type: "automations", automations })
}

export async function loadAutomations(cwd: string): Promise<Automation[]> {
  try {
    const document = parseAutomationDocument(
      await readFile(join(cwd, FILE), "utf8")
    )
    automations = document.automations
  } catch {
    automations = []
  }
  if (runtime?.cwd === cwd) syncFileWatcher(runtime)
  publish()
  return automations
}

export function parseAutomationDocument(text: string): AutomationDocument {
  const value: JsonValue = JSON.parse(text)
  if (!isJsonObject(value) || !Array.isArray(value.automations))
    return { automations: [] }

  const entries: Automation[] = []
  for (const entry of value.automations) {
    if (!isJsonObject(entry)) throw new Error("Invalid automation")
    entries.push(normalizeAutomation(entry))
  }
  return { automations: entries }
}

/**
 * A file from a repository is input, not configuration we wrote.
 *
 * `enabled` is forced off on load: an automation arrives from a checkout with
 * whatever the author set, and honouring that would mean cloning a repo could
 * start running an agent. Enabling is a local decision, held locally.
 */
export function normalizeAutomation(raw: JsonObject): Automation {
  return {
    id:
      String(raw.id ?? "").slice(0, 80) ||
      `a${Math.abs(hash(JSON.stringify(raw)))}`,
    name: String(raw.name ?? "Untitled").slice(0, 120),
    prompt: String(raw.prompt ?? "").slice(0, 8000),
    trigger: normalizeTrigger(raw),
    enabled: false,
  }
}

function normalizeTrigger(raw: JsonObject): Automation["trigger"] {
  const trigger = raw.trigger
  if (trigger === "files") return { kind: "files", paths: strings(raw.paths) }
  if (trigger === "commit") return { kind: "commit" }
  if (trigger === "manual" || !isJsonObject(trigger)) return { kind: "manual" }
  const kind = trigger.kind
  if (kind === "files") return { kind, paths: strings(trigger.paths) }
  if (kind === "commit" || kind === "manual") return { kind }
  if (kind === "slack") {
    const event = [
      "message_in_channel",
      "reaction_added",
      "channel_created",
    ].includes(String(trigger.event))
      ? trigger.event
      : "message_in_channel"
    return {
      kind,
      event:
        event === "reaction_added" || event === "channel_created"
          ? event
          : "message_in_channel",
      channels: strings(trigger.channels),
      messageFilter: optionalString(trigger.messageFilter),
    }
  }
  if (kind === "gmail") {
    return {
      kind,
      event: "message_received",
      from: strings(trigger.from),
      to: strings(trigger.to),
      subjectFilter: optionalString(trigger.subjectFilter),
      labels: strings(trigger.labels),
      hasAttachment: trigger.hasAttachment === true,
    }
  }
  if (kind === "google_calendar") {
    const event = String(trigger.event)
    return {
      kind,
      event:
        event === "event_updated" ||
        event === "event_cancelled" ||
        event === "event_starting_soon" ||
        event === "event_ended"
          ? event
          : "event_created",
      calendars: strings(trigger.calendars),
      titleFilter: optionalString(trigger.titleFilter),
    }
  }
  if (kind === "webhook") {
    return {
      kind,
      path: String(trigger.path ?? "").slice(0, 160),
    }
  }
  return { kind: "manual" }
}

function strings(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.slice(0, 40).map((entry) => String(entry).slice(0, 200))
    : []
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return OptionalTextSchema.catch(undefined).parse(value) || undefined
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function hash(text: string): number {
  let value = 0
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0
  }
  return value
}

export async function saveAutomations(
  cwd: string,
  next: Automation[]
): Promise<Automation[]> {
  automations = next
  if (runtime?.cwd === cwd) syncFileWatcher(runtime)
  publish()
  try {
    await mkdir(join(cwd, ".mako"), { recursive: true })
    // `enabled` is not written: it is a local decision about a shared file, and
    // committing it would switch the automation on for everyone who clones.
    const shared = next.map((entry) => ({ ...entry, enabled: undefined }))
    await writeFile(
      join(cwd, FILE),
      `${JSON.stringify({ automations: shared }, null, 2)}\n`,
      "utf8"
    )
  } catch {
    // A project we cannot write to still gets working automations in memory.
  }
  return automations
}

/** Enabling is per-machine and is not written to the shared file. */
export function setEnabled(id: string, enabled: boolean): Automation[] {
  automations = automations.map((entry) =>
    entry.id === id && (!enabled || automationTriggerAvailable(entry.trigger))
      ? { ...entry, enabled }
      : entry
  )
  if (runtime) syncFileWatcher(runtime)
  publish()
  return automations
}

/* ------------------------------------------------------------------ */
/* matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Glob matching, small on purpose.
 *
 * `**` crosses directories, `*` does not, `?` is one character. That is the
 * whole vocabulary — enough for `src/**\/*.ts` and `migrations/*.sql`, which is
 * what these patterns are for, and small enough to read in one sitting rather
 * than pulling in a matcher.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  let source = ""
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index] ?? ""
    if (char === "*" && pattern[index + 1] === "*") {
      // `**/` has to be able to match *no* directories, or `src/**/*.ts`
      // misses `src/session.ts` — which is the first thing anyone writes and
      // the first thing they would notice not working.
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?"
        index += 3
        continue
      }
      source += ".*"
      index += 2
      continue
    }
    if (char === "*") {
      source += "[^/]*"
      index += 1
      continue
    }
    if (char === "?") {
      source += "[^/]"
      index += 1
      continue
    }
    source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
    index += 1
  }
  try {
    return new RegExp(`^${source}$`).test(path)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* running                                                             */
/* ------------------------------------------------------------------ */

export function bindAutomations(
  send: (event: HostEvent) => void,
  run: (cwd: string, prompt: string, label: string) => Promise<void>
) {
  emit = send
  launch = run
}

/**
 * Fire one automation.
 *
 * Two guards, both about money rather than tidiness: an automation already
 * running does not start again, and one that ran a moment ago waits. A file
 * watcher pointed at a directory an agent is editing will otherwise re-trigger
 * on the agent's own output, which is a loop that bills.
 */
export async function fireAutomation(
  id: string,
  reason: AutomationRun["reason"]
): Promise<void> {
  const automation = automations.find((entry) => entry.id === id)
  const state = runtime
  if (!automation || !state || !launch) return
  if (reason !== "manual" && (!automation.enabled || automation.trigger.kind !== reason)) return
  if (state.inFlight.has(id)) return

  const last = state.lastRun.get(id) ?? 0
  if (reason !== "manual" && Date.now() - last < MIN_INTERVAL_MS) return

  state.inFlight.add(id)
  const runId = randomUUID()
  const startedAt = Date.now()
  state.lastRun.set(id, startedAt)
  emit({
    type: "automation-run",
    run: {
      runId,
      id,
      name: automation.name,
      reason,
      at: startedAt,
      status: "started",
    },
  })
  try {
    await launch(state.cwd, automation.prompt, automation.name)
    emit({
      type: "automation-run",
      run: {
        runId,
        id,
        name: automation.name,
        reason,
        at: Date.now(),
        status: "completed",
      },
    })
  } catch (error) {
    emit({
      type: "automation-run",
      run: {
        runId,
        id,
        name: automation.name,
        reason,
        at: Date.now(),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    })
  } finally {
    state.inFlight.delete(id)
  }
}

/**
 * Watch the workspace.
 *
 * One recursive watcher for the whole tree rather than one per pattern: the
 * patterns are matched here, and a watcher per rule would multiply the same
 * events by the number of rules. No subscription is needed until a file rule
 * is enabled; native watcher registration and close can block on the OS.
 */
export async function watchWorkspace(cwd: string) {
  stopWatching()
  const current: Runtime = {
    cwd,
    watcher: null,
    timers: new Map(),
    lastRun: new Map(),
    inFlight: new Set(),
    head: null,
  }
  runtime = current
  await loadAutomations(cwd)
}

function syncFileWatcher(current: Runtime): void {
  const enabled = new Set(automations.filter(entry => entry.enabled && entry.trigger.kind === "files").map(entry => entry.id))
  for (const [id, timer] of current.timers) {
    if (enabled.has(id)) continue
    clearTimeout(timer)
    current.timers.delete(id)
  }
  if (!enabled.size) {
    const watcher = current.watcher
    current.watcher = null
    watcher?.close()
    return
  }
  if (current.watcher) return

  try {
    const watcher: FSWatcher = watch(current.cwd, { recursive: true }, (_event, filename) => {
      if (!filename || runtime !== current || current.watcher !== watcher) return
      const path = relative(current.cwd, join(current.cwd, filename.toString()))
        .split(sep)
        .join("/")
      if (!path || isIgnored(path)) return

      for (const automation of automations) {
        if (!automation.enabled || automation.trigger.kind !== "files") continue
        if (!automation.trigger.paths.some((pattern) => matchesGlob(pattern, path)))
          continue
        // Debounced per automation: a save that touches four matching files is
        // one event, not four.
        clearTimeout(current.timers.get(automation.id))
        current.timers.set(
          automation.id,
          setTimeout(() => {
            current.timers.delete(automation.id)
            if (runtime === current && current.watcher === watcher)
              void fireAutomation(automation.id, "files")
          }, DEBOUNCE_MS)
        )
      }
    })
    current.watcher = watcher
  } catch {
    // Recursive watching is unavailable on some platforms and some volumes.
    // File triggers simply do not fire there; manual ones still work.
  }
}

/** Directories whose churn is never what a rule means. */
const IGNORED =
  /(^|\/)(\.git|node_modules|dist|dist-electron|release|build|out|\.next|coverage|\.turbo)(\/|$)/

function isIgnored(path: string): boolean {
  return IGNORED.test(path)
}

/**
 * Notice a commit.
 *
 * Driven by the git status the app already computes rather than a watcher of
 * its own — the app re-reads git after every turn and on focus, which is
 * exactly when HEAD could have moved.
 */
export function noticeHead(head: string | undefined) {
  if (!runtime || !head) return
  const previous = runtime.head
  runtime.head = head
  if (previous === null || previous === head) return
  for (const automation of automations) {
    if (automation.enabled && automation.trigger.kind === "commit") {
      void fireAutomation(automation.id, "commit")
    }
  }
}

export function stopWatching() {
  if (!runtime) return
  const previous = runtime
  runtime = null
  for (const timer of previous.timers.values()) clearTimeout(timer)
  previous.watcher?.close()
}
