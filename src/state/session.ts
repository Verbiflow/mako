import { noteFolderUse } from "@/state/prefs"
import { playFeedback } from "@/state/feedback"
import { workspaceTransitionStore } from "@/state/workspace-transition"
import { promptClipboard } from "@/lib/prompt-clipboard"
import type { Attachment } from "@/lib/attachments"
import { applyThreadArchives, threadLifecycle } from "@/state/thread-lifecycle"
import { receiveControlActivity } from "@/state/control-preview"
import { hostConnectionStore } from "@/state/host-connection"
import { isHostReconnectingError } from "../../electron/contracts/host-connection"
import { admitProfile, providers } from "@/state/providers"
import { applyLiveBatch, hydrateLiveSummaries, hydrateLive } from "@/state/live-recovery"
import { replayUnconfirmedPrompts } from "@/state/acp-queue"
import { createHook, createStore, shallowEqual } from "@/state/store"
import type {
  Capabilities,
  GitStatus,
  HostEvent,
  ModelInfo,
  ChatMessage,
  SessionMeta,
  SessionState,
  TabSnapshot,
  ThinkingLevel,
  TreeNode,
} from "@/lib/types"
import { getMako, hasBridge } from "@/lib/bridge"
import { reconcileMessages } from "@/lib/reconcile"
import { composerTurnRunning } from "@/lib/composer-action"
import {
  addTab,
  cacheOf,
  dropCache,
  hydrate,
  patchTab,
  refresh,
  removeTab,
  tabsStore,
  titleFor,
  writeCache,
  type TabCache,
} from "@/state/tabs"
import { workspaceName } from "@/lib/format"
import { viewer, viewerStore } from "@/state/viewer"
import { stage } from "@/state/stage"
import { applyUpdate, updates } from "@/state/updates"
import { application, applicationStore } from "@/state/application"
import { runCommand } from "@/extend/commands"
import {
  applyAutomations,
  automations,
  noteAutomationRun,
} from "@/state/automations"
import {
  applyThreadActivity,
  applyThreadEntries,
  applyThreadRef,
  applyThreadRemoved,
  applyThreadRun,
  applyThreads,
  threads,
  threadsStore,
} from "@/state/threads"
import { acp, acpStore, activeAcp, activeLiveAcp } from "@/state/acp"
import { noteOutcome, openSubjectId, retireSubject, subjectId } from "@/state/notifications"
import { toast } from "sonner"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { mcpStore } from "@/state/mcp"

export type Phase = "booting" | "ready" | "detached"

export interface SessionStore {
  phase: Phase
  fault?: string
  meta?: SessionMeta
  messages: ChatMessage[]
  /** The in-flight assistant message. Isolated so tokens touch one subtree. */
  stream: ChatMessage | null
  tree: TreeNode[]
  git?: GitStatus
  models: ModelInfo[]
  capabilities: Capabilities
  platform: NodeJS.Platform | "unknown"
  /** Mako's own source tree, when it is editable — development only. */
  sourceRoot?: string
}

const empty: Capabilities = { tools: [], commands: [], skills: [] }
let workspaceGeneration = 0
let gitRefreshGeneration = 0

export const store = createStore<SessionStore>({
  phase: "booting",
  messages: [],
  stream: null,
  tree: [],
  models: [],
  capabilities: empty,
  platform: "unknown",
})

export const useSession = createHook(store)
export { shallowEqual }

export function currentTurnRunning(): boolean {
  const acpState = acpStore.get()
  const active = activeAcp(acpState)
  const live = activeLiveAcp(acpState)
  return composerTurnRunning({
    builtinRunning: store.get().meta?.isStreaming ?? false,
    livePresent: Boolean(active),
    liveRunning:
      active?.kind === "starting" || live?.session.status === "running",
    liveThreadPath: active?.threadPath,
    viewingPath: threadsStore.get().viewing?.ref.path,
    viewingRunning: threadsStore.get().run?.status === "running",
  })
}

/* ------------------------------------------------------------------ */
/* event application                                                   */
/* ------------------------------------------------------------------ */

/**
 * Route one host event.
 *
 * Several agents are running, so the first question is always "whose is this?".
 * Events for the tab on screen land in the store and repaint. Events for a
 * background tab go into its cache and touch nothing but its entry in the tab
 * strip — a conversation you are not looking at costs one small object write,
 * not a render.
 */
