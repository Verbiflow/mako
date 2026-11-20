import { toast } from "sonner"
import { getMako, hasBridge } from "@/lib/bridge"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { threadFolderKey, workedFolderRanks } from "@/lib/thread-folders"
import { cloneParent, tildePath } from "@/lib/project-query"
import type { ThreadRef } from "@/lib/types"
import { chatFolderOf } from "@mako/host/contracts/chat-folders"
import type { CloneProgress, CloneState, FolderBrowse, FoundCheckout, FoundCheckouts } from "@mako/host/contracts/projects"
import { chatFoldersStore, refreshChatFolders } from "@/state/chat-folders"
import { prefsStore, setPref } from "@/state/prefs"
import { railRanksStore } from "@/state/rail-ranks"
import { actions, store } from "@/state/session"
import { acpStore, activeAcp } from "@/state/acp"
import { openSessionDraft, sessionDraftKey, threadGroupsStore } from "@/state/thread-groups"
import { createHook, createStore } from "@/state/store"
import { useMemo } from "react"
import { useChatFolders } from "@/state/chat-folders"
import { useRailRanks } from "@/state/rail-ranks"
import { useThreads } from "@/state/thread-store"
import { threads } from "@/state/threads"
import { threadsStore } from "@/state/thread-store"
import { draftText, projectDraftKey, rememberDraft } from "@/state/drafts"

/**
 * Open project: the palette that starts work in a folder (a recent project, a checkout found on this Mac, a path
 * typed, a GitHub repository cloned, a new empty folder), and the clones it started, which keep going after it closes.
 */

/** What the palette is asking for: any project, a repository to clone, or a new project's name. */
export type OpenProjectMode = "open" | "clone" | "create"

/** A clone the window started, as its host reports it. `background`: the palette closed on it; a toast follows it. */
export interface CloneView extends CloneProgress {
  background: boolean
  openWhenReady: boolean
  into: string
}

interface OpenProjectState {
  open: boolean
  mode: OpenProjectMode
  /** What the palette opens with typed in it. */
  query: string
  /** Bumped each time it's asked to open, so an open palette takes the new query. */
  opened: number
  found: FoundCheckouts | undefined
  /** The host's home folder, once an answer says it. */
  home: string | undefined
  clones: Record<string, CloneView>
  /** A chat being turned into a project (Turn into project…): Create moves its folder there instead of making one. */
  adopt?: { folder: string; title: string }
}

export const openProjectStore = createStore<OpenProjectState>({ open: false, mode: "open", query: "", opened: 0, found: undefined, home: undefined, clones: {} })
export const useOpenProject = createHook(openProjectStore)

/** A folder the person has worked in through Mako, hidden ones included. */
export interface RecentProject {
  path: string
  name: string
  /** When they last worked there, in ms. */
  at: number
  /** Its newest Thread here, for ⌘↩. */
  latest?: ThreadRef
}

/** Recents the palette shows with nothing typed. */
export const RECENT_SHOWN = 8
/** Found checkouts it shows with nothing typed. */
export const FOUND_SHOWN = 5
/** macOS's Privacy & Security pane for files and folders. */
const FILES_PRIVACY = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"

/**
 * Every folder with a Mako Thread, newest work first: what the rail ranks folders by (`workedFolderRanks` and the
 * window's kept ranks), so the palette and the rail agree. Chats and Threads in no folder aren't projects.
 */
export function recentProjects(refs: readonly ThreadRef[] = threadsStore.get().threads, kept: Readonly<Record<string, string>> = railRanksStore.get().folders, chatRoot = chatFoldersStore.get().root): RecentProject[] {
  const worked = workedFolderRanks({ refs, live: [], owners: [] })
  const at = new Map<string, number>()
  for (const [key, time] of [...Object.entries(worked), ...Object.entries(kept)]) {
    if (!key || key === "~" || !key.startsWith("/")) continue
    if (chatRoot && chatFolderOf(key, chatRoot) !== undefined) continue
    at.set(key, Math.max(at.get(key) ?? 0, Date.parse(time) || 0))
  }
  const latest = new Map<string, ThreadRef>()
  for (const ref of refs) {
    const key = threadFolderKey(ref)
    const held = latest.get(key)
    if (!held || (ref.updatedAt ?? "") > (held.updatedAt ?? "")) latest.set(key, ref)
  }
  return [...at]
    .sort((a, b) => b[1] - a[1])
    .map(([path, time]) => ({ path, name: path.split("/").filter(Boolean).at(-1) ?? path, at: time, latest: latest.get(path) }))
}

