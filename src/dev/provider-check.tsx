import { createRoot } from "react-dom/client"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { providerStore, providers } from "@/state/providers"
import { accountsStore, accounts } from "@/state/accounts"
import {
  providerConnectionsStore,
  providerConnections,
} from "@/state/provider-connections"
import { prefsStore, bindTheme } from "@/state/prefs"
import { installMockBridge } from "./mock-bridge"
import { getMako } from "@/lib/bridge"
import type { HarnessUpdates } from "../../electron/contracts/harness-updates"
import "../index.css"

installMockBridge()
providers.loadAll = async () => {}
providers.loadStatus = async () => {}
providers.refreshAccount = async () => {}
providers.loadRuntimeUpdates = async () => {}
accounts.load = () => {}
providerConnections.load = () => {}
export const calls: string[] = []
const versions: HarnessUpdates = {
  claude: {
    installed: "2.1.266",
    latest: "2.1.266",
    binary: "/Users/developer/.local/bin/claude",
    channel: "self",
  },
  codex: {
    installed: "0.154.0",
    latest: "0.155.0",
    binary: "/Users/developer/.bun/bin/codex",
    channel: "bun",
    update: {
      label: "Update with bun",
      command: "bun",
      args: ["add", "-g", "@openai/codex@latest"],
    },
  },
  grok: {
    installed: "1.0.34",
    latest: "1.0.41",
    binary: "/Users/developer/.grok/bin/grok",
    channel: "self",
    update: { label: "Update Grok", command: "grok", args: ["update"] },
  },
  cursor: {
    installed: "2026.09.12-fd3934a",
    binary: "/Applications/Cursor.app/Contents/Resources/cursor-agent",
    channel: "app",
    managedBy: "Cursor.app",
  },
  opencode: {
    provider: "opencode",
    label: "OpenCode",
    primary: true,
    installed: "2.0.1",
    latest: "2.0.2",
    binary: "/Users/developer/.opencode/bin/opencode",
    channel: "self",
    update: {
      label: "Update",
      command: "/Users/developer/.opencode/bin/opencode",
      args: ["upgrade", "2.0.2"],
    },
  },
}
providerStore.set({
  availability: {
    claude: true,
    codex: true,
    cursor: true,
    opencode: true,
    grok: true,
  },
  runtimeUpdates: versions,
})
accountsStore.set({
  loadedAt: Date.now(),
  providers: [
    {
      provider: "claude",
      label: "Claude Code",
      mode: "selectable",
      loginCommand: "claude auth login",
    },
    {
      provider: "codex",
      label: "Codex",
      mode: "selectable",
      loginCommand: "codex login",
    },
    {
      provider: "opencode",
      label: "OpenCode",
      mode: "observed",
      loginCommand: "opencode auth login",
    },
  ],
  accounts: [
    {
      harness: "claude",
      name: "work",
      email: "developer@company.com",
      active: true,
    },
    {
      harness: "codex",
      name: "default",
      email: "developer@company.com",
      active: true,
    },
    {
      harness: "opencode",
      name: "anthropic",
      providerId: "anthropic",
      authType: "api",
      source: "opencode",
      active: false,
    },
    {
      harness: "opencode",
      name: "openai",
      email: "developer@company.com",
      providerId: "openai",
      authType: "oauth",
      source: "opencode",
      active: false,
    },
  ],
})
const connection = {
  provider: "cursor",
  label: "Cursor",
  description: "Sign in to run Cursor agents in Mako.",
  state: { status: "signed-out" as const },
  secureStorage: true,
  keyUrl: "https://cursor.com/dashboard",
}
providerConnectionsStore.set({
  loadedAt: Date.now(),
  connections: [
    connection,
    {
      provider: "grok",
      label: "Grok",
      description: "Sign in with Grok in your browser.",
      state: { status: "signed-out" },
      secureStorage: false,
      actions: ["sign-in-browser", "sign-out"],
    },
  ],
})
const bridge = getMako()
window.mako = {
  ...bridge,
  runHarnessUpdate: async (id) => {
    calls.push(id)
    const held = providerStore.get().runtimeUpdates?.[id]
    if (!held) throw new Error("Unknown installation")
    providerStore.set({
      runtimeUpdates: {
        ...providerStore.get().runtimeUpdates,
        [id]: { ...held, phase: "updating" },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    return {
      ...held,
      result: {
        at: Date.now(),
        outcome: "failed",
        message: "Download interrupted. Retry when connected.",
      },
    }
  },
  providerConnectionAction: async (provider, action) => {
    calls.push(action.kind)
    if (action.kind === "sign-in-key")
      throw new Error("This key was refused. Check the key and try again.")
    if (provider === "grok") {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const grok = providerConnectionsStore
        .get()
        .connections.find((entry) => entry.provider === "grok")
      if (!grok) throw new Error("Grok fixture is missing")
      return { ...grok, state: { status: "signed-in", source: "cli" } }
    }
    return connection
  },
}
export function theme(theme: "light" | "dark") {
  prefsStore.set({ theme })
}
export function narrow() {
  document.documentElement.style.setProperty("--settings-width", "640px")
}
prefsStore.set({ theme: "dark" })
bindTheme()
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <TooltipProvider>
      <SettingsDialog
        open
        section="agents"
        onOpenChange={() => {}}
        onSectionChange={() => {}}
      />
    </TooltipProvider>
  )

export function grokConnected() {
  providerConnectionsStore.set((state) => ({
    connections: state.connections.map((entry) =>
      entry.provider === "grok"
        ? { ...entry, state: { status: "signed-in", source: "cli" } }
        : entry
    ),
  }))
}
