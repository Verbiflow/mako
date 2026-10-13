import assert from "node:assert/strict"
import { chordClash, chordConflict, clashSentence } from "@mako/host/contracts/appshot-shortcut"
import {
  MACOS_DEFAULT_SHORTCUTS,
  canonicalChord,
  carbonHotKeyOf,
  chordOfParameters,
  sameChord,
  symbolicHotKeyOn,
  systemShortcutOn,
  systemShortcuts,
} from "@mako/host/contracts/macos-shortcuts"

/**
 * The Appshot shortcut's clash rules, and macOS's shortcuts read from
 * `com.apple.symbolichotkeys` (docs/audits/2026-10-12/appshot-shortcut-clashes.md).
 * The preferences below are the shape `defaults export com.apple.symbolichotkeys - |
 * plutil -convert json -o - -` prints; the first is this Mac's at the time
 * of the audit, with screenshots, Spotlight and input sources turned off.
 */

const THIS_MAC = JSON.stringify({
  AppleSymbolicHotKeys: {
    15: { enabled: false },
    28: { enabled: false, value: { type: "standard", parameters: [51, 20, 1179648] } },
    29: { enabled: false, value: { type: "standard", parameters: [51, 20, 1441792] } },
    30: { enabled: false, value: { type: "standard", parameters: [52, 21, 1179648] } },
    31: { enabled: false, value: { type: "standard", parameters: [52, 21, 1441792] } },
    60: { enabled: false, value: { type: "standard", parameters: [32, 49, 262144] } },
    61: { enabled: false, value: { type: "standard", parameters: [32, 49, 786432] } },
    64: { enabled: false, value: { type: "standard", parameters: [32, 49, 1048576] } },
    65: { enabled: false, value: { type: "standard", parameters: [32, 49, 1572864] } },
    79: { enabled: true },
    164: { enabled: false, value: { type: "standard", parameters: [65535, 65535, 0] } },
    184: { enabled: false, value: { type: "standard", parameters: [53, 23, 1179648] } },
  },
})

/* The parameters: [character, key code, modifier flags] ---------------------------- */

assert.equal(chordOfParameters([32, 49, 0x100000]), "mod+space", "⌘Space: the character is 32, the key code 49")
assert.equal(chordOfParameters([52, 21, 0x120000]), "mod+shift+4")
assert.equal(chordOfParameters([51, 20, 0x160000]), "mod+ctrl+shift+3", "modifiers come out in the desk's order")
assert.equal(chordOfParameters([65535, 126, 0x840000]), "ctrl+arrowup", "an arrow carries the fn flag by itself; it isn't part of the chord")
assert.equal(chordOfParameters([65535, 122, 0x840000]), "ctrl+f1")
assert.equal(chordOfParameters([65535, 103, 0x800000]), "f11")
assert.equal(chordOfParameters([113, 12, 0x800000]), null, "fn with a letter (the Globe key's shortcuts) is no desk chord")
assert.equal(chordOfParameters([65535, 65535, 0]), null, "65535 is no key: a shortcut with no keys set")
assert.equal(chordOfParameters([47, 44, 0x120000]), "mod+shift+/")
assert.equal(chordOfParameters([96, 50, 0x100000]), "mod+`")
assert.equal(chordOfParameters([1, 2]), null, "too few parameters")

/* Chords in one spelling, and Carbon's terms for the probe ------------------------- */

assert.equal(canonicalChord("shift+alt+mod+k"), "mod+shift+alt+k")
assert.equal(canonicalChord("meta+ "), "mod+space")
assert.equal(canonicalChord("hyper+k"), null)
assert.ok(sameChord("alt+ctrl+mod+s", "ctrl+alt+mod+s"))
assert.ok(!sameChord("ctrl+s", "ctrl+shift+s"))
assert.deepEqual(carbonHotKeyOf("ctrl+alt+mod+k"), { keyCode: 40, modifiers: 0x100 | 0x1000 | 0x800 }, "the keys the live probe registers")
assert.deepEqual(carbonHotKeyOf("ctrl+arrowup"), { keyCode: 126, modifiers: 0x1000 })
assert.deepEqual(carbonHotKeyOf("mod+shift+/"), { keyCode: 44, modifiers: 0x100 | 0x200 })
assert.equal(carbonHotKeyOf("mod+dead"), null)

/* This Mac's shortcuts over the defaults ------------------------------------------ */

const mine = systemShortcuts(THIS_MAC)
assert.equal(systemShortcutOn("mod+shift+4", mine), null, "screenshots are off here, so ⌘⇧4 is free (CleanShot's, perhaps; the recorder tells)")
assert.equal(systemShortcutOn("mod+space", mine), null, "Spotlight is off here")
assert.equal(systemShortcutOn("ctrl+space", mine), null, "input sources are off here")
assert.equal(systemShortcutOn("ctrl+arrowup", mine)?.name, "Mission Control", "an id the preferences don't list has its default")
assert.equal(systemShortcutOn("ctrl+arrowleft", mine)?.name, "moving a space left", "`{enabled: true}` alone keeps the default keys")
assert.equal(systemShortcutOn("mod+`", mine)?.name, "moving focus to the next window")
assert.equal(systemShortcutOn("mod+tab", mine)?.name, "switching apps", "⌘Tab isn't in System Settings, so no preference frees it")
assert.ok(!mine.some((shortcut) => shortcut.id === 164), "a shortcut with no keys is no clash")