let connectionEpoch = 0
/** A built-in tab's notification identity. */
function tabSubject(id: string, cache: TabCache) {
  const tab = tabsStore.get().tabs.find((entry) => entry.id === id)
  return {
    id: subjectId({ kind: "tab", id }),
    target: { kind: "tab" as const, id },
    title: tab?.title ?? titleFor(cache.meta, cache.messages),
    agent: cache.meta?.model?.name ?? "Agent",
    workspace: cache.meta?.cwd ? workspaceName(cache.meta.cwd) : undefined,
  }
}

function tabWorking(meta: SessionMeta | undefined): boolean {
  return Boolean(meta?.isStreaming || meta?.isCompacting)
}

function lastReplyOf(messages: ChatMessage[]): string {
  const parts: string[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === "user") break
    if (message.role !== "assistant") continue
    for (const block of message.blocks)
      if (block.type === "text") parts.push(block.text)
  }
  return parts.toReversed().join("\n\n")
}

/** A tab's turn ended (or began): the attention centre hears about it once. */
function noteTabTurn(id: string, before: SessionMeta | undefined, cache: TabCache) {
  const after = cache.meta
  if (!before || !after) return
  if (tabWorking(after) && !tabWorking(before)) {
    retireSubject(subjectId({ kind: "tab", id }))
    return
  }
  if (!tabWorking(before) || tabWorking(after)) return
  noteOutcome({
    kind: "ready",
    subject: tabSubject(id, cache),
    marker: `turn:${after.messageCount}:${after.leafId ?? ""}`,
    detail: lastReplyOf(cache.messages),
  })
}

function apply(event: HostEvent) {
  if (event.type === "notification-activated") {
    openSubjectId(event.subject)
    return
  }
  if (event.type === "thread-archives") {
    applyThreadArchives(event.snapshot)
    return
  }
  if (event.type === "host-reconnected") {
    void actions.reconnect()
    return
  }
  if (event.type === "host-disconnected") {
    connectionEpoch++
    hostConnectionStore.set({ kind: "disconnected", message: event.message })
    return
  }
  if (event.type === "control-activity") {
    receiveControlActivity(event.activity)
    return
  }
  if (event.type === "browser-control") {
    mcpStore.set({ browsers: event.browsers })
    return
  }
  if (event.type === "live-batch") {
    applyLiveBatch(event.batch)
    return
  }
  if (event.type === "harness-profile") {
    admitProfile(event.profile, event.cwd ?? "")
    return
  }
  const active = tabsStore.get().activeId
  if (event.tabId && event.tabId !== active) {
    if (!tabsStore.get().tabs.some((tab) => tab.id === event.tabId)) return
    absorb(event.tabId, event)
    return
  }
  const metaBefore = store.get().meta
  applyToActive(event)
  if (event.type === "meta" || event.type === "session") {
    const state = store.get()
    noteTabTurn(active, metaBefore, {
      meta: state.meta,
      messages: state.messages,
      stream: state.stream,
      tree: state.tree,
    })
  }
  if (
    event.tabId &&
    (event.type === "meta" ||
      event.type === "session" ||
      event.type === "messages")
  ) {
    const state = store.get()
    writeCache(event.tabId, { meta: state.meta })
    refresh(event.tabId, { ...cacheOf(event.tabId), messages: state.messages })
  }
}

/** Fold a background tab's event into its cache, and update its strip entry. */
function absorb(id: string, event: HostEvent) {
  const entry = cacheOf(id)
  switch (event.type) {
    case "session":
      writeCache(id, {
        meta: event.session.meta,
        messages: event.session.messages,
        tree: event.session.tree,
        stream: null,
      })
      break
    case "meta":
      writeCache(id, { meta: event.meta, git: entry.git?.cwd === event.meta.cwd ? entry.git : undefined })
      break
    case "messages":
      writeCache(id, { messages: event.messages })
      break
    case "tree":
      writeCache(id, { tree: event.tree })
      break
    case "git":
      if (entry.meta?.cwd !== event.git.cwd) return
      writeCache(id, { git: event.git })
      break
    case "capabilities":
      writeCache(id, { capabilities: event.capabilities })
      break
    case "notice":
      // Errors from a hidden tab still surface — a failure you never see is
      // worse than an interruption — but they say which conversation raised it.
      if (event.level === "error") report(event.message)
      return
    default:
      return
  }

  const previous = entry.meta
  const next = cacheOf(id)
  refresh(id, next)
  // Finished while you were elsewhere: that is worth a dot on the tab.
  const wasWorking = tabWorking(previous)
  const nowWorking = tabWorking(next.meta)
  if (wasWorking && !nowWorking) patchTab(id, { unread: true })
  noteTabTurn(id, previous, next)
}

