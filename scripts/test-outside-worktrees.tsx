import assert from "node:assert/strict"
import { ThreadIdSchema } from "../electron/contracts/thread-identity.ts"

/**
 * A worktree made outside Mako, known from the checkout heads alone: its
 * folders file under the project it came from, it carries its branch, and
 * the composer says the Thread is on it.
 */

const saved = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  },
})

const { renderToStaticMarkup } = await import("react-dom/server")
const { applyCheckoutHeads } = await import("@/state/checkout-heads")
const { workingFolder, worktreeAt, worktreesStore } = await import("@/state/worktrees")
const { threadsStore } = await import("@/state/threads")
const { WorkspaceChoice } = await import("@/components/composer/workspace-choice")

const linked = { path: "/Users/you/.codex/worktrees/a1b2/app", repoRoot: "/Users/you/app" }
let sets = 0
worktreesStore.subscribe(() => {
  sets += 1
})

assert.equal(worktreesStore.get().folderMap(`${linked.path}/web`), undefined, "unknown until a head says so")

applyCheckoutHeads({ [`${linked.path}/web`]: { kind: "branch", name: "agent/fix-login", linked } })
const state = worktreesStore.get()
assert.equal(state.folderMap(`${linked.path}/web`), "/Users/you/app/web", "a folder inside it files under its project")
assert.equal(state.folderMap(linked.path), "/Users/you/app")
assert.equal(worktreeAt(state.outside, `${linked.path}/web`)?.worktree.branch, "agent/fix-login")
assert.equal(sets, 1)

applyCheckoutHeads({ [linked.path]: { kind: "branch", name: "agent/fix-login", linked } })
assert.equal(sets, 1, "a second folder of the same worktree changes nothing")

const thread = "00000000-0000-4000-8000-000000000002"
const ref = { harness: "codex", nativeId: "cx-9", path: "/Users/you/.codex/sessions/cx-9.jsonl", cwd: `${linked.path}/web`, threadId: thread, title: "Fix the login redirect" }
threadsStore.set({ ...threadsStore.get(), opening: { kind: "loading", ref } })
const composer = renderToStaticMarkup(<WorkspaceChoice />)
assert.match(composer, /data-workspace="own-branch"/, "the composer shows the Thread on its own branch")
assert.match(composer, /data-worktree-origin="outside"/)
assert.match(composer, /aria-label="Makes changes on its own branch, agent\/fix-login, in a worktree made outside Mako"/)
assert.match(composer, />agent\/fix-login</)
threadsStore.set({ ...threadsStore.get(), opening: { kind: "loading", ref: { ...ref, cwd: "/Users/you/app" } } })
applyCheckoutHeads({ "/Users/you/app": { kind: "branch", name: "main" }, "/Users/you/app/api": { kind: "branch", name: "main" } })
assert.match(renderToStaticMarkup(<WorkspaceChoice />), /data-workspace="project-folder"/, "the main checkout is still the project folder")

// A harness that records the folder of its latest turn (Claude, Codex): a move into a worktree moves the Session; a cd doesn't.
const places = worktreesStore.get()
assert.equal(workingFolder(places, { cwd: "/Users/you/app", currentCwd: `${linked.path}/web` }), `${linked.path}/web`, "EnterWorktree, or a Codex turn in a worktree")
assert.equal(workingFolder(places, { cwd: "/Users/you/app", currentCwd: "/Users/you/app/api" }), "/Users/you/app", "the shell changing into a subfolder")
assert.equal(workingFolder(places, { cwd: "/Users/you", currentCwd: "/Users/you/other-repo" }), "/Users/you", "the shell changing into another repository")
assert.equal(workingFolder(places, { cwd: linked.path, currentCwd: `${linked.path}/web` }), linked.path, "a cd inside the worktree it started in")
assert.equal(workingFolder(places, { cwd: `${linked.path}/web`, currentCwd: "/Users/you/app/web" }), "/Users/you/app/web", "ExitWorktree after claude -w, or a Codex turn back in the project")
assert.equal(workingFolder(places, { cwd: "/Users/you/other", currentCwd: `${linked.path}/web` }), "/Users/you/other", "a cd into another repository's worktree")
assert.equal(workingFolder(places, { cwd: linked.path, currentCwd: "/Users/you/elsewhere" }), linked.path, "a cd out of its worktree to somewhere unrelated")
const scratch = { path: "/Users/you/.codex/worktrees/103b/app", repoRoot: "/tmp/e2e/app" }
applyCheckoutHeads({ [scratch.path]: { kind: "detached", commit: "0123456789abcdef0123456789abcdef01234567", linked: scratch } })
assert.equal(workingFolder(worktreesStore.get(), { cwd: scratch.path, currentCwd: "/private/tmp/e2e/app" }), "/private/tmp/e2e/app", "back in the project, spelled through /private")
assert.equal(worktreeAt(worktreesStore.get().outside, "/private/Users/nothing"), undefined)
assert.equal(worktreesStore.get().folderMap(`${scratch.path}/web`), "/tmp/e2e/app/web")
applyCheckoutHeads({ [scratch.path]: null })
assert.equal(workingFolder(places, { cwd: "/Users/you/app" }), "/Users/you/app")
threadsStore.set({ ...threadsStore.get(), opening: { kind: "loading", ref: { ...ref, cwd: "/Users/you/app", currentCwd: `${linked.path}/web` } } })
assert.match(renderToStaticMarkup(<WorkspaceChoice />), /data-workspace="own-branch"[^>]*data-worktree-origin="outside"/, "a Session its harness moved into a worktree shows that branch")
threadsStore.set({ ...threadsStore.get(), opening: { kind: "loading", ref: { ...ref, cwd: "/Users/you/app", currentCwd: "/Users/you/app/api" } } })
assert.match(renderToStaticMarkup(<WorkspaceChoice />), /data-workspace="project-folder"/, "a cd leaves it in the project folder")
threadsStore.set({ ...threadsStore.get(), opening: null })

applyCheckoutHeads({ [linked.path]: { kind: "detached", commit: "0123456789abcdef0123456789abcdef01234567", linked } })
applyCheckoutHeads({ [`${linked.path}/web`]: { kind: "detached", commit: "0123456789abcdef0123456789abcdef01234567", linked } })
assert.equal(worktreeAt(worktreesStore.get().outside, linked.path)?.worktree.branch, undefined, "detached, it has no branch to show")

applyCheckoutHeads({ [linked.path]: null, [`${linked.path}/web`]: null })
assert.equal(worktreesStore.get().outside.length, 0, "removed, it's gone")
assert.equal(worktreesStore.get().folderMap(linked.path), undefined)

const made = { thread: ThreadIdSchema.parse("00000000-0000-4000-8000-000000000001"), path: linked.path, repoRoot: linked.repoRoot, project: linked.repoRoot, branch: "mako/fix-login", base: "0".repeat(40), createdAt: 0 }
worktreesStore.set({ ...worktreesStore.get(), worktrees: [made] })
applyCheckoutHeads({ [linked.path]: { kind: "branch", name: "mako/fix-login", linked } })
assert.equal(worktreeAt(worktreesStore.get().outside, linked.path), undefined, "a worktree Mako made isn't also an outside one")

console.log("outside worktrees: unknown until read, regroups, branch, one per worktree, composer on its branch, moved by its harness vs a cd, detached, removed, Mako's own excluded")
