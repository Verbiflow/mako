import { useEffect } from "react"
import {
  commands,
  isTypingTarget,
  keysFor,
  matchesChord,
  registerCommands,
  type DeskCommand,
} from "@/extend/commands"
import { installBuiltins } from "@/desk/builtins"
import { actions, currentTurnRunning, store } from "@/state/session"
import { git } from "@/state/git"
import { commitDrafts } from "@/state/commit-drafts"
import { currentCommitModel } from "@/state/commit-model"
import { prefsStore, setPref, togglePref } from "@/state/prefs"
import { updates, updatesStore } from "@/state/updates"
import { application, applicationStore } from "@/state/application"
import { openInterfacePreview, reloadInterface } from "@/state/development"
import { stage } from "@/state/stage"
import { surfaces } from "@/extend/surfaces"
import { tabsStore } from "@/state/tabs"
import { search } from "@/state/search"
import { AGENT_TAB_ID, viewer, viewerStore } from "@/state/viewer"
import { markAllSeen, nextUnseen, openItem } from "@/state/notifications"
import { toast } from "sonner"

const openPalette = () => {
  window.dispatchEvent(new CustomEvent("mako:palette"))
}
const focusComposer = () => {
  window.dispatchEvent(new CustomEvent("mako:focus-composer"))
}

/** 1-9 from a keyboard event, or 0 if this was not a digit. */
function digitOf(event: KeyboardEvent): number {
  if (/^[1-9]$/.test(event.key)) return Number(event.key)
  if (/^Digit[1-9]$/.test(event.code)) return Number(event.code.slice(5))
  return 0
}

/** Move `delta` tabs along the strip, wrapping at both ends. */
function stepTab(delta: number) {
  const { tabs, activeId } = tabsStore.get()
  if (tabs.length < 2) return
  const at = tabs.findIndex((tab) => tab.id === activeId)
  const next = tabs[(at + delta + tabs.length) % tabs.length]
  if (next) void actions.switchTab(next.id)
}

function closeActiveTab() {
  const state = viewerStore.get()
  const pane =
    state.panes.find((candidate) => candidate.id === state.focusedPaneId) ??
    state.panes[0]
  if (pane?.activeId && pane.activeId !== AGENT_TAB_ID) {
    viewer.closeTab(pane.id, pane.activeId)
    return
  }
  const tabId = tabsStore.get().activeId
  if (tabId) void actions.closeTab(tabId)
}

/** Advance to the next effort level the current model actually supports. */
function cycleEffort() {
  const meta = store.get().meta
  if (!meta) return
  const levels = meta.thinkingLevels
  if (levels.length <= 1) return
  const index = levels.indexOf(meta.thinkingLevel)
  void actions.setThinking(levels[(index + 1) % levels.length])
}

