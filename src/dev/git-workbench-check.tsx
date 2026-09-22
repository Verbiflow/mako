import { runGitRemote } from "@/state/git-push"
import { createRoot } from "react-dom/client"
import { GitWorkbenchFixture } from "./git-workbench-fixture"
import { actions, store } from "@/state/session"
import { prefsStore, bindTheme } from "@/state/prefs"
import { githubStore } from "@/state/github"
import { workspaceTransitionStore } from "@/state/workspace-transition"
import { getMako } from "@/lib/bridge"
import type { GitStatus, GitCommitEntry, TabSnapshot } from "@/lib/types"
import { installMockBridge } from "./mock-bridge"
import { META } from "./mock-fixtures"
import "../index.css"

installMockBridge()
const bridge = getMako()
const boot = await bridge.boot()
const tab = boot.tabs[0]
if (!tab) throw new Error("Missing fixture tab")
const switches = new Map<string, (snapshot: TabSnapshot) => void>()
const projects = new Map<string, GitStatus>()
const histories = new Map<string, Array<(commits: GitCommitEntry[]) => void>>()
const pushes = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
export const calls = { selections: 0, pushes: 0, stages: 0, commits: 0, diffs: 0, copied: "", copiedHtml: "", context: "", remoteAction: "" }
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  write: async (items: ClipboardItem[]) => { calls.copied = await (await items[0].getType("text/plain")).text(); calls.copiedHtml = await (await items[0].getType("text/html")).text() },
} })
let cwd = "/fixture/large"

function project(path: string, count: number): GitStatus {
  return { cwd: path, root: path, branch: "main", head: "a".repeat(40), upstream: "origin/main", ahead: 2, behind: 0, files: Array.from({ length: count }, (_, index) => ({ path: `file-${String(index).padStart(5, "0")}.ts`, status: "modified", staged: false, insertions: null, deletions: null, binary: false })) }
}

export function selectProject(path: string, count = 13_000) {
  cwd = path
  const snapshot = projects.get(path) ?? project(path, count)
  projects.set(path, snapshot)
  store.set({ phase: "ready", meta: { ...META, cwd: path }, git: snapshot })
  workspaceTransitionStore.set({ kind: "ready" })
  githubStore.set({ root: path, statusRoot: path, branch: "main", loading: false, pull: null, status: { installed: true, authenticated: true, repo: "fixture/project", defaultBranch: "main" } })
}

export function selectMultiRepositoryProject() {
  selectProject("/fixture/mono", 12)
  const current = projects.get(cwd)!
  const snapshot = { ...current, root: `${cwd}/mako`, repositories: [
    { root: `${cwd}/mako`, label: "mako", branch: "main", changes: 12 },
    { root: `${cwd}/mako-backend`, label: "mako-backend", branch: "main", changes: 1 },
  ] }
  projects.set(cwd, snapshot)
  store.set({ git: snapshot })
}

export function startSwitch(path: string) {
  void actions.openWorkspace(path)
}

export function finishSwitch(path: string, count = 4) {
  const resolve = switches.get(path)
  if (!resolve) throw new Error("No pending fixture workspace")
  cwd = path
  const snapshot = project(path, count)
  projects.set(path, snapshot)
  githubStore.set({ root: path, statusRoot: path, branch: "main", loading: false, pull: null, status: { installed: true, authenticated: true, repo: "fixture/project", defaultBranch: "main" } })
  resolve({ ...tab, session: { ...tab.session, meta: { ...META, cwd: path } }, git: snapshot })
  switches.delete(path)
}

export function resolveHistory(path: string) {
  for (const resolve of histories.get(path) ?? []) resolve([{ hash: "b".repeat(40), shortHash: "bbbbbbb", subject: `Commit from ${path}`, author: "Fixture", date: new Date().toISOString(), files: null, insertions: null, deletions: null }])
  histories.delete(path)
}

export function finishPush(path: string, success: boolean) {
  const pending = pushes.get(path)
  if (!pending) throw new Error("No pending fixture push")
  if (success) {
    const value = projects.get(path)
    if (value) projects.set(path, { ...value, ahead: 0 })
    pending.resolve()
  } else {
    const value = projects.get(path)
    if (value) projects.set(path, { ...value, behind: 3 })
    pending.reject(new Error("Remote rejected the update. Fetch remote changes before retrying."))
  }
  pushes.delete(path)
}

export function incoming(path: string, conflicts = false) {
  const current = projects.get(path)!
  const snapshot: GitStatus = { ...current, ahead: 2, behind: 3, operation: conflicts ? "merge" : undefined,
    files: conflicts ? [{ path: "shared.ts", status: "conflicted", staged: false, insertions: null, deletions: null, binary: false }] : current.files }
  projects.set(path, snapshot)
  if (cwd === path) store.set({ git: snapshot })
}

