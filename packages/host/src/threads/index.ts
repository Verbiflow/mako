import { homedir } from "node:os"
import { join } from "node:path"
import type { MethodTable } from "../base/methods.js"
import { hostWarn } from "../base/host-log.js"
import type { HostJobs, JobDemand } from "../base/host-jobs.js"
import { SessionMemory, sessionMemoryPath, type SessionMemoryHost } from "./session-memory.js"
import { openThreadStore, threadStorePath, type ThreadStore } from "./store.js"
import { formatsKey, storeFormats } from "./store-formats.js"
import type { StoreFormats } from "../contracts/store-formats.js"
import { storeWriter } from "@mako/sessions/store-format"
import { makoRecords } from "@mako/sessions/record-streams"
import type { MessageAnchor } from "../contracts/message-anchor.js"
import { followOtherHosts } from "./groups-follow.js"
import { threadCatalog, type ThreadCatalog, type ThreadCatalogDeps, type ThreadFileHomes } from "./catalog.js"
import { WorktreeOrigins } from "./worktree-origins.js"
import { ThreadArchives } from "./archives.js"
import { ThreadLifecycle, followNativeArchives, type LiveThreads, type NativeQueue } from "./lifecycle.js"
import { declareThreadLifecycleMethods } from "./lifecycle-methods.js"
import { declareThreadGroupMethods } from "./group-methods.js"
import { declareThreadTitleMethods } from "./title-methods.js"
import { declareChatFolderMethods } from "./chat-folder-methods.js"
import { Lineage, chainOf } from "./lineage.js"
import { daemonLoginEnabled, setDaemonLogin, type DaemonApp } from "./daemon-login.js"
import type { HostEnvironment } from "../base/host-environment.js"
import type { ThreadHarnesses } from "./harnesses.js"
import type { ThreadChildContext, ThreadContextOptions } from "../contracts/conversation-session.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import { defaultCatalogIdentity, loadedCatalogCode } from "@mako/sessions"

export type { ThreadCatalog, ThreadFileHomes } from "./catalog.js"
export type { ThreadLifecycle, LiveThreads, NativeQueue } from "./lifecycle.js"
export { SessionMemory, SessionHeldError, type ConversationEndpoint, type ConversationRoute, type SessionFacts } from "./session-memory.js"
export type { JournalFacts, MoveBegan, SourceRef, ThreadStore } from "./store.js"
export { discardChatFolder, ensureChatsRoot, newChatFolder, standsForNoProject } from "./chat-folders.js"
export { nativeSessionPath, type NativeSourceIdentity } from "./native-source.js"
export type {
  ProviderActivityResult,
  ProviderActivitySession,
  ProviderActivityStatus,
  ProviderProbeTarget,
  ProviderProcessProbe,
  ProviderSessionEmitter,
  ThreadHarnesses,
} from "./harnesses.js"

/** The Thread store, the machine's catalog of sessions, and what each Session last ran as. */
export interface Threads {
  /**
   * Per-user, shared by every host on this Mac: what each native session last
   * ran as and which host has it live. Without it a thread started in the
   * installed app read "Model not recorded" in a development host and both
   * could open one store. Null when its file can't be opened.
   */
  memory: SessionMemory | null
  /**
   * Per-user like the ledger: which Session and Thread every journal and
   * native session belongs to, so every host names a conversation alike. A
   * fixture root keeps its own store; a fixture desk only reads the user's.
   */
  store: ThreadStore | null
  /** Why the store didn't open, or opened degraded. */
  storeProblem: string | undefined
  origins: WorktreeOrigins
  lineage: Lineage
  catalog: ThreadCatalog
  archives: ThreadArchives
  /** The app whose sync daemon the catalog reads through. */
  app: DaemonApp
  /** Every shared store's format for this build: which this host only reads because a newer Mako changed it. */
  formats(): StoreFormats
  /** After every reader has stopped: the ledger, the store and the archives close. */
  close(): void
}

export interface ThreadsDeps {
  /** Its data root, and `appData`, where a profile's Thread store is shared from. */
  environment: Pick<HostEnvironment, "dataRoot" | "appData" | "appName" | "development"> & DaemonApp
  /** A fixture desk's Threads read the user's stores and write none. */
  readOnly: boolean
  /** How this host is named in the session ledger every host on this Mac reads. */
  ledger: SessionMemoryHost
  harnesses: ThreadHarnesses
  readFile: ThreadCatalogDeps["readFile"]
  emit(event: HostEvent): void
  jobs: HostJobs
  /** On while any client is subscribed to events; other hosts' Thread changes are followed only for subscribers. */
  subscribed: JobDemand
}

