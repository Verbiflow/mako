/**
 * The workspaces domain, loaded a part at a time: the composition root awaits each step with the loop turning in
 * between (`create-host.ts`), so reading and running the domain's 160 modules is no one stretch of the host's
 * thread. Each step imports modules the entry imports anyway and does nothing else; the last is the entry itself,
 * whose remaining modules are few by then. `check-host-boundaries.mjs` lets the composition root, and nothing else,
 * import this file beside `index.ts`.
 */
export const workspacesLoad = [
  () => import("./worktree-move.js"),
  () => Promise.all([import("./thread-worktrees.js"), import("./clients.js"), import("./environment-tools.js")]),
  () => Promise.all([import("./file-readers.js"), import("./snapshots.js")]),
  () => import("./index.js"),
] as const