let untrackedBlock = false
let mergeConflict = false
let dirtyBlock = false
export async function showUntrackedBlocker(path: string) {
  const snapshot: GitStatus = { ...projects.get(path)!, behind: 3, operation: undefined, files: [{ path: "report.md", status: "untracked", staged: false, insertions: null, deletions: null, binary: false }] }
  projects.set(path, snapshot)
  store.set({ git: snapshot })
  untrackedBlock = true
  await runGitRemote("merge")
  untrackedBlock = false
}

export async function showDirtyBlocker(path: string) {
  const snapshot: GitStatus = { ...projects.get(path)!, behind: 3, operation: undefined, files: [{ path: "local-edit.ts", status: "modified", staged: false, insertions: null, deletions: null, binary: false }] }
  projects.set(path, snapshot)
  store.set({ git: snapshot })
  dirtyBlock = true
  await runGitRemote("merge")
  dirtyBlock = false
}

export async function showMergeConflict(path: string) {
  incoming(path, true)
  mergeConflict = true
  await runGitRemote("merge")
  mergeConflict = false
}

async function stagePaths(paths: string[], staged: boolean) {
  calls.stages += 1
  const target = cwd
  await new Promise((resolve) => setTimeout(resolve, 60))
  const snapshot = projects.get(target)
  if (!snapshot) throw new Error("Missing fixture project")
  const selected = new Set(paths)
  projects.set(target, { ...snapshot, files: snapshot.files.map((file) => selected.has(file.path) ? { ...file, staged } : file) })
}

window.mako = {
  ...bridge,
  copy: async (text) => { calls.copied = text },
  stageFile: async (name, data) => {
    calls.context = new TextDecoder().decode(Uint8Array.from(atob(data), char => char.charCodeAt(0)))
    return { path: `/fixture/attachments/${name}`, name, size: calls.context.length }
  },
  setCwd: async (path) => new Promise<TabSnapshot>((resolve) => switches.set(path, resolve)),
  selectGitRepository: async (workspace, root) => {
    calls.selections += 1
    await new Promise((resolve) => setTimeout(resolve, 100))
    const current = projects.get(workspace)
    if (!current || workspace !== cwd) throw new Error("Workspace changed")
    const selected = { ...project(root, root.endsWith("backend") ? 1 : 12), cwd: workspace, repositories: current.repositories }
    projects.set(workspace, selected)
    return selected
  },
  gitStatus: async () => { const value = projects.get(cwd); if (!value) throw new Error("Missing fixture project"); return value },
  gitLog: async () => { const target = cwd; return new Promise((resolve) => histories.set(target, [...histories.get(target) ?? [], resolve])) },
  gitStage: (paths) => stagePaths(paths, true),
  gitUnstage: (paths) => stagePaths(paths, false),
  gitPush: async (target) => { calls.pushes += 1; return new Promise<void>((resolve, reject) => pushes.set(target.cwd, { resolve, reject })) },
  gitRemote: async (target) => {
    calls.remoteAction = target.action
    const current = projects.get(target.cwd)!
    if (dirtyBlock) return { status: current, problem: { kind: "dirty", message: "Git needs your local edits set aside before merging. Temporarily stash and restore them to pull without committing. Restoring may cause conflicts; staged edits return unstaged.", detail: "Your local changes would be overwritten by merge: local-edit.ts" } }
    if (mergeConflict) return { status: current, problem: { kind: "conflicts", message: "Resolve and stage the conflicted files, then continue.", detail: "CONFLICT (content): Merge conflict in shared.ts" } }
    if (untrackedBlock) return { status: current, problem: { kind: "untracked", message: "A local file conflicts with incoming changes.", detail: "The following untracked working tree files would be overwritten by merge: report.md" } }
    const status: GitStatus = target.action === "fetch" ? current : { ...current, behind: 0, ahead: current.ahead + (target.action === "merge" ? 1 : 0), operation: undefined }
    projects.set(target.cwd, status)
    return { status }
  },
  gitCommit: async () => { calls.commits += 1; await new Promise((resolve) => setTimeout(resolve, 80)); const value = projects.get(cwd); if (value) projects.set(cwd, { ...value, head: "c".repeat(40), files: [], ahead: value.ahead + 1 }) },
  gitDiff: async (path) => { calls.diffs += 1; return { path, binary: false, oldFile: null, newFile: null, preview: { kind: "patch", contents: "diff --git a/large.ts b/large.ts\n@@ -1 +1 @@\n-old\n+new\n", limited: true } } },
}

prefsStore.set({ theme: "dark", autoOpenDiff: false, commitModel: "google/gemini-3.8-flash" })
bindTheme()
selectProject(cwd)

const node = document.getElementById("root")
if (node) createRoot(node).render(<GitWorkbenchFixture />)