/** Re-read the open file when the agent's last turn touched it. */
function followEdits(git: GitStatus) {
  const path = viewerStore.get().path
  if (!path) return
  if (git.files.some((file) => file.path === path)) viewer.refresh()
}

function applyToActive(event: HostEvent) {
  switch (event.type) {
    case "session":
      store.set({
        meta: event.session.meta,
        git: store.get().git?.cwd === event.session.meta.cwd ? store.get().git : undefined,
        messages: reconcileMessages(
          store.get().messages,
          event.session.messages
        ),
        tree: event.session.tree,
        stream: null,
      })
      break
    case "meta":
      store.set({ meta: event.meta, git: store.get().git?.cwd === event.meta.cwd ? store.get().git : undefined })
      break
    case "messages":
      // Reuse the objects for turns that did not change, so a tool result
      // re-renders one turn instead of the whole transcript.
      store.set({
        messages: reconcileMessages(store.get().messages, event.messages),
      })
      break
    case "stream":
      store.set({ stream: event.message })
      break
    case "tree":
      store.set({ tree: event.tree })
      break
    case "git":
      if (store.get().meta?.cwd !== event.git.cwd) return
      store.set({ git: event.git })
      // The agent just wrote something. If it wrote the file you happen to be
      // reading, the version on screen is now wrong — and a stale file is
      // worse than no file, because nothing about it looks stale.
      if (event.cause !== "index") followEdits(event.git)
      break
    case "capabilities":
      store.set({ capabilities: event.capabilities })
      break
    case "application-lifecycle":
      applicationStore.set({ lifecycle: event.lifecycle })
      break
    case "installation":
      applicationStore.set({ installation: event.installation })
      break
    case "app-command":
      runCommand(event.command)
      break
    case "app-shutdown":
      void application.shutdown(event.requestId)
      break
    case "update":
      applyUpdate(event.update)
      break
    case "automations":
      applyAutomations(event.automations)
      break
    case "threads":
      applyThreads(event.threads)
      acp.bindThreads(event.threads)
      break
    case "thread-ref":
      applyThreadRef(event.ref)
      acp.bindThreads([event.ref])
      break
    case "thread-removed":
      applyThreadRemoved(event.path)
      break
    case "thread-activity":
      applyThreadActivity(event.path, event.activity)
      break
    case "thread-entries":
      applyThreadEntries(
        event.path,
        event.entries,
        event.replace,
        event.replaceFrom
      )
      break
    case "native-requests":
      threadsStore.set({ nativeRequests: event.requests })
      break
    case "thread-run":
      applyThreadRun(event.run)
      break
    case "file-changed":
      void viewer.refresh(event.path)
      break
    case "automation-run":
      noteAutomationRun(event.run)
      if (event.run.status === "started" && event.run.reason === "manual") {
        toast(`${event.run.name} started`, {
          description: "run by hand",
        })
      } else if (event.run.status === "failed") {
        toast.error(`${event.run.name} failed`, {
          duration: ACTION_TOAST_MS,
          description: event.run.error,
          action: {
            label: "Run again",
            onClick: () => automations.run(event.run.id),
          },
        })
      }
      break
    case "notice":
      if (event.level === "error") report(event.message)
      else if (event.level === "success") toast.success(event.message)
      else toast(event.message)
      break
  }
}

/* ------------------------------------------------------------------ */
/* actions — every mutation the UI can perform, in one place           */
/* ------------------------------------------------------------------ */

