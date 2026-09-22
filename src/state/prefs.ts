import { z } from "zod"
import { terminalGroupSchema, type TerminalGroup } from "@/lib/terminal-layout"
import { SessionSettingsSchema, SettingsPreferenceSchema, type SessionSettings, type SettingsPreference } from "@mako/sessions/settings"
import { createHook, createStore } from "@/state/store"
import { threadFolderKey } from "@/lib/thread-folders"

/**
 * Durable UI preferences. Written through a microtask-batched save so that
 * dragging a panel divider does not hit localStorage on every frame.
 */

export type Theme = "dark" | "light" | "system"
export type OceanTone = "ink" | "moon"

/** What the left rail is showing: your conversations, or the project. */
export type RailMode = "threads" | "agents" | "files"

/** How the session rail is scoped and grouped, mirroring ORCA's sidebar model. */
export type RailScope = "workspace" | "all"
export type RailSortBy = "recent" | "created" | "name"

interface PreferenceStringMap {
  [key: string]: string
}

/** Dragged companion-card widths, keyed by surface id. */
interface SurfaceWidthMap {
  [surfaceId: string]: number
}

export interface Prefs {
  oceanTone: OceanTone
  oceanMotion: boolean
  soundEnabled: boolean
  soundVolume: number
  theme: Theme
  railOpen: boolean
  railWidth: number
  /** Dragged companion-card widths, per surface id — a spatial habit. */
  surfaceWidths: SurfaceWidthMap
  surfaceHeights: SurfaceWidthMap
  /** What the right-sidebar toggle reopens. Tab ids don't survive a relaunch. */
  lastCompanion: string | null
  /** `provider/id` keys, most recent first. */
  favoriteModels: string[]
  recentModels: string[]
  /** The ordered pick list ⌃⌘1–5 selects — provider and model id, ≤5. */
  modelLoadout: { harness: string; model: string }[]
  showThinking: boolean
  denseTools: boolean
  railMode: RailMode
  railScope: RailScope
  railSortBy: RailSortBy
  railGrouping: "project" | "recent" | "status" | "archived"
  /**
   * When you last worked in each folder (a prompt sent, a thread started),
   * by folder key. The only thing that lifts a folder in the rail.
   */
  folderUse: PreferenceStringMap
  providerModes: PreferenceStringMap
  /**
   * Enter during a running turn steers it when the provider can; Cmd/Ctrl+Enter
   * then queues for after the turn. Off swaps the two.
   */
  steerOnEnter: boolean
  collapsedGroups: string[]
  collapsedDirs: string[]
  /** Folders open in the project tree. Keys are folded paths, not path prefixes. */
  openDirs: string[]
  autoOpenDiff: boolean
  selectedDiffs: PreferenceStringMap
  /** Threads kept at the top of both rails, by session path. */
  pinnedThreads: string[]
  pinnedProjects: string[]
  /** Harnesses shown in the Agents rail. Empty means all of them. */
  agentHarnessFilter: string[]
  /** The composer's chosen agent, kept across launches. */
  composerHarness?: string
  /** Intentional new-thread defaults; migrated values retain their uncertain origin. */
  providerSettings: Record<string, SettingsPreference>
  /** Pending selections scoped to a workspace draft or a single conversation. */
  settingsOverrides: Record<string, SessionSettings>
  keybindings: PreferenceStringMap
  terminalFontSize: number
  terminalFontFamily: string
  terminalGroups: TerminalGroup[]
  terminalPaneSizes: SurfaceWidthMap
  terminalOptionAsMeta: "auto" | "on" | "off"
  /**
   * How a conversation moves to another harness. Transcript replay is the
   * loss-aware default; session import is the compatibility path for stores
   * that accept synthesized history.
   */
  conversionMode: "native" | "transcript"
  /** Your names for threads, by path — native stores don't take renames. */
  titleOverrides: PreferenceStringMap
  /** Dismissed saved-message occurrences; presentation only, never delivery state. */
  dismissedRecoveryRequests: PreferenceStringMap
  /** Your names for persistent terminal sessions, by daemon id. */
  terminalTitles: PreferenceStringMap
  /** Overrides the host's default commit-drafting prompt. */
  commitPrompt?: string
  commitModel?: string
  externalEditor?: string
  /** Desktop banners while Mako is in the background. */
  notifyDesktop: boolean
  /** Which outcomes interrupt: an answer ready, an agent needing you, a failed run. */
  notifyReady: boolean
  notifyAsk: boolean
  notifyFailed: boolean
  /** Threads with something unseen, counted on the app icon. */
  badgeCount: boolean
}

