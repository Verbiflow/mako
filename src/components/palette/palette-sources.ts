import { useEffect, useMemo, useState } from "react"
import { formatChord, keysFor, useCommands, type DeskCommand } from "@/extend/commands"
import { workspaceName } from "@/lib/format"
import { harnessLabel } from "@/lib/harness-label"
import type { ThreadRef } from "@/lib/types"
import { listedAsThread } from "@mako/host/contracts/thread-list"
import type { PullRequestListing } from "@mako/host/contracts/pull-request-search"
import { PROJECT_SETTINGS_COMMAND } from "@/desk/project-commands"
import { actions, useSession } from "@/state/session"
import { modelKey, noteModelUse, usePrefs } from "@/state/prefs"
import { threads, threadsStore, threadStatus, useThreads } from "@/state/threads"
import { archivedThread, useThreadArchives } from "@/state/thread-lifecycle"
import { recentProjects } from "@/state/open-project"
import { useRailRanks } from "@/state/rail-ranks"
import { useChatFolders } from "@/state/chat-folders"
import { openProjectSettings } from "@/state/project-settings"
import { useAutomations } from "@/state/automations"
import { showAutomation } from "@/state/automations-view"
import { inboxModel, openInboxItem, useInbox, sameItems, type InboxAsk } from "@/state/inbox"
import { windowRoutesStore } from "@/state/window-routes"
import { currentThreadTabs } from "@/state/thread-sessions"
import { openInPane } from "@/state/session-panes"
import { desktop } from "@/state/desktop"
import { fieldsOf, type GlyphName, type PaletteIcon, type PaletteItem } from "@/components/palette/palette-search"

/**
 * Where the palette's rows come from: the desk's commands, models and the agent's own commands; every Thread and Fin
 * in the catalog; what needs the person; the projects; the automations; Settings' sections. Each is a hook that
 * builds its rows only while the palette is open (`open`), and keeps a row object while what it's made of is the same
 * object, so a catalog of 5,000 Threads that changes one row rebuilds one row.
 */

/** Offered with nothing typed, in this order, before what the person has used most. */
const SUGGESTED = ["session.new", "apex.new", "workspace.open", "model.pick", "view.search", "attention.next", "view.automations", "view.settings", "view.toggle-rail", "view.toggle-companion"]

const COMMAND_GLYPH = new Map<string, GlyphName>([
  ["session.new", "new"],
  ["session.new-chat", "new"],
  ["apex.new", "new"],
  ["attention.next", "inbox"],
  ["view.automations", "automation"],
  ["model.pick", "model"],
])

export function commandItems(list: readonly DeskCommand[], keybindings: Readonly<Record<string, string>>): PaletteItem[] {
  const items: PaletteItem[] = []
  for (const command of list) {
    if (command.when?.() === false) continue
    if (command.id === "view.command-palette") continue
    const projectSettings = command.id.startsWith(PROJECT_SETTINGS_COMMAND)
    const setting = projectSettings || command.id === "view.settings" || command.id === "view.settings-file"
    const suggested = SUGGESTED.indexOf(command.id)
    items.push({
      id: `command:${command.id}`,
      group: setting ? "settings" : "actions",
      title: command.title,
      fields: fieldsOf(command.title, command.keywords, command.hint),
      primary: 1,
      meta: command.hint,
      keys: formatChord(keysFor(command, keybindings)),
      icon: { kind: "glyph", name: COMMAND_GLYPH.get(command.id) ?? (setting ? "setting" : "action") },
      ...(suggested >= 0 && { suggested }),
      ...(projectSettings && { queryOnly: true, project: command.id.slice(PROJECT_SETTINGS_COMMAND.length) }),
      ...(command.id === "model.pick" && { scope: { kind: "models" as const } }),
      verb: command.id === "model.pick" ? "Choose" : "Run",
      run: () => void command.run(),
    })
  }
  return items
}

/** The desk's commands, and the agent's own `/` commands. */
export function useCommandItems(open: boolean): PaletteItem[] {
  const list = useCommands()
  const keybindings = usePrefs((prefs) => prefs.keybindings)
  const agentCommands = useSession((state) => state.capabilities.commands)
  return useMemo(() => {
    if (!open) return []
    const items = commandItems(list, keybindings)
    for (const command of agentCommands) {
      items.push({
        id: `agent:${command.name}`,
        group: "agent",
        title: `/${command.name}`,
        fields: fieldsOf(command.name, command.description),
        primary: 1,
        meta: command.description,
        icon: { kind: "glyph", name: "agent" },
        queryOnly: true,
        verb: "Run",
        run: () => void actions.runCommand(command.name),
      })
    }
    return items
  }, [open, list, keybindings, agentCommands])
}