function report(message: string) {
  toast.error(message, {
    duration: ACTION_TOAST_MS,
    action: {
      label: "Troubleshoot",
      onClick: () =>
        window.dispatchEvent(
          new CustomEvent("mako:settings", { detail: "diagnostics" })
        ),
    },
  })
}

/** Reject after `ms`, so no await can strand the interface in a skeleton. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function guard<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    // The host left mid-call. The reconnect banner already says so; a second
    // alarm per refresh would only bury it.
    if (error instanceof Error && isHostReconnectingError(error)) return undefined
    report(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

/**
 * Which session file a tab is showing.
 *
 * The active tab's is in the store, not the cache — the cache for the tab you
 * are looking at is only written when you leave it — so both have to be read.
 */
function sessionFileOf(id: string): string | undefined {
  if (id === tabsStore.get().activeId) return store.get().meta?.sessionFile
  return cacheOf(id).meta?.sessionFile
}

/** Put a fresh session state on screen and keep the tab strip in step with it. */
function adoptState(next: SessionState) {
  store.set({
    meta: next.meta,
    git: store.get().git?.cwd === next.meta.cwd ? store.get().git : undefined,
    messages: reconcileMessages(store.get().messages, next.messages),
    tree: next.tree,
    stream: null,
  })
  const id = tabsStore.get().activeId
  if (id) {
    writeCache(id, { meta: next.meta })
    refresh(
      id,
      { ...cacheOf(id), meta: next.meta, messages: next.messages },
      { unread: false }
    )
  }
}

function adoptSnapshot(next: TabSnapshot) {
  store.set({
    meta: next.session.meta,
    messages: reconcileMessages(store.get().messages, next.session.messages),
    tree: next.session.tree,
    stream: null,
    git: next.git,
    capabilities: next.capabilities,
  })
  writeCache(next.id, {
    meta: next.session.meta,
    messages: next.session.messages,
    tree: next.session.tree,
    git: next.git,
    capabilities: next.capabilities,
  })
  refresh(next.id, cacheOf(next.id), { unread: false })
}

