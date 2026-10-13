/**
 * The keyboard shortcuts macOS keeps for itself, as System Settings ›
 * Keyboard › Keyboard Shortcuts lists them, in the desk's spelling of a
 * chord (`mod+shift+4`, `extend/commands.ts`).
 *
 * macOS keeps them in the `com.apple.symbolichotkeys` preferences, which
 * name only what the person changed: each entry is an id, whether it is on,
 * and `[character, key code, modifier flags]`. An id that isn't there has
 * its default, so the defaults are listed here and the preferences are laid
 * over them (`systemShortcuts`). Measured on macOS 26
 * (docs/audits/2026-10-12/appshot-shortcut-clashes.md): the shortcuts the
 * window server holds (Mission Control, moving between spaces, ⌘Tab) can't
 * be held by another app, while the ones apps act on themselves (⌘`, the
 * Help menu) can, and Electron's `globalShortcut.register` says yes to all
 * of them.
 */
import { z } from "zod"

export interface SystemShortcut {
  /** The id in `com.apple.symbolichotkeys`; null for the few System Settings doesn't list (⌘Tab). */
  id: number | null
  /** What it does, to finish "the shortcut for …"; null for an id this list doesn't know. */
  name: string | null
  chord: string
  enabled: boolean
}

/** macOS's virtual key codes (the physical key, ANSI layout) in the desk's names for keys. */
const KEY_NAMES = {
  0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v", 11: "b", 12: "q", 13: "w", 14: "e",
  15: "r", 16: "y", 17: "t", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9", 26: "7", 27: "-",
  28: "8", 29: "0", 30: "]", 31: "o", 32: "u", 33: "[", 34: "i", 35: "p", 36: "enter", 37: "l", 38: "j", 39: "'",
  40: "k", 41: ";", 42: "\\", 43: ",", 44: "/", 45: "n", 46: "m", 47: ".", 48: "tab", 49: "space", 50: "`",
  51: "backspace", 53: "escape", 64: "f17", 79: "f18", 80: "f19", 90: "f20", 96: "f5", 97: "f6", 98: "f7", 99: "f3",
  100: "f8", 101: "f9", 103: "f11", 105: "f13", 106: "f16", 107: "f14", 109: "f10", 111: "f12", 113: "f15",
  115: "home", 116: "pageup", 117: "delete", 118: "f4", 119: "end", 120: "f2", 121: "pagedown", 122: "f1",
  123: "arrowleft", 124: "arrowright", 125: "arrowdown", 126: "arrowup",
}
const KEY_CODES = new Map(Object.entries(KEY_NAMES).map(([code, key]) => [Number(code), key]))
const CODE_OF_KEY = new Map(Object.entries(KEY_NAMES).map(([code, key]) => [key, Number(code)]))

/** Keys the keyboard reports with the function flag set (F-keys, arrows, Home…): the flag says nothing about the chord. */
const FUNCTION_KEY = /^(f\d+|arrow\w+|home|end|pageup|pagedown|delete)$/

/** NSEvent's device-independent modifier flags, the third parameter, in the desk's order. */
const FLAGS = [
  ["mod", 0x100000],
  ["ctrl", 0x40000],
  ["shift", 0x20000],
  ["alt", 0x80000],
] as const
const FUNCTION_FLAG = 0x800000
/** Carbon's modifiers for `RegisterEventHotKey` (cmdKey, controlKey, shiftKey, optionKey). */
const CARBON = { mod: 0x100, ctrl: 0x1000, shift: 0x200, alt: 0x800 } as const

const MODIFIER_ALIASES = new Map(Object.entries({ mod: "mod", meta: "mod", cmd: "mod", command: "mod", ctrl: "ctrl", control: "ctrl", shift: "shift", alt: "alt", option: "alt" }))
const ORDER = ["mod", "ctrl", "shift", "alt"]

/** A chord in one spelling: modifiers in the desk's order, `meta` as `mod`, a space as `space`; null when a part isn't a modifier. */
export function canonicalChord(chord: string): string | null {
  const parts = chord.toLowerCase().split("+")
  const modifiers = new Set<string>()
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES.get(part)
    if (!modifier) return null
    modifiers.add(modifier)
  }
  const last = parts.at(-1) ?? ""
  const key = last === " " ? "space" : last
  if (!key) return null
  return [...ORDER.filter((modifier) => modifiers.has(modifier)), key].join("+")
}

export function sameChord(a: string, b: string): boolean {
  const left = canonicalChord(a)
  return left !== null && left === canonicalChord(b)
}

