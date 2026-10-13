import assert from "node:assert/strict"
import { z } from "zod"
import { Appshots } from "@mako/host/control/appshots"
import type { WindowState } from "@mako/control/computer"
import { acceleratorOf, chordConflict, sameShortcut } from "@mako/host/contracts/appshot-shortcut"
import type { ComputerDriverClient } from "@mako/control-runtime/host"

/**
 * An Appshot through the host: the window the person is in, and a capture
 * through Mako control's one capture path (`captureAppshot`), its picture
 * and tree read side by side. The outline itself is Mako control's and is
 * tested with it (`packages/control/test/outline.mjs`). Then the shortcut's
 * key rules.
 */

/** One of the driver's preorder rows, as `get_window_state` lists them. */
type Row = {
  role: string
  depth: number
  label?: string
  value?: string | number
  element_index?: number
  enabled?: boolean
  focused?: boolean
  actions?: string[]
  frame?: { x: number; y: number; w: number; h: number }
}
type Call = ComputerDriverClient["callTool"]

/** The driver's window state for a 400×300-point window at (100, 50), captured at 2x. */
function state(elements: Row[], extra: Partial<WindowState> = {}): WindowState {
  return {
    app_name: "Fixture Books",
    window_title: "Invoices",
    window_bounds: { x: 100, y: 50, width: 400, height: 300 },
    screenshot_width: 800,
    screenshot_height: 600,
    screenshot_scale: 2,
    elements_complete: true,
    elements,
    ...extra,
  }
}
const at = (x: number, y: number, w: number, h: number) => ({ frame: { x, y, w, h } })

const rows: Row[] = [
  { role: "AXWindow", depth: 0, label: "Invoices", element_index: 0, enabled: true, actions: ["AXRaise"], ...at(100, 50, 400, 300) },
  // Electron's wrappers: a titled group exactly the size of the page it holds, then nameless ones.
  { role: "AXGroup", depth: 1, label: "Invoices", ...at(100, 66, 400, 284) },
  { role: "AXGroup", depth: 2, ...at(100, 66, 400, 284) },
  { role: "AXGroup", depth: 3, ...at(100, 66, 400, 284) },
  { role: "AXWebArea", depth: 4, label: "Invoices", element_index: 1, enabled: true, actions: ["AXShowMenu", "AXScrollToVisible"], ...at(100, 66, 400, 284) },
  { role: "AXHeading", depth: 5, label: "Invoices", value: "1", element_index: 2, enabled: true, ...at(110, 70, 120, 20) },
  { role: "AXStaticText", depth: 6, value: "Invoices", element_index: 3, enabled: true, ...at(110, 70, 120, 20) },
  { role: "AXGroup", depth: 5, ...at(110, 95, 200, 16) },
  { role: "AXStaticText", depth: 6, label: "Customer", value: "Customer ", element_index: 4, enabled: true, ...at(110, 95, 60, 16) },
  { role: "AXTextField", depth: 6, label: "Customer", value: "Acme \"Corp\"", element_index: 5, enabled: true, focused: true, actions: ["AXPress"], ...at(170, 95, 140, 16) },
  { role: "AXButton", depth: 5, label: "Export", element_index: 6, enabled: true, actions: ["AXPress", "AXShowMenu"], ...at(400, 70, 60, 20) },
  // Not indexed: the driver indexes only what can act, so this one can't.
  { role: "AXButton", depth: 5, label: "Send reminders", ...at(330, 70, 60, 20) },
  { role: "AXCheckBox", depth: 5, label: "Send by email", value: 1, element_index: 7, enabled: true, actions: ["AXPress"], ...at(110, 120, 100, 16) },
  { role: "AXGroup", depth: 5, label: "Row actions", element_index: 8, enabled: true, actions: ["AXPress"], ...at(110, 140, 50, 16) },
  { role: "AXTable", depth: 5, element_index: 9, enabled: true, ...at(110, 160, 380, 100) },
  { role: "AXRow", depth: 6, element_index: 10, enabled: true, ...at(110, 160, 380, 20) },
  { role: "AXCell", depth: 7, element_index: 11, enabled: true, ...at(110, 160, 100, 20) },
  { role: "AXStaticText", depth: 8, value: "INV-1042", element_index: 12, enabled: true, ...at(112, 162, 60, 16) },
  { role: "AXColumn", depth: 6, element_index: 13, enabled: true, ...at(110, 160, 100, 100) },
  { role: "AXCell", depth: 7, element_index: 14, enabled: true, ...at(110, 160, 100, 20) },
  // Scrolled out of the picture, and one the driver gave no frame.
  { role: "AXLink", depth: 5, label: "Older invoices", element_index: 15, enabled: true, ...at(110, 900, 80, 16) },
  { role: "AXStaticText", depth: 5, value: "Footer", element_index: 16, enabled: true },
  { role: "AXButton", depth: 1, element_index: 17, enabled: true, actions: ["AXPress", "AXZoomWindow", "AXShowMenu"], ...at(106, 56, 8, 8) },
  // The application's menu bar, with the person's Recent Items under it.
  { role: "AXMenuBar", depth: 0, element_index: 18, enabled: true, ...at(0, 0, 1440, 24) },
  { role: "AXMenuBarItem", depth: 1, label: "Apple", element_index: 19, enabled: true },
  { role: "AXMenu", depth: 2, element_index: 20, enabled: true },
  { role: "AXMenuItem", depth: 3, label: "Recent Items", element_index: 21, enabled: true },
  { role: "AXMenuItem", depth: 4, label: "Tax return 2025.pdf", element_index: 22, enabled: true },
]

