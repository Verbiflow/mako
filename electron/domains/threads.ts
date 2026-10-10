import { homedir } from "node:os"
import { join } from "node:path"
import type { HostConfig } from "../host-config.js"
import { hostLabel } from "../host-config.js"
import type { MethodTable } from "../host-methods.js"
import { hostWarn } from "../host-log.js"
import { SessionMemory, sessionMemoryPath } from "../session-memory.js"
import { openThreadStore, threadStorePath, type ThreadStore } from "../thread-store.js"
import { followOtherHosts } from "../thread-groups-follow.js"
import { threadCatalog, type ThreadCatalog } from "../threads.js"
import { WorktreeOrigins } from "../worktree-origins.js"
import { ThreadArchives } from "../thread-archives.js"
import { ThreadLifecycle, followNativeArchives } from "../thread-lifecycle.js"
import { installThreadLifecycleIpc } from "../ipc/thread-lifecycle.js"
import { installThreadGroupsIpc } from "../ipc/thread-groups.js"
import { installThreadTitlesIpc } from "../ipc/thread-titles.js"
import { installChatFoldersIpc } from "../ipc/chat-folders.js"
import { installTranscriptDocumentIpc } from "../ipc/transcript-document.js"
import { bindLineageDirect, chainOf } from "../lineage.js"
import { daemonLoginEnabled, setDaemonLogin } from "../daemon-login.js"
import { abortNative, nativeStopToken } from "../drivers.js"
import type { LiveConversations } from "../live-conversations.js"
import type { NativeRequests } from "../native-requests.js"
import type { ThreadEnvironments } from "../thread-environment.js"
import type { BlockAddress, ThreadContextOptions } from "@mako/host/contracts/conversation-session"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { MessageAnchor } from "@mako/host/contracts/message-anchor"

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
  catalog: ThreadCatalog
  archives: ThreadArchives
  /** After every reader has stopped: the ledger, the store and the archives close. */
  close(): void
}

export function openThreads(config: HostConfig, emit: (event: HostEvent) => void): Threads {
  const { environment, fixtureDesk } = config
  const memory = openSessionMemory(config)
  const { store, problem } = openThreadStore(threadStorePath({ dataRoot: environment.dataRoot, appData: environment.appData }), { readOnly: fixtureDesk })
  if (problem) hostWarn("threads", "Thread store problem", { problem })
  const stopFollowing = store ? followOtherHosts(store, emit) : () => {}
  const origins = new WorktreeOrigins(join(homedir(), ".mako", "worktree-origins.json"))
  const archives = new ThreadArchives(join(environment.dataRoot, "thread-archives.sqlite"))
  return {
    memory,
    store,
    storeProblem: problem,
    origins,
    catalog: threadCatalog({
      dataRoot: environment.dataRoot,
      sessionMemory: memory,
      threadStore: store,
      worktreeOrigins: origins,
      readOnly: fixtureDesk,
      emit,
    }),
    archives,
    close() {
      void origins.flush()
      memory?.close()
      stopFollowing()
      store?.close()
      archives.close()
    },
  }
}

