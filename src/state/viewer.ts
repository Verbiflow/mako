import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import { acpStore } from "@/state/acp-state"
import type { ProposedPlan } from "@mako/sessions/content"
import type { FileContents, GitDiff } from "@/lib/types"
import type { TranscriptDepth, TranscriptSource } from "../../electron/contracts/transcript-document.ts"

/**
 * Files open for reading in the renderer workbench.
 *
 * Documents and pane layout deliberately live only for this launch. Callers
 * still see the active document through the original path/file/diff fields,
 * while the workbench can retain pinned tabs and two independent panes.
 */

export type ViewerSplit = "right" | "down"
export type ViewerRenderMode = "source" | "preview"

/**
 * The Session a transcript tab reads: its conversation while that is open
 * here, else its native record. Either can come or go while the tab is open.
 */
export interface TranscriptOf {
  live?: string
  path?: string
  depth: TranscriptDepth
  harness?: string
}

/**
 * A proposed plan open as a document. The tab follows the plan in its
 * conversation, revisions and streaming included; `snapshot` is what it
 * shows once that conversation is gone.
 */
export interface PlanOf {
  id: string
  source: { liveId?: string; threadPath?: string }
  snapshot: ProposedPlan
}

export interface ViewerDocument {
  id: string
  kind: "file" | "diff" | "transcript" | "plan"
  path: string
  liveId?: string
  threadPath?: string
  title: string
  file?: FileContents
  diff?: { title: string; diffs: GitDiff[]; note?: string }
  transcript?: TranscriptOf
  plan?: PlanOf
  loading: boolean
  error?: string
  line?: number
  pinned: boolean
  renderMode: ViewerRenderMode
}

/** A Session shown in a pane: its Thread, and its tab (a Session ID, or the new tab's draft ID). */
export interface PaneSession {
  thread: string
  tab: string
}

export type PaneSide = "left" | "right" | "up" | "down"

export interface ViewerPane {
  id: string
  tabIds: string[]
  activeId?: string
  /**
   * What this pane's chat shows while another pane has focus. The focused
   * pane shows the window's active conversation instead, and keeps this only
   * until that conversation catches up with it.
   */
  session?: PaneSession
}

export interface ViewerState {
  /** Workspace-relative path, or undefined when nothing is open. */
  path?: string
  file?: FileContents
  loading: boolean
  error?: string
  /**
   * The line to land on, when the file was opened from a search hit.
   *
   * Carried as state rather than scrolled imperatively because the content
   * arrives after the open: whoever renders it scrolls once it exists.
   */
  line?: number
  /** Diffs on the center stage instead of a file, when set. */
  diff?: { title: string; diffs: GitDiff[]; note?: string }
  documents: Record<string, ViewerDocument>
  panes: ViewerPane[]
  focusedPaneId: string
  split: ViewerSplit
}

export const AGENT_TAB_ID = "agent"
const PRIMARY_PANE = "primary"
/** Every split makes a new ID: after the first pane closes, the one left may be any. */
let paneSequence = 0
const newPaneId = () => `pane-${++paneSequence}`
const initialState: ViewerState = {
  loading: false,
  documents: {},
  panes: [{ id: PRIMARY_PANE, tabIds: [AGENT_TAB_ID], activeId: AGENT_TAB_ID }],
  focusedPaneId: PRIMARY_PANE,
  split: "right",
}

export const viewerStore = createStore<ViewerState>(initialState)
export const useViewer = createHook(viewerStore)

/** Bumped per document read so a slow result for a closed tab cannot land. */
let generation = 0
let documentSequence = 0
let watchGeneration = 0
const requests = new Map<string, number>()

function activeDocument(
  documents: Record<string, ViewerDocument>,
  panes: ViewerPane[],
  focusedPaneId: string
): ViewerDocument | undefined {
  const pane =
    panes.find((candidate) => candidate.id === focusedPaneId) ?? panes[0]
  return pane?.activeId ? documents[pane.activeId] : undefined
}

function commit(
  documents: Record<string, ViewerDocument>,
  panes: ViewerPane[],
  focusedPaneId: string,
  split = viewerStore.get().split
) {
  const active = activeDocument(documents, panes, focusedPaneId)
  viewerStore.set({
    documents,
    panes,
    focusedPaneId,
    split,
    path: active?.path,
    file: active?.kind === "file" ? active.file : undefined,
    loading: active?.loading ?? false,
    error: active?.error,
    line: active?.line,
    diff: active?.kind === "diff" ? active.diff : undefined,
  })
}