/* Which window the shortcut takes ------------------------------------------- */

const windows = [
  { pid: 10, window_id: 1, app_name: "Mako", title: "Mako", is_on_screen: true, on_current_space: true, z_index: 30, bounds: { x: 0, y: 0, width: 900, height: 700 } },
  { pid: 20, window_id: 2, app_name: "Finder", title: "", is_on_screen: true, on_current_space: true, z_index: 29, bounds: { x: 0, y: 0, width: 900, height: 24 } },
  { pid: 30, window_id: 3, app_name: "Safari", title: "Docs", is_on_screen: true, on_current_space: true, z_index: 20, bounds: { x: 10, y: 10, width: 800, height: 600 } },
  { pid: 40, window_id: 4, app_name: "Notes", title: "Groceries", is_on_screen: true, on_current_space: true, z_index: 25, bounds: { x: 30, y: 30, width: 500, height: 400 } },
  { pid: 40, window_id: 5, app_name: "Notes", title: "Elsewhere", is_on_screen: true, on_current_space: false, z_index: 28, bounds: { x: 0, y: 0, width: 300, height: 300 } },
]
const calls: string[] = []
const driver = (tool: (name: string, args: Parameters<Call>[1]) => Awaited<ReturnType<Call>>): ComputerDriverClient => ({
  listTools: async () => [],
  callTool: async (name, args) => {
    calls.push(name)
    return tool(name, args)
  },
  onClose: () => {},
  close: async () => {},
})
const listing = driver(() => ({ content: [], structuredContent: { windows } }))
let front: number | null = 30
/** The broker's side of an Appshot, faked: one connection, and a warm-up that does nothing. */
const brokered = (client: ComputerDriverClient) => ({ connect: async () => client, warm: async () => {} })
const shots = new Appshots(brokered(listing), () => undefined, async () => front)
assert.equal((await shots.frontWindow([10])).windowId, 3, "the front application's window, even when another is above it")
front = 10
assert.equal((await shots.frontWindow([10])).windowId, 4, "pressed in Mako: the frontmost window that isn't Mako's, on this Space, and not a strip")
front = null
assert.deepEqual(await shots.frontWindow([10]), { pid: 40, windowId: 4, app: "Notes", title: "Groceries", bounds: { x: 30, y: 30, width: 500, height: 400 } })
await assert.rejects(shots.frontWindow([10, 20, 30, 40]), /no window to capture/)

/* A capture: picture and tree side by side ---------------------------------- */

const picture = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }
const geometry = { window_bounds: { x: 100, y: 50, width: 400, height: 300 }, screenshot_width: 800, screenshot_height: 600, screenshot_scale: 2, screenshot_frame_valid: true }
/** A window state as the driver's wire carries it: JSON, its absent fields gone. */
const asJson = (value: WindowState) => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)))
const reading = (tree: WindowState | null, moved = geometry.window_bounds) =>
  driver((name, args) => {
    if (name === "list_windows") return { content: [], structuredContent: { windows } }
    if (args.include_accessibility_tree === false) return { content: [picture], structuredContent: geometry }
    if (!tree) return { isError: true, content: [{ type: "text", text: "AX walk failed" }] }
    return { content: [], structuredContent: asJson({ ...tree, window_bounds: moved }) }
  })
