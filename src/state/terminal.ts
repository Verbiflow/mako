import { getMako, hasBridge } from "@/lib/bridge"
import type {
  TerminalEvent,
  TerminalSession,
  TerminalSnapshot,
} from "@/lib/types"
import {
  MAX_TERMINAL_PANES,
  reconcileTerminalGroups,
  terminalGroupFor,
  type TerminalGroup,
} from "@/lib/terminal-layout"
import { prefsStore, setPref } from "@/state/prefs"
import { createStore } from "@/state/store"

export interface TerminalOutput {
  sessionId: string
  sequence: number
  data: string
}
export interface TerminalState {
  phase: "idle" | "connecting" | "ready" | "error"
  sessions: TerminalSession[]
  groups: TerminalGroup[]
  activeId?: string
  snapshots: Record<string, TerminalSnapshot | undefined>
  faults: Record<string, string | undefined>
  closingId?: string
  fault?: string
  creating: boolean
}
export const terminalStore = createStore<TerminalState>({
  phase: "idle",
  sessions: [],
  groups: prefsStore.get().terminalGroups,
  snapshots: {},
  faults: {},
  creating: false,
})
interface Stream {
  sequence: number
  recent: TerminalOutput[]
  characters: number
  attachment?: Promise<void>
}
const streams = new Map<string, Stream>()
const outputListeners = new Map<string, Set<(output: TerminalOutput) => void>>()
let subscribers = 0
let unsubscribe: (() => void) | undefined
let connectionLost = false
let loadGeneration = 0
let desiredWorkspace: string | undefined
let creatingWorkspace = false
const MAX_RECENT_OUTPUT_CHARACTERS = 512 * 1024