const KEY = "mako.prefs.v1"
const LEGACY_KEY = "pi.prefs.v1"

const defaults: Prefs = {
  oceanTone: "ink",
  oceanMotion: true,
  soundEnabled: false,
  soundVolume: 0.25,
  theme: "dark",
  railOpen: true,
  railWidth: 264,
  surfaceWidths: {},
  surfaceHeights: {},
  lastCompanion: "changes",
  favoriteModels: [],
  recentModels: [],
  modelLoadout: [],
  showThinking: true,
  denseTools: false,
  railMode: "threads",
  railScope: "all",
  railSortBy: "recent",
  railGrouping: "project",
  folderUse: {},
  providerModes: {},
  steerOnEnter: true,
  collapsedGroups: [],
  collapsedDirs: [],
  openDirs: [],
  autoOpenDiff: true,
  selectedDiffs: {},
  pinnedThreads: [],
  pinnedProjects: [],
  agentHarnessFilter: [],
  providerSettings: {},
  settingsOverrides: {},
  keybindings: {},
  terminalFontSize: 12,
  terminalFontFamily: "",
  terminalGroups: [],
  terminalPaneSizes: {},
  terminalOptionAsMeta: "auto",
  titleOverrides: {},
  terminalTitles: {},
  dismissedRecoveryRequests: {},
  conversionMode: "transcript",
  notifyDesktop: true,
  notifyReady: true,
  notifyAsk: true,
  notifyFailed: true,
  badgeCount: true,
}

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = null | boolean | number | string | JsonObject | JsonValue[]
type StoredValue = JsonValue | undefined

function isJsonObject(value: StoredValue): value is JsonObject {
  return Object(value) === value && !Array.isArray(value)
}

function isJsonArray(value: StoredValue): value is JsonValue[] {
  return Array.isArray(value)
}

function isJsonString(value: StoredValue): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isJsonNumber(value: StoredValue): value is number {
  return (
    Object.prototype.toString.call(value) === "[object Number]" &&
    Number.isFinite(Number(value))
  )
}

function isJsonBoolean(value: StoredValue): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}

function readOptionalString(value: StoredValue): string | undefined {
  return isJsonString(value) ? value : undefined
}

function readComposerHarness(value: StoredValue): string | undefined {
  const harness = readOptionalString(value)
  return harness === "pi" ? "devin" : harness
}

function readNumber(value: StoredValue, fallback: number): number {
  return isJsonNumber(value) ? value : fallback
}

function readBoolean(value: StoredValue, fallback: boolean): boolean {
  return isJsonBoolean(value) ? value : fallback
}

function readChoice<const Choice extends string>(
  value: StoredValue,
  choices: readonly Choice[],
  fallback: Choice
): Choice {
  if (!isJsonString(value)) return fallback
  return choices.find((choice) => choice === value) ?? fallback
}

function readStringList(value: StoredValue, fallback: string[]): string[] {
  if (!isJsonArray(value) || !value.every(isJsonString)) return fallback
  return value
}

function readLoadout(value: StoredValue): { harness: string; model: string }[] {
  if (!isJsonArray(value)) return []
  return value.flatMap((entry) =>
    isJsonObject(entry) &&
    isJsonString(entry.harness) &&
    isJsonString(entry.model)
      ? [{ harness: entry.harness, model: entry.model }]
      : []
  )
}

function readNumberRecord(value: StoredValue): SurfaceWidthMap {
  if (!isJsonObject(value)) return {}
  const record: SurfaceWidthMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonNumber(entry)) record[key] = entry
  }
  return record
}

