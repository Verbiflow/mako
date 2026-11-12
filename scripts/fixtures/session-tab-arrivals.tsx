import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { SessionTabList } from "../../src/components/stage/session-tabs"
import { TooltipProvider } from "../../src/components/ui/tooltip"
import type { SessionTab } from "../../src/state/thread-sessions"

/** Real mounted strip: slow first rendering stays still; a later tab joins. */
export function sessionTabArrivals() {
  const node = document.createElement("div")
  document.body.append(node)
  const root = createRoot(node)
  const first: SessionTab = { kind: "session", id: "arrival-first", ref: { harness: "codex", nativeId: "arrival-first", path: "/fixture/arrival-first" } }
  const next: SessionTab = { kind: "session", id: "arrival-next", ref: { harness: "codex", nativeId: "arrival-next", path: "/fixture/arrival-next" } }
  const draw = (tabs: SessionTab[]) => root.render(<TooltipProvider><SessionTabList tabs={tabs} here={{ session: first.id }} paneId="arrival-fixture" agentActive /></TooltipProvider>)
  const clock = Object.getOwnPropertyDescriptor(performance, "now")
  let now = 1_000
  try {
    Object.defineProperty(performance, "now", { configurable: true, value: () => (now += 40) })
    flushSync(() => draw([first]))
    const initialNew = node.querySelectorAll("[data-new]").length
    flushSync(() => draw([first, next]))
    return { initialNew, firstNew: Boolean(node.querySelector('[data-session-tab="arrival-first"]')?.closest("[data-new]")), laterNew: Boolean(node.querySelector('[data-session-tab="arrival-next"]')?.closest("[data-new]")) }
  } finally {
    if (clock) Object.defineProperty(performance, "now", clock)
    else Reflect.deleteProperty(performance, "now")
    flushSync(() => root.unmount())
    node.remove()
  }
}