/** `recentProjects`, kept current as Threads, the rail's ranks and the chats' folder change. */
export function useRecentProjects(): RecentProject[] {
  const refs = useThreads((state) => state.threads)
  const kept = useRailRanks((state) => state.folders)
  const chatRoot = useChatFolders((state) => state.root)
  return useMemo(() => recentProjects(refs, kept, chatRoot), [refs, kept, chatRoot])
}

/** Checkouts found on this Mac that Mako has no Thread in, those with a remote first, the newest first within each. */
export function newFound(found: readonly FoundCheckout[], recent: readonly RecentProject[]): FoundCheckout[] {
  const known = new Set(recent.map((each) => each.path))
  return found
    .filter((each) => !known.has(each.path))
    .sort((a, b) => Number(Boolean(b.remote)) - Number(Boolean(a.remote)) || b.touchedAt - a.touchedAt)
}

/** Where a clone or a new project goes: the "Clone into" setting, else where most recent projects sit, else home. */
export function cloneDirectory(recent: readonly RecentProject[] = recentProjects()): string | undefined {
  return prefsStore.get().cloneInto ?? cloneParent(recent.map((each) => each.path), openProjectStore.get().home)
}

export function openProjectPalette(options: { query?: string; mode?: OpenProjectMode; adopt?: { folder: string; title: string } } = {}): void {
  const { opened } = openProjectStore.get()
  openProjectStore.set({ open: true, mode: options.mode ?? "open", query: options.query ?? "", opened: opened + 1, adopt: options.adopt })
  void loadFound()
}

/** The palette closes; a clone still going moves to a toast. */
export function closeProjectPalette(): void {
  openProjectStore.set({ open: false, adopt: undefined })
  for (const clone of Object.values(openProjectStore.get().clones))
    if (!clone.background && clone.state.kind === "cloning") {
      setClone(clone.id, { background: true })
      cloneToast(openProjectStore.get().clones[clone.id]!)
    }
}

let listening = false
/** Follows the host's answers about scans and clones, once, from the first time anything here asks. */
function listen(): void {
  if (listening || !hasBridge()) return
  listening = true
  getMako().onEvent((event) => {
    if (event.type === "folders-found") openProjectStore.set({ found: event.found, home: event.found.home })
    if (event.type === "project-clone") cloneChanged(event.clone)
  })
}

/** Guarded folders (Desktop, Documents, Downloads) worth scanning: the person said so, or a recent project is there. */
function guardedWithin(home: string | undefined): string[] {
  if (!home) return []
  const guarded = ["Desktop", "Documents", "Downloads"].map((name) => `${home}/${name}`)
  if (prefsStore.get().scanGuardedFolders) return guarded
  const recent = recentProjects().map((each) => each.path)
  return guarded.filter((root) => recent.some((path) => path.startsWith(`${root}/`)))
}

/** Asks the host what its scan found; it answers at once, and a scan it starts lands as `folders-found`. */
export async function loadFound(): Promise<void> {
  if (!hasBridge()) return
  listen()
  try {
    const found = await getMako().foundCheckouts({ within: guardedWithin(openProjectStore.get().home) })
    openProjectStore.set({ found, home: found.home })
    // Home wasn't known for the first ask: ask again with the guarded folders a recent project is in.
    if (guardedWithin(found.home).length && found.skipped.some((path) => guardedWithin(found.home).includes(path))) {
      const again = await getMako().foundCheckouts({ within: guardedWithin(found.home) })
      openProjectStore.set({ found: again })
    }
  } catch {
    // A host that can't scan (an older one, a fixture desk) leaves the group out.
  }
}

/** The folders under a path being typed (`./` from `base`, the project on screen); undefined when the host can't say. */
export async function browseFolders(partialPath: string, base?: string): Promise<FolderBrowse | undefined> {
  if (!hasBridge()) return undefined
  try {
    const result = await getMako().browseFolders({ partialPath, base })
    if (!openProjectStore.get().home) openProjectStore.set({ home: result.home })
    return result
  } catch {
    // An older host, or a fixture desk, lists nothing: the typed path can still go to the chooser.
    return undefined
  }
}