/**
 * The chord of a symbolic hot key's `[character, key code, modifier flags]`,
 * or null when it has no key (65535) or needs the fn key with a key that
 * isn't a function key, which no desk chord can be.
 */
export function chordOfParameters(parameters: readonly number[]): string | null {
  const [, code = -1, flags = 0] = parameters
  if (parameters.length < 3) return null
  const key = KEY_CODES.get(code)
  if (!key) return null
  if (flags & FUNCTION_FLAG && !FUNCTION_KEY.test(key)) return null
  return [...FLAGS.filter(([, flag]) => flags & flag).map(([name]) => name), key].join("+")
}

/** The key code and Carbon modifiers `RegisterEventHotKey` takes for a chord, or null for a key without a code here. */
export function carbonHotKeyOf(chord: string): { keyCode: number; modifiers: number } | null {
  const canonical = canonicalChord(chord)
  if (!canonical) return null
  const parts = canonical.split("+")
  const keyCode = CODE_OF_KEY.get(parts.at(-1) ?? "")
  if (keyCode === undefined) return null
  const modifiers = Object.entries(CARBON).reduce((sum, [name, flag]) => (parts.includes(name) ? sum | flag : sum), 0)
  return { keyCode, modifiers }
}

type Default = readonly [id: number, name: string, parameters: readonly [number, number, number], enabled: boolean]

/**
 * What macOS ships, for the ids the person hasn't changed. Checked against
 * Carbon's `CopySymbolicHotKeys`, which reports the effective set without
 * ids or names (`scripts/test-appshot-shortcut-clashes.mjs`).
 */
const DEFAULTS: readonly Default[] = [
  [7, "moving focus to the menu bar", [65535, 120, 0x840000], true],
  [8, "moving focus to the Dock", [65535, 99, 0x840000], true],
  [9, "moving focus to the active or next window", [65535, 118, 0x840000], true],
  [10, "moving focus to the window toolbar", [65535, 96, 0x840000], true],
  [11, "moving focus to the floating window", [65535, 97, 0x840000], true],
  [12, "turning keyboard navigation on or off", [65535, 122, 0x840000], true],
  [13, "changing the way Tab moves focus", [65535, 98, 0x840000], true],
  [15, "turning zoom on or off", [56, 28, 0x180000], false],
  [17, "zooming in", [61, 24, 0x180000], false],
  [19, "zooming out", [45, 27, 0x180000], false],
  [21, "inverting colors", [56, 28, 0x1c0000], false],
  [23, "turning image smoothing on or off", [92, 42, 0x180000], false],
  [25, "increasing contrast", [46, 47, 0x1c0000], false],
  [26, "decreasing contrast", [44, 43, 0x1c0000], false],
  [27, "moving focus to the next window", [96, 50, 0x100000], true],
  [28, "screenshots of the screen", [51, 20, 0x120000], true],
  [29, "screenshots of the screen to the clipboard", [51, 20, 0x160000], true],
  [30, "screenshots of an area", [52, 21, 0x120000], true],
  [31, "screenshots of an area to the clipboard", [52, 21, 0x160000], true],
  [32, "Mission Control", [65535, 126, 0x840000], true],
  [33, "application windows", [65535, 125, 0x840000], true],
  [34, "Mission Control", [65535, 126, 0x860000], true],
  [35, "application windows", [65535, 125, 0x860000], true],
  [36, "showing the desktop", [65535, 103, 0x800000], true],
  [37, "showing the desktop", [65535, 103, 0x820000], true],
  [52, "turning Dock hiding on or off", [100, 2, 0x180000], true],
  [57, "moving focus to the status menus", [65535, 100, 0x840000], true],
  [59, "VoiceOver", [65535, 96, 0x900000], true],
  [60, "the previous input source", [32, 49, 0x40000], true],
  [61, "the next input source", [32, 49, 0xc0000], true],
  [64, "Spotlight", [32, 49, 0x100000], true],
  [65, "Finder search", [32, 49, 0x180000], true],
  [79, "moving a space left", [65535, 123, 0x840000], true],
  [80, "moving a space left", [65535, 123, 0x860000], true],
  [81, "moving a space right", [65535, 124, 0x840000], true],
  [82, "moving a space right", [65535, 124, 0x860000], true],
  [98, "the Help menu", [47, 44, 0x120000], true],
  [118, "switching to Desktop 1", [65535, 18, 0x40000], false],
  [119, "switching to Desktop 2", [65535, 19, 0x40000], false],
  [120, "switching to Desktop 3", [65535, 20, 0x40000], false],
  [121, "switching to Desktop 4", [65535, 21, 0x40000], false],
  [184, "screenshots and recording", [53, 23, 0x120000], true],
]