function readStringRecord(value: StoredValue): PreferenceStringMap {
  if (!isJsonObject(value)) return {}
  const record: PreferenceStringMap = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonString(entry)) record[key] = entry
  }
  return record
}

function readTuningOptions(
  value: StoredValue
): Record<string, string | boolean> | undefined {
  if (!isJsonObject(value)) return undefined
  const options: Record<string, string | boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonString(entry) || isJsonBoolean(entry)) options[key] = entry
  }
  return options
}

function readProviderSettings(value: StoredValue, legacy: StoredValue): Prefs["providerSettings"] {
  const result: Prefs["providerSettings"] = {}
  if (isJsonObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const parsed = SettingsPreferenceSchema.safeParse(entry)
      if (parsed.success) result[key] = parsed.data
    }
    return result
  }
  if (!isJsonObject(legacy)) return result
  for (const [key, entry] of Object.entries(legacy)) {
    if (!isJsonObject(entry)) continue
    const options = readTuningOptions(entry.options) ?? {}
    const effort = readOptionalString(entry.effort)
    if (effort !== undefined && options.effort === undefined) options.effort = effort
    if (isJsonBoolean(entry.fast) && options.fast === undefined && options.serviceTier === undefined) {
      options.fast = entry.fast
    }
    result[key] = { source: "legacy", settings: { model: readOptionalString(entry.model), options } }
  }
  return result
}

function readSettingsOverrides(value: StoredValue): Prefs["settingsOverrides"] {
  if (!isJsonObject(value)) return {}
  const result: Prefs["settingsOverrides"] = {}
  for (const [key, entry] of Object.entries(value)) {
    const parsed = SessionSettingsSchema.safeParse(entry)
    if (parsed.success) result[key] = parsed.data
  }
  return result
}

/** One-shot migration from the inspector-era width and open state. */
function readSurfaceWidths(value: JsonObject): SurfaceWidthMap {
  const stored = readNumberRecord(value.surfaceWidths)
  if (Object.keys(stored).length > 0) return stored
  const seeded: SurfaceWidthMap = {}
  if (isJsonNumber(value.inspectorWidth)) seeded.changes = value.inspectorWidth
  return seeded
}

function readLastCompanion(value: JsonObject): string | null {
  if (isJsonString(value.lastCompanion)) return value.lastCompanion
  if (value.lastCompanion === null || value.inspectorOpen === false) return null
  if (isJsonString(value.inspectorTab)) return value.inspectorTab
  return defaults.lastCompanion
}

