/**
 * The control domain as the composition root reaches it without loading it. Browser and computer use loads at its
 * first use (`create-host.ts`'s control domain, `core.ts`'s `openControlNow`): what the core holds of it before then
 * is here, none of which imports the domain's runtime, and `controlLoad` is the domain itself, a part at a time, the
 * last its entry. `check-host-boundaries.mjs` lets the composition root, and nothing else, import this file beside
 * `index.ts`.
 */
export { controlLine } from "../base/control-launch.js"
export { ControlResidency } from "./residency.js"
export { accountBorrowing, BorrowedSimulators } from "./simulators/borrowed.js"
export { controlVideoMedia } from "./video-media.js"
export { ControlSessions } from "./sessions.js"
export { SimulatorTools } from "./simulators/mcp.js"

export const controlLoad = [
  () => import("@mako/control-runtime/browser"),
  () => import("./index.js"),
] as const