function beginRequest(id: string) {
  const mine = ++generation
  requests.set(id, mine)
  return mine
}

function requestIsCurrent(id: string, mine: number) {
  return requests.get(id) === mine && Boolean(viewerStore.get().documents[id])
}

function updateDocument(id: string, update: Partial<ViewerDocument>) {
  const state = viewerStore.get()
  const current = state.documents[id]
  if (!current) return
  commit(
    { ...state.documents, [id]: { ...current, ...update } },
    state.panes,
    state.focusedPaneId
  )
}

/** Transcript tabs keep reading a Session whose record moved. */
export function followMovedTranscripts(from: string, to: string) {
  for (const document of Object.values(viewerStore.get().documents))
    if (document.kind === "transcript" && document.transcript?.path === from)
      updateDocument(document.id, { path: `transcript:${to}`, transcript: { ...document.transcript, path: to } })
}

function removeUnreferenced(
  documents: Record<string, ViewerDocument>,
  panes: ViewerPane[]
) {
  const referenced = new Set(panes.flatMap((pane) => pane.tabIds))
  const next = { ...documents }
  for (const id of Object.keys(next)) {
    if (referenced.has(id)) continue
    requests.delete(id)
    delete next[id]
  }
  return next
}

function placeDocument(
  create: (id: string, previous?: ViewerDocument) => ViewerDocument,
  match: (document: ViewerDocument) => boolean
): ViewerDocument {
  const state = viewerStore.get()
  const existing = Object.values(state.documents).find(match)
  if (existing) {
    const pane =
      state.panes.find(
        (candidate) =>
          candidate.id === state.focusedPaneId &&
          candidate.tabIds.includes(existing.id)
      ) ??
      state.panes.find((candidate) => candidate.tabIds.includes(existing.id))
    const next = create(existing.id, existing)
    const panes = state.panes.map((candidate) =>
      candidate.id === pane?.id
        ? { ...candidate, activeId: existing.id }
        : candidate
    )
    commit(
      { ...state.documents, [existing.id]: next },
      panes,
      pane?.id ?? state.focusedPaneId
    )
    return next
  }

  const id = `viewer-${++documentSequence}`
  const next = create(id)
  const focused =
    state.panes.find((candidate) => candidate.id === state.focusedPaneId) ??
    state.panes[0]
  const previewId = focused.tabIds.find(
    (tabId) => state.documents[tabId] && !state.documents[tabId].pinned
  )
  const tabIds = previewId
    ? focused.tabIds.map((tabId) => (tabId === previewId ? id : tabId))
    : [...focused.tabIds, id]
  const panes = state.panes.map((pane) =>
    pane.id === focused.id ? { ...pane, tabIds, activeId: id } : pane
  )
  const documents = removeUnreferenced(
    { ...state.documents, [id]: next },
    panes
  )
  commit(documents, panes, focused.id)
  return next
}

async function watchActiveFile() {
  if (!hasBridge()) return
  const mine = ++watchGeneration
  const state = viewerStore.get()
  const active = activeDocument(
    state.documents,
    state.panes,
    state.focusedPaneId
  )
  if (mine !== watchGeneration) return
  if (active?.kind !== "file" || active.threadPath) {
    await getMako().unwatchFile()
    return
  }
  await getMako().watchFile(active.path)
}