/** Every authenticated model: favourites, then recent, then the rest; listed for a query or in Switch model. */
export function useModelItems(open: boolean): PaletteItem[] {
  const models = useSession((state) => state.models)
  const active = useSession((state) => state.meta?.model)
  const favorites = usePrefs((prefs) => prefs.favoriteModels)
  const recent = usePrefs((prefs) => prefs.recentModels)
  return useMemo(() => {
    if (!open) return []
    return models.map((model, index): PaletteItem => {
      const key = modelKey(model.provider, model.id)
      const current = active?.provider === model.provider && active.id === model.id
      const favorite = favorites.indexOf(key)
      const used = recent.indexOf(key)
      return {
        id: `model:${key}`,
        group: "models",
        title: model.name,
        fields: fieldsOf(model.name, model.id, model.provider),
        primary: 2,
        meta: [harnessLabel(model.provider), current ? "current" : favorite >= 0 ? "favourite" : undefined].filter(Boolean).join(" · "),
        icon: { kind: "glyph", name: "model" },
        queryOnly: true,
        suggested: favorite >= 0 ? favorite : used >= 0 ? 100 + used : 1000 + index,
        verb: "Switch",
        run: () => {
          noteModelUse(key)
          void actions.setModel(model.provider, model.id)
        },
      }
    })
  }, [open, models, active, favorites, recent])
}

type ThreadStatusKind = ReturnType<typeof threadStatus>["kind"]

function markState(kind: ThreadStatusKind, unread: boolean): Extract<PaletteIcon, { kind: "thread" }>["state"] {
  if (kind === "needs-permission") return "needs"
  if (kind === "working" || kind === "background" || kind === "external-active") return "working"
  if (kind === "failed") return "failed"
  if (kind === "review" && unread) return "unread"
  return "idle"
}

const URGENCY = { needs: 0, working: 1, failed: 2, unread: 3, idle: 4 } satisfies Record<Extract<PaletteIcon, { kind: "thread" }>["state"], number>

function timeOf(ref: ThreadRef): number | undefined {
  const at = Date.parse(ref.updatedAt ?? ref.startedAt ?? "")
  return Number.isFinite(at) ? at : undefined
}

/** Opens a Thread's Session beside the one on screen, when the window has panes; else as Enter does. */
function openBeside(ref: ThreadRef): void {
  const thread = ref.threadId
  const tab = thread ? currentThreadTabs(thread).find((candidate) => candidate.kind === "session" && (candidate.id === ref.sessionId || candidate.ref?.path === ref.path)) : undefined
  if (thread && tab && openInPane(tab, thread, "right")) return
  void threads.view(ref)
}

const rowCache = new WeakMap<ThreadRef, { archived: boolean; apexTitle: string | undefined; item: PaletteItem }>()

/**
 * The catalog's Threads, one row a Thread (its newest Session stands for it), and its Fins, each under its Apex.
 * Archived Threads are found by a query, saying so, and never offered with nothing typed. A row's status is read
 * only for the newest 60, which are what the Recent list can show.
 */
export function catalogItems(refs: readonly ThreadRef[], archives: ReadonlySet<string>): PaletteItem[] {
  const newest = new Map<string, ThreadRef>()
  const titles = new Map<string, string>()
  for (const ref of refs) {
    const key = ref.threadId ?? ref.path
    if (ref.threadId && ref.title && listedAsThread(ref)) titles.set(ref.threadId, ref.title)
    const held = newest.get(key)
    if (!held || (ref.updatedAt ?? "") > (held.updatedAt ?? "")) newest.set(key, ref)
  }
  const shown = [...newest.values()].filter((ref) => ref.nativeAgent?.kind !== "internal-review" && !ref.childOf)
  shown.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
  const state = threadsStore.get()
  return shown.map((ref, index) => {
    const fin = ref.parent !== undefined
    const apexTitle = fin ? titles.get(ref.parent?.thread ?? "") : undefined
    const archived = archivedThread(ref, archives)
    const held = rowCache.get(ref)
    let item: PaletteItem
    if (held && held.archived === archived && held.apexTitle === apexTitle) item = held.item
    else {
      const title = ref.title?.trim() || "Untitled Thread"
      const project = ref.workspace ?? ref.cwd
      const projectName = project ? workspaceName(project) : undefined
      const agent = harnessLabel(ref.harness)
      item = {
        id: `thread:${ref.threadId ?? ref.path}`,
        group: fin ? "fins" : "threads",
        title,
        fields: fieldsOf(title, projectName, agent, ref.model, ref.threadId),
        primary: 1,
        meta: [fin ? (apexTitle ? `Fin of ${apexTitle}` : "Fin") : projectName, agent, archived ? "archived" : undefined].filter(Boolean).join(" · "),
        at: timeOf(ref),
        icon: fin ? { kind: "fin", harness: ref.harness, state: "idle" } : { kind: "thread", harness: ref.harness, state: "idle" },
        ...(project && { project }),
        ...(archived && { queryOnly: true }),
        alternate: { label: "Open beside", run: () => openBeside(ref) },
        run: () => void threads.view(ref),
      }
      rowCache.set(ref, { archived, apexTitle, item })
    }
    if (index >= 60 || archived) return item
    // The newest rows wear their state, read now: what Recent orders by.
    const status = threadStatus(ref, state)
    const mark = markState(status.kind, status.kind === "review" && status.unread)
    if (mark === "idle") return item
    return { ...item, icon: { kind: fin ? "fin" : "thread", harness: ref.harness, state: mark }, urgency: URGENCY[mark] }
  })
}

