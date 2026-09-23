/**
 * Compatibility barrel for the Electron/renderer wire contract.
 *
 * Keep existing consumers importing this module while domain contracts live
 * under `electron/contracts/`.
 */
export * from "./contracts/automations-usage-updates.js"
export * from "./contracts/conversation-session.js"
export * from "./contracts/git-workspace-search.js"
export * from "./contracts/utility-models.js"
export * from "./contracts/host-events-boot.js"
export * from "./contracts/mcp-skills-integrations.js"
export * from "./contracts/providers-acp.js"
export * from "./contracts/provider-connection.js"
export * from "./contracts/terminal.js"
export * from "./contracts/thread-lifecycle.js"
export * from "./contracts/thread-continuation.js"
export * from "./contracts/runtime.js"
export * from "./contracts/app-lifecycle.js"

export * from "./contracts/live-conversations.js"
export * from "./contracts/live-content.js"

export * from "./contracts/conversation-control.js"
export * from "./contracts/message-anchor.js"

export * from "./contracts/native-requests.js"

export * from "./contracts/renderer-bridge.js"

export * from "@mako/control-runtime/contracts"
export * from "./contracts/workspace-snapshots.js"
export * from "./contracts/live-actions.js"
export * from "./contracts/notifications.js"

export type {
  AccountCatalog,
  AccountProviderInfo,
  AccountHarness,
  AccountProvider,
  AccountUsage,
  HarnessAccount,
} from "./account-types.js"

export * from "./contracts/native-agents.js"
