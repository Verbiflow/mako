/**
 * The Appshot shortcut: a global key that captures the window the person
 * is in and drops it into the conversation they last had open in Mako.
 *
 * The desktop client holds the shortcut (it is the process that owns the
 * screen); the desk decides whether it is on and which keys, keeps that in
 * its preferences, and tells its client (`mako:appshot-shortcut`). When it
 * fires, the client tells the window the person last used
 * (`appshot-shortcut` event), which captures through the host and shows
 * what happened (`mako:appshot-feedback`).
 */
import { MACOS_DEFAULT_SHORTCUTS, systemShortcutOn, type SystemShortcut } from "./macos-shortcuts.js"

/** A modifier whose two keys pressed together are the shortcut. */
export type AppshotModifier = "shift" | "command" | "option" | "control"

export type AppshotShortcut =
  /** Both keys of a modifier pair at once, which apps can't register: the default is both Shift keys. */
  | { kind: "modifiers"; modifier: AppshotModifier }
  /** A chord in the desk's spelling (`mod+shift+2`, `extend/commands.ts`). */
  | { kind: "keys"; chord: string }

export type AppshotShortcutState =
  | { state: "off" }
  | { state: "on"; shortcut: AppshotShortcut }
  /**
   * The system or another app holds the keys, or the helper couldn't start;
   * `clash` says which when the client could tell. `later` when the keys
   * were held and a later check found them taken: the client let them go,
   * and holds them again once a check finds them free.
   */
  | { state: "refused"; reason: string; clash?: ChordClash; later?: boolean }
  /** This client can't hold a global shortcut (a browser tab, another platform). */
  | { state: "unavailable"; reason: string }

/**
 * Why a key combination can't be the Appshot shortcut. Only what can be
 * known before a press is here: another app that registered the keys the
 * usual way (every hot key library does) can't be seen, which the Settings
 * recorder covers by whether the keys reach Mako at all.
 */
export type ChordClash =
  /** An everyday command, how text is typed, or no modifier: refused before anything is asked. */
  | { by: "rule"; reason: string }
  /** One of macOS's own shortcuts, turned on; `name` is null for one System Settings doesn't name. */
  | { by: "macos"; name: string | null }
  /** Held for itself by macOS or another app: a registration would succeed and never fire. */
  | { by: "held" }

/**
 * What the client knows of the shortcut since it was set, for Settings and
 * Diagnostics: it pushes this to every window (`appshot-shortcut-watch`)
 * whenever a check, a press or the state changes it. Measured and designed
 * in docs/audits/2026-10-12/appshot-shortcut-clashes.md, "Taken later".
 */
export interface AppshotShortcutWatch {
  /** What the client holds now, which a later check can change. */
  state: AppshotShortcutState
  /** The latest checks of a chord, newest first, at most `WATCH_CHECKS`. */
  checks: AppshotShortcutCheck[]
  /** When the next check is due, if one is waiting or armed. */
  next: number | null
  /** What is watched while the keys are held: System Settings' shortcuts (their file, or its folder until it exists) and apps coming to the front. */
  watching: { preferences: "file" | "folder" | "off"; activations: boolean }
  /** The last press the client heard, and the app that came to the front right after it, if one did. */
  press: { at: number; evidence: AppshotPressEvidence | null } | null
  /** Another app that came to the front right after a press of these keys, until a later press says otherwise or the keys change. */
  evidence: AppshotPressEvidence | null
}

export const WATCH_CHECKS = 5

/** Why a chord was checked: when it was set, or when something could have taken it since. */
export type AppshotCheckReason = "set" | "asked" | "preferences" | "wake" | "unlock" | "active" | "hourly"

export interface AppshotShortcutCheck {
  at: number
  reason: AppshotCheckReason
  /** `busy`: the keys' modifiers were held, so nothing was registered and it is tried again. */
  result: "clear" | "clash" | "busy" | "failed"
  clash?: ChordClash
  ms: number
}