const capture = async (tree: WindowState | null, moved?: typeof geometry.window_bounds) =>
  new Appshots(brokered(reading(tree, moved)), () => undefined, async () => 30).capture({ pid: 30, windowId: 3 })
const shot = await capture(state(rows))
assert.equal(shot.image.data, picture.data)
assert.equal(shot.window.app, "Safari", "a driver whose picture doesn't name its window: named as the window list names it")
assert.equal(shot.elements, 14)
assert.equal(shot.truncated, false)
assert.match(shot.text, /\n {4}Button "Export" \[600,40,120,40\]\n/)
const moved = await capture(state(rows), { x: 300, y: 50, width: 400, height: 300 })
assert.match(moved.text, /\n {4}Button "Export" \[200,40,120,40\]\n/, "a window that moved between the two reads is measured from where its tree was read")
const resized = await capture(state(rows), { x: 100, y: 50, width: 500, height: 300 })
assert.ok(!resized.text.split("\n\n")[1]!.includes("["), "a window resized between the two reads gets no boxes rather than wrong ones")
const withoutBounds = state(rows)
delete withoutBounds.window_bounds
const unsaid = await new Appshots(brokered(
  driver((name, args) => {
    if (name === "list_windows") return { content: [], structuredContent: { windows } }
    if (args.include_accessibility_tree === false) return { content: [picture], structuredContent: geometry }
    return { content: [], structuredContent: asJson(withoutBounds) }
  })), () => undefined, async () => 30).capture({ pid: 30, windowId: 3 })
assert.match(unsaid.text, /\n {4}Button "Export" \[600,40,120,40\]\n/, "a tree read that reports no window frame is measured from its window element's (the driver's tree-only read does that)")
calls.length = 0
const namedPicture: Awaited<ReturnType<Call>> = { content: [picture], structuredContent: { ...geometry, app_name: "Safari", window_title: "Docs" } }
const named = await new Appshots(brokered(
  driver((name, args) => {
    if (name === "list_windows") return { content: [], structuredContent: { windows } }
    if (args.include_accessibility_tree === false) return namedPicture
    return { content: [], structuredContent: asJson(state(rows)) }
  })), () => undefined, async () => 30).capture({ pid: 30, windowId: 3 })
assert.deepEqual([named.window.app, named.window.title, calls.filter((call) => call === "list_windows").length], ["Safari", "Docs", 0], "a known target costs no window list: the picture names its window")
const blind = await capture(null)
assert.equal(blind.truncated, true)
assert.match(blind.text, /The window's elements couldn't be read; use the image\./, "a tree that failed still delivers the picture and says so")

/* The shortcut's keys -------------------------------------------------------- */

assert.equal(acceleratorOf("mod+shift+2"), "Command+Shift+2")
assert.equal(acceleratorOf("ctrl+alt+mod+s"), "Control+Option+Command+S")
assert.equal(acceleratorOf("ctrl+alt+space"), "Control+Option+Space")
assert.equal(acceleratorOf("mod+alt+arrowup"), "Command+Option+Up")
assert.equal(acceleratorOf("mod+alt+f5"), "Command+Option+F5")
assert.equal(acceleratorOf("s"), null, "a bare key is never global")
assert.equal(acceleratorOf("mod+dead"), null)
assert.match(chordConflict("mod+s") ?? "", /Save/)
assert.match(chordConflict("shift+a") ?? "", /capitals/)
assert.match(chordConflict("mod+shift+4") ?? "", /screenshots/)
assert.match(chordConflict("mod+space") ?? "", /Spotlight/)
assert.match(chordConflict("ctrl+c") ?? "", /Terminals/)
assert.match(chordConflict("alt+s") ?? "", /special character/)
assert.match(chordConflict("k") ?? "", /modifier/)
assert.equal(chordConflict("ctrl+alt+mod+s"), null)
assert.equal(chordConflict("mod+shift+2"), null)
assert.ok(sameShortcut({ kind: "keys", chord: "Mod+Shift+2" }, { kind: "keys", chord: "mod+shift+2" }))
assert.ok(!sameShortcut({ kind: "modifiers", modifier: "shift" }, { kind: "modifiers", modifier: "command" }))
assert.ok(sameShortcut(null, null))

console.log(
  "Appshots in the host: the front app's window chosen, Mako's never; picture and tree read side by side, a known target with no window list; shortcut keys checked"
)