export function replayTerminalOutput(
  sessionId: string,
  listener: (output: TerminalOutput) => void
) {
  for (const output of streams.get(sessionId)?.recent ?? []) listener(output)
}
export function subscribeTerminalOutput(
  sessionId: string,
  listener: (output: TerminalOutput) => void
) {
  const listeners = outputListeners.get(sessionId) ?? new Set()
  outputListeners.set(sessionId, listeners)
  listeners.add(listener)
  replayTerminalOutput(sessionId, listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) outputListeners.delete(sessionId)
  }
}
function remember(stream: Stream, output: TerminalOutput) {
  stream.recent.push(output)
  stream.characters += output.data.length
  while (
    stream.characters > MAX_RECENT_OUTPUT_CHARACTERS &&
    stream.recent.length > 1
  )
    stream.characters -= stream.recent.shift()!.data.length
}
function visibleIds() {
  const state = terminalStore.get()
  return terminalGroupFor(state.groups, state.activeId)?.sessionIds ?? []
}
export function runningTerminalForWorkspace(
  sessions: TerminalSession[],
  cwd: string
) {
  return sessions.find(
    (session) => session.status === "running" && session.cwd === cwd
  )
}
function setSessions(sessions: TerminalSession[]) {
  const groups = reconcileTerminalGroups(terminalStore.get().groups, sessions)
  terminalStore.set({ sessions, groups })
  setPref("terminalGroups", groups)
}
function upsert(session: TerminalSession) {
  setSessions(
    [
      session,
      ...terminalStore
        .get()
        .sessions.filter((entry) => entry.id !== session.id),
    ].sort((a, b) => b.createdAt - a.createdAt)
  )
}
function setSessionFault(sessionId: string, fault?: string) {
  if (!terminalStore.get().sessions.some((session) => session.id === sessionId))
    return
  terminalStore.set((state) => ({
    faults: { ...state.faults, [sessionId]: fault },
  }))
}
function applySnapshot(snapshot: TerminalSnapshot) {
  const id = snapshot.session.id
  const stream = streams.get(id)
  if (!stream) return
  const pending = stream.recent.filter(
    (output) => output.sequence > snapshot.sequence
  )
  stream.recent = []
  stream.characters = 0
  stream.sequence = snapshot.sequence
  upsert(snapshot.session)
  terminalStore.set((state) => ({
    snapshots: { ...state.snapshots, [id]: snapshot },
    faults: { ...state.faults, [id]: undefined },
  }))
  for (const output of pending) receiveOutput(output)
}
function attach(sessionId: string): Promise<void> {
  let stream = streams.get(sessionId)
  if (stream?.attachment) return stream.attachment
  if (!stream) {
    stream = { sequence: 0, recent: [], characters: 0 }
    streams.set(sessionId, stream)
  }
  const owner = stream
  const promise = getMako()
    .terminalAttach(sessionId)
    .then(
      (snapshot) => {
        if (streams.get(sessionId) !== owner || owner.attachment !== promise)
          return
        owner.attachment = undefined
        applySnapshot(snapshot)
      },
      (error) => {
        if (streams.get(sessionId) !== owner || owner.attachment !== promise)
          return
        owner.attachment = undefined
        setSessionFault(
          sessionId,
          error instanceof Error ? error.message : String(error)
        )
      }
    )
  owner.attachment = promise
  return promise
}
function syncVisible() {
  const visible = new Set(visibleIds())
  for (const id of streams.keys()) {
    if (visible.has(id)) continue
    streams.delete(id)
    terminalStore.set((state) => ({
      snapshots: { ...state.snapshots, [id]: undefined },
    }))
    void getMako()
      .terminalDetach(id)
      .catch(() => {})
  }
  if (!subscribers || terminalStore.get().phase !== "ready") return
  for (const id of visible) if (!streams.has(id)) void attach(id)
}
function receiveOutput(output: TerminalOutput) {
  const stream = streams.get(output.sessionId)
  if (!stream || output.sequence <= stream.sequence) return
  if (stream.attachment) {
    remember(stream, output)
    return
  }
  if (output.sequence !== stream.sequence + 1) {
    remember(stream, output)
    void attach(output.sessionId)
    return
  }
  stream.sequence = output.sequence
  remember(stream, output)
  for (const listener of outputListeners.get(output.sessionId) ?? [])
    listener(output)
  // Output never publishes React state. Only the terminal renderer sees frames.
}
function applyEvent(event: TerminalEvent) {
  if (event.type === "output") {
    receiveOutput(event)
    return
  }
  if (event.type === "wake") {
    for (const id of visibleIds()) void attach(id)
    return
  }
  if (event.type === "connection") {
    if (event.state === "ready") {
      // Listing and reattachment finish the recovery. A socket handshake alone
      // must not invite workspace creation against an empty/stale catalog.
      if (connectionLost) {
        connectionLost = false
        void load()
      }
      return
    }
    if (event.state === "disconnected") {
      connectionLost = true
      streams.clear()
      loadGeneration++
    }
    terminalStore.set({
      phase: event.state === "connecting" ? "connecting" : "error",
      fault: event.error,
    })
    return
  }
  if (event.type === "snapshot") {
    if (!streams.get(event.snapshot.session.id)?.attachment)
      applySnapshot(event.snapshot)
    return
  }
  if (event.type === "status") {
    upsert(event.session)
    const stream = streams.get(event.session.id)
    if (
      stream &&
      event.session.status !== "running" &&
      event.session.sequence > stream.sequence
    )
      void attach(event.session.id)
    return
  }
  if (event.type === "removed") {
    const state = terminalStore.get()
    const previousGroup = terminalGroupFor(state.groups, event.sessionId)
    streams.delete(event.sessionId)
    setSessions(
      state.sessions.filter((session) => session.id !== event.sessionId)
    )
    terminalStore.set({
      activeId:
        state.activeId !== event.sessionId
          ? state.activeId
          : (previousGroup?.sessionIds.find((id) => id !== event.sessionId) ??
            terminalStore
              .get()
              .sessions.find(
                (session) =>
                  session.cwd ===
                  state.sessions.find((s) => s.id === event.sessionId)?.cwd
              )?.id),
      snapshots: { ...state.snapshots, [event.sessionId]: undefined },
      faults: { ...state.faults, [event.sessionId]: undefined },
      closingId:
        state.closingId === event.sessionId ? undefined : state.closingId,
    })
    syncVisible()
  }
}
async function load() {
  const generation = ++loadGeneration
  try {
    const sessions = (await getMako().terminalList()).sort(
      (a, b) => b.createdAt - a.createdAt
    )
    if (generation !== loadGeneration || !subscribers) return
    setSessions(sessions)
    const current = terminalStore.get().activeId
    const activeId =
      sessions.find((session) => session.id === current)?.id ??
      (desiredWorkspace
        ? runningTerminalForWorkspace(sessions, desiredWorkspace)?.id
        : undefined) ??
      sessions.find((session) => session.status === "running")?.id ??
      sessions[0]?.id
    terminalStore.set({ phase: "ready", activeId, fault: undefined })
    syncVisible()
  } catch (error) {
    if (generation === loadGeneration)
      terminalStore.set({
        phase: "error",
        fault: error instanceof Error ? error.message : String(error),
      })
  }
}

