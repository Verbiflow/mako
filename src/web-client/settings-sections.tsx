import { ActivityIcon, BellIcon, BotIcon, CircleUserRoundIcon, GitPullRequestIcon, MessagesSquareIcon, MonitorSmartphoneIcon, PackageIcon, PaletteIcon, WorkflowIcon } from "lucide-react"
import type { SettingsSection } from "@/components/settings/sections/manifest"
import { AgentsSettings } from "./agents-settings"
import { WebDevices } from "./devices"
import { Fins } from "./fins"
import { AccountGroup, Appearance, Conversation, Diagnostics, Notifications, PullRequests, Setups, ThisBrowser } from "./settings"

/**
 * Settings as a laptop's browser draws them, in the desktop's own panes (`SettingsPanes`): the sections a browser can
 * reach, under the desktop's ids (their deep links land here as on the desk), titles, groups and icons, each drawn by
 * the web's own group of the same settings. What lives only on a Mac (its MCP, Git, storage, updates, keys) stays in its
 * own Settings.
 */
export function webSettingsSections(onSetup: (project: string) => void): readonly SettingsSection[] {
  return [
    { id: "agents", title: "Agents", group: "Providers", icon: BotIcon, keywords: ["harness", "sign in", "signed in", "models", "mac"], perHarness: true, Component: AgentsSettings },
    { id: "fins", title: "Fins", group: "Providers", icon: WorkflowIcon, keywords: ["apex", "rules", "at once", "limit", "model"], Component: Fins },
    { id: "notifications", title: "Notifications", group: "Desk", icon: BellIcon, keywords: ["push", "quiet hours", "alerts"], Component: Notifications },
    { id: "transcript", title: "Conversation", group: "Desk", icon: MessagesSquareIcon, keywords: ["steer", "queue", "send"], Component: Conversation },
    { id: "appearance", title: "Appearance", group: "Desk", icon: PaletteIcon, keywords: ["theme", "dark", "light"], Component: Appearance },
    { id: "setup", title: "Setup", group: "Project", icon: PackageIcon, keywords: ["project", "files", "accounts", "environments"], Component: () => <Setups onOpen={onSetup} /> },
    { id: "pull-requests", aliases: ["git"], title: "Pull requests", group: "Project", icon: GitPullRequestIcon, keywords: ["github", "token", "commits", "author"], Component: PullRequests },
    { id: "account", title: "Account", group: "Application", icon: CircleUserRoundIcon, keywords: ["sign out", "email", "browser"], Component: () => (
      <>
        <AccountGroup />
        <ThisBrowser />
      </>
    ) },
    { id: "devices", title: "Devices", group: "Application", icon: MonitorSmartphoneIcon, keywords: ["mac", "machine", "phone", "add a machine"], Component: WebDevices },
    { id: "diagnostics", title: "Diagnostics", group: "Application", icon: ActivityIcon, keywords: ["connection", "logs", "copy"], Component: Diagnostics },
  ]
}