export const viewer = {
  async open(
    path: string,
    line?: number,
    threadPath?: string,
    liveId?: string
  ) {
    if (!hasBridge()) return
    const document = placeDocument(
      (id, previous) => ({
        id,
        kind: "file",
        path,
        threadPath,
        liveId,
        title: path.split("/").at(-1) ?? path,
        file: previous?.kind === "file" ? previous.file : undefined,
        loading:
          previous?.kind === "file" && previous.file !== undefined
            ? false
            : true,
        error: undefined,
        line,
        pinned: previous?.pinned ?? false,
        renderMode:
          previous?.renderMode ?? (hasRichPreview(path) ? "preview" : "source"),
      }),
      (candidate) =>
        candidate.kind === "file" &&
        candidate.path === path &&
        candidate.threadPath === threadPath &&
        candidate.liveId === liveId
    )
    const mine = beginRequest(document.id)
    // Live from here: the active writer lands without a manual reopen.
    void watchActiveFile()
    try {
      const file = liveId
        ? await getMako().readLiveFile(liveId, path)
        : threadPath
          ? await getMako().readThreadFile(threadPath, path)
          : await getMako().readFile(path)
      if (!requestIsCurrent(document.id, mine)) return
      const patch: Partial<ViewerDocument> = {file, loading: false}
      if (!document.file && file.artifactPreview && line === undefined) patch.renderMode = "preview"
      // A request that named a file without its directory is answered by the
      // file the host found. Take its path, or the tab's header, its refresh,
      // its `@` mention and Open in your editor would all keep naming
      // something that is not on disk.
      if (file.path !== document.path) {
        patch.path = file.path
        patch.title = file.path.split("/").at(-1) ?? file.path
      }
      updateDocument(document.id, patch)
    } catch (error) {
      if (!requestIsCurrent(document.id, mine)) return
      updateDocument(document.id, {
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  /** Re-read an open file in place, without flashing its existing contents. */
  async refresh(path?: string) {
    if (!hasBridge()) return
    const state = viewerStore.get()
    const active = activeDocument(
      state.documents,
      state.panes,
      state.focusedPaneId
    )
    const targetPath =
      path ?? (active?.kind === "file" ? active.path : undefined)
    if (!targetPath) return
    const targets = Object.values(state.documents).filter(
      (document) => document.kind === "file" && document.path === targetPath
    )
    if (targets.length === 0) return
    await Promise.all(
      targets.map(async (target) => {
        const token = beginRequest(target.id)
        try {
          const file = target.liveId
            ? await getMako().readLiveFile(target.liveId, targetPath)
            : target.threadPath
              ? await getMako().readThreadFile(target.threadPath, targetPath)
              : await getMako().readFile(targetPath)
          if (requestIsCurrent(target.id, token))
            updateDocument(target.id, { file, error: undefined })
        } catch {
          // A transient read failure mid-write resolves on the next event.
        }
      })
    )
  },

  /**
   * A diff opens in the same tab model as a file, so history can remain beside
   * the conversation and can be pinned or split without a second viewer path.
   */
  async openDiff(
    title: string,
    load: () => Promise<{ diffs: GitDiff[]; note?: string }>
  ) {
    if (!hasBridge()) return
    const document = placeDocument(
      (id, previous) => ({
        id,
        kind: "diff",
        path: title,
        title,
        diff: previous?.kind === "diff" ? previous.diff : undefined,
        loading: true,
        error: undefined,
        pinned: previous?.pinned ?? false,
        renderMode: "source",
      }),
      (candidate) => candidate.kind === "diff" && candidate.path === title
    )
    const mine = beginRequest(document.id)
    void watchActiveFile()
    try {
      const { diffs, note } = await load()
      if (!requestIsCurrent(document.id, mine)) return
      updateDocument(document.id, {
        diff: { title, diffs, note },
        loading: false,
      })
    } catch (error) {
      if (!requestIsCurrent(document.id, mine)) return
      updateDocument(document.id, {
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  /**
   * A Session's transcript as a document tab, read again as the Session
   * goes on; see `readTranscript`.
   */
  async openTranscript(of: Omit<TranscriptOf, "depth">, title: string) {
    if (!hasBridge() || (!of.live && !of.path)) return
    const key = `transcript:${of.path ?? of.live}`
    const document = placeDocument(
      (id, previous) => ({
        id,
        kind: "transcript",
        path: key,
        title,
        transcript: { ...previous?.transcript, ...of, depth: previous?.transcript?.depth ?? "concise" },
        file: previous?.file,
        loading: !previous?.file,
        error: undefined,
        pinned: previous?.pinned ?? false,
        renderMode: previous?.renderMode ?? "preview",
      }),
      (candidate) => candidate.kind === "transcript" && (candidate.path === key || (of.live !== undefined && candidate.transcript?.live === of.live))
    )
    void watchActiveFile()
    await viewer.readTranscript(document.id)
  },

  /**
   * Read a transcript tab's Session as it is now: from its conversation
   * while that is open here, else from its native record. A read that fails
   * after one succeeded keeps what the tab shows.
   */
  async readTranscript(id: string, live?: boolean): Promise<void> {
    const document = viewerStore.get().documents[id]
    const of = document?.transcript
    if (!document || !of) return
    const source: TranscriptSource | undefined =
      of.live && live !== false && acpStore.get().conversations[of.live] ? { kind: "live", id: of.live } : of.path ? { kind: "file", path: of.path } : undefined
    if (!source) return
    const mine = beginRequest(id)
    try {
      const read = await getMako().transcriptDocument(source, of.depth)
      if (!requestIsCurrent(id, mine)) return
      updateDocument(id, {
        file: { path: "transcript.md", contents: read.markdown, size: read.markdown.length, binary: false, truncated: false },
        title: read.title ?? document.title,
        transcript: { ...of, harness: read.harness },
        loading: false,
        error: undefined,
      })
    } catch (error) {
      if (!requestIsCurrent(id, mine)) return
      if (source.kind === "live" && of.path) return viewer.readTranscript(id, false)
      updateDocument(id, document.file ? { loading: false } : { loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  /**
   * A plan as a document tab, like a Markdown file: preview first, source a
   * click away. Opening it again shows the tab it already has, pinned so a
   * file preview doesn't replace it.
   */
  openPlan(plan: ProposedPlan, source: PlanOf["source"], title: string) {
    placeDocument(
      (id, previous) => ({
        id,
        kind: "plan",
        path: `plan:${plan.id}`,
        title,
        plan: { id: plan.id, source, snapshot: plan },
        loading: false,
        error: undefined,
        pinned: true,
        renderMode: previous?.renderMode ?? "preview",
      }),
      (candidate) => candidate.kind === "plan" && candidate.plan?.id === plan.id
    )
    if (hasBridge()) void getMako().unwatchFile()
  },

  /** Keep a plan tab's fallback and title current while its conversation is open. */
  updatePlan(id: string, plan: ProposedPlan, title: string) {
    const document = viewerStore.get().documents[id]
    if (!document?.plan || (document.plan.snapshot === plan && document.title === title)) return
    updateDocument(id, { title, plan: { ...document.plan, snapshot: plan } })
  },

  setTranscriptDepth(id: string, depth: TranscriptDepth) {
    const of = viewerStore.get().documents[id]?.transcript
    if (!of || of.depth === depth) return
    updateDocument(id, { transcript: { ...of, depth } })
    void viewer.readTranscript(id)
  },

  showAgent() {
    const state = viewerStore.get()
    const holds = (candidate: ViewerPane) => candidate.tabIds.includes(AGENT_TAB_ID)
    const pane =
      state.panes.find((candidate) => candidate.id === state.focusedPaneId && holds(candidate)) ??
      state.panes.find(holds)
    if (!pane) return
    commit(
      state.documents,
      state.panes.map((candidate) =>
        candidate.id === pane.id
          ? { ...candidate, activeId: AGENT_TAB_ID }
          : candidate
      ),
      pane.id
    )
    if (hasBridge()) void getMako().unwatchFile()
  },

  activate(paneId: string, id: string) {
    if (id === AGENT_TAB_ID) {
      viewer.showAgent()
      return
    }
    const state = viewerStore.get()
    const pane = state.panes.find((candidate) => candidate.id === paneId)
    if (!pane?.tabIds.includes(id)) return
    commit(
      state.documents,
      state.panes.map((candidate) =>
        candidate.id === paneId ? { ...candidate, activeId: id } : candidate
      ),
      paneId
    )
    void watchActiveFile()
    const document = state.documents[id]
    if (document?.kind === "file") void viewer.refresh(document.path)
    if (document?.kind === "transcript") void viewer.readTranscript(document.id)
  },

  focusPane(paneId: string) {
    const state = viewerStore.get()
    if (
      state.focusedPaneId === paneId ||
      !state.panes.some((pane) => pane.id === paneId)
    )
      return
    commit(state.documents, state.panes, paneId)
    void watchActiveFile()
    const pane = state.panes.find((candidate) => candidate.id === paneId)
    const document = pane?.activeId ? state.documents[pane.activeId] : undefined
    if (document?.kind === "file") void viewer.refresh(document.path)
    if (document?.kind === "transcript") void viewer.readTranscript(document.id)
  },

  pin(id: string) {
    const state = viewerStore.get()
    const document = state.documents[id]
    if (!document || document.pinned) return
    commit(
      { ...state.documents, [id]: { ...document, pinned: true } },
      state.panes,
      state.focusedPaneId
    )
  },

  setRenderMode(id: string, renderMode: ViewerRenderMode) {
    updateDocument(id, { renderMode })
  },

  splitPane(split: ViewerSplit) {
    const state = viewerStore.get()
    if (state.panes.length === 2) {
      commit(state.documents, state.panes, state.focusedPaneId, split)
      return
    }
    const source =
      state.panes.find((pane) => pane.id === state.focusedPaneId) ??
      state.panes[0]
    if (!source.activeId || source.activeId === AGENT_TAB_ID) return
    const secondary: ViewerPane = {
      id: newPaneId(),
      tabIds: [source.activeId],
      activeId: source.activeId,
    }
    commit(state.documents, [...state.panes, secondary], secondary.id, split)
    void watchActiveFile()
  },

  /**
   * Open a second pane holding a chat, on `side` of the one there is. Focus
   * doesn't move; `bindPanes` decides it. Returns the new pane's ID, or null
   * when there are two panes already.
   */
  openAgentPane(side: PaneSide, session: PaneSession): string | null {
    const state = viewerStore.get()
    if (state.panes.length !== 1) return null
    const pane: ViewerPane = { id: newPaneId(), tabIds: [AGENT_TAB_ID], activeId: AGENT_TAB_ID, session }
    const before = side === "left" || side === "up"
    commit(
      state.documents,
      before ? [pane, ...state.panes] : [...state.panes, pane],
      state.focusedPaneId,
      side === "left" || side === "right" ? "right" : "down"
    )
    return pane.id
  },

  /** Set what panes show without focus, show their chats, and focus one, in one change. */
  bindPanes(sessions: Readonly<Record<string, PaneSession | undefined>>, focusedPaneId: string) {
    const state = viewerStore.get()
    if (!state.panes.some((pane) => pane.id === focusedPaneId)) return
    const panes = state.panes.map((pane) => {
      if (!(pane.id in sessions)) return pane
      const tabIds = pane.tabIds.includes(AGENT_TAB_ID) ? pane.tabIds : [AGENT_TAB_ID, ...pane.tabIds]
      return { ...pane, tabIds, activeId: pane.id === focusedPaneId ? AGENT_TAB_ID : pane.activeId ?? AGENT_TAB_ID, session: sessions[pane.id] }
    })
    commit(state.documents, panes, focusedPaneId)
    void watchActiveFile()
  },

  closeTab(paneId: string, id: string) {
    if (id === AGENT_TAB_ID) return
    const state = viewerStore.get()
    const pane = state.panes.find((candidate) => candidate.id === paneId)
    const index = pane?.tabIds.indexOf(id) ?? -1
    if (!pane || index < 0) return
    const tabIds = pane.tabIds.filter((tabId) => tabId !== id)
    let panes = state.panes.map((candidate) =>
      candidate.id === paneId
        ? {
            ...candidate,
            tabIds,
            activeId:
              candidate.activeId === id
                ? tabIds[Math.min(index, tabIds.length - 1)]
                : candidate.activeId,
          }
        : candidate
    )
    let focusedPaneId = state.focusedPaneId
    if (tabIds.length === 0 && panes.length === 2) {
      panes = panes.filter((candidate) => candidate.id !== paneId)
      focusedPaneId = panes[0].id
    } else if (focusedPaneId === paneId && tabIds.length === 0) {
      focusedPaneId = paneId
    }
    const documents = removeUnreferenced(state.documents, panes)
    commit(documents, panes, focusedPaneId)
    void watchActiveFile()
  },

  closePane(paneId: string) {
    const state = viewerStore.get()
    if (state.panes.length === 1) return
    const panes = state.panes.filter((pane) => pane.id !== paneId)
    if (panes.length === state.panes.length) return
    const documents = removeUnreferenced(state.documents, panes)
    commit(documents, panes, panes[0].id)
    void watchActiveFile()
  },

  close() {
    if (hasBridge()) void getMako().unwatchFile()
    watchGeneration += 1
    generation += 1
    requests.clear()
    // Files belong to the project; chats don't. Two Threads side by side
    // outlive a project switch, which moving focus between them can cause.
    const state = viewerStore.get()
    const chats = state.panes
      .filter((pane) => pane.tabIds.includes(AGENT_TAB_ID))
      .map((pane) => ({ ...pane, tabIds: [AGENT_TAB_ID], activeId: AGENT_TAB_ID }))
    const panes = chats.length ? chats : [{ id: PRIMARY_PANE, tabIds: [AGENT_TAB_ID], activeId: AGENT_TAB_ID }]
    const focused = panes.some((pane) => pane.id === state.focusedPaneId) ? state.focusedPaneId : panes[0].id
    commit({}, panes, focused, panes.length > 1 ? state.split : "right")
  },
}

function hasRichPreview(path: string) {
  return /\.(?:csv|md|markdown|mdx|tsv)$/i.test(path)
}

export function viewerFileUrl(url: string): string {
  return getMako().resolveFileUrl(url)
}
