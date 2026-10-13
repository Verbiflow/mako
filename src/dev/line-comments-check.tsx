import { createRoot } from "react-dom/client"
import { getMako } from "@/lib/bridge"
import type { ContextInput } from "@/lib/context-detail"
import type { GitDiff, GitStatus } from "@/lib/types"
import { bindTheme, prefsStore, setPref } from "@/state/prefs"
import { reviewStore } from "@/state/review"
import { store } from "@/state/session"
import { viewer } from "@/state/viewer"
import { workspaceTransitionStore } from "@/state/workspace-transition"
import { LineCommentsFixture } from "./line-comments-fixture"
import { installMockBridge } from "./mock-bridge"
import { META } from "./mock-fixtures"
import "../index.css"

/**
 * Comments on picked lines, driven with trusted input by
 * `scripts/test-line-comments-ui.mjs`: the production file viewer, the
 * Changes panel's file diff and Review stream, and a commit's diff in the
 * center, over a fixture repository. Every chip they add is kept in `added`.
 */

installMockBridge()
const bridge = getMako()
const ROOT = "/fixture/project"
const PATH = "src/state/review.ts"

const lines = (count: number, change: (line: number) => string | null = (line) => `const value${line} = ${line}`) =>
  Array.from({ length: count }, (_, index) => change(index + 1)).filter((line): line is string => line !== null)

/** The working tree's file, with Windows line endings so the chips' code is checked without them. */
export const FILE = `${lines(40).join("\r\n")}\r\n`
const BEFORE = `${lines(40).join("\n")}\n`
const AFTER = `${lines(40, (line) => (line === 12 ? "const value12 = twelve" : line === 13 ? null : line === 30 ? "const value30 = thirty\nconst value30b = 30.5" : `const value${line} = ${line}`)).join("\n")}\n`

export const added: ContextInput[] = []
window.addEventListener("mako:add-context", (event) => added.push(event.detail))

const diff = (path: string): GitDiff => ({ path, binary: false, oldFile: { name: path, contents: BEFORE }, newFile: { name: path, contents: AFTER } })
const status: GitStatus = {
  cwd: ROOT, root: ROOT, branch: "main", head: "a".repeat(40), upstream: "origin/main", ahead: 0, behind: 0,
  files: [{ path: PATH, status: "modified", staged: false, insertions: 3, deletions: 2, binary: false }],
}

window.mako = {
  ...bridge,
  readFile: async (path) => ({ path, contents: FILE, size: FILE.length, binary: false, truncated: false }),
  watchFile: async () => {},
  unwatchFile: async () => {},
  gitStatus: async () => status,
  gitLog: async () => [],
  gitDiff: async (path) => diff(path),
  gitCommitFileDiff: async (_hash, path) => diff(path),
}

prefsStore.set({ theme: "dark", changesLayout: "files", autoOpenDiff: true, diffStyle: "unified", selectedDiffs: { [ROOT]: PATH } })
bindTheme()
store.set({ phase: "ready", meta: { ...META, cwd: ROOT }, git: status })
workspaceTransitionStore.set({ kind: "ready" })
reviewStore.set({ comments: [], draft: undefined })

export function openFile() {
  return viewer.open(`${ROOT}/${PATH}`)
}

export function openCommitDiff() {
  return viewer.openDiff(`bbbbbbb · ${PATH}`, async () => ({ diffs: [diff(PATH)], base: "bbbbbbb^", root: ROOT }))
}

export function layout(value: "files" | "review") {
  setPref("changesLayout", value)
}

const node = document.getElementById("root")
if (node) createRoot(node).render(<LineCommentsFixture />)

export { reviewStore, setPref }
