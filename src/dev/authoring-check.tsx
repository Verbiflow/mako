import { createRoot } from "react-dom/client"
import { TooltipProvider } from "@/components/ui/tooltip"
import { prefsStore, bindTheme } from "@/state/prefs"
import { threadsStore } from "@/state/thread-store"
import { authoring } from "@/state/native-authoring"
import type { McpRegistrySnapshot, NativeAuthoringFamily } from "@/lib/types"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import { MCP } from "./mock-fixtures"
import { AuthoringReviewPage } from "./authoring-review-page"
import { reviewSection } from "./authoring-review-section"
import "../index.css"

/**
 * Settings › Hooks and commands and Settings › MCP servers over the authoring
 * fixture (`mock-authoring.ts`), for `scripts/test-authoring-ui.mjs` and the
 * audit's screenshots: every harness's sources, a Codex hook waiting on
 * trust, a shadowed Grok command, and one server set in six agents' files.
 */

installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })
const bridge = window.mako!
const docs = (provider: McpRegistrySnapshot["servers"][number]["origins"][number]["provider"], provenance: string, enabled?: boolean) => {
  const origin: McpRegistrySnapshot["servers"][number]["origins"][number] = { provider, account: "default", scope: "user", provenance }
  if (enabled !== undefined) origin.enabled = enabled
  return origin
}
bridge.discoverMcp = async () => ({
  ...MCP,
  servers: [
    ...MCP.servers,
    {
      id: "mock-docs", name: "docs", transport: "http", url: "https://docs.example.com/mcp", envNames: [], headerNames: ["Authorization"], portable: false,
      blockReason: "contains inline header values",
      origins: [docs("claude", "~/.claude.json", false), docs("codex", "codex mcp list --json"), docs("cursor", "~/.cursor/mcp.json"), docs("grok", "grok mcp list --json"), docs("devin", "~/.config/devin/mcp_config.json", false), docs("opencode", "~/.config/opencode/opencode.jsonc", false)],
    },
  ],
})

export function theme(value: "light" | "dark") {
  prefsStore.set({ theme: value })
}

export function show(next: string) {
  reviewSection.show(next)
}

export function select(provider: string, family: NativeAuthoringFamily) {
  authoring.select(provider, family)
}

prefsStore.set({ theme: "dark" })
bindTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<TooltipProvider><AuthoringReviewPage /></TooltipProvider>)