export const actions = {
  async reconnect() {
    const epoch = ++connectionEpoch
    const cwd = store.get().meta?.cwd
    try {
      const bridge = getMako()
      if (cwd) await bridge.setCwd(cwd)
      const boot = await bridge.boot()
      if (epoch !== connectionEpoch) return
      if (boot.archives) applyThreadArchives(boot.archives)
      hydrateLiveSummaries(boot.live, true)
      const conversation = acpStore.get().activeKey
      if (conversation) await hydrateLive(conversation)
      if (epoch !== connectionEpoch) return
      // A send the outage swallowed goes out now, under the id the host
      // settles it by; one it had already accepted comes back as that receipt.
      void replayUnconfirmedPrompts()
      if (store.get().meta?.cwd === cwd) {
        hydrate(boot.tabs, boot.activeTabId)
        const active = boot.tabs.find((tab) => tab.id === boot.activeTabId)
        if (active) store.set({ meta: active.session.meta, git: active.git, capabilities: active.capabilities, models: boot.models })
      }
      hostConnectionStore.set({ kind: "connected" })
      void providers.loadAll()
      void threads.load()
      if (!boot.archives) void threadLifecycle.load()
    } catch (error) {
      if (epoch === connectionEpoch) hostConnectionStore.set({ kind: "disconnected", message: error instanceof Error ? error.message : "The shared host could not be restored" })
    }
  },
  async boot() {
    if (!hasBridge()) {
      store.set({
        phase: "detached",
        fault:
          "The agent host is not attached. Launch the desktop app with `npm run desktop`.",
      })
      return () => {}
    }
    const bridge = getMako()
    // The renderer hot-reloads through Vite; the engine does not. When this
    // window is newer than the engine it woke up inside — the bridge missing
    // an API this build requires — nothing works *subtly*, which is the
    // worst way for nothing to work. Refuse loudly, with the fix.
    if (!Object.hasOwn(bridge, "daemonStatus")) {
      store.set({
        phase: "detached",
        fault:
          "This window is newer than the engine it is connected to — the interface hot-reloaded past the running app. Quit the app and run `npm run desktop` again to rebuild and restart the engine.",
      })
      return () => {}
    }
    const unsubscribe = bridge.onEvent(apply)
    void providers.loadAll()
    try {
      const boot = await withTimeout(
        bridge.boot(),
        45_000,
        "The agent host did not answer within 45 seconds. Check the terminal it was launched from, then restart."
      )
      hydrate(boot.tabs, boot.activeTabId)
      if (boot.archives) applyThreadArchives(boot.archives)
      hydrateLiveSummaries(boot.live)
      const active =
        boot.tabs.find((tab) => tab.id === boot.activeTabId) ?? boot.tabs[0]
      if (!active) throw new Error("The host started without a conversation")
      hostConnectionStore.set({ kind: "connected" })
      store.set({
        phase: "ready",
        meta: active.session.meta,
        messages: active.session.messages,
        tree: active.session.tree,
        git: active.git,
        models: boot.models,
        capabilities: active.capabilities,
        platform: boot.platform,
        sourceRoot: boot.sourceRoot,
      })
      void updates.load()
      void application.load()
      void automations.load()
      void threads.load()
      if (!boot.archives) void threadLifecycle.load()
      threads.watchFocus()
    } catch (error) {
      store.set({
        phase: "detached",
        fault: error instanceof Error ? error.message : String(error),
      })
    }
    return unsubscribe
  },

  /* ---------------------------------------------------------------- tabs */

  /**
   * Show a different tab.
   *
   * The conversation you are leaving is written to its cache and the one you
   * are entering is read back from it, so the swap is a single synchronous
   * paint. The host is told afterwards — it will re-push authoritative state,
   * which arrives a frame or two later and reconciles into what is already on
   * screen rather than replacing it.
   */
  async switchTab(id: string) {
    const { activeId } = tabsStore.get()
    if (id === activeId) return
    workspaceGeneration += 1
    workspaceTransitionStore.set({ kind: "ready" })
    const current = store.get()
    if (activeId) {
      writeCache(activeId, {
        meta: current.meta,
        messages: current.messages,
        stream: current.stream,
        tree: current.tree,
        git: current.git,
        capabilities: current.capabilities,
      })
    }
    const next = cacheOf(id)
    threads.closeViewer()
    if (!next.meta?.sessionFile || !acp.activateThread({ path: next.meta.sessionFile }))
      acp.deactivate()
    tabsStore.set({ activeId: id })
    patchTab(id, { unread: false })
    store.set({
      meta: next.meta,
      messages: next.messages,
      stream: next.stream,
      tree: next.tree,
      git: next.git,
      capabilities: next.capabilities ?? empty,
    })
    dropCache(id)
    window.dispatchEvent(new CustomEvent("mako:close-settings"))
    await guard(() => getMako().activateTab(id))
  },

  /** Open another conversation beside this one. */
  async openTab(options: { cwd?: string; sessionPath?: string } = {}) {
    workspaceGeneration += 1
    workspaceTransitionStore.set({ kind: "ready" })
    const current = store.get()
    const { activeId } = tabsStore.get()
    if (activeId) {
      writeCache(activeId, {
        meta: current.meta,
        messages: current.messages,
        stream: current.stream,
        tree: current.tree,
        git: current.git,
        capabilities: current.capabilities,
      })
    }
    const tab = await guard(() => getMako().openTab(options))
    if (!tab) return false
    threads.closeViewer()
    if (
      !tab.session.meta.sessionFile ||
      !acp.activateThread({ path: tab.session.meta.sessionFile })
    )
      acp.deactivate()
    addTab(tab)
    window.dispatchEvent(new CustomEvent("mako:close-settings"))
    store.set({
      meta: tab.session.meta,
      messages: tab.session.messages,
      stream: null,
      tree: tab.session.tree,
      git: tab.git,
      capabilities: tab.capabilities,
    })
    return true
  },

  async closeTab(id: string) {
    const result = await guard(() => getMako().closeTab(id))
    if (!result) return
    const wasActive = tabsStore.get().activeId === id
    removeTab(id, result.activeId)
    stage.drop(id)
    if (result.opened) addTab(result.opened)
    if (!wasActive) return
    threads.closeViewer()
    const opened = result.opened?.id === result.activeId ? result.opened : null
    const next = opened
      ? {
          meta: opened.session.meta,
          messages: opened.session.messages,
          stream: null,
          tree: opened.session.tree,
          git: opened.git,
          capabilities: opened.capabilities,
        }
      : cacheOf(result.activeId)
    if (!next.meta?.sessionFile || !acp.activateThread({ path: next.meta.sessionFile }))
      acp.deactivate()
    store.set({
      meta: next.meta,
      messages: next.messages,
      stream: next.stream,
      tree: next.tree,
      git: next.git,
      capabilities: next.capabilities ?? empty,
    })
    dropCache(result.activeId)
    patchTab(result.activeId, { unread: false })
  },

  async refreshModels() {
    const models = await guard(() => getMako().listModels())
    if (models) store.set({ models })
  },

  /**
   * Send a prompt. Resolves `true` only if the host accepted it.
   *
   * The composer clears optimistically so typing feels instant, and it can
   * only put the draft back if it can tell success from failure — which a
   * `void`-returning call cannot. The agent rejects a prompt outright when no
   * model is selected or no key is available, and losing a paragraph to that
   * is not an acceptable way to find out.
   */
  async send(
    text: string,
    mode?: "steer" | "followUp",
    images?: Array<{ mimeType: string; data: string }>
  ): Promise<boolean> {
    try {
      await getMako().prompt(text, mode, images)
      noteFolderUse(store.get().meta?.cwd)
      return true
    } catch (error) {
      report(error instanceof Error ? error.message : String(error))
      return false
    }
  },

  abort() {
    return guard(() => getMako().abort())
  },

  async stopCurrentTurn() {
    const active = activeAcp(acpStore.get())
    const live = activeLiveAcp(acpStore.get())
    const viewing = threadsStore.get().viewing?.ref
    const viewingOwnsComposer = Boolean(
      viewing &&
      active?.kind !== "starting" &&
      (!active || viewing.path !== active.threadPath)
    )
    if (viewingOwnsComposer && viewing) return threads.abortReply(viewing)
    if (active?.kind === "starting") return acp.close()
    if (live?.session.status === "running") return acp.cancel()
    if (store.get().meta?.isStreaming) {
      await actions.abort()
      return true
    }
    return false
  },

  clearQueue() {
    return guard(() => getMako().clearQueue())
  },

  /**
   * Start a fresh thread in `folder`. The current view stays put until the
   * host has actually opened a tab there: tearing it down first would leave
   * the previous tab's empty launcher on screen after a failed open, which
   * looks exactly like a new thread — in the wrong project.
   */
  async newConversationIn(folder: string) {
    const opened = await actions.openTab({ cwd: folder })
    if (!opened) return false
    const cwd = store.get().meta?.cwd
    if (cwd !== folder) {
      report(
        `The new thread opened in ${cwd ?? "an unknown folder"} instead of ${folder}. Check the folder still exists before sending a prompt.`
      )
      return false
    }
    noteFolderUse(folder)
    viewer.close()
    stage.close()
    requestAnimationFrame(() =>
      window.dispatchEvent(new CustomEvent("mako:focus-composer"))
    )
    return true
  },

  async newSession() {
    const folder = store.get().meta?.cwd
    return folder ? actions.newConversationIn(folder) : actions.openTab()
  },

  /**
   * Show a thread. `inNewTab` keeps the current one running beside it, which is
   * what a modifier-click means everywhere else.
   */
  async openSession(path: string, { inNewTab = false } = {}) {
    // Already open somewhere? Go there. Two tabs on one session file would be
    // two views of one runtime fighting over it, and the rail giving you a
    // duplicate instead of the thing you can see is the wrong answer anyway.
    const existing = tabsStore
      .get()
      .tabs.find((tab) => sessionFileOf(tab.id) === path)
    if (existing) return actions.switchTab(existing.id)
    if (inNewTab) return actions.openTab({ sessionPath: path })
    acp.deactivate()
    threads.closeViewer()
    // Picking a thread means "show me that thread" — so any full-window view
    // standing in front of the transcript steps aside first.
    window.dispatchEvent(new CustomEvent("mako:close-settings"))
    const next = await guard(() => getMako().openSession(path))
    if (!next) return
    adoptState(next)
  },

  async pickWorkspace() {
    const folder = await guard(() => getMako().pickFolder())
    if (folder) await actions.newConversationIn(folder)
  },

  /** Point the agent at a folder by path, without a dialog. */
  async openWorkspace(folder: string) {
    const mine = ++workspaceGeneration
    workspaceTransitionStore.set({ kind: "loading", cwd: folder })
    store.set({ git: undefined })
    let next: TabSnapshot
    try {
      next = await getMako().setCwd(folder)
    } catch (error) {
      if (mine === workspaceGeneration) workspaceTransitionStore.set({ kind: "failed", cwd: folder, message: error instanceof Error ? error.message : "The project could not be opened." })
      return
    }
    if (mine !== workspaceGeneration) return
    adoptSnapshot(next)
    workspaceTransitionStore.set({ kind: "ready" })
    viewer.close()
    void actions.refreshModels()
  },

  /**
   * Branch at a past turn into a new session, in a tab of its own.
   *
   * Both halves matter. The new session means the original is not rewound and
   * abandoned; the new *tab* means both lines of enquiry are on screen at once,
   * which is the only reason to want two of them. The prompt that was forked
   * from comes back so it can go straight into the composer — retyping it is
   * the one thing the feature exists to avoid.
   */
  async fork(entryId: string, position: "before" | "at" = "before") {
    const current = store.get()
    const { activeId } = tabsStore.get()
    if (activeId) {
      writeCache(activeId, {
        meta: current.meta,
        messages: current.messages,
        stream: current.stream,
        tree: current.tree,
        git: current.git,
        capabilities: current.capabilities,
      })
    }
    const result = await guard(() => getMako().fork(entryId, position))
    if (!result || result.cancelled) return
    addTab(result.tab)
    store.set({
      meta: result.tab.session.meta,
      messages: result.tab.session.messages,
      stream: null,
      tree: result.tab.session.tree,
      git: result.tab.git,
      capabilities: result.tab.capabilities,
    })
    if (result.text) {
      window.dispatchEvent(
        new CustomEvent("mako:compose", { detail: { text: result.text } })
      )
    }
  },

  async navigate(nodeId: string) {
    const next = await guard(() => getMako().navigateTree(nodeId))
    if (!next) return
    adoptState(next)
  },

  rename(name: string) {
    return guard(() => getMako().setName(name))
  },

  setModel(provider: string, id: string) {
    return guard(() => getMako().setModel(provider, id))
  },

  setThinking(level: ThinkingLevel) {
    return guard(() => getMako().setThinking(level))
  },

  compact(instructions?: string) {
    if (activeLiveAcp(acpStore.get())) return acp.compact()
    return guard(() => getMako().compact(instructions))
  },

  setAutoCompaction(enabled: boolean) {
    return guard(() => getMako().setAutoCompaction(enabled))
  },

  setActiveTools(names: string[]) {
    return guard(() => getMako().setActiveTools(names))
  },

  runCommand(name: string, args?: string) {
    return guard(() => getMako().runCommand(name, args))
  },

  async refreshGit() {
    const generation = ++gitRefreshGeneration
    const workspace = store.get().meta?.cwd
    const git = await guard(() => getMako().gitStatus())
    if (git && generation === gitRefreshGeneration && store.get().meta?.cwd === workspace) store.set({ git })
  },

  async copy(
    text: string,
    { notify = true, attachments = [] }: { notify?: boolean; attachments?: readonly Attachment[] } = {}
  ): Promise<boolean> {
    try {
      if (attachments.length) {
        const payload = promptClipboard(text, attachments)
        try {
          await navigator.clipboard.write([new ClipboardItem({
            "text/plain": new Blob([payload.text], { type: "text/plain" }),
            "text/html": new Blob([payload.html], { type: "text/html" }),
          })])
        } catch {
          await getMako().copy(payload.text)
        }
      } else await getMako().copy(text)
      toast.dismiss("clipboard-error")
      if (notify)
        toast.success("Copied", { id: "clipboard-success", duration: 1600 })
      playFeedback("copy")
      return true
    } catch {
      toast.dismiss("clipboard-success")
      toast.error("Could not copy", {
        id: "clipboard-error",
        duration: ACTION_TOAST_MS,
        action: { label: "Retry", onClick: () => void actions.copy(text, { notify, attachments }) },
      })
      return false
    }
  },
}