export function openThreads({ environment, readOnly, ledger, harnesses, readFile, emit, jobs, subscribed }: ThreadsDeps): Threads {
  const { dataRoot, appData } = environment
  const catalogCode = loadedCatalogCode()
  // How this build names itself in a store whose format it raises, so an older build can say which Mako changed it.
  const writer = storeWriter(environment)
  const memory = openSessionMemory(ledger, readOnly, jobs, writer)
  const threadsPath = threadStorePath({ dataRoot, appData })
  const { store, problem } = openThreadStore(threadsPath, { readOnly, writer })
  if (problem) hostWarn("threads", "Thread store problem", { problem })
  const formats = () => storeFormats({
    threads: store,
    threadsPath,
    memory,
    memoryPath: sessionMemoryPath(),
    records: makoRecords(),
    archive: join(homedir(), ".mako", "archive"),
  })
  const stopFollowing = store
    ? followOtherHosts(store, emit, {
      jobs,
      subscribed,
      formats: {
        // Every shared store: the record store and kept outputs are another process's to write, so their files are read.
        key: () => formatsKey(formats()),
        changed: () => emit({ type: "store-formats", formats: formats() }),
      },
    })
    : () => {}
  const origins = new WorktreeOrigins(join(homedir(), ".mako", "worktree-origins.json"))
  const lineage = new Lineage(join(dataRoot, "lineage.json"))
  const archives = new ThreadArchives(join(dataRoot, "thread-archives.sqlite"))
  return {
    memory,
    store,
    storeProblem: problem,
    origins,
    lineage,
    catalog: threadCatalog({
      dataRoot,
      profiles: { appData, app: environment.appName },
      app: environment,
      sessionMemory: memory,
      threadStore: store,
      worktreeOrigins: origins,
      lineage,
      harnesses,
      readFile,
      catalogIdentity: () => defaultCatalogIdentity(join(homedir(), ".mako", "archive"), catalogCode),
      jobs,
      readOnly,
      writer,
      emit,
    }),
    archives,
    app: environment,
    formats,
    close() {
      void origins.flush()
      memory?.close()
      stopFollowing()
      store?.close()
      archives.close()
    },
  }
}

