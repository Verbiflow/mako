// Isolated terminal fixture: real renderer and state, deterministic transport.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Terminal } from "@xterm/xterm"
import { TerminalPanel } from "@/components/inspector/terminal-panel"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import type { TerminalEvent, TerminalSession } from "../../electron/shared"
import { installMockBridge } from "./mock-bridge"
import { terminalActions, terminalStore } from "@/state/terminal"
import { setPref } from "@/state/prefs"
import "../index.css"

const cwd = "/Users/developer/projects/mako"
const listeners = new Set<(event: TerminalEvent) => void>()
const terminals: Terminal[] = []
const originalOpen = Terminal.prototype.open
Terminal.prototype.open = function (parent: HTMLElement) {
  terminals.push(this)
  originalOpen.call(this, parent)
}
const history = [
  "\x1b[36m~/projects/mako\x1b[0m  \x1b[35mmain\x1b[0m",
  "$ npm run dev",
  "",
  "  \x1b[32mVITE\x1b[0m  ready in 184 ms",
  "",
  "  \x1b[34mLocal:\x1b[0m    http://localhost:5173/",
  "  \x1b[90mPress h + enter to show help\x1b[0m",
  "",
  "\x1b[32m✓\x1b[0m Connected to workspace",
  "$ ",
].join("\r\n")
let sessions: TerminalSession[] = ["Shell", "Dev server", "Tests"].map(
  (title, index) => ({
    id: `terminal-${index}`,
    title,
    cwd,
    createdAt: index,
    updatedAt: index,
    status: "running",
    cols: 80,
    rows: 24,
    sequence: 0,
  })
)
const sequences = new Map<string, number>()
const histories = new Map<string, string>()
export const inputs: Array<{ id: string; data: string }> = []
export const metrics = {
  resizes: 0,
  acknowledgements: 0,
  attachments: 0,
  writes: 0,
}
installMockBridge()
const bridge = window.mako!
bridge.terminalList = async () => sessions
bridge.terminalAttach = async (id) => {
  metrics.attachments++
  const session = sessions.find((entry) => entry.id === id)
  if (!session) throw new Error("Unknown fixture terminal")
  return {
    session,
    sequence: sequences.get(id) ?? 0,
    data: histories.get(id) ?? history,
  }
}
bridge.terminalCreate = async () => {
  const session: TerminalSession = {
    ...sessions[0],
    id: `terminal-${sessions.length}`,
    title: "Shell",
    createdAt: Date.now(),
  }
  sessions = [...sessions, session]
  emit({ type: "status", session })
  return session
}
bridge.terminalResize = async () => {
  metrics.resizes++
}
bridge.terminalAcknowledge = async () => {
  metrics.acknowledgements++
}
bridge.terminalWrite = async (id, data) => {
  metrics.writes++
  inputs.push({ id, data })
  output(data, id)
}
bridge.terminalKill = async (id) => {
  sessions = sessions.filter((session) => session.id !== id)
  emit({ type: "removed", sessionId: id })
}
bridge.onTerminalEvent = (listener) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emit(event: TerminalEvent) {
  for (const listener of listeners) listener(event)
}
export function output(data: string, id = terminalStore.get().activeId!) {
  const sequence = (sequences.get(id) ?? 0) + 1
  sequences.set(id, sequence)
  histories.set(id, (histories.get(id) ?? history) + data)
  emit({ type: "output", sessionId: id, sequence, data })
}
export function split(orientation: "horizontal" | "vertical") {
  return terminalActions.split(orientation)
}
export function state() {
  return terminalStore.get()
}
export function font(size: number) {
  setPref("terminalFontSize", size)
}
export function replayQueries() {
  const id = terminalStore.get().activeId!
  histories.set(id, history + "\x1b[6n\x1b[c\x1b[?2004$p\r\nREPLAY_SAFE")
  terminalActions.resync(id)
}
export function terminalFor(id: string) {
  return terminals.findLast((terminal) =>
    terminal.element?.closest(`[data-terminal-session="${id}"]`)
  )!
}
export function rendererCount() {
  return terminals.length
}
export function activate(id: string) {
  terminalActions.activate(id)
}
export function create() {
  return terminalActions.create(cwd)
}
export function latestTerminal() {
  return terminals.at(-1)!
}
export function recreateRenderer() {
  latestTerminal().write = () => {
    throw new Error("Simulated renderer failure")
  }
  output("renderer recovery")
}
export function reconnect() {
  emit({ type: "connection", state: "disconnected" })
  emit({ type: "connection", state: "connecting" })
  emit({ type: "connection", state: "ready" })
}
export function resync() {
  terminalActions.resync()
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
