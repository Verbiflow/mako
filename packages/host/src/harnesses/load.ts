/**
 * The harnesses domain, loaded a part at a time: the composition root awaits each step with the loop turning in
 * between (`create-host.ts`), so reading and running the domain's 300 modules is no one stretch of the host's
 * thread. Each harness is a part of its own. Each step imports modules the entry imports anyway and does nothing
 * else; the last is the entry itself, whose remaining modules are few by then. `check-host-boundaries.mjs` lets the
 * composition root, and nothing else, import this file beside `index.ts`.
 */
export const harnessesLoad = [
  () => import("./host.js"),
  () => import("./codex/index.js"),
  () => import("./claude/index.js"),
  () => import("./opencode/index.js"),
  () => import("./grok/index.js"),
  () => import("./devin/index.js"),
  () => import("./cursor/index.js"),
  () => import("./antigravity/index.js"),
  () => import("./index.js"),
] as const