export const terminalActions = {
  mount() {
    subscribers++
    if (subscribers === 1) {
      if (!hasBridge())
        terminalStore.set({
          phase: "error",
          fault: "The terminal is available in the desktop app.",
        })
      else {
        terminalStore.set({ phase: "connecting", fault: undefined })
        const stopTerminal = getMako().onTerminalEvent(applyEvent)
        const stopHost = getMako().onEvent((event) => {
          if (event.type === "host-disconnected")
            applyEvent({
              type: "connection",
              state: "disconnected",
              error: event.message,
            })
          if (event.type === "host-reconnected")
            applyEvent({ type: "connection", state: "ready" })
        })
        unsubscribe = () => {
          stopTerminal()
          stopHost()
        }
        void load()
      }
    }
    return () => {
      if (--subscribers !== 0) return
      loadGeneration++
      unsubscribe?.()
      for (const id of streams.keys())
        void getMako()
          .terminalDetach(id)
          .catch(() => {})
      streams.clear()
    }
  },
  refresh() {
    for (const id of streams.keys())
      void getMako()
        .terminalDetach(id)
        .catch(() => {})
    streams.clear()
    terminalStore.set({ phase: "connecting", fault: undefined })
    return load()
  },
  async ensureWorkspace(cwd: string) {
    desiredWorkspace = cwd
    if (
      terminalStore.get().phase !== "ready" ||
      creatingWorkspace ||
      terminalStore.get().creating
    )
      return
    creatingWorkspace = true
    try {
      while (desiredWorkspace) {
        const target = desiredWorkspace
        desiredWorkspace = undefined
        const state = terminalStore.get()
        const selected = state.sessions.find(
          (session) => session.id === state.activeId && session.cwd === target
        )
        if (selected) continue
        const existing =
          runningTerminalForWorkspace(state.sessions, target) ??
          state.sessions.find((s) => s.cwd === target)
        if (existing) terminalActions.activate(existing.id)
        else await terminalActions.create(target)
      }
    } finally {
      creatingWorkspace = false
    }
  },
  activate(sessionId: string) {
    if (!terminalStore.get().sessions.some((s) => s.id === sessionId)) return
    terminalStore.set({ activeId: sessionId })
    syncVisible()
  },
  async create(
    cwd: string,
    cols = 80,
    rows = 24,
    split?: { sessionId: string; orientation: TerminalGroup["orientation"] }
  ) {
    if (terminalStore.get().creating) return
    if (
      split &&
      (terminalGroupFor(terminalStore.get().groups, split.sessionId)?.sessionIds
        .length ?? 0) >= MAX_TERMINAL_PANES
    )
      return
    terminalStore.set({ creating: true })
    try {
      const session = await getMako().terminalCreate({ cwd, cols, rows })
      upsert(session)
      const group =
        split && terminalGroupFor(terminalStore.get().groups, split.sessionId)
      if (group && group.sessionIds.length < MAX_TERMINAL_PANES) {
        const groups = terminalStore
          .get()
          .groups.filter((g) => !g.sessionIds.includes(session.id))
          .map((g) =>
            g.id === group.id
              ? {
                  ...g,
                  orientation: split.orientation,
                  sessionIds: [...g.sessionIds, session.id],
                }
              : g
          )
        terminalStore.set({ groups })
        setPref("terminalGroups", groups)
      }
      terminalActions.activate(session.id)
      await streams.get(session.id)?.attachment
      return session.id
    } catch (error) {
      terminalStore.set({
        fault: error instanceof Error ? error.message : String(error),
      })
    } finally {
      terminalStore.set({ creating: false })
      if (desiredWorkspace)
        void terminalActions.ensureWorkspace(desiredWorkspace)
    }
  },
  split(
    orientation: TerminalGroup["orientation"],
    sessionId = terminalStore.get().activeId
  ) {
    const session = terminalStore.get().sessions.find((s) => s.id === sessionId)
    if (session)
      return terminalActions.create(session.cwd, session.cols, session.rows, {
        sessionId: session.id,
        orientation,
      })
  },
  unsplit(sessionId: string) {
    const state = terminalStore.get()
    const groups = reconcileTerminalGroups(
      state.groups.map((g) => ({
        ...g,
        sessionIds: g.sessionIds.filter((id) => id !== sessionId),
      })),
      state.sessions
    )
    terminalStore.set({ groups, activeId: sessionId })
    setPref("terminalGroups", groups)
    syncVisible()
  },
  resync(sessionId = terminalStore.get().activeId) {
    if (sessionId) void attach(sessionId)
  },
  acknowledge(sessionId: string, sequence: number) {
    if (!streams.has(sessionId)) return
    void getMako()
      .terminalAcknowledge(sessionId, sequence)
      .catch(() => {
        if (streams.has(sessionId) && terminalStore.get().phase === "ready")
          void attach(sessionId)
      })
  },
  write(data: string, sessionId = terminalStore.get().activeId) {
    if (
      !sessionId ||
      terminalStore.get().phase !== "ready" ||
      !streams.has(sessionId) ||
      streams.get(sessionId)?.attachment
    )
      return
    if (
      terminalStore.get().sessions.find((s) => s.id === sessionId)?.status !==
      "running"
    )
      return
    void getMako()
      .terminalWrite(sessionId, data)
      .catch((error) =>
        setSessionFault(
          sessionId,
          error instanceof Error ? error.message : String(error)
        )
      )
  },
  resize(cols: number, rows: number, sessionId = terminalStore.get().activeId) {
    if (!sessionId) return
    void getMako()
      .terminalResize(sessionId, cols, rows)
      .catch((error) =>
        setSessionFault(
          sessionId,
          error instanceof Error ? error.message : String(error)
        )
      )
  },
  requestClose(sessionId = terminalStore.get().activeId) {
    const session = terminalStore.get().sessions.find((s) => s.id === sessionId)
    if (!session) return
    if (session.status === "running")
      terminalStore.set({ closingId: session.id })
    else void terminalActions.kill(session.id)
  },
  cancelClose() {
    terminalStore.set({ closingId: undefined })
  },
  async kill(sessionId: string) {
    try {
      await getMako().terminalKill(sessionId)
      applyEvent({ type: "removed", sessionId })
    } catch (error) {
      setSessionFault(
        sessionId,
        error instanceof Error ? error.message : String(error)
      )
    }
  },
}
