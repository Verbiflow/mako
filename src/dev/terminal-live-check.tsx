// Real terminal integration fixture: isolated daemon, production state and UI.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Terminal } from "@xterm/xterm"
import { TerminalPanel } from "@/components/inspector/terminal-panel"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { createMakoBridge } from "../../electron/shared"
import { terminalActions, terminalStore } from "@/state/terminal"
import "../index.css"

type FixtureTransport = Pick<
  Parameters<typeof createMakoBridge>[0],
  "invoke" | "onTerminalEvent"
>
declare global {
  interface Window {
    terminalFixture: FixtureTransport
  }
}
window.mako = createMakoBridge({
  ...window.terminalFixture,
  onEvent: () => () => {},
  pathForFile: () => null,
  resolveFileUrl: (url) => url,
})
const cwd = new URLSearchParams(location.search).get("cwd")!
const terminals = new Map<string, Terminal>()
const originalOpen = Terminal.prototype.open
Terminal.prototype.open = function (parent: HTMLElement) {
  originalOpen.call(this, parent)
  const id = parent.closest<HTMLElement>("[data-terminal-session]")?.dataset
    .terminalSession
  if (id) terminals.set(id, this)
}
export function text(id: string) {
  const terminal = terminals.get(id)!
  return Array.from(
    { length: terminal.buffer.active.length },
    (_, index) =>
      terminal.buffer.active.getLine(index)?.translateToString() ?? ""
  ).join("\n")
}
export const state = () => terminalStore.get()
export const split = () => terminalActions.split("horizontal")
export function recover() {
  return terminalActions.refresh()
}
export function wake() {
  for (const id of terminals.keys()) terminalActions.resync(id)
}
export function input(id: string, value: string) {
  terminalActions.write(value, id)
}
const root = document.getElementById("root")!
root.style.height = "100vh"
createRoot(root).render(
  <StrictMode>
    <WorkspaceFocusContext value={{ cwd, identity: cwd, ready: true }}>
      <TerminalPanel />
    </WorkspaceFocusContext>
  </StrictMode>
)

let remembered = terminalStore.get().snapshots
export function rememberSnapshots() {
  remembered = terminalStore.get().snapshots
}
export function recoveredSnapshots() {
  const state = terminalStore.get()
  const ids =
    state.groups.find((group) =>
      group.sessionIds.includes(state.activeId ?? "")
    )?.sessionIds ?? []
  return (
    ids.length > 0 &&
    ids.every(
      (id) => state.snapshots[id] && state.snapshots[id] !== remembered[id]
    )
  )
}