/** Scan Desktop, Documents and Downloads too; macOS may ask the person first. */
export function scanGuardedFolders(): void {
  setPref("scanGuardedFolders", true)
  void loadFound()
}

export function openPrivacySettings(): void {
  void getMako().openUrl(FILES_PRIVACY)
}

/** A new Thread in `path`, the project in the rail and the composer focused. */
export function openProject(path: string): Promise<boolean> {
  closeProjectPalette()
  return actions.newConversationIn(path)
}

/** The project's newest Thread, or a new one when it has none. */
export function openLatestThread(project: RecentProject): void {
  closeProjectPalette()
  if (project.latest) threads.view(project.latest)
  else void actions.newConversationIn(project.path)
}

/** The system's folder chooser, opened at `defaultPath` or beside the most recent project. */
export function chooseInFinder(defaultPath?: string): void {
  closeProjectPalette()
  const parent = defaultPath ?? recentProjects()[0]?.path.split("/").slice(0, -1).join("/")
  void actions.pickWorkspace(parent || undefined)
}

/** The chooser, for a folder to clone into; undefined when the person cancels. */
export async function chooseCloneFolder(): Promise<string | undefined> {
  return (await getMako().pickFolder(cloneDirectory())) ?? undefined
}

function setClone(id: string, patch: Partial<CloneView>): void {
  const clones = openProjectStore.get().clones
  const held = clones[id]
  if (held) openProjectStore.set({ clones: { ...clones, [id]: { ...held, ...patch } } })
}

/** Clones `repository` (`owner/name` or an address) into `into`, and opens it when done if the palette still shows it. */
export async function startClone(repository: string, into: string): Promise<string> {
  listen()
  const id = crypto.randomUUID()
  const label = repository
  openProjectStore.set({
    clones: { ...openProjectStore.get().clones, [id]: { id, repository: label, path: `${into}/${label.split("/").at(-1) ?? ""}`, into, state: { kind: "cloning", phase: "Connecting" }, background: false, openWhenReady: false } },
  })
  try {
    const accepted = await getMako().cloneProject({ id, repository, into })
    setClone(id, { path: accepted.path })
    if (accepted.already) cloneChanged({ id, repository: label, path: accepted.path, state: { kind: "done", path: accepted.path } })
  } catch (error) {
    cloneChanged({ id, repository: label, path: `${into}/${label.split("/").at(-1) ?? ""}`, state: { kind: "failed", message: error instanceof Error ? error.message : String(error), signIn: false } })
  }
  return id
}

export function cancelClone(id: string): void {
  setClone(id, { state: { kind: "cancelled" } })
  void getMako().cancelClone(id).catch(() => undefined)
}

/** Forget a clone the palette showed: one that failed or was cancelled, once the person moves on. */
export function dropClone(id: string): void {
  const clones = { ...openProjectStore.get().clones }
  delete clones[id]
  openProjectStore.set({ clones })
}

function cloneChanged(progress: CloneProgress): void {
  const held = openProjectStore.get().clones[progress.id]
  if (!held) return
  // A cancel the window already showed stays cancelled.
  if (held.state.kind === "cancelled") return
  const next: CloneView = { ...held, ...progress, repository: held.repository }
  setClone(progress.id, next)
  const { state } = progress
  if (state.kind === "done") {
    if (!held.background && openProjectStore.get().open) {
      dropClone(progress.id)
      void openProject(state.path)
    } else if (held.openWhenReady) {
      dropClone(progress.id)
      toast.dismiss(toastId(progress.id))
      void actions.newConversationIn(state.path)
    } else cloneToast(next)
    return
  }
  if (held.background) cloneToast(next)
}

const toastId = (id: string) => `clone-${id}`

/** A clone the palette closed on, in a toast: its progress, then Open, or the one thing that fixes a failure. */
function cloneToast(clone: CloneView): void {
  const state: CloneState = clone.state
  const id = toastId(clone.id)
  const home = openProjectStore.get().home
  if (state.kind === "cloning") {
    const at = state.percent === undefined ? "" : ` · ${state.percent}%`
    if (clone.openWhenReady) toast(`Cloning ${clone.repository}${at}`, { id, description: "Opens when it's ready" })
    else toast(`Cloning ${clone.repository}${at}`, { id, duration: ACTION_TOAST_MS, action: { label: "Open when ready", onClick: () => {
      setClone(clone.id, { openWhenReady: true })
      cloneToast({ ...clone, openWhenReady: true })
    } } })
    return
  }
  if (state.kind === "done") {
    toast(`Cloned ${clone.repository} into ${tildePath(state.path, home)}`, { id, duration: ACTION_TOAST_MS, action: { label: "Open", onClick: () => {
      dropClone(clone.id)
      void actions.newConversationIn(state.path)
    } } })
    return
  }
  if (state.kind === "failed") {
    toast(state.message, { id, duration: ACTION_TOAST_MS, action: { label: "Try again", onClick: () => {
      dropClone(clone.id)
      openProjectPalette({ query: clone.repository })
    } } })
    return
  }
  toast.dismiss(id)
  dropClone(clone.id)
}