/** Shortcuts the window server keeps that System Settings doesn't list, so no preference turns them off. */
const FIXED: readonly SystemShortcut[] = [
  { id: null, name: "switching apps", chord: "mod+tab", enabled: true },
  { id: null, name: "switching apps", chord: "mod+shift+tab", enabled: true },
  { id: null, name: "Force Quit", chord: "mod+alt+escape", enabled: true },
  { id: null, name: "locking the screen", chord: "mod+ctrl+q", enabled: true },
  { id: null, name: "the Character Viewer", chord: "mod+ctrl+space", enabled: true },
]

const SymbolicHotKey = z.object({
  enabled: z.union([z.boolean(), z.number().transform((value) => value !== 0)]).optional(),
  value: z.object({ parameters: z.array(z.number()).min(3).optional() }).optional(),
})
const SymbolicHotKeys = z.object({ AppleSymbolicHotKeys: z.record(z.string(), z.unknown()) })

function preferencesOf(json: string): z.infer<typeof SymbolicHotKeys> | null {
  try {
    return SymbolicHotKeys.safeParse(JSON.parse(json)).data ?? null
  } catch {
    return null
  }
}

/**
 * macOS's shortcuts on this Mac, from `com.apple.symbolichotkeys` as JSON
 * text (`defaults export com.apple.symbolichotkeys - | plutil -convert json
 * -o - -`): each listed id's `enabled` and `value.parameters` replace its
 * default, an id this list doesn't know is kept without a name, and an
 * entry that can't be read leaves its default alone. Text that isn't the
 * preferences reads as no changes.
 */
export function systemShortcuts(json: string): SystemShortcut[] {
  const known = new Map(DEFAULTS.map((entry) => [entry[0], entry]))
  const shortcuts = new Map<number, SystemShortcut>()
  for (const [id, name, parameters, enabled] of DEFAULTS) {
    const chord = chordOfParameters(parameters)
    if (chord) shortcuts.set(id, { id, name, chord, enabled })
  }
  for (const [key, raw] of Object.entries(preferencesOf(json)?.AppleSymbolicHotKeys ?? {})) {
    const id = Number(key)
    const entry = SymbolicHotKey.safeParse(raw).data
    if (!Number.isInteger(id) || !entry) continue
    const base = known.get(id)
    const parameters = entry.value?.parameters ?? base?.[2]
    // `{"enabled": true}` with no value is how macOS keeps a default turned back on.
    const chord = parameters ? chordOfParameters(parameters) : null
    if (chord) shortcuts.set(id, { id, name: base?.[1] ?? null, chord, enabled: entry.enabled ?? base?.[3] ?? false })
    else shortcuts.delete(id)
  }
  return [...shortcuts.values(), ...FIXED]
}

/** macOS's shortcuts as a new Mac has them: what is assumed when the preferences can't be read. */
export const MACOS_DEFAULT_SHORTCUTS: readonly SystemShortcut[] = systemShortcuts("{}")

/** The enabled macOS shortcut on `chord`, or null. */
export function systemShortcutOn(chord: string, shortcuts: readonly SystemShortcut[]): SystemShortcut | null {
  return shortcuts.find((shortcut) => shortcut.enabled && sameChord(shortcut.chord, chord)) ?? null
}

/** One of Carbon's `CopySymbolicHotKeys`: every shortcut the system keeps, hidden ones included, with no id or name. */
export interface SymbolicHotKey {
  keyCode: number
  /** Carbon modifiers; 0x20000 is the fn key. */
  modifiers: number
  enabled: boolean
}

const CARBON_FN = 0x20000
const FUNCTION_KEY_CODES = new Set([...CODE_OF_KEY].filter(([key]) => FUNCTION_KEY.test(key)).map(([, code]) => code))

/**
 * Whether an enabled entry of Carbon's list is on `chord`. Keys that report
 * fn by themselves (F-keys, arrows) match with or without it; any other key
 * with fn (the Globe key's shortcuts) is never a desk chord.
 */
export function symbolicHotKeyOn(chord: string, list: readonly SymbolicHotKey[]): boolean {
  const wanted = carbonHotKeyOf(chord)
  if (!wanted) return false
  return list.some(
    (entry) =>
      entry.enabled &&
      entry.keyCode === wanted.keyCode &&
      (FUNCTION_KEY_CODES.has(entry.keyCode) ? entry.modifiers & ~CARBON_FN : entry.modifiers) === wanted.modifiers,
  )
}