function openSessionMemory(config: HostConfig): SessionMemory | null {
  const { environment } = config
  try {
    const memory = new SessionMemory(sessionMemoryPath(), {
      pid: process.pid,
      startedAt: Math.round(performance.timeOrigin),
      label: hostLabel(config),
      socket: config.socket,
      launch: {
        dataRoot: environment.dataRoot, executable: config.executable,
        args: environment.packaged ? [] : [environment.appRoot], cwd: process.cwd(), profile: environment.profile,
      },
    }, { readOnly: config.fixtureDesk })
    memory.startHeartbeat()
    return memory
  } catch (error) {
    hostWarn("memory", "ledger unavailable", { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

export interface ThreadMethodsDeps {
  threads: Threads
  live: LiveConversations
  native: NativeRequests
  environments: ThreadEnvironments | null
  emit(event: HostEvent): void
}

/** Cross-harness threads: every agent's sessions on this machine, and what becomes of them. */
export function declareThreadMethods(methods: MethodTable, { threads, live, native, environments, emit }: ThreadMethodsDeps): ThreadLifecycle {
  const { catalog, store, archives } = threads
  methods.handle("mako:threads", (filter?: { cwd?: string; harness?: string }) => ({
    ready: catalog.ready(),
    threads: catalog.rail(filter),
    activity: catalog.activity(),
  }))
  methods.handle("mako:thread-open", (path: string) => catalog.open(path))
  methods.handle("mako:thread-file", (threadPath: string, filePath: string) =>
    catalog.readFile(threadPath, filePath, environments ?? undefined)
  )
  methods.handle("mako:thread-page", (path: string, before?: number, limit?: number) => catalog.viewPage(path, before, limit))
  methods.handle("mako:thread-preview", (path: string) => catalog.viewPreview(path))
  methods.handle("mako:thread-block", (path: string, at: BlockAddress) => catalog.block(path, at))
  methods.handle("mako:thread-contexts", async (paths: string[], options?: ThreadContextOptions) =>
    Promise.all(paths.map((path) => options?.inline ? catalog.transcriptInline(path) : catalog.transcriptArtifact(path)))
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
        const [thread, artifact] = await Promise.all([
          catalog.open(path),
          catalog.transcriptArtifact(path, instruction),
        ])
        if (!thread || !artifact)
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
        return { kind: "prepared" as const, prompt, cwd: thread.ref.cwd ?? "" }
      }
      // Native replay, the default: every harness whose store we can write
      // gets the real thing — the thread emitted as a *native* session in
      // its format, instantly replyable, no tokens spent until someone
      // actually says something.
      const materialized = await catalog.emitAs(path, harness)
      if (materialized) {
        bindLineageDirect(materialized.sessionPath, chainOf(materialized.thread.ref))
        return { kind: "emitted" as const, path: materialized.sessionPath }
      }
      const [thread, artifact] = await Promise.all([
        catalog.open(path),
        catalog.transcriptArtifact(path, instruction),
      ])
      if (!thread || !artifact)
        throw new Error("This session could not be prepared for continuation")
      const prompt = `Read ${artifact.file} in full before continuing. It is ordered newest turn first; each turn remains chronological.`
      return { kind: "prepared" as const, prompt, cwd: thread.ref.cwd ?? "" }
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
    const [thread, artifact] = await Promise.all([
      catalog.open(path),
      catalog.transcriptArtifact(path, "Start a new branch after the final answer in this bundle.", anchor ?? { index: upto }),
    ])
    if (!thread || !artifact)
      throw new Error("This conversation could not be prepared for a fork")
    const prompt = [
      `Read ${artifact.file} in full before doing anything else.`,
      "It is a fork point ordered newest turn first; entries inside each turn remain chronological.",
      "Start a new branch from the final answer in the bundle. Do not repeat work unless the next user message asks for it.",
    ].join("\n")
    return { prompt, cwd: thread.ref.cwd ?? "" }
  })
  methods.handle("mako:daemon-status", () => catalog.daemonStatus())
  methods.handle("mako:daemon-login", () => daemonLoginEnabled())
  methods.handle("mako:daemon-login-set", (enabled: boolean) => setDaemonLogin(enabled))

  const lifecycle = new ThreadLifecycle({
    live,
    archives,
    native,
    threads: () => catalog.list(),
    nativeToken: nativeStopToken,
    abortNative,
    external: (path) => Boolean(catalog.activity()[path]),
  })
  installThreadLifecycleIpc(methods, lifecycle, archives, emit)
  followNativeArchives(lifecycle, (subscriber) => catalog.subscribe(subscriber), emit)
  installThreadGroupsIpc(methods, store, live, threads.storeProblem, (message) => emit({ type: "notice", level: "error", message }))
  installThreadTitlesIpc(methods, { store, emit })
  installChatFoldersIpc(methods)
  installTranscriptDocumentIpc(methods, { snapshot: (id) => live.snapshot(id), openThread: (path) => catalog.open(path) })
  return lifecycle
}