/** The catalog's Threads and Fins, while the palette is open. */
export function useCatalogItems(open: boolean): PaletteItem[] {
  const refs = useThreads((state) => state.threads)
  const archives = useThreadArchives((state) => state.keys)
  return useMemo(() => (open ? catalogItems(refs, archives) : []), [open, refs, archives])
}

/** What waits on the person, as the Inbox lists it: each opens where it's answered. */
export function useNeedsItems(open: boolean): PaletteItem[] {
  const asks = useInbox((model) => model.asks, sameItems)
  return useMemo(() => (open ? asks.map(askItem) : []), [open, asks])
}

function askItem(ask: InboxAsk): PaletteItem {
  return {
    id: `ask:${ask.key}`,
    group: "needs",
    title: ask.title,
    fields: fieldsOf(ask.title, ask.question),
    primary: 1,
    meta: ask.question,
    at: ask.since,
    icon: { kind: ask.kind === "fin" ? "fin" : "thread", harness: ask.harness, state: "needs" },
    verb: "Answer",
    run: () => openInboxItem(ask),
  }
}

/** For tests and the timing check: the Inbox's asks now. */
export function needsItems(): PaletteItem[] {
  return inboxModel().asks.map(askItem)
}

function newThreadIn(cwd: string): void {
  const { routes } = windowRoutesStore.get()
  if (routes) routes.newThreadIn(cwd)
  else void actions.newConversationIn(cwd)
}

/** Every project with a Thread, newest work first: Enter starts a Thread there; Tab looks inside. */
export function useProjectItems(open: boolean): PaletteItem[] {
  // Read from the stores and ranked only while open: closed, a catalog change costs the palette nothing.
  const refs = useThreads((state) => state.threads)
  const kept = useRailRanks((state) => state.folders)
  const chatRoot = useChatFolders((state) => state.root)
  return useMemo(
    () =>
      open
        ? recentProjects(refs, kept, chatRoot).map((project, index): PaletteItem => ({
            id: `project:${project.path}`,
            group: "projects",
            title: project.name,
            fields: fieldsOf(project.name, project.path),
            primary: 1,
            meta: project.path.replace(/^\/(?:Users|home)\/[^/]+(?=\/)/, "~"),
            at: project.at,
            icon: { kind: "glyph", name: "project" },
            project: project.path,
            scope: { kind: "project", path: project.path, name: project.name },
            suggested: index,
            verb: "New Thread",
            alternate: { label: "Project settings", run: () => openProjectSettings(project.path) },
            run: () => newThreadIn(project.path),
          }))
        : [],
    [open, refs, kept, chatRoot]
  )
}

/** The automations the host keeps, each opening its page. */
export function useAutomationItems(open: boolean): PaletteItem[] {
  const projects = useAutomations((state) => state.projects)
  return useMemo(() => {
    if (!open) return []
    return projects.flatMap((reading) =>
      reading.automations.map((view): PaletteItem => {
        const name = view.definition.name
        const projectName = workspaceName(view.project)
        const at = view.lastRun ? view.lastRun.at : Number.NaN
        return {
          id: `automation:${view.project}#${view.definition.id}`,
          group: "automations",
          title: name,
          fields: fieldsOf(name, view.definition.id, projectName),
          primary: 2,
          meta: [projectName, view.standing === "on" ? undefined : view.standing].filter(Boolean).join(" · "),
          ...(Number.isFinite(at) && { at }),
          icon: { kind: "glyph", name: "automation" },
          project: view.project,
          run: () => showAutomation(view.project, view.definition.id),
        }
      })
    )
  }, [open, projects])
}

