import { lazyPackage } from "@mako/lazy"

/** The harnesses' modules built around a heavy package, each loaded the first time a feature needs it. */
export const adapters = {
  /** ACP's form schemas, read into Mako's questions. */
  acpElicitation: lazyPackage("@agentclientprotocol/sdk (acp-elicitation.ts)", () => import("./acp-elicitation.js")),
  devinApprovals: lazyPackage("@agentclientprotocol/sdk (devin/approval-observer.ts)", () =>
    import("./devin/approval-observer.js")),
}