const DESK_COMMANDS: DeskCommand[] = [
  {
    id: "view.notifications",
    title: "Focus notifications",
    section: "View",
    keys: "alt+t",
    run: () => document.querySelector<HTMLElement>("[data-sonner-toaster]")?.focus(),
  },
  {
    id: "attention.next",
    title: "Open the next thread that needs you",
    section: "View",
    keys: "mod+shift+u",
    hint: "Approvals first, then failures, then answers ready to read",
    run: () => {
      const item = nextUnseen()
      if (item) openItem(item)
      else toast("Nothing is waiting for you")
    },
  },
  {
    id: "attention.clear",
    title: "Mark every notification seen",
    section: "View",
    run: markAllSeen,
  },
  {
    id: "view.command-palette",
    title: "Open command palette",
    section: "View",
    keys: "mod+k",
    run: openPalette,
  },
  {
    id: "session.new",
    title: "New session",
    section: "Session",
    keys: "mod+n",
    run: () => void actions.newSession(),
  },
  {
    id: "tab.new",
    title: "Attach another session",
    section: "Session",
    hint: "A second conversation kept running beside this one",
    keys: "mod+t",
    run: () => void actions.openTab(),
  },
  {
    id: "tab.close",
    title: "Close active tab",
    section: "Session",
    hint: "Closes the active file, or detaches the active session",
    keys: "mod+w",
    run: closeActiveTab,
  },
  {
    id: "tab.next",
    title: "Next attached session",
    section: "Session",
    keys: "mod+shift+]",
    when: () => tabsStore.get().tabs.length > 1,
    run: () => stepTab(1),
  },
  {
    id: "tab.previous",
    title: "Previous attached session",
    section: "Session",
    keys: "mod+shift+[",
    when: () => tabsStore.get().tabs.length > 1,
    run: () => stepTab(-1),
  },
  {
    id: "session.focus-composer",
    title: "Focus the composer",
    section: "Session",
    keys: "mod+l",
    run: focusComposer,
  },
  {
    id: "session.stop",
    title: "Stop the current turn",
    section: "Session",
    keys: "mod+escape",
    when: currentTurnRunning,
    run: () => void actions.stopCurrentTurn(),
  },
  {
    id: "session.compact",
    title: "Compact the conversation",
    section: "Session",
    hint: "Summarize history to free context",
    run: () => void actions.compact(),
  },
  {
    id: "session.auto-compact",
    title: "Toggle auto-compaction",
    section: "Session",
    run: () => void actions.setAutoCompaction(!(store.get().meta?.autoCompaction ?? true)),
  },
  {
    id: "workspace.open",
    title: "Open folder…",
    section: "Workspace",
    keys: "mod+o",
    run: () => void actions.pickWorkspace(),
  },
  {
    id: "workspace.generate-commit",
    title: "Draft a commit message",
    section: "Workspace",
    keys: "mod+shift+g",
    hint: "From the diff, using your connected drafting model",
    run: async () => {
      stage.open("changes")
      const { model, status } = await currentCommitModel()
      if (!model || status.kind === "disconnected") {
        window.dispatchEvent(new CustomEvent("mako:settings", { detail: "commits" }))
        return
      }
      const cwd = store.get().git?.cwd ?? store.get().meta?.cwd
      if (cwd) void commitDrafts.generate(cwd)
    },
  },
  {
    id: "workspace.stage-all",
    title: "Stage every change",
    section: "Workspace",
    run: () => void git.stageAll(),
  },
  {
    id: "workspace.push",
    title: "Push the current branch",
    section: "Workspace",
    hint: "Publishes work outside this machine",
    run: () => void git.push(),
  },
  {
    id: "workspace.refresh-git",
    title: "Refresh git status",
    section: "Workspace",
    run: () => void actions.refreshGit(),
  },
  {
    id: "model.pick",
    title: "Switch model…",
    section: "Model",
    keys: "mod+shift+m",
    hint: "Search every authenticated model",
    run: () => {
      openPalette()
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
        if (input) {
          input.value = ""
          input.focus()
        }
      })
    },
  },
  {
    id: "model.cycle-effort",
    title: "Cycle reasoning effort",
    section: "Model",
    keys: "mod+.",
    run: cycleEffort,
  },
  {
    id: "model.refresh",
    title: "Reload model catalog",
    section: "Model",
    run: () => void actions.refreshModels(),
  },
  {
    id: "view.toggle-rail",
    title: "Toggle the session list",
    section: "View",
    keys: "mod+b",
    run: () => togglePref("railOpen"),
  },
  {
    id: "view.toggle-diff",
    title: "Toggle the diff pane",
    section: "View",
    keys: "mod+shift+d",
    hint: "The changed file's contents, beneath the file list",
    run: () => {
      stage.open("changes")
      togglePref("autoOpenDiff")
    },
  },
  {
    id: "view.search",
    title: "Search everything…",
    section: "View",
    keys: "mod+shift+f",
    hint: "File contents and every conversation, in one query",
    run: () => search.open(),
  },
  {
    id: "view.search-sessions",
    title: "Search sessions…",
    section: "View",
    keys: "mod+shift+l",
    run: () => {
      setPref("railOpen", true)
      setPref("railMode", "threads")
      requestAnimationFrame(() =>
        window.dispatchEvent(new CustomEvent("mako:search-threads"))
      )
    },
  },
  {
    id: "view.quick-open",
    title: "Open a file…",
    section: "View",
    keys: "mod+p",
    hint: "Find any file in the project by name",
    run: () => window.dispatchEvent(new CustomEvent("mako:quick-open")),
  },
  {
    id: "view.files",
    title: "Show the project files",
    section: "View",
    keys: "mod+shift+e",
    hint: "Browse the folder the agent is working in",
    run: () => {
      setPref("railOpen", true)
      setPref("railMode", "files")
    },
  },
  {
    id: "view.threads",
    title: "Show the thread list",
    section: "View",
    run: () => {
      setPref("railOpen", true)
      setPref("railMode", "threads")
    },
  },
  {
    id: "view.toggle-companion",
    title: "Toggle the right sidebar",
    section: "View",
    keys: "mod+alt+b",
    hint: "Hide the right sidebar, or bring back its last section",
    run: () => stage.toggleCompanion(),
  },
  {
    id: "view.changes",
    title: "Show changed files",
    section: "View",
    run: () => stage.toggle("changes"),
  },
  {
    id: "view.terminal",
    title: "Toggle terminal dock",
    section: "View",
    keys: "mod+j",
    hint: "Open the terminal below the conversation",
    run: () => stage.toggleDock("terminal"),
  },
  {
    id: "view.all-projects",
    title: "Show sessions from every project",
    section: "Workspace",
    hint: "Search and switch across projects",
    run: () => {
      const next = prefsStore.get().railScope === "all" ? "workspace" : "all"
      setPref("railScope", next)
    },
  },
  {
    id: "view.toggle-thinking",
    title: "Toggle reasoning blocks",
    section: "View",
    run: () => togglePref("showThinking"),
  },
  {
    id: "view.guide",
    title: "What is where",
    section: "View",
    keys: "mod+/",
    hint: "The layout, and every key that does something",
    run: () => window.dispatchEvent(new CustomEvent("mako:guide")),
  },
  {
    id: "view.settings",
    title: "Settings",
    section: "View",
    keys: "mod+,",
    run: () => window.dispatchEvent(new CustomEvent("mako:settings")),
  },
  {
    id: "session.improve-mako",
    title: "Improve Mako",
    section: "Session",
    // Hidden in a packaged build, where there is no source tree to point at
    // and no dev server to apply an edit through.
    hint: "Point this session at Mako's own source",
    keywords: "self edit source dogfood hack",
    // Hidden in a packaged build, where there is no source tree to point at
    // and no dev server to apply an edit through.
    when: () => Boolean(store.get().sourceRoot),
    run: async () => {
      const root = store.get().sourceRoot
      if (root) await actions.openWorkspace(root)
    },
  },
  {
    id: "app.reload-interface",
    title: "Reload interface without stopping agents",
    section: "View",
    keys: "mod+r",
    run: reloadInterface,
  },
  {
    id: "app.preview-interface",
    title: "Open shared-host preview window",
    section: "View",
    run: openInterfacePreview,
  },
  {
    id: "app.updates",
    title: "Updates and build information",
    section: "View",
    keywords: "version production installed release local build",
    run: application.openUpdates,
  },
  {
    id: "app.build-update",
    title: "Build a local Mako update",
    section: "View",
    hint: "Build and verify separately; agents keep running",
    when: () => applicationStore.get().installation?.distribution === "local",
    run: () => applicationStore.get().installation?.source ? application.build() : application.openUpdates(),
  },
  {
    id: "app.check-updates",
    title: "Check for Mako updates",
    section: "View",
    when: () => applicationStore.get().installation?.distribution === "signed",
    run: async () => { application.openUpdates(); await updates.check() },
  },
  {
    id: "app.install-update",
    title: "Install prepared Mako update…",
    section: "View",
    hint: "Choose when to install without interrupting agents",
    when: () => applicationStore.get().installation?.local.kind === "ready" || updatesStore.get().status === "ready",
    run: () => application.request("install"),
  },
  {
    id: "app.cancel-update",
    title: "Cancel pending update or restart",
    section: "View",
    when: () => applicationStore.get().lifecycle?.operation.kind === "waiting",
    run: application.cancel,
  },
  {
    id: "app.quit",
    title: "Quit Mako…",
    section: "View",
    keys: "mod+q",
    hint: "Keep agents running, or stop them before quitting",
    run: () => application.request("quit"),
  },
  {
    id: "app.restart",
    title: "Restart Mako",
    section: "Session",
    hint: "Quit and come back on the current build; conversations reopen from their journals",
    keywords: "relaunch reload engine rebuild host",
    run: () => updates.relaunch(),
  },
  {
    id: "view.toggle-theme",
    title: "Toggle light and dark",
    section: "View",
    run: () => setPref("theme", prefsStore.get().theme === "light" ? "dark" : "light"),
  },
]