/** Makes a new project folder (a Git repository when `git`), and opens it; or, turning a chat into one, moves it there. */
export async function createProject(path: string, git: boolean): Promise<string | undefined> {
  const { adopt } = openProjectStore.get()
  if (adopt) return makeChatProject(adopt.folder, path)
  try {
    const made = await getMako().createProject({ path, git })
    await openProject(made.path)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Turn into project…: a chat's folder moves out of Mako's Chats to `path`, becomes a Git repository, and its Thread
 * goes on there, filed under the new project. Its conversations move with it, so the host refuses while one is mid-turn.
 */
export async function makeChatProject(folder: string, path: string): Promise<string | undefined> {
  try {
    const made = await getMako().makeChatProject({ folder, to: path })
    openProjectStore.set({ open: false, adopt: undefined })
    await refreshChatFolders([made.path])
    toast(`Moved to ${made.path}`, { description: "It's a project now, with its own repository." })
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Opens Create, named for the chat: Create moves the chat's folder there (`makeChatProject`). */
export function turnChatIntoProject(folder: string, title: string): void {
  openProjectPalette({ mode: "create", query: projectNameOf(title), adopt: { folder, title } })
}

/** A folder name from a chat's title: its words, lower-cased and joined by hyphens, at most 40 letters. */
export function projectNameOf(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "project"
}

/** The key the composer keeps the words on screen under, as it picks it (`Composer`). */
export function onScreenDraftKey(): string | undefined {
  const viewing = threadsStore.get()
  const cwd = store.get().meta?.cwd
  return activeAcp(acpStore.get())?.draftKey
    ?? viewing.opening?.ref.path ?? viewing.viewing?.ref.path
    ?? sessionDraftKey(openSessionDraft(threadGroupsStore.get()))
    ?? (cwd ? projectDraftKey(cwd) : undefined)
}

/**
 * The unsent draft on a new Thread's screen goes with it to the new Thread `open` makes (in another project, or a
 * chat): its words move, and the place it left keeps none. A draft already waiting there keeps its place, the moved
 * words after it.
 */
export async function moveDraft(open: () => Promise<boolean>): Promise<boolean> {
  const fromKey = onScreenDraftKey()
  const text = fromKey ? draftText(fromKey) : ""
  const opened = await open()
  const cwd = store.get().meta?.cwd
  if (!opened || !fromKey || !text.trim() || !cwd) return opened
  const toKey = projectDraftKey(cwd)
  if (toKey === fromKey) return opened
  const waiting = draftText(toKey)
  rememberDraft(toKey, waiting.trim() ? `${waiting}\n\n${text}` : text)
  rememberDraft(fromKey, "")
  return opened
}

/**
 * What a drop on the rail or the empty stage does: the first folder opens as a project; files go to the composer,
 * as a drop on the composer itself takes them. False when nothing in it was a folder on this Mac or a file.
 */
export function takeDrop(items: ReadonlyArray<{ file: File; folder: boolean }>): boolean {
  if (!hasBridge()) return false
  const folder = items.find((item) => item.folder)
  const path = folder ? getMako().pathForFile(folder.file) : null
  if (path) {
    void actions.newConversationIn(path)
    return true
  }
  const files = items.filter((item) => !item.folder).map((item) => item.file)
  if (!files.length) return false
  window.dispatchEvent(new CustomEvent("mako:attach", { detail: { files, text: (references: string) => references } }))
  return true
}

/** Settings › Git › Clone into: the chooser, opened where clones go now; the folder picked is where they go from then. */
export async function chooseCloneInto(): Promise<void> {
  const folder = await getMako().pickFolder(cloneDirectory())
  if (folder) setPref("cloneInto", folder)
}