function parsePrefs(value: JsonValue): Prefs | null {
  if (!isJsonObject(value)) return null
  const prefs: Prefs = {
    oceanTone: readChoice(value.oceanTone, ["ink", "moon"], defaults.oceanTone),
    oceanMotion: readBoolean(value.oceanMotion, defaults.oceanMotion),
    soundEnabled: readBoolean(value.soundEnabled, defaults.soundEnabled),
    soundVolume: Math.max(
      0,
      Math.min(1, readNumber(value.soundVolume, defaults.soundVolume))
    ),
    theme: readChoice(value.theme, ["dark", "light", "system"], defaults.theme),
    railOpen: readBoolean(value.railOpen, defaults.railOpen),
    railWidth: readNumber(value.railWidth, defaults.railWidth),
    surfaceWidths: readSurfaceWidths(value),
    surfaceHeights: readNumberRecord(value.surfaceHeights),
    lastCompanion: readLastCompanion(value),
    favoriteModels: readStringList(
      value.favoriteModels,
      defaults.favoriteModels
    ),
    recentModels: readStringList(value.recentModels, defaults.recentModels),
    modelLoadout: readLoadout(value.modelLoadout),
    showThinking: readBoolean(value.showThinking, defaults.showThinking),
    denseTools: readBoolean(value.denseTools, defaults.denseTools),
    railMode: readChoice(
      value.railMode,
      ["threads", "agents", "files"],
      defaults.railMode
    ),
    railScope: readChoice(
      value.railScope,
      ["workspace", "all"],
      defaults.railScope
    ),
    railSortBy: readChoice(
      value.railSortBy,
      ["recent", "created", "name"],
      defaults.railSortBy
    ),
    collapsedGroups: readStringList(
      value.collapsedGroups,
      defaults.collapsedGroups
    ),
    collapsedDirs: readStringList(value.collapsedDirs, defaults.collapsedDirs),
    openDirs: readStringList(value.openDirs, defaults.openDirs),
    autoOpenDiff: readBoolean(value.autoOpenDiff, defaults.autoOpenDiff),
    selectedDiffs: readStringRecord(value.selectedDiffs),
    pinnedThreads: readStringList(value.pinnedThreads, defaults.pinnedThreads),
    pinnedProjects: readStringList(
      value.pinnedProjects,
      defaults.pinnedProjects
    ),
    agentHarnessFilter: readStringList(
      value.agentHarnessFilter,
      defaults.agentHarnessFilter
    ),
    composerHarness: readComposerHarness(value.composerHarness),
    railGrouping: readChoice(value.railGrouping, ["project", "recent", "status", "archived"], defaults.railGrouping),
    folderUse: readStringRecord(value.folderUse),
    providerModes: readStringRecord(value.providerModes),
    steerOnEnter: readBoolean(value.steerOnEnter, defaults.steerOnEnter),
    providerSettings: readProviderSettings(value.providerSettings, value.composerTuning),
    settingsOverrides: readSettingsOverrides(value.settingsOverrides),
    keybindings: readStringRecord(value.keybindings),
    terminalFontSize: Math.min(24, Math.max(10, readNumber(value.terminalFontSize, defaults.terminalFontSize))),
    terminalFontFamily: (readOptionalString(value.terminalFontFamily) ?? "").slice(0, 200),
    terminalGroups: z.array(terminalGroupSchema).max(24).catch([]).parse(value.terminalGroups),
    terminalPaneSizes: readNumberRecord(value.terminalPaneSizes),
    terminalOptionAsMeta: readChoice(
      value.terminalOptionAsMeta,
      ["auto", "on", "off"],
      defaults.terminalOptionAsMeta
    ),
    conversionMode: readChoice(
      value.conversionMode,
      ["native", "transcript"],
      defaults.conversionMode
    ),
    titleOverrides: readStringRecord(value.titleOverrides),
    terminalTitles: readStringRecord(value.terminalTitles),
    dismissedRecoveryRequests: readStringRecord(value.dismissedRecoveryRequests),
    commitPrompt: readOptionalString(value.commitPrompt),
    commitModel: readOptionalString(value.commitModel),
    externalEditor: readOptionalString(value.externalEditor),
    notifyDesktop: readBoolean(value.notifyDesktop, defaults.notifyDesktop),
    notifyReady: readBoolean(value.notifyReady, defaults.notifyReady),
    notifyAsk: readBoolean(value.notifyAsk, defaults.notifyAsk),
    notifyFailed: readBoolean(value.notifyFailed, defaults.notifyFailed),
    badgeCount: readBoolean(value.badgeCount, defaults.badgeCount),
  }

  // The rail redesigned around showing every folder; a "workspace" scope
  // persisted under the old design would silently narrow it. One flip.
  if (value.railScopeMigrated !== true) prefs.railScope = "all"
  if (value.transcriptReplayDefaultMigrated !== true) {
    prefs.conversionMode = "transcript"
  }
  return prefs
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)
    if (!raw) return defaults
    const parsed: JsonValue = JSON.parse(raw)
    return parsePrefs(parsed) ?? defaults
  } catch {
    return defaults
  }
}

export const prefsStore = createStore<Prefs>(load())
export const usePrefs = createHook(prefsStore)

