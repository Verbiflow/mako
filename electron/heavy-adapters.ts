import { lazyPackage } from "@mako/lazy"

/**
 * The host's adapters still in `electron/`: Mako modules built around a heavy
 * package, each loaded the first time a feature needs it, like the packages
 * in `heavy-packages.ts`. A domain that moves into `@mako/host` takes its
 * adapter's declaration with it.
 */
export const adapters = {
  /** ACP's form schemas, read into Mako's questions. */
  acpElicitation: lazyPackage("@agentclientprotocol/sdk (acp-elicitation.ts)", () => import("./acp-elicitation.js")),
  devinApprovals: lazyPackage("@agentclientprotocol/sdk (providers/devin/approval-observer.ts)", () =>
    import("./providers/devin/approval-observer.js")),
  /** The AI SDK and its providers, for utility models. */
  utilityLanguage: lazyPackage("ai, @ai-sdk/* (utility-language.ts)", () => import("./utility-language.js")),
}