/** An app that came to the front right after a press: the one sign that it reacts to the same keys. */
export interface AppshotPressEvidence {
  app: string
  bundleId: string | null
  pid: number
  /** How long after the press. */
  afterMs: number
  /** The keys pressed, in the desk's spelling, or the pair. */
  shortcut: AppshotShortcut
}

export const DEFAULT_APPSHOT_SHORTCUT: AppshotShortcut = { kind: "modifiers", modifier: "shift" }

/** A rectangle in screen points from the top-left of the main display. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * What the client shows outside the desk while Mako is behind the window
 * that was captured: a flash over that window, then a card in the corner of
 * its display. The desk sends its own colours, so the card wears the theme
 * the person chose.
 */
export interface AppshotFeedback {
  /** One capture's card; a later phase with the same id updates it. */
  id: string
  phase: "capturing" | "added" | "failed"
  app: string
  title: string
  /** The captured window; the flash covers it and the card sits on its display. */
  bounds?: ScreenRect
  /** `data:` URLs. */
  icon?: string
  thumbnail?: string
  /** The conversation the capture went into. */
  destination?: string
  /** Why it failed, in a sentence. */
  message?: string
  colors?: { surface: string; text: string; muted: string; border: string; font: string }
}

export const MODIFIER_NAMES = {
  shift: "Shift",
  command: "Command",
  option: "Option",
  control: "Control",
} as const satisfies Record<AppshotModifier, string>

export const MODIFIER_GLYPHS = {
  shift: "⇧",
  command: "⌘",
  option: "⌥",
  control: "⌃",
} as const satisfies Record<AppshotModifier, string>

const NAMED_KEYS = new Map(Object.entries({
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  enter: "Return",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  space: "Space",
  " ": "Space",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
}))

const MODIFIER_ACCELERATORS = new Map(Object.entries({ mod: "Command", meta: "Command", ctrl: "Control", alt: "Option", shift: "Shift" }))