/**
 * Registers the desk's own commands and installs the single global key
 * listener. One listener for every shortcut in the app: adding a command with
 * a `keys` field is all it takes to make the chord live.
 */
export function useDeskCommands() {
  useEffect(() => {
    const disposers = [registerCommands(DESK_COMMANDS), installBuiltins()]
    return () => disposers.forEach((dispose) => dispose())
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return
      }
      const mod = event.metaKey || event.ctrlKey

      // ⌘1 shows the chat; ⌘2…⌘9 open the reading surfaces in strip order.
      // Terminal is a dock with its own ⌘J command. Bound here rather than as
      // nine palette commands nobody would search for. Both `key` and `code`
      // are consulted: `code` is layout-independent, `key` is what synthetic
      // events actually carry. Attached sessions cycle with ⌘⇧[ and ⌘⇧] instead.
      const digit = digitOf(event)
      if (mod && !event.shiftKey && !event.altKey && digit > 0) {
        event.preventDefault()
        if (digit === 1) {
          viewer.showAgent()
          stage.showChat()
          stage.close()
        } else {
          const target = surfaces
            .list()
            .filter((surface) => surface.placement !== "bottom")
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[digit - 2]
          if (target) stage.open(target.id)
        }
        return
      }

      // Unmodified keys belong to whatever the user is typing into.
      if (!mod && !event.altKey && isTypingTarget(event.target)) return

      const overrides = prefsStore.get().keybindings
      for (const command of commands.list()) {
        const keys = keysFor(command, overrides)
        if (!keys || !matchesChord(event, keys)) continue
        if (command.when?.() === false) continue
        event.preventDefault()
        void command.run()
        return
      }
    }

    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])
}
