/** The desk's side of an element pick, without React or a host: ordering the
 * chooser's tabs, turning a pick into composer context (one chip per
 * element, the comment once), and the start, wait and settle loop over a
 * stand-in bridge. Run: tsx --tsconfig tsconfig.app.json scripts/test-element-pick-state.ts */
import assert from "node:assert/strict"
import type { ElementPick, ElementPickState } from "@mako/host/contracts/element-picks"
import type { ContextInput } from "@/lib/context-detail"

const added: ContextInput[] = []
const calls: string[] = []
let surfaced = 0
let finish: ((state: ElementPickState) => void) | undefined
const events = new EventTarget()
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: Object.assign(events, {
    mako: {
      startElementPick: async (request: { id: string }) => {
        calls.push(`start ${"target" in request ? "tab" : "conversation"}`)
        return { status: "picking", title: "Pricing", url: "http://localhost:5173/pricing" }
      },
      waitElementPick: (id: string) => {
        calls.push(`wait ${id.length > 0}`)
        return new Promise<ElementPickState>((resolve) => { finish = resolve })
      },
      cancelElementPick: async () => {
        calls.push("cancel")
        return null
      },
      surfaceWindow: async () => { surfaced++ },
    },
  }),
})
events.addEventListener("mako:add-context", (event) => {
  if (event instanceof CustomEvent) added.push(event.detail)
})

const { orderTabs, pickContexts, elementPicks, elementPicksStore, tabHost } = await import("../src/state/element-picks.ts")

const tabs = [
  { browser: "chrome", tab: "a", title: "Docs", url: "https://docs.example.com/", inUse: false },
  { browser: "chrome", tab: "b", title: "App", url: "http://localhost:20140/pricing", inUse: false },
  { browser: "chrome", tab: "c", title: "Other port", url: "http://localhost:3000/", inUse: true },
]
const ordered = orderTabs(tabs, { host: "mako-thread.thread.localhost", port: 20140 })
assert.deepEqual(ordered.app.map((tab) => tab.tab), ["b"], "a loopback tab on the app's port is the Thread's app, whatever loopback name it uses")
assert.deepEqual(ordered.other.map((tab) => tab.tab), ["a", "c"], "the rest keep the browser's order")
assert.deepEqual(orderTabs(tabs).app, [], "without a running app nothing is first")
assert.equal(tabHost("http://localhost:20140/pricing"), "localhost:20140")

const element = (label: string, extra: Partial<ElementPick["elements"][number]> = {}): ElementPick["elements"][number] => ({
  tag: "button",
  selector: "button.cta",
  html: "<button class=\"cta\">\n  Save\n</button>",
  styles: "display: inline-block",
  box: { x: 1, y: 2, width: 30, height: 20 },
  label,
  frame: false,
  ...extra,
})
const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64")
const single: ElementPick = {
  url: "http://localhost:5173/",
  title: "Plans",
  comment: "Make it the primary colour",
  send: false,
  elements: [element("PlanCard", { role: "button", name: "Start a trial", component: "PlanCard", source: { file: "src/PlanCard.tsx", line: 13, column: 7 }, image: { data: png, mimeType: "image/png" } })],
}
const [one] = pickContexts(single)
assert.ok(one)
assert.equal(one.label, "PlanCard")
assert.equal(one.text, undefined)
assert.deepEqual(one.detail, {
  kind: "element",
  url: "http://localhost:5173/",
  title: "Plans",
  tag: "button",
  selector: "button.cta",
  role: "button",
  name: "Start a trial",
  html: single.elements[0]!.html,
  styles: "display: inline-block",
  box: { x: 1, y: 2, width: 30, height: 20 },
  component: "PlanCard",
  source: { file: "src/PlanCard.tsx", line: 13, column: 7 },
  comment: "Make it the primary colour",
}, "one element carries the comment on its own chip")
assert.equal(one.image?.type, "image/png")
assert.equal(one.image?.name, "PlanCard.png")
assert.deepEqual(new Uint8Array(await one.image!.arrayBuffer()), new Uint8Array(Buffer.from(png, "base64")), "the crop's bytes reach the file")

const several = pickContexts({ ...single, comment: "Align these", elements: [element("button#save"), element("h1 “Plans”", { tag: "h1" })] })
assert.deepEqual(several.map((input) => input.label), ["button#save", "h1 “Plans”"], "one chip per element")
assert.deepEqual(several.map((input) => "comment" in input.detail ? input.detail.comment : undefined), [undefined, undefined], "several elements don't repeat the comment")
assert.deepEqual(several.map((input) => input.text), [undefined, "Align these"], "it follows the last chip once")
assert.equal(several[0]!.image, undefined, "no crop, no file")

// The loop: start, wait, settle into chips, bring the window back.
const running = elementPicks.start({ browser: "chrome", tab: "b" }, "App")
await new Promise((resolve) => setTimeout(resolve, 10))
assert.deepEqual(elementPicksStore.get().active && { place: elementPicksStore.get().active!.place, starting: elementPicksStore.get().active!.starting }, { place: "Pricing", starting: false })
finish?.({ status: "picked", pick: single })
await running
assert.equal(elementPicksStore.get().active, undefined)
assert.equal(added.length, 1)
assert.equal(added[0]!.label, "PlanCard")
assert.equal(surfaced, 1, "Mako comes back to the front with the chip")
assert.deepEqual(calls, ["start tab", "wait true"])

// Cancelled in the page by the person: nothing is added and the window stays where they are.
const cancelled = elementPicks.start({ conversation: "c1" }, "this task’s tab")
await new Promise((resolve) => setTimeout(resolve, 10))
elementPicks.cancel()
assert.equal(elementPicksStore.get().active, undefined, "Cancel clears the line at once")
finish?.({ status: "cancelled", by: "mako", reason: "Cancelled in Mako." })
await cancelled
assert.equal(added.length, 1)
assert.equal(surfaced, 1)
assert.ok(calls.includes("start conversation") && calls.includes("cancel"))

console.log("Element pick state: tabs ordered by the Thread's app, one chip per element with the comment once, and the start-wait-settle loop")