export interface SettingsEntry {
  id: string
  title: string
  group: string
  keywords: readonly string[]
  onSearch?: (query: string) => void
}

const loadDeskSettings = () => import("@/components/settings/settings-dialog").then((module) => module.SETTINGS_SECTIONS)

/**
 * Settings' sections and what each is found by ("theme" finds Appearance), read from Settings' own list once its
 * code has loaded (the window loads it when idle, `app-shell.tsx`), so the palette's first paint never waits on it.
 */
export function useSettingsItems(open: boolean, load: () => Promise<readonly SettingsEntry[]> = loadDeskSettings): PaletteItem[] {
  const [sections, setSections] = useState<readonly SettingsEntry[] | null>(null)
  useEffect(() => {
    if (!open || sections) return
    let current = true
    void load().then((loaded) => {
      if (current) setSections(loaded)
    }, () => undefined)
    return () => {
      current = false
    }
  }, [open, sections, load])
  return useMemo(() => (open && sections ? settingsItems(sections) : []), [open, sections])
}

/** Settings' sections as rows: each opens its section, at what was typed when a section can find it there. */
export function settingsItems(sections: readonly SettingsEntry[]): PaletteItem[] {
  return sections.map((section): PaletteItem => ({
    id: `settings:${section.id}`,
    group: "settings",
    title: section.title,
    fields: fieldsOf(section.title, ...section.keywords),
    primary: 1,
    meta: `Settings · ${section.group}`,
    icon: { kind: "glyph", name: "setting" },
    queryOnly: true,
    run: (query) => {
      const term = query.trim().toLowerCase()
      if (term) section.onSearch?.(term)
      window.dispatchEvent(new CustomEvent("mako:settings", { detail: section.id }))
    },
  }))
}

/** A laptop browser's Threads (`WebThread`, folded from the account's list), as the palette's rows. */
export interface ListedThread {
  id: string
  title: string
  project?: string
  harness?: string
  agents: string
  where?: string
  at: number
  standing: "waiting" | "failed" | "working" | "moving" | "idle"
  archived: boolean
  apex?: string
  open: () => void
}

const LISTED_STATE = { waiting: "needs", working: "working", moving: "working", failed: "failed", idle: "idle" } as const

export function listedThreadItems(listed: readonly ListedThread[]): PaletteItem[] {
  return listed.map((thread): PaletteItem => {
    const state = LISTED_STATE[thread.standing]
    return {
      id: `thread:${thread.id}`,
      group: thread.apex ? "fins" : "threads",
      title: thread.title,
      fields: fieldsOf(thread.title, thread.project, thread.agents, thread.where),
      primary: 1,
      meta: [thread.apex ? `Fin of ${thread.apex}` : thread.project, thread.agents, thread.where, thread.archived ? "archived" : undefined].filter(Boolean).join(" · "),
      at: thread.at,
      icon: thread.apex ? { kind: "fin", harness: thread.harness, state } : { kind: "thread", harness: thread.harness, state },
      urgency: URGENCY[state],
      ...(thread.archived && { queryOnly: true }),
      run: thread.open,
    }
  })
}

/** A pull request as a row: opens on GitHub. */
export function pullItem(pull: PullRequestListing, repository: string | undefined): PaletteItem {
  const at = Date.parse(pull.updatedAt ?? "")
  const name = repository?.split("/").at(-1)
  return {
    id: `pull:${repository ?? ""}#${pull.number}`,
    group: "pulls",
    title: pull.title,
    fields: fieldsOf(pull.title, `#${pull.number}`, String(pull.number), name ? `${name}#${pull.number}` : undefined, pull.head, pull.author),
    primary: 4,
    meta: [`#${pull.number}`, pull.draft ? "draft" : pull.state === "open" ? undefined : pull.state, pull.author, pull.head].filter(Boolean).join(" · "),
    ...(Number.isFinite(at) && { at }),
    icon: { kind: "glyph", name: pull.state === "merged" ? "pull-merged" : pull.state === "closed" ? "pull-closed" : "pull" },
    verb: "Open on GitHub",
    alternate: { label: "Copy link", run: () => void navigator.clipboard?.writeText(pull.url) },
    run: () => void desktop.openUrl(pull.url),
  }
}