let queued = false
let receiving = false
globalThis.window?.addEventListener?.("storage", (event) => {
  if (event.key !== KEY || !event.newValue) return
  try {
    const value: JsonValue = JSON.parse(event.newValue)
    const next = parsePrefs(value)
    if (!next) return
    receiving = true
    prefsStore.set({ providerModes: next.providerModes, providerSettings: next.providerSettings, settingsOverrides: next.settingsOverrides, dismissedRecoveryRequests: next.dismissedRecoveryRequests })
  } catch {
    return
  } finally {
    receiving = false
  }
})
prefsStore.subscribe(() => {
  if (queued || receiving) return
  queued = true
  queueMicrotask(() => {
    queued = false
    try {
      const stored = {
        ...prefsStore.get(),
        railScopeMigrated: true,
        transcriptReplayDefaultMigrated: true,
        openCodeProviderDefaultMigrated: true,
      }
      localStorage.setItem(KEY, JSON.stringify(stored))
    } catch {
      // A full or disabled store is not worth interrupting the session for.
    }
  })
})

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  prefsStore.set((prefs) => ({ ...prefs, [key]: value }))
}

/**
 * Every preference that is a switch, derived rather than listed.
 *
 * The list used to be written out by hand, so adding a boolean preference and
 * then trying to toggle it was a type error in an unrelated file — which is
 * exactly the kind of friction that ends with someone reaching past the helper.
 */
// `-?` matters: an optional preference makes its mapped value `K | undefined`,
// and `undefined` is not a key.
type BooleanPref = {
  [K in keyof Prefs]-?: Prefs[K] extends boolean ? K : never
}[keyof Prefs]

/** Pin or unpin a thread by its session path, newest pin first. */
export function togglePinned(path: string) {
  const current = prefsStore.get().pinnedThreads
  setPref(
    "pinnedThreads",
    current.includes(path)
      ? current.filter((entry) => entry !== path)
      : [path, ...current]
  )
}

export function togglePinnedProject(path: string) {
  const current = prefsStore.get().pinnedProjects
  setPref(
    "pinnedProjects",
    current.includes(path)
      ? current.filter((entry) => entry !== path)
      : [path, ...current]
  )
}

/** How many folders' last use is remembered; older ones fall back to their threads' times. */
const FOLDER_USE_LIMIT = 64

/**
 * You worked in `cwd`: a prompt went out or a thread started there. This is
 * the one event that moves a folder in the rail's Projects view, so agent
 * output never reshuffles the list under you.
 */
export function noteFolderUse(
  cwd: string | undefined,
  at = new Date().toISOString()
) {
  const key = threadFolderKey({ cwd })
  if (!key) return
  const current = prefsStore.get().folderUse
  if ((current[key] ?? "") >= at) return
  const kept = Object.entries({ ...current, [key]: at })
    .sort((left, right) => right[1].localeCompare(left[1]))
    .slice(0, FOLDER_USE_LIMIT)
  setPref("folderUse", Object.fromEntries(kept))
}

export function togglePref(key: BooleanPref) {
  setPref(key, !prefsStore.get()[key])
}

export function toggleGroupCollapsed(key: string) {
  const current = prefsStore.get().collapsedGroups
  prefsStore.set({
    collapsedGroups: current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [...current, key],
  })
}

export function modelKey(provider: string, id: string) {
  return `${provider}/${id}`
}

export function toggleFavoriteModel(key: string) {
  const current = prefsStore.get().favoriteModels
  prefsStore.set({
    favoriteModels: current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [key, ...current],
  })
}

export function noteModelUse(key: string) {
  const current = prefsStore.get().recentModels.filter((entry) => entry !== key)
  prefsStore.set({ recentModels: [key, ...current].slice(0, 8) })
}

/** Apply the resolved theme class to <html>. Returns a disposer. */
export function bindTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: light)")
  const paint = () => {
    const { theme } = prefsStore.get()
    const light = theme === "light" || (theme === "system" && media.matches)
    document.documentElement.classList.toggle("light", light)
    document.documentElement.style.colorScheme = light ? "light" : "dark"
  }
  paint()
  const off = prefsStore.subscribe(paint)
  media.addEventListener("change", paint)
  return () => {
    off()
    media.removeEventListener("change", paint)
  }
}