/** Electron's accelerator for a desk chord on macOS, or null when Electron can't hold it. */
export function acceleratorOf(chord: string): string | null {
  const parts = chord.toLowerCase().split("+")
  const key = parts.at(-1) ?? ""
  const modifiers = parts.slice(0, -1)
  const names: string[] = []
  for (const modifier of modifiers) {
    const name = MODIFIER_ACCELERATORS.get(modifier)
    if (!name) return null
    names.push(name)
  }
  if (names.length === 0) return null
  const named = NAMED_KEYS.get(key)
  const shown =
    named ??
    (/^[a-z0-9]$/.test(key) || /^f([1-9]|1[0-9]|2[0-4])$/.test(key) ? key.toUpperCase() : /^[[\]\\;',./`=-]$/.test(key) ? key : null)
  if (!shown) return null
  return [...new Set(names), shown].join("+")
}

const COMMON_COMMAND_KEYS = new Map(Object.entries({
  a: "Select All",
  c: "Copy",
  f: "Find",
  h: "Hide",
  m: "Minimize",
  n: "New",
  o: "Open",
  p: "Print",
  q: "Quit",
  s: "Save",
  t: "New Tab",
  v: "Paste",
  w: "Close Window",
  x: "Cut",
  z: "Undo",
  ",": "Settings",
}))

/**
 * Why a chord would get in the way everywhere, or null. A global shortcut
 * takes its keys from every app, so one that is an app's everyday command
 * (⌘S), how text is typed (⇧ and a letter) or one of macOS's own (⌘⇧4,
 * ⌘Space) is refused before it is registered: Electron's registration says
 * yes to all of them, and the person would lose Save in every app.
 * `system` is macOS's shortcuts on this Mac (`systemShortcuts`); where they
 * can't be read, what a new Mac has.
 */
export function chordClash(chord: string, system: readonly SystemShortcut[] = MACOS_DEFAULT_SHORTCUTS): ChordClash | null {
  const parts = chord.toLowerCase().split("+")
  const key = parts.at(-1) ?? ""
  const modifiers = new Set(parts.slice(0, -1).map((part) => (part === "meta" ? "mod" : part)))
  const rule = (reason: string): ChordClash => ({ by: "rule", reason })
  if (modifiers.size === 0) return rule("A shortcut for every app needs a modifier key, or it would type a letter in all of them.")
  if (modifiers.size === 1 && modifiers.has("shift")) return rule("Shift and a key is how capitals are typed. Add Command, Option or Control.")
  const macos = systemShortcutOn(chord, system)
  if (macos) return { by: "macos", name: macos.name }
  const everyday = COMMON_COMMAND_KEYS.get(key)
  if (modifiers.size === 1 && modifiers.has("mod") && everyday) return rule(`This is ${everyday} in most apps.`)
  if (modifiers.size === 1 && modifiers.has("ctrl") && ["c", "d", "z", "a", "e", "k", "l", "r"].includes(key))
    return rule("Terminals and text fields use this shortcut.")
  if (modifiers.size === 1 && modifiers.has("alt") && /^[a-z0-9]$/.test(key)) return rule("Option and a key types a special character.")
  return null
}

/** A clash in one sentence, naming the keys when given (`⌘Space`), else as "This". */
export function clashSentence(clash: ChordClash, keys?: string): string {
  if (clash.by === "rule") return clash.reason
  const subject = keys ?? "This"
  if (clash.by === "held") return `macOS or another app already holds ${keys ?? "these keys"} for itself.`
  return clash.name ? `${subject} is the shortcut for ${clash.name} in System Settings.` : `${subject} is a macOS shortcut.`
}

/** A clash a later check found, in one sentence: the keys were held until then. */
export function laterClashSentence(clash: ChordClash, keys: string): string {
  if (clash.by === "held") return `Since you set it, macOS or another app took ${keys} for itself.`
  if (clash.by === "macos") return clash.name ? `Since you set it, ${keys} became the shortcut for ${clash.name} in System Settings.` : `Since you set it, ${keys} became a macOS shortcut.`
  return clash.reason
}

/** Settings' line for an app that came to the front right after a press. */
export function evidenceSentence(evidence: AppshotPressEvidence, keys: string): string {
  return `Another app may also react to ${keys}: ${evidence.app} came to the front right after you pressed ${evidence.shortcut.kind === "keys" ? "it" : "them"}.`
}

/** The Appshot card's hint for the same, where the person is looking when it happens. */
export function evidenceHint(evidence: AppshotPressEvidence, keys: string): string {
  return `${evidence.app} came to the front too. It may also use ${keys}.`
}

const KEY_GLYPHS = new Map(Object.entries({
  mod: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  shift: "⇧",
  alt: "⌥",
  enter: "↩",
  escape: "Esc",
  backspace: "⌫",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
}))

/** A chord as the Mac shows it (`⌃⇧2`), in its own order, as the desk's `formatChord` does: for the client, which has no desk. */
export function chordGlyphs(chord: string): string {
  return chord
    .split("+")
    .map((part) => KEY_GLYPHS.get(part.toLowerCase()) ?? part.toUpperCase())
    .join("")
}

/** `chordClash` as a sentence, or null. */
export function chordConflict(chord: string, system: readonly SystemShortcut[] = MACOS_DEFAULT_SHORTCUTS): string | null {
  const clash = chordClash(chord, system)
  return clash ? clashSentence(clash) : null
}

export function shortcutLabel(shortcut: AppshotShortcut, format: (chord: string) => string[]): string {
  return shortcut.kind === "modifiers" ? `Both ${MODIFIER_NAMES[shortcut.modifier]} keys` : format(shortcut.chord).join("")
}

export function sameShortcut(a: AppshotShortcut | null, b: AppshotShortcut | null): boolean {
  if (!a || !b) return a === b
  return a.kind === "modifiers" ? b.kind === "modifiers" && a.modifier === b.modifier : b.kind === "keys" && a.chord.toLowerCase() === b.chord.toLowerCase()
}