const remapped = systemShortcuts(
  JSON.stringify({
    AppleSymbolicHotKeys: {
      64: { enabled: true, value: { type: "standard", parameters: [32, 49, 0x80000] } },
      32: { enabled: 0 },
      52: { enabled: 1 },
      901: { enabled: true, value: { type: "standard", parameters: [107, 40, 0x1c0000] } },
      33: { enabled: true, value: { type: "standard", parameters: ["x", 125] } },
      nonsense: { enabled: true },
    },
  }),
)
assert.equal(systemShortcutOn("alt+space", remapped)?.name, "Spotlight", "a remapped shortcut is found on its new keys")
assert.equal(systemShortcutOn("mod+space", remapped), null, "and its old keys are free")
assert.equal(systemShortcutOn("ctrl+arrowup", remapped), null, "0 is off, as older macOS wrote it")
assert.equal(systemShortcutOn("mod+alt+d", remapped)?.name, "turning Dock hiding on or off", "1 is on")
const unnamed = systemShortcutOn("ctrl+alt+mod+k", remapped)
assert.deepEqual(unnamed && { id: unnamed.id, name: unnamed.name }, { id: 901, name: null }, "an id this list doesn't know is still a clash, without a name")
assert.equal(systemShortcutOn("ctrl+arrowdown", remapped)?.name, "application windows", "an entry that can't be read leaves its default")

for (const unreadable of ["", "not json", "[]", JSON.stringify({ AppleSymbolicHotKeys: 3 })])
  assert.deepEqual(systemShortcuts(unreadable), [...MACOS_DEFAULT_SHORTCUTS], `${JSON.stringify(unreadable)} reads as a new Mac's shortcuts`)
assert.ok(systemShortcutOn("mod+space", MACOS_DEFAULT_SHORTCUTS), "a new Mac has Spotlight on ⌘Space")
assert.ok(!systemShortcutOn("ctrl+1", MACOS_DEFAULT_SHORTCUTS), "Switch to Desktop 1 ships off")

/* Carbon's symbolic hot keys (the hidden ones too) --------------------------------- */

const carbon = [
  { keyCode: 46, modifiers: 0x100, enabled: true },
  { keyCode: 126, modifiers: 0x20000 | 0x1000, enabled: true },
  { keyCode: 3, modifiers: 0x20000 | 0x1000, enabled: true },
  { keyCode: 49, modifiers: 0x100, enabled: false },
]
assert.ok(symbolicHotKeyOn("mod+m", carbon), "⌘M (minimize) is one of them on macOS 26")
assert.ok(symbolicHotKeyOn("ctrl+arrowup", carbon), "an arrow matches with fn or without")
assert.ok(!symbolicHotKeyOn("ctrl+f", carbon), "fn⌃F is the Globe key's, not ⌃F")
assert.ok(!symbolicHotKeyOn("mod+space", carbon), "a disabled one isn't a clash")

/* The clash rules ------------------------------------------------------------------ */

assert.deepEqual(chordClash("mod+s", mine), { by: "rule", reason: "This is Save in most apps." })
assert.match(chordConflict("shift+a") ?? "", /capitals/)
assert.match(chordConflict("k") ?? "", /modifier/)
assert.deepEqual(chordClash("ctrl+arrowup", mine), { by: "macos", name: "Mission Control" })
assert.equal(chordClash("mod+shift+4", mine), null, "free on this Mac")
assert.deepEqual(chordClash("mod+shift+4"), { by: "macos", name: "screenshots of an area" }, "taken on a new Mac, which is what is assumed without preferences")
assert.equal(chordClash("ctrl+arrowup", []), null, "with no system shortcuts only the rules apply: the recorder's first check, before the client's")
assert.equal(chordClash("ctrl+alt+mod+s", mine), null)
assert.equal(chordClash("ctrl+shift+2", mine), null)

assert.equal(clashSentence({ by: "macos", name: "Spotlight" }, "⌥Space"), "⌥Space is the shortcut for Spotlight in System Settings.")
assert.equal(clashSentence({ by: "macos", name: null }, "⌘."), "⌘. is a macOS shortcut.")
assert.equal(clashSentence({ by: "held" }, "⌃⇧2"), "macOS or another app already holds ⌃⇧2 for itself.")
assert.equal(clashSentence({ by: "macos", name: "Mission Control" }), "This is the shortcut for Mission Control in System Settings.")
assert.equal(clashSentence({ by: "rule", reason: "This is Save in most apps." }, "⌘S"), "This is Save in most apps.")

console.log(
  `Appshot shortcut clashes: ${MACOS_DEFAULT_SHORTCUTS.length} macOS shortcuts known by name, the preferences laid over them (off, remapped, unknown ids, unreadable entries), Carbon's hidden ones matched, and each clash said in one sentence`,
)