function openSessionMemory(ledger: SessionMemoryHost, readOnly: boolean, jobs: HostJobs, writer: string): SessionMemory | null {
  try {
    const memory = new SessionMemory(sessionMemoryPath(), ledger, { readOnly, writer })
    memory.startHeartbeat(jobs)
    return memory
  } catch (error) {
    hostWarn("memory", "ledger unavailable", { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export interface ThreadMethodsDeps {
  threads: Threads
  live: LiveThreads & { announceGroup(thread: string): void }
  native: NativeQueue
  /** Ends a headless run on a native session, given the token its stop control was shown. */
  nativeStops: { token(path: string): string | null; abort(path: string, token: string): void }
  homes: ThreadFileHomes | null
  emit(event: HostEvent): void
}

/** Cross-harness threads: every agent's sessions on this machine, and what becomes of them. */
export function declareThreadMethods(methods: MethodTable, { threads, live, native, nativeStops, homes, emit }: ThreadMethodsDeps): ThreadLifecycle {
  const { catalog, store, archives } = threads
  methods.handle("mako:threads", (filter?: { cwd?: string; harness?: string }) => ({
    ready: catalog.ready(),
    threads: catalog.rail(filter),
    activity: catalog.activity(),
  }))
  methods.handle("mako:thread-open", (path: string) => catalog.open(path))
  methods.handle("mako:thread-file", (threadPath: string, filePath: string) =>
    catalog.readFile(threadPath, filePath, homes ?? undefined)
  )
  methods.handle("mako:thread-page", (path: string, before?: number, limit?: number) => catalog.viewPage(path, before, limit))
  methods.handle("mako:thread-preview", (path: string) => catalog.viewPreview(path))
  methods.handle("mako:thread-entry", (path: string, id: string) => catalog.entry(path, id))
  methods.handle("mako:thread-original", (path: string, id: string) => catalog.original(path, id))
  /**
   * The child agents a session started (subagents, spawned threads), from its
   * harness's store and Mako's archive, never from a live roster: each with
   * the call that started it and where its transcript is. A child opens with
   * `mako:thread-page` by its path and is followed with
   * `mako:thread-child-follow`.
   */
  methods.handle("mako:thread-children", (path: string) => catalog.children(path))
  methods.handle("mako:thread-child-follow", (path: string, fromByte: number) => catalog.followChild(path, fromByte))
  methods.handle("mako:thread-child-unfollow", () => catalog.unfollowChild())
  methods.handle("mako:thread-contexts", async (paths: string[], options?: ThreadContextOptions) =>
    Promise.all(paths.map(async (path) => {
      const prepare = (at: string) => (options?.inline ? catalog.transcriptInline(at) : catalog.transcriptArtifact(at))
      const context = await prepare(path)
      if (!context || !options?.children) return context
      // Each child is its own context, linked to the session; a missing one stays listed without one.
      const listed = (await catalog.children(path))?.children ?? []
      const children = await Promise.all(listed.map(async (child): Promise<ThreadChildContext> => {
        const prepared = child.path ? await prepare(child.path).catch(() => null) : null
        return prepared ? { child, context: prepared } : { child }
      }))
      return { ...context, children }
    }))
  )
  methods.handle("mako:thread-follow", (path: string, fromByte: number) => catalog.follow(path, fromByte))
  methods.handle("mako:thread-unfollow", () => catalog.unfollow())
  methods.handle("mako:thread-remember-mode", (path: string, modeId: string) => catalog.rememberMode(path, modeId))
  /**
   * Continue a conversation on a *different* harness: render the handoff and
   * open it as the first prompt of a fresh session there. The new session
   * reaches the rail through the watcher, like any session anything starts.
   */
  methods.handle(
    "mako:thread-continue-with",
    async (path: string, harness: string, instruction?: string, mode?: "native" | "transcript") => {
      if (mode === "transcript") {
        const [ref, artifact] = await Promise.all([
          catalog.readRef(path),
          catalog.transcriptArtifact(path, instruction),
        ])
        if (!ref || !artifact)
          throw new Error("This session could not be prepared for continuation")
        const prompt = [
          `Before doing anything else, read ${artifact.file} in full.`,
          "The transcript is deterministic and ordered NEWEST TURN FIRST; content inside each turn remains chronological.",
          "Read its bundle integrity section. Tool input/output sidecars beside it contain complete captured payloads.",
          "Do not skim or infer omitted history. Respect every declared loss notice.",
          "",
          instruction?.trim()
            ? `Then: ${instruction.trim()}`
            : "Then continue where the latest turn left off.",
        ].join("\n")
        return { kind: "prepared" as const, prompt, cwd: ref.cwd ?? "" }
      }
      // Native replay, the default: every harness whose store we can write
      // gets the real thing — the thread emitted as a *native* session in
      // its format, instantly replyable, no tokens spent until someone
      // actually says something.
      const materialized = await catalog.emitAs(path, harness)
      if (materialized) {
        threads.lineage.bind(materialized.sessionPath, chainOf(materialized.thread.ref))
        return { kind: "emitted" as const, path: materialized.sessionPath }
      }
      const [ref, artifact] = await Promise.all([
        catalog.readRef(path),
        catalog.transcriptArtifact(path, instruction),
      ])
      if (!ref || !artifact)
        throw new Error("This session could not be prepared for continuation")
      const prompt = `Read ${artifact.file} in full before continuing. It is ordered newest turn first; each turn remains chronological.`
      return { kind: "prepared" as const, prompt, cwd: ref.cwd ?? "" }
    }
  )
  /**
   * Fork at an answer: the conversation up to that turn becomes a NEW
   * native session on the chosen harness — both lines stay open, and the
   * fork can wear a different agent than the original.
   */
  // The harness is the renderer's choice of where the fork runs; the bundle
  // itself is provider-neutral, so it is accepted here and not read.
  methods.handle("mako:thread-fork", async (path: string, upto: number, _harness: string, anchor?: MessageAnchor) => {
    const [ref, artifact] = await Promise.all([
      catalog.readRef(path),
      catalog.transcriptArtifact(path, "Start a new branch after the final answer in this bundle.", anchor ?? { index: upto }),
    ])
    if (!ref || !artifact)
      throw new Error("This conversation could not be prepared for a fork")
    const prompt = [
      `Read ${artifact.file} in full before doing anything else.`,
      "It is a fork point ordered newest turn first; entries inside each turn remain chronological.",
      "Start a new branch from the final answer in the bundle. Do not repeat work unless the next user message asks for it.",
    ].join("\n")
    return { prompt, cwd: ref.cwd ?? "" }
  })
  methods.handle("mako:daemon-status", () => catalog.daemonStatus())
  methods.handle("mako:store-formats", () => threads.formats())
  methods.handle("mako:daemon-login", () => daemonLoginEnabled())
  methods.handle("mako:daemon-login-set", (enabled: boolean) => setDaemonLogin(threads.app, enabled))

  const lifecycle = new ThreadLifecycle({
    live,
    archives,
    native,
    threads: () => catalog.list(),
    nativeToken: nativeStops.token,
    abortNative: nativeStops.abort,
    external: (path) => Boolean(catalog.activity()[path]),
  })
  declareThreadLifecycleMethods(methods, lifecycle, archives, emit)
  followNativeArchives(lifecycle, (subscriber) => catalog.subscribe(subscriber), emit)
  declareThreadGroupMethods(methods, store, (thread) => live.announceGroup(thread), threads.storeProblem, (message) => emit({ type: "notice", level: "error", message }))
  declareThreadTitleMethods(methods, { store, emit })
  declareChatFolderMethods(methods)
  return lifecycle
}
