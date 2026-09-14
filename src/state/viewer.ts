import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import type { FileContents, GitDiff } from "@/lib/types"

/**
 * Files open for reading in the renderer workbench.
 *
 * Documents and pane layout deliberately live only for this launch. Callers
 * still see the active document through the original path/file/diff fields,
 * while the workbench can retain pinned tabs and two independent panes.
 */

export type ViewerSplit = "right" | "down"
export type ViewerRenderMode = "source" | "preview"

export interface ViewerDocument {
  id: string
  kind: "file" | "diff"
  path: string
  liveId?: string
  threadPath?: string
  title: string
  file?: FileContents
  diff?: { title: string; diffs: GitDiff[]; note?: string }
  loading: boolean
  error?: string
  line?: number
  pinned: boolean
  renderMode: ViewerRenderMode
}

export interface ViewerPane {
  id: string
  tabIds: string[]
  activeId?: string
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

  showAgent() {
    const state = viewerStore.get()
    const pane = state.panes.find((candidate) =>
      candidate.tabIds.includes(AGENT_TAB_ID)
    )
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
      id: "secondary",
      tabIds: [source.activeId],
      activeId: source.activeId,
    }
    commit(state.documents, [...state.panes, secondary], secondary.id, split)
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
    commit(
      {},
      [{ id: PRIMARY_PANE, tabIds: [AGENT_TAB_ID], activeId: AGENT_TAB_ID }],
      PRIMARY_PANE,
      "right"
    )
  },
}

function hasRichPreview(path: string) {
  return /\.(?:csv|md|markdown|mdx|tsv)$/i.test(path)
}

export function viewerFileUrl(url: string): string {
  return getMako().resolveFileUrl(url)
}
