import { browserApplicationIcon } from "./browser-icon.js"
import { z } from "zod"
import { describeHarnesses } from "./providers/harness-descriptors.js"
import type { QueuedPromptEdit } from "./contracts/live-queue.js"
import { hostLifecycle, stopOnSignals, takePredecessor } from "./host-lifecycle.js"
import { nodeShell, type HostShell, type ShellHost } from "./host-shell.js"
import { devHostBuild } from "./dev-host-build.js"
import { hostEnvironment } from "./host-environment.js"
import { acquireHostLock } from "./host-lock.js"
import { RUNTIME_PROTOCOL, type RuntimeInfo } from "./contracts/runtime.js"
import { hostChannels } from "./contracts/host-call-inputs.js"
import { openableLink, socketCalls } from "./contracts/client-calls.js"
import { runtimeInfo, RuntimeDisconnectedError, settleRuntime } from "./runtime-connection.js"
import { lstat, mkdir, rm, stat, unlink } from "node:fs/promises"
import { existsSync, realpathSync, rmSync } from "node:fs"
import type { SessionSettings } from "@mako/sessions/settings"
import { restrictNativeStores } from "@mako/sessions/read-only-sqlite"
import { resolveExecutable } from "./executable.js"
import { Appshots } from "./appshots.js"
import { DesktopChannel } from "./desktop-channel.js"
import type { MakoComputerPermissions } from "./contracts/mcp-skills-integrations.js"
import { ControlPreviews, previewThumbnail } from "./control-previews.js"
import type { DesktopNotification } from "./contracts/notifications.js"
import { assessProviderResume } from "./provider-recovery.js"
import { randomUUID } from "node:crypto"
import type { ProviderBinding, ResumeVerdict } from "./contracts/conversation-control.js"
import { nativePathForSession } from "./threads.js"
import { createContinuationPlanner } from "./continuation.js"
import { NativeRequests } from "./native-requests.js"
import type {
  BlockAddress,
  NativeRequestInput,
} from "./shared.js"
import { startConversationMcp } from "./conversation-mcp.js"
import { BrowserService } from "@mako/control-runtime/browser"
import {
  localBrowsers,
  publishDeskBrowserRegistration,
} from "@mako/control-runtime/desktop"
import { DeskBrowser } from "./desk-browser.js"
import {
  watchDevRendererRegistration,
} from "./dev-renderer-registration.js"
import { deskUrlPolicy } from "./desk-browser-policy.js"
import { compileCacheStatus } from "./compile-cache.js"
import { prepareBrowserExtension } from "./browser-extension-setup.js"
import { ControlSessions } from "./control-sessions.js"
import { launchLines } from "./control-launch.js"
import { portListening, ThreadEnvironments } from "./thread-environment.js"
import { ThreadProcesses } from "./thread-processes.js"
import { beginTrace } from "./app-probe.js"
import { childHistory } from "./watch-backend.js"
import { commandEnvironment, environmentTools } from "./environment-tools.js"
import { spareInstaller } from "./spare-install.js"
import { isSpareCheckout } from "./worktree-carry.js"
import { startControlService } from "./control-service.js"
import type { ForkInput, MessageAnchor, TransferInput } from "./shared.js"
import { TransferInputSchema } from "./contracts/conversation-control.js"
import { readConversationFile } from "./host-workspace.js"
import { resolveFilePreview } from "./file-previews.js"
import { providerHost } from "./providers/index.js"
import { resumes } from "./providers/live-capabilities.js"
import { describeConnection } from "./providers/connection-capability.js"
import { WorkspaceSnapshots } from "./workspace-snapshots.js"
import type { RewindInput } from "./contracts/workspace-snapshots.js"
import type { LiveActionInput } from "./contracts/live-actions.js"
import { LiveConversations } from "./live-conversations.js"
import { SessionMemory, SessionHeldError, sessionMemoryPath } from "./session-memory.js"
import { openThreadStore, threadStorePath } from "./thread-store.js"
import { followOtherHosts } from "./thread-groups-follow.js"
import { ThreadArchives } from "./thread-archives.js"
import { ThreadLifecycle, followNativeArchives } from "./thread-lifecycle.js"
import { installThreadLifecycleIpc } from "./ipc/thread-lifecycle.js"
import { installThreadGroupsIpc } from "./ipc/thread-groups.js"
import { installThreadTitlesIpc } from "./ipc/thread-titles.js"
import { UtilityWork } from "./utility-work.js"
import { installThreadWorktreesIpc } from "./ipc/thread-worktrees.js"
import { installChatFoldersIpc } from "./ipc/chat-folders.js"
import { installWorkspaceMovesIpc } from "./ipc/workspace-moves.js"
import { installPlanBuildsIpc } from "./ipc/plan-builds.js"
import { PlanBuilds } from "./plan-builds.js"
import { installTranscriptDocumentIpc } from "./ipc/transcript-document.js"
import { WorkspaceMoves, type MoveSource } from "./workspace-moves.js"
import { moveablePlace, within, workspaceTools } from "./workspace-tools.js"
import { discardChatFolder, newChatFolder, standsForNoProject } from "./chat-folders.js"
import { ThreadWorktreeService } from "./thread-worktrees.js"
import { moveIntoWorktree as moveConversation, type MovedConversation } from "./conversation-move.js"
import { projectRecipe } from "./thread-recipe.js"
import { CheckoutHeadService } from "./checkout-heads.js"
import { installThreadAppIpc } from "./ipc/thread-app.js"
import { installCheckoutHeadsIpc } from "./ipc/checkout-heads.js"
import { nativeStopToken } from "./drivers.js"
import type { LiveStartOptions } from "./shared.js"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { AppKeySchema, type AppKey } from "./contracts/thread-environments.js"
import { ThreadIdSchema } from "./contracts/thread-identity.js"
import { fileURLToPath } from "node:url"
import type { AgentHost } from "./host.js"
import {
  clearCrashes,
  crashesDir,
  installCrashReporting,
  listCrashes,
  record,
} from "./crash.js"
import { flushHostLog, hostLog, hostLogPath, hostWarn, installHostLog } from "./host-log.js"
import { closeRepositories, configureGit } from "@mako/git"
import { belowAgents } from "./background-priority.js"
import { installProviderChildren } from "./provider-children.js"
import {
  computerPermissions,
  requestComputerPermissions,
} from "./computer-permissions.js"
import { check, installUpdates, updateState } from "./updates.js"
import { installApplicationIpc } from "./ipc/application.js"
import { UsageReader } from "./usage-reader.js"
import {
  automationList,
  bindAutomations,
  fireAutomation,
  loadAutomations,
  noticeHead,
  saveAutomations,
  setEnabled,
  stopWatching,
  watchWorkspace,
} from "./automations.js"
import {
  githubStatus,
  listBranchPulls,
  listPullHeads,
  listPulls,
  listRemoteBranches,
  pullForBranch,
  repoAvatar,
  userAvatar,
  type CreatePullOptions,
} from "./github.js"
import { mergePullRequest, openPullRequest, rerunFailedChecks } from "./pull-requests.js"
import { pullRequestTools } from "./pull-request-tools.js"
import type { MergeMethod } from "./contracts/git-actions.js"
import type { HostPool } from "./pool.js"
import { WorkspaceClients } from "./workspace-clients.js"
import { hostClient, withHostClient } from "./host-client.js"
import { listExternalEditors, openInExternalEditor } from "./editors.js"
import { workspacePreviewPath } from "./workspace-preview.js"
import { revealAction } from "./reveal-policy.js"
import { hostMachine, machineOffer, presentMachine } from "./machine.js"
import {
  daemonStatus,
  emitThreadAs,
  followThread,
  threadsReady,
  threadActivitySnapshot,
  installThreadStore,
  installSessionMemory,
  installThreads,
  listThreads,
  catalogRef,
  railThreads,
  rememberThreadMode,
  openThread,
  pageThread,
  threadBlock,
  viewThreadPage,
  viewThreadPreview,
  readThreadFile,
  stopThreads,
  subscribeThreadEvents,
  transcriptArtifactFor,
  transcriptInlineFor,
  unfollowThread,
} from "./threads.js"
import {
  abortNative,
  bindDrivers,
  resumableHarnesses,
  resumeNative,
  threadRun,
  waitForNativeRun,
  startFresh,
  stopDrivers,
} from "./drivers.js"
import {
  harnessProfile,
  resolveHarnessLaunch,
  resolveNativeLaunch,
  harnessProfiles,
  harnessProfilesNow,
  onHarnessProfile,
  refreshHarnessProfiles,
  stopHarnessProfiles,
  resolveHarnessTuning,
} from "./harnesses.js"
import { RuntimeUpdates } from "./runtime-updates.js"
import { bindLineageDirect, chainOf } from "./lineage.js"
import {
  accountUsage,
  accountUsageSpent,
  onAccountUsage,
  captureAccount,
  accountCatalog,
  completePendingRemovals,
  bindingAccountEnv,
  keepAccount,
  removeAccount,
  useResetCredit,
  selectAccount,
  type AccountHarness,
  type AccountProvider,
} from "./accounts.js"
import { accountRemovalSessions } from "./account-removal-sessions.js"
import {
  cancelAccountLogin,
  startAccountLogin,
  submitAccountLoginCode,
  waitAccountLogin,
} from "./account-login.js"
import type { ProviderConnectionAction } from "./contracts/provider-connection.js"
import { daemonLoginEnabled, setDaemonLogin } from "./daemon-login.js"
import { buildTag } from "./build-identity.js"
import {
  IdleShutdown,
  PROFILE_HOST_IDLE_MS,
  activeHostLeases,
} from "./host-idle.js"
import { TerminalClients } from "./terminal-clients.js"
import { ensureCuaEmbedded, stopCuaEmbedded } from "./cua-embedded.js"
import { cuaDriverStatus, updateCuaDriver } from "./cua-driver-version.js"
import { MAKO_BUNDLE_ID, desktopLaunchEnvironment } from "./local-update-installer.js"
import { bindAcp, stopAcp } from "./acp.js"
import { bindCodexApp, stopCodexApps } from "./codex-app.js"
import {
  deletePlugin,
  listPlugins,
  pluginsDir,
  writePlugin,
} from "./plugins.js"
import { discoverMcpRegistry } from "./mcp-registry.js"
import { integrationCatalog } from "./integrations.js"
import { applyMcpSync, previewMcpSync } from "./mcp-sync.js"
import { nativeAuthoringCatalog, listNativeAuthoring, readNativeAuthoring, writeNativeAuthoring, removeNativeAuthoring } from "./native-authoring.js"
import type { NativeAuthoringTarget, NativeAuthoringWrite, NativeAuthoringRemove } from "./contracts/native-authoring.js"
import {
  discoverSkillRegistry,
  resolveSkillReferences,
} from "./skill-registry.js"
import {
  applySkillSync,
  previewSkillRemove,
  previewSkillSync,
} from "./skill-sync.js"
import { installGitIpc, openUtilityModels } from "./ipc/git.js"
import { fileResponse, localFile } from "./file-response.js"
import { startWebHost } from "./web-host.js"
import { hostSecretKeyHandover } from "./host-secrets.js"
import { SharedConversations } from "./shared-conversations.js"
import { registerIpc as handle, enforceFixtureDesk, invokeHost, invokeHostPreview, installConversationRouting, installHistoryPresentation, stopHostCalls } from "./ipc/register.js"
import { LiveHistoryReader } from "./live-history-reader.js"
import { LiveHistoryReadSchema, type LiveHistoryRead } from "./contracts/live-history.js"
import { installSessionIpc } from "./ipc/session.js"
import { installWorkspaceIpc, stopWorkspaceIpc } from "./ipc/workspace.js"
import { installCloudAccountIpc, stopCloudAccountIpc, wakeCloudAccount } from "./ipc/cloud-account.js"
import { watchWake, type WakeWatch } from "./wake.js"
import { installTelemetry } from "./ipc/telemetry.js"
import type { HostTelemetry } from "./host-telemetry.js"
import type {
  LivePermissionResponse,
  PromptAttachment,
  HostEvent,
  McpSyncTarget,
  SkillSyncTarget,
  TerminalCreateOptions,
  ThreadContextOptions,
} from "./shared.js"
import { nodePlatform } from "./platform.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
/** The renderer bundle, served on `mako-app://desk/` when not on Vite. */
const rendererBundle = join(__dirname, "../dist")
/**
 * One classic script for every renderer. Renderers run sandboxed, so the
 * preload cannot import; `scripts/build-preload.mjs` bundles it.
 */
const PRELOAD = join(__dirname, "preload.cjs")
const environment = hostEnvironment()
/** Electron's own executable, which starts this host again; the Helper runs it in Node mode (`hostCommand`). */
const electronExecutable = process.env.MAKO_HOST_EXECUTABLE ?? process.execPath
const isDev = environment.development
const loadedDevBuild = isDev ? devHostBuild(environment.appRoot) : undefined
const configuredDevServerUrl = isDev
  ? process.env.VITE_DEV_SERVER_URL ?? null
  : null
let activeDevServerUrl = configuredDevServerUrl
/**
 * One data directory per instance. The host's lock is per data directory
 * (`host-lock.ts`), so a source checkout that shared the installed app's directory
 * could never run beside it — and developing Mako from inside Mako needs
 * exactly that: the desk you work in stays up while the build under test
 * comes and goes. Dev defaults to its own profile; `MAKO_PROFILE` names any
 * other, for a second checkout or a throwaway test instance.
 */
const persistentHost = process.env.MAKO_HOST_ONLY === "1"
const webSocket =
  isDev || persistentHost ? process.env.MAKO_WEB_SOCKET : undefined
const instanceProfile = environment.profile
/** The installed app's own directory; a launcher passes it back as MAKO_DATA_ROOT. */
const defaultUserData = environment.defaultDataRoot
/**
 * Electron while Electron's main process runs the host; plain Node, or
 * Electron's Helper in Node mode (`MAKO_HOST_RUNTIME=node`), otherwise. The
 * Electron shell is the one module of the host that imports Electron.
 */
const shellHost: ShellHost = {
  environment,
  development: isDev,
  persistent: persistentHost,
  rendererBundle,
  preload: PRELOAD,
  devServerUrl: () => activeDevServerUrl,
  isDeskUrl: (url) => isDeskUrl(url),
  openLink: (url) => openLink(url),
  emit: (event) => emit(event),
  release: (client) => {
    terminalClients?.release(client)
    void workspaceClients.release(client)
  },
  running: () => lifecycle.running(),
  socketClients: () => webHost?.clients().length ?? 0,
}
const shell: HostShell = process.type === "browser"
  ? (await import("./host-shell-electron.js")).electronShell(shellHost)
  : nodeShell()
const exitHost = shell.exit
/**
 * A fixture desk host serves agents a look at the interface. It keeps its own
 * profile and refuses every host call outside the fixture allowlist, from
 * every client, for its whole life.
 */
const fixtureDesk = process.env.MAKO_FIXTURE_DESK === "1"
if (fixtureDesk) {
  enforceFixtureDesk()
  restrictNativeStores()
  if (!/(^|-)fixture-/.test(basename(environment.dataRoot))) {
    process.stderr.write("A fixture desk host needs a fixture profile of its own\n")
    exitHost(78, false)
  }
}
installHostLog(join(environment.dataRoot, "logs", "host.log"))
for (const [name, [ours, electron]] of shell.disagreements)
  hostWarn("host", "the host's environment disagrees with Electron's", { name, ours: String(ours), electron: String(electron) })
/** A Git process slower than this is logged. */
const GIT_SLOW_MS = 2_000
configureGit({
  background: belowAgents,
  // Every Git process with MAKO_GIT_TRACE=1; otherwise the slow ones and those stopped for time, to explain a stall.
  // Failures alone are routine: probes such as `rev-parse --verify` fail by design.
  trace: (run) => {
    const traced = process.env.MAKO_GIT_TRACE === "1"
    if (!traced && run.ms < GIT_SLOW_MS && run.outcome !== "timeout") return
    // A remote URL in Git's error output can carry a token.
    const stderr = traced && run.stderr ? { stderr: run.stderr.replace(/\/\/[^/@\s]+@/g, "//***@") } : {}
    hostLog("git", `${run.command} ${run.outcome}`, { args: run.args.slice(0, 6).join(" ").slice(0, 200), cwd: run.cwd, ms: Math.round(run.ms), queuedMs: Math.round(run.queuedMs), code: run.code ?? -1, bytes: run.bytes, ...stderr })
  },
})
// Earlier builds drafted with Kiri and cached its analyses here; nothing reads them now.
void rm(join(environment.dataRoot, "kiri-analysis-cache"), { recursive: true, force: true })
  .catch((error: Error) => hostWarn("git", "retired Kiri cache not removed", { error: error.message }))
const providerChildren = installProviderChildren(environment.dataRoot)
/** How another host's refusal names this one. */
function sessionMemoryLabel(): string {
  if (instanceProfile) return `Mako's ${instanceProfile} host`
  if (resolve(environment.dataRoot) !== resolve(defaultUserData))
    return `another Mako host (${basename(environment.dataRoot)})`
  return environment.packaged ? "the installed Mako app" : "Mako's default host"
}
/**
 * Per-user, shared by every host on this Mac: what each native session last
 * ran as and which host has it live. Without it a thread started in the
 * installed app read "Model not recorded" in a development host and both
 * could open one store.
 */
const sessionMemory = openSessionMemory()
function openSessionMemory(): SessionMemory | null {
  try {
    const memory = new SessionMemory(sessionMemoryPath(), {
      pid: process.pid,
      startedAt: Math.round(performance.timeOrigin),
      label: sessionMemoryLabel(),
      socket: process.env.MAKO_WEB_SOCKET,
      launch: {
        dataRoot: environment.dataRoot, executable: electronExecutable,
        args: environment.packaged ? [] : [environment.appRoot], cwd: process.cwd(), profile: instanceProfile,
      },
    }, { readOnly: fixtureDesk })
    memory.startHeartbeat()
    return memory
  } catch (error) {
    hostWarn("memory", "ledger unavailable", { error: error instanceof Error ? error.message : String(error) })
    return null
  }
}
installSessionMemory(sessionMemory)
/**
 * Per-user like the ledger: which Session and Thread every journal and
 * native session belongs to, so every host names a conversation alike. A
 * fixture root keeps its own store; a fixture desk only reads the user's.
 */
const { store: threadStore, problem: threadStoreProblem } = openThreadStore(threadStorePath({ dataRoot: environment.dataRoot, appData: environment.appData }), { readOnly: fixtureDesk })
if (threadStoreProblem) hostWarn("threads", "Thread store problem", { problem: threadStoreProblem })
installThreadStore(threadStore)
const stopFollowingThreads = threadStore ? followOtherHosts(threadStore, (event) => emit(event)) : () => {}
const utilityModels = openUtilityModels()
/** Which model drafts commit messages. */
const utilityWork = new UtilityWork({ models: utilityModels })
const checkoutHeads = new CheckoutHeadService((heads) => emit({ type: "checkout-heads", heads }))
/** Beside the Thread store, so every profile sharing the store shares its worktrees. */
const conversationsIn = (path: string, status: (value: string) => boolean) => liveConversations
  .summaries()
  .filter(({ session }) => status(session.status) && (session.cwd === path || session.cwd.startsWith(`${path}/`)))
  .map(({ session }) => `“${session.title || "Untitled conversation"}”`)
/** The recipe Mako keeps for each project, one file per repository, outside every checkout. */
const threadRecipes = threadStore ? join(realpathSync(dirname(threadStore.path)), "recipes") : undefined
/** Beside the Thread store too, so a Thread keeps one data folder whichever host starts its agents. */
const threadEnvironments = threadStore
  ? new ThreadEnvironments({ store: threadStore, dataRoot: join(realpathSync(dirname(threadStore.path)), "thread-data"), recipesRoot: threadRecipes })
  : null
/** Whose app a key is, in words: a Worktree Thread's, or a folder's that Threads share. */
function whoseApp(app: AppKey): string | undefined {
  const thread = ThreadIdSchema.safeParse(app)
  if (thread.success) {
    const title = threadStore?.thread(thread.data)?.title
    return title ? `the Thread “${title}”` : undefined
  }
  const folder = threadProcesses?.checkoutOf(app)
  if (folder && isSpareCheckout(folder)) return "the install of a checkout kept ready for a new Thread"
  return folder ? `the ${basename(folder)} folder` : undefined
}
/** What changed on disk while apps ran, for their probes; FSEvents keeps that history, so macOS only. */
const fileHistory = childHistory()
/** The Worktree Thread an app belongs to, for the Room. */
function appOwner(app: AppKey): { id: string; title: string } | undefined {
  const thread = ThreadIdSchema.safeParse(app)
  const found = thread.success ? threadStore?.thread(thread.data) : undefined
  return found ? { id: found.id, title: found.title || "Untitled Thread" } : undefined
}
/** And its running app's records, so any host sees and stops the processes another host started. */
const threadProcesses = threadStore
  ? new ThreadProcesses({
      root: join(realpathSync(dirname(threadStore.path)), "thread-environments"),
      listening: portListening,
      whose: (app) => whoseApp(app),
      cameUp: (folder, at) => beginTrace(folder, at, fileHistory),
    })
  : null
/** A long quiet, not a short timer: a stopped app keeps its files and data, and restarting it for nothing costs more than it frees. */
const THREAD_APP_IDLE_MS = 6 * 60 * 60 * 1000
if (!fixtureDesk) setInterval(() => {
  void threadProcesses?.stopIdle(THREAD_APP_IDLE_MS).then((stopped) => {
    if (stopped.length) hostLog("threads", "stopped apps unused for six hours", { threads: stopped.join(", ") })
  }, (error) => hostWarn("threads", "idle apps couldn't be stopped", { error: error instanceof Error ? error.message : String(error) }))
}, 10 * 60 * 1000).unref()
/** Each running copy's peak counts toward its project's "about N at once"; with nothing running a look reads no process table. */
setInterval(() => {
  void threadProcesses?.memory().catch((error) => hostWarn("threads", "app memory couldn't be measured", { error: error instanceof Error ? error.message : String(error) }))
}, 30_000).unref()
/** The recipe's cleanup for a worktree about to be removed, once the app tools exist. */
let worktreeCleanup: ((path: string) => Promise<string | undefined>) | undefined
const threadWorktrees = threadStore
  ? new ThreadWorktreeService(join(realpathSync(dirname(threadStore.path)), "worktrees"), threadStore, async (path) => {
      const shells = (await terminalClients?.runningShells().catch(() => []) ?? [])
        .filter((shell) => shell.cwd === path || shell.cwd.startsWith(`${path}/`))
        .map((shell) => `the terminal “${shell.title}”`)
      return [...conversationsIn(path, (status) => status !== "closed"), ...shells]
    }, async (path) => conversationsIn(path, (status) => status === "running"), threadProcesses && threadEnvironments ? {
      stop: async (thread) => { await threadProcesses.stop(AppKeySchema.parse(thread)) },
      cleanup: async (thread, path) => {
        const done = await worktreeCleanup?.(path).catch((error: Error) => `cleanup couldn't run: ${error.message}`)
        if (done) hostLog("threads", "worktree cleanup", { thread, path, result: done })
      },
      discard: async (thread, path) => {
        await threadProcesses.discard(AppKeySchema.parse(thread))
        await threadProcesses.forgetPrepared(path)
        await rm(threadEnvironments.dataDir(AppKeySchema.parse(thread)), { recursive: true, force: true })
      },
    } : undefined, threadProcesses ? {
      recipe: (checkout) => projectRecipe(checkout, threadRecipes),
      prepared: (checkout) => threadProcesses.prepared(checkout),
      savePrepared: (checkout, prepared) => threadProcesses.savePrepared(checkout, prepared),
      forgetPrepared: (checkout) => threadProcesses.forgetPrepared(checkout),
      spareInstall: spareInstaller({
        processes: threadProcesses,
        recipe: (checkout) => projectRecipe(checkout, threadRecipes),
        env: (values) => ({ ...commandEnvironment(), ...values }),
      }),
    } : undefined)
  : null
hostLog("host", "starting", {
  pid: process.pid,
  version: environment.version,
  profile: instanceProfile || "default",
  persistent: persistentHost,
  electron: process.versions.electron ?? "",
  node: process.versions.node ?? "",
  dataRoot: environment.dataRoot,
  compileCache: compileCacheStatus(),
})
const hostLock = await acquireHostLock(environment.dataRoot, { predecessor: takePredecessor() })
// A host from before this lock holds only Electron's, and answers on the socket once it listens.
// A socket that neither answers nor refuses counts as occupied.
const olderHost = hostLock.kind === "held" && persistentHost && webSocket
  ? await settleRuntime(webSocket, { timeoutMs: 2_000 }).then((probe) => probe.state !== "absent", () => true)
  : false
// Electron's lock stays for standalone mode alone, which reopens its window on a second launch.
if (hostLock.kind === "taken" || olderHost || (!persistentHost && !shell.singleInstance())) {
  hostWarn("host", "another host holds this data root", {
    dataRoot: environment.dataRoot,
    holder: hostLock.kind === "taken" ? hostLock.holder : null,
    olderHost,
  })
  console.error(
    "Mako is already running. Close the existing desk host before starting another desktop or web host."
  )
  // Exiting drops queued log writes; this line is the only record a detached launch leaves.
  await flushHostLog()
  exitHost(1, false)
}

let conversationMcp: Awaited<ReturnType<typeof startConversationMcp>> | null =
  null
let workspaceMoves: WorkspaceMoves | null = null
let nativeRequests: NativeRequests | null = null
let usageReader: UsageReader | undefined
/**
 * The desktop app attached on `/desktop`, for what only Electron's main
 * process can do. It answers first; a host Electron runs answers the rest
 * itself, and a host under Node without a desktop goes without.
 */
const desktop = new DesktopChannel()
const appshots = new Appshots(async () => {
  const driver = resolveExecutable("cua-driver")
  const socket = await ensureMakoLocalControl()
  return driver && socket
    ? { command: driver, args: ["mcp", "--embedded", "--socket", socket] }
    : null
}, undefined, () => desktop.answers("window-thumbnails") ? desktop.capturer() : shell.capturer)
const deskBrowser = new DeskBrowser({
  fixture: fixtureDesk,
  allowsUrl: (url) => isDeskUrl(url),
  createPage: (previewId) => {
    if (desktop.answers("desk-page-create")) return desktop.deskPage(previewId)
    if (shell.deskPage) return shell.deskPage(previewId)
    throw new Error("Open Mako's desktop app to let agents open Mako's own windows.")
  },
})
function readComputerPermissions(): Promise<MakoComputerPermissions> {
  if (desktop.answers("computer-permissions")) return desktop.ask("computer-permissions", {})
  return Promise.resolve(computerPermissions(shell.privacy))
}
let removeDeskBrowserRegistration: (() => void) | undefined
let stopDevRendererWatch: (() => void) | undefined
let defaultBrowserApplication: Promise<string | undefined> | undefined
function preferredBrowserApplication() {
  const machine = hostMachine()
  return (defaultBrowserApplication ??= machine.kind === "present" ? machine.defaultBrowser() : Promise.resolve(undefined))
}
/** A link from a window this host shows itself: a desk window, or the standalone window. */
function openLink(url: string) {
  const link = openableLink(url)
  if (!link) return
  void Promise.resolve()
    .then(() => presentMachine().openUrl(link))
    .catch((error: Error) => hostWarn("machine", "link not opened", { reason: error.message }))
}
// The application owns checkout resources; the reusable Node runtime does not
// infer workspace paths. Child control servers receive the same explicit root.
const developmentMedia = join(environment.appRoot, "vendor/control-media", `${nodePlatform()}-${process.arch}`)
if (!environment.packaged && existsSync(developmentMedia))
  process.env.MAKO_CONTROL_MEDIA_ROOT ??= developmentMedia
const browserControl = new BrowserService(
  async () => {
    const defaultPath = await preferredBrowserApplication()
    const browsers = await localBrowsers(defaultPath ? [defaultPath] : [])
    await shell.ready()
    return [
      ...(await Promise.all(
        browsers.map(async (browser) => {
          const path = browser.applicationPath
          if (!path) return browser
          return { ...browser, icon: await browserApplicationIcon(path) }
        })
      )),
      deskBrowser.definition,
    ]
  },
  {
    preferencePath: join(environment.dataRoot, "browser-preference.json"),
    defaultApplication: preferredBrowserApplication,
  }
)
let devRendererGeneration = 0
async function configureDevRenderer(
  registration: {
    profile: string
    sourceRoot: string
    url: string
  } | null
): Promise<void> {
  const generation = ++devRendererGeneration
  activeDevServerUrl = registration?.url ?? configuredDevServerUrl
  removeDeskBrowserRegistration?.()
  removeDeskBrowserRegistration = undefined
  if (!registration) {
    await browserControl.refresh()
    return
  }
  try {
    const endpoint = await deskBrowser.start()
    if (generation !== devRendererGeneration) return
    removeDeskBrowserRegistration = publishDeskBrowserRegistration({
      endpoint,
      origin: new URL(registration.url).origin,
      profile: registration.profile,
      sourceRoot: registration.sourceRoot,
      fixture: fixtureDesk,
    })
  } catch (error) {
    hostWarn("browser", "dev desk registration failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  await browserControl.refresh()
}
const controlPreviews = new ControlPreviews(
  browserControl,
  previewThumbnail,
  (activity) => emit({ type: "control-activity", activity })
)
let controlService: Awaited<ReturnType<typeof startControlService>> | null =
  null
let liveConversations: LiveConversations
let hostTelemetry: HostTelemetry | undefined
const liveHistory = new LiveHistoryReader(pageThread, threadBlock)
installHistoryPresentation(value => liveHistory.present(value))
let threadArchives: ThreadArchives
/**
 * Runtime versions are a per-user fact, like the provider profiles beside
 * them: every host on this machine launches the same binaries.
 */
const runtimeUpdates = new RuntimeUpdates({
  sources: () => providerHost.updateSources.list(),
  path: join(homedir(), ".mako", "runtime-updates.json"),
  emit: (updates) => emit({ type: "runtime-updates", updates }),
  // A new binary lists new models: drop the catalog and discover again, so
  // the picker shows what the updated CLI offers without a restart.
  onRuntimeChanged: ({ provider }) => {
    void refreshHarnessProfiles(provider)
  },
})
let threadLifecycle: ThreadLifecycle
let webHost: Awaited<ReturnType<typeof startWebHost>> | undefined
let sharedConversations: SharedConversations | undefined
const webOnly =
  persistentHost || Boolean(webSocket && process.env.MAKO_WEB_ONLY !== "0")
let terminalClients: TerminalClients | null = null
const workspaceClients = new WorkspaceClients(emit)

function terminal() {
  if (!terminalClients) throw new Error("Terminal service is not ready")
  return terminalClients.forOwner(hostClient())
}

/** Each reason is told once per host; every failed start is still logged. */
const controlUnavailableNotices = new Set<string>()
const controlSessions = new ControlSessions(async () => {
  const driver = resolveExecutable("cua-driver")
  if (!driver) return undefined
  const socket = await ensureMakoLocalControl()
  return socket ? { driver, socket } : undefined
})

function ensureMakoLocalControl() {
  return ensureCuaEmbedded(
    join(environment.dataRoot, "computer-use", "cua"),
    MAKO_BUNDLE_ID
  )
}

let wakeWatch: WakeWatch | undefined
function emitTerminalWake() {
  webHost?.terminal({ type: "wake" })
  shell.send("mako:terminal-event", { type: "wake" })
}

const holds = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`)

/**
 * The Thread's other open Sessions editing in the same checkout as this
 * one, in a folder around it or inside it. Archived ones, such as those a
 * move left behind, and those in the Thread's worktree already stay put.
 */
function threadCompanions(id: string): string[] {
  const placed = threadStore?.journalPlacement(id)
  const cwd = liveConversations.session(id)?.cwd
  if (!placed || !cwd) return []
  const worktree = threadWorktrees?.threadCheckout(id)?.path
  return liveConversations.summaries()
    .filter(({ session, threadId }) => session.id !== id && threadId === placed.thread && session.status !== "closed" &&
      (holds(cwd, session.cwd) || holds(session.cwd, cwd)) && !(worktree && holds(worktree, session.cwd)) &&
      !threadLifecycle.controls({ kind: "live", id: session.id }).archived)
    .map(({ session }) => session.id)
}

/** Where a Thread's move starts from: the outermost folder among this Session's and its companions', so the worktree is the whole project's. */
function moveProject(id: string): string | undefined {
  const cwd = liveConversations.session(id)?.cwd
  if (!cwd) return undefined
  return threadCompanions(id)
    .map((other) => liveConversations.session(other)?.cwd ?? cwd)
    .reduce((outer, folder) => holds(folder, outer) ? folder : outer, cwd)
}

/** Move a conversation into its Thread's worktree (`conversation-move.ts`). */
function moveIntoWorktree(id: string, input: ForkInput, project?: string): Promise<MovedConversation> {
  if (!threadWorktrees) throw new Error("Worktrees need the Thread store, which didn't open.")
  return moveConversation({ conversations: liveConversations, worktrees: threadWorktrees, warn: (message, facts) => hostWarn("workspace", message, facts) }, id, input, project)
}

/**
 * The move an agent asked for and the user allowed, once its turn and its
 * companions' ended: the Session goes on in the Thread's worktree, and the
 * agent is told where it is now. A fork leaves the Session it came from
 * archived. A companion (`asked` false) follows quietly, starting no turn.
 */
async function moveOntoOwnBranch(id: string, asked = true): Promise<void> {
  const source = liveConversations.snapshot(id)
  if (!source) throw new Error("The conversation closed before it could move onto its own branch.")
  const last = source.requests.filter((request) => request.status === "completed").at(-1)
  if (!last) throw new Error(asked
    ? "The agent's turn didn't finish, so it didn't move onto its own branch. Move it from the composer once it has an answer."
    : `“${source.session.title || "Untitled conversation"}” stayed in the main checkout: it has no answer yet to go on from in the worktree.`)
  const { conversation, moved, relocated } = await moveIntoWorktree(id, {
    id: crypto.randomUUID(),
    provider: source.session.harness,
    point: { kind: "run", requestId: last.id },
    thread: "parent",
    worktree: true,
    move: true,
  }, asked ? moveProject(id) : undefined)
  if (!relocated)
    emit({ type: "thread-archives", snapshot: threadLifecycle.archive({ id: crypto.randomUUID(), target: { kind: "live", id }, archived: true }) })
  const branch = threadWorktrees?.ofConversation(conversation.session.id)?.branch
  const event: Extract<HostEvent, { type: "workspace-moved" }> = { type: "workspace-moved", from: id, to: conversation.session.id, changed: moved }
  if (branch) event.branch = branch
  emit(event)
  if (!asked) return
  const came = moved ? ` The ${moved === 1 ? "uncommitted file" : `${moved} uncommitted files`} from the project folder came with you.` : ""
  const tuning = await resolveHarnessLaunch(conversation.session.harness, conversation.session.cwd, last.tuning)
  liveConversations.submit(
    conversation.session.id,
    crypto.randomUUID(),
    `You're on this Thread's own branch now${branch ? `, ${branch}` : ""}, in ${conversation.session.cwd}.${came} Work there from now on, and carry on where you left off.`,
    [],
    tuning,
    undefined,
    undefined,
    { kind: "service", name: "workspace" }
  )
}

/** Live sessions mid-turn, by id, with the harness that is spending. */
const spending = new Map<string, string>()

/** A session write older than this is the catalog catching up, not use. */
const RECENT_WRITE_MS = 2 * 60_000
/** A harness busy outside Mako writes constantly; its limits are read again at most this often. */
const STORE_SPEND_THROTTLE_MS = 60_000

/**
 * Every harness's turn ends here, live or headless; its limits moved. So
 * does any write to its session store, from Mako or a terminal elsewhere.
 */
function noteSpend(event: HostEvent) {
  let ended: string | undefined
  let throttle: number | undefined
  const status = event.type === "live-batch" ? (event.batch.session ?? event.batch.sessionChanges)?.status : undefined
  if (event.type === "live-batch" && status) {
    const harness = event.batch.session?.harness ?? liveConversations?.session(event.batch.id)?.harness
    if (status === "running" && harness) spending.set(event.batch.id, harness)
    else if (status !== "running") { ended = spending.get(event.batch.id); spending.delete(event.batch.id) }
  } else if (event.type === "thread-run" && event.run.status !== "running") {
    ended = event.run.harness
  } else if (event.type === "thread-ref" && Date.now() - Date.parse(event.ref.updatedAt ?? "") < RECENT_WRITE_MS) {
    ended = event.ref.harness
    throttle = STORE_SPEND_THROTTLE_MS
  }
  if (ended !== undefined && accountUsageSpent(ended, throttle))
    emit({ type: "account-usage-spent", harness: ended })
}

onAccountUsage((harness, name, usage) => emit({ type: "account-usage", harness, name, usage }))

const accountRemoval = accountRemovalSessions(
  () => liveConversations ?? undefined,
  (harness, name, event) => emit({ type: "account-removal", harness, name, event })
)

function emit(event: HostEvent, client?: string) {
  if (hostClosing) return
  noteSpend(event)
  if (event.type === "threads" || event.type === "thread-ref")
    liveConversations?.discoverNativePaths()
  if (event.type === "live-batch") workspaceMoves?.settled(event.batch.id)
  if (event.type === "thread-run" && event.run.status !== "running")
    nativeRequests?.ready(event.run.path)
  // Git status is recomputed after every turn and on focus, which is exactly
  // when HEAD could have moved — so the commit trigger rides on it rather than
  // running a watcher of its own.
  // Selecting a child repository is not a commit in the parent workspace.
  if (event.type === "git" && !event.git.repositories?.length) noticeHead(event.git.head)
  webHost?.event(event, client)
  shell.send("mako:event", event, client)
}

/** The system is shutting down or logging out; Electron's quit then ends the host instead of backgrounding it. */
let systemShutdown = false
/** Set when cleanup begins; events stop going out from then on. */
let hostClosing = false
let application: ReturnType<typeof installApplicationIpc> | undefined
const lifecycle = hostLifecycle({
  cleanup: cleanupHost,
  exit: exitHost,
  log: (message, fields) => hostLog("lifecycle", message, fields),
  failed: async (error) => {
    hostWarn("lifecycle", "shutdown failed", { error: String(error) })
    await flushHostLog()
  },
})

function hasActiveWork(): boolean {
  return application
    ? application.lifecycle.snapshot().work.length > 0
    : Boolean(
        liveConversations?.hasActiveWork() ||
        nativeRequests
          ?.list()
          .some(
            (request) =>
              request.status === "dispatching" || request.status === "queued"
          )
      )
}

/**
 * A profile host (dev, sandbox, test) stops itself soon after nothing holds
 * it: no client, no launcher lease, no work. The installed app's host on the
 * default profile never does: it is the product and outlives every window.
 * What holds it is logged whenever that changes, so a host that stays up says
 * why.
 */
function watchProfileHostIdle(hostDirectory: string): void {
  let leases = 0
  let held: string | null = null
  const holds = () => {
    const clients = webHost?.clients().length ?? 0
    const reasons = [
      !lifecycle.running() && "stopping",
      application?.lifecycle.blocked && "lifecycle blocked",
      hasActiveWork() && "active work",
      shell.windowOpen() && "open window",
      clients > 0 && `${clients} web client${clients === 1 ? "" : "s"}`,
      leases > 0 && `${leases} launcher lease${leases === 1 ? "" : "s"}`,
    ].filter(Boolean)
    const now = reasons.join(", ") || "nothing"
    if (now !== held) {
      held = now
      hostLog("lifecycle", "idle watch", { holds: now })
    }
    return reasons.length > 0
  }
  const idle = new IdleShutdown({
    idleMs: PROFILE_HOST_IDLE_MS,
    now: () => Date.now(),
    busy: holds,
    quit: () => {
      hostLog("lifecycle", "idle; stopping", {
        profile: instanceProfile,
        idleSeconds: PROFILE_HOST_IDLE_MS / 1000,
      })
      void lifecycle.stop({ kind: "idle" })
    },
  })
  const timer = setInterval(() => {
    activeHostLeases(hostDirectory)
      .then((holders) => {
        leases = holders.length
        idle.tick()
      })
      .catch((error) =>
        hostWarn("lifecycle", "idle watch failed", { error: String(error) })
      )
  }, 5_000)
  timer.unref()
}

async function reopenWindow(): Promise<void> {
  if (!lifecycle.running()) return
  if (webOnly && !shell.clients().length) {
    // The default profile answers an activate/second-instance by starting a
    // desktop client; a sandbox or test host owns another data root and stays
    // headless. Packaged clients must come up through `open -n` — a process
    // spawned outside LaunchServices checks in as a UIElement, which `open`
    // can then resolve as the bundle's instance and fail to activate.
    if (
      persistentHost &&
      resolve(environment.dataRoot) === resolve(defaultUserData)
    ) {
      const env = desktopLaunchEnvironment(process.env)
      if (environment.packaged) {
        spawn("open", ["-n", resolve(dirname(environment.appRoot), "../..")], {
          detached: true,
          stdio: "ignore",
          env,
        }).unref()
        return
      }
      spawn(electronExecutable, [environment.appRoot], {
        detached: true,
        stdio: "ignore",
        env,
      }).unref()
    }
    return
  }
  await shell.reopen(!webOnly)
}

function relaunch() {
  if (!application)
    throw new Error("Mako is still starting. Try again once it is ready.")
  return application.lifecycle.command({ kind: "wait", action: "restart" })
}

/** Start the first tab once, however many callers race for it. */
async function ready(): Promise<HostPool> {
  return workspaceClients.ready(hostClient())
}

/**
 * Run against the tab in front.
 *
 * Every command from the UI is aimed at the conversation on screen — that is
 * the only one with a composer pointed at it — so tab routing does not need to
 * reach the handlers. Background tabs keep streaming; they just take no orders.
 */
async function withHost<T>(
  run: (host: AgentHost) => T | Promise<T>
): Promise<T> {
  const live = await ready()
  return run(live.active)
}

const isDeskUrl = (url: string) =>
  deskUrlPolicy({
    devServerUrl: isDev ? activeDevServerUrl : null,
  })(url)

async function assessResume(binding: ProviderBinding): Promise<ResumeVerdict> {
  // Closed native records may be relocated; neither path grants a reopen.
  const current = binding.nativeId
    ? nativePathForSession({ harness: binding.provider, nativeId: binding.nativeId, nativePath: binding.path })
    : undefined
  const closed = [binding.path, current]
    .map((path) => path ? catalogRef(path) : undefined)
    .find((ref) => ref?.harness === binding.provider && ref.resumeUnavailable)
  if (closed?.resumeUnavailable) return { kind: "closed", reason: closed.resumeUnavailable }
  return assessProviderResume(binding, providerHost.liveDrivers.get(binding.provider))
}

function bindIpc() {
  installSessionIpc({
    liveSummaries: () => liveConversations.summaries(),
    archives: () => threadArchives.snapshot(),
    ready,
    withHost,
    platform: nodePlatform(),
    machine: () => machineOffer(hostMachine()),
    sourceRoot: isDev ? environment.appRoot : undefined,
    onWorkspaceChanged: watchWorkspace,
  })

  installWorkspaceIpc({ withHost, emit })
  installGitIpc({
    withHost,
    models: utilityModels,
    work: utilityWork,
  })

  handle("mako:list-plugins", () => listPlugins())
  handle("mako:plugins-dir", () => pluginsDir())
  handle("mako:write-plugin", (_e, id: string, source: string) =>
    writePlugin(id, source)
  )
  handle("mako:delete-plugin", (_e, id: string) => deletePlugin(id))
  handle("mako:reveal-plugins", async () => {
    await presentMachine().open(pluginsDir())
  })

  handle("mako:pick-folder", () => presentMachine().chooseFolder("Choose a folder"))
  handle("mako:external-editors", () => listExternalEditors())
  handle("mako:open-in-editor", (_e, path: string, editor?: string) =>
    withHost(async (h) => {
      const absolute = await h.resolvePath(path)
      await openInExternalEditor(absolute, editor)
    })
  )
  handle("mako:reveal", (_e, path: string) =>
    withHost(async (h) => {
      // Documents open in their default app; anything the default handler
      // would run (bundles, executables, `.command`) is only shown in Finder.
      // The path may come from anywhere, including an agent's answer.
      const absolute = await h.resolvePath(path)
      const info = await stat(absolute)
      const machine = presentMachine()
      if (revealAction(absolute, info) === "open" && (await machine.open(absolute))) return
      await machine.reveal(absolute)
    })
  )
  handle("mako:github-status", () => withHost((h) => githubStatus(h.gitWorkspace)))
  handle("mako:pull-request", () => withHost((h) => pullForBranch(h.gitWorkspace)))
  handle("mako:pull-requests", (_e, limit?: number) =>
    withHost((h) => listPulls(h.gitWorkspace, limit))
  )
  handle("mako:pull-branches", () =>
    withHost((h) => listRemoteBranches(h.gitWorkspace))
  )
  handle("mako:create-pull", (_e, options: CreatePullOptions) =>
    withHost(async (h) => {
      const opened = await openPullRequest(h.gitWorkspace, options)
      threadWorktrees?.forgetPulls()
      return opened.pull
    })
  )
  handle("mako:merge-pull", (_e, strategy: MergeMethod) =>
    withHost(async (h) => {
      const { pull } = await mergePullRequest(h.gitWorkspace, strategy)
      threadWorktrees?.forgetPulls()
      return pull
    })
  )
  handle("mako:rerun-checks", () => withHost((h) => rerunFailedChecks(h.gitWorkspace)))
  handle("mako:repo-avatar", (_e, repo: string) =>
    withHost((h) => repoAvatar(h.gitWorkspace, repo))
  )
  handle("mako:user-avatar", () => withHost((h) => userAvatar(h.gitWorkspace)))

  handle("mako:usage", () => {
    usageReader ??= new UsageReader({
      ledgerPath: join(environment.dataRoot, "usage-ledger.sqlite"),
      sessionsRoot: join(homedir(), ".mako", "sessions"),
      homeRoot: homedir(),
      conversationsRoot: join(environment.dataRoot, "conversations"),
    })
    return usageReader.read()
  })

  /* Cross-harness threads: every agent's sessions on this machine. */
  handle("mako:threads", (_e, filter?: { cwd?: string; harness?: string }) => ({
    ready: threadsReady(),
    threads: railThreads(filter),
    activity: threadActivitySnapshot(),
  }))
  handle("mako:thread-open", (_e, path: string) => openThread(path))
  handle("mako:thread-file", (_e, threadPath: string, filePath: string) =>
    readThreadFile(threadPath, filePath, threadEnvironments ?? undefined)
  )
  handle(
    "mako:thread-page",
    (_e, path: string, before?: number, limit?: number) =>
      viewThreadPage(path, before, limit)
  )
  handle("mako:thread-preview", (_e, path: string) => viewThreadPreview(path))
  handle("mako:thread-block", (_e, path: string, at: BlockAddress) =>
    threadBlock(path, at)
  )
  handle(
    "mako:thread-contexts",
    async (_e, paths: string[], options?: ThreadContextOptions) =>
      Promise.all(
        paths.map((path) =>
          options?.inline
            ? transcriptInlineFor(path)
            : transcriptArtifactFor(path)
        )
      )
  )
  handle("mako:thread-follow", (_e, path: string, fromByte: number) =>
    followThread(path, fromByte)
  )
  handle("mako:thread-unfollow", () => unfollowThread())
  const installed = () => [
    ...new Set([
      ...resumableHarnesses(),
      ...providerHost.liveDrivers
        .list()
        .filter((driver) => driver.available(environment.appRoot))
        .map((driver) => driver.provider),
    ]),
  ]
  const continuation = createContinuationPlanner({
    assessResume: async (ref) => assessResume({
      id: ref.nativeId, provider: ref.harness, nativeId: ref.nativeId, path: ref.path,
      coveredBlocks: 0, includesBase: false,
    }),
    resolveOwner: async (ref) => sharedConversations
      ? sharedConversations.resolve(ref.harness, ref.nativeId, Boolean(ref.heldBy || ref.locked || threadActivitySnapshot()[ref.path]))
      : { kind: "unavailable", reason: "Session ownership is unavailable. Retry when the host reconnects." },
    ref: async (path) =>
      listThreads().find((ref) => ref.path === path) ??
      (await openThread(path))?.ref,
    live: (provider) => {
      const driver = providerHost.liveDrivers.get(provider)
      return driver
        ? { available: driver.available(environment.appRoot), canResume: resumes(driver) }
        : null
    },
    nativeInstalled: (provider) => {
      const runner = providerHost.nativeRunners.get(provider)
      return runner?.available() ?? false
    },
    running: (path) => threadRun(path)?.status === "running",
    external: (path) => threadActivitySnapshot()[path]?.status ?? null,
  })
  handle("mako:thread-continuation-resolve", (_event, path: string) => continuation.resolve(path))
  handle("mako:thread-owner-resolve", (_event, path: string) => continuation.owner(path))
  handle("mako:thread-continuation-plan", (_event, path: string) => continuation.plan(path))
  handle("mako:live-locate", (_event, provider: string, nativeId: string) =>
    liveConversations.connectedSession(provider, nativeId))
  handle("mako:live-attach", async (_event, path: string) => {
    const result = await continuation.resolve(path)
    if (result.transport === "unavailable") throw new RuntimeDisconnectedError(false)
    return result.transport === "attached" ? result.snapshot : null
  })
  handle("mako:thread-remember-mode", (_event, path: string, modeId: string) =>
    rememberThreadMode(path, modeId)
  )
  /**
   * Continue a conversation on a *different* harness: render the handoff and
   * open it as the first prompt of a fresh session there. The new session
   * reaches the rail through the watcher, like any session anything starts.
   */
  handle(
    "mako:thread-continue-with",
    async (
      _e,
      path: string,
      harness: string,
      instruction?: string,
      mode?: "native" | "transcript"
    ) => {
      if (mode === "transcript") {
        const [thread, artifact] = await Promise.all([
          openThread(path),
          transcriptArtifactFor(path, instruction),
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
      const materialized = await emitThreadAs(path, harness)
      if (materialized) {
        bindLineageDirect(
          materialized.sessionPath,
          chainOf(materialized.thread.ref)
        )
        return { kind: "emitted" as const, path: materialized.sessionPath }
      }
      const [thread, artifact] = await Promise.all([
        openThread(path),
        transcriptArtifactFor(path, instruction),
      ])
      if (!thread || !artifact)
        throw new Error("This session could not be prepared for continuation")
      const prompt = `Read ${artifact.file} in full before continuing. It is ordered newest turn first; each turn remains chronological.`
      return { kind: "prepared" as const, prompt, cwd: thread.ref.cwd ?? "" }
    }
  )
  /* Provider transports with their own sign-in (Cursor's SDK). */
  const listConnections = (refresh = false) =>
    Promise.all(
      providerHost.connections.list().map((capability) => describeConnection(capability, refresh))
    )
  handle("mako:provider-connections", (_e, refresh?: boolean) => listConnections(refresh === true))
  handle(
    "mako:provider-connection-action",
    async (_e, provider: string, action: ProviderConnectionAction) => {
      const capability = providerHost.connections.get(provider)
      if (!capability) throw new Error(`${provider} has no connection to manage`)
      if (action.kind !== "refresh") await capability.act(action)
      return describeConnection(capability, action.kind === "refresh")
    }
  )
  for (const capability of providerHost.connections.list()) {
    capability.onChange?.(() => {
      // The transport a new thread opens through changed, and with it the
      // models on offer: discovery runs again and every window hears both.
      void harnessProfile(capability.provider, true).catch(() => undefined)
      void listConnections().then((connections) => emit({ type: "provider-connections", connections }))
    })
  }
  installCloudAccountIpc({
    emit,
    fixture: fixtureDesk,
    signedIn: () => void hostTelemetry?.signedIn(),
    request: (call) => hostTelemetry?.cloudRequest(call),
  })
  /* Harness accounts: several logins per CLI, Orca-style isolated homes. */
  handle("mako:accounts", () => accountCatalog())
  handle("mako:account-login-start", (_e, harness: AccountHarness, renew?: string) => startAccountLogin(harness, renew))
  handle("mako:account-login-wait", (_e, id: string) => waitAccountLogin(id))
  handle("mako:account-login-code", (_e, id: string, code: string) => submitAccountLoginCode(id, code))
  handle("mako:account-login-cancel", (_e, id: string) => cancelAccountLogin(id))
  handle("mako:account-capture", (_e, harness: AccountHarness, name: string) =>
    captureAccount(harness, name)
  )
  handle(
    "mako:account-select",
    (_e, harness: AccountHarness, name: string | null) =>
      selectAccount(harness, name)
  )
  handle("mako:account-remove", (_e, harness: AccountHarness, name: string) =>
    removeAccount(harness, name)
  )
  handle("mako:account-removal-plan", (_e, harness: AccountHarness, name: string) =>
    accountRemoval.plan(harness, name)
  )
  handle("mako:account-keep", (_e, harness: AccountHarness, name: string) =>
    keepAccount(harness, name)
  )
  handle("mako:account-usage", (_e, harness: AccountProvider, name: string) =>
    accountUsage(harness, name)
  )
  handle("mako:account-reset", (_e, harness: AccountProvider, name: string, attempt: string) =>
    useResetCredit(harness, name, attempt)
  )

  // The picker opens on what is known; each provider's discovery arrives as
  // its own event, so the slowest CLI no longer hides the rest.
  handle("mako:harness-profiles", (_event, force?: boolean) =>
    force === true ? harnessProfiles(true) : harnessProfilesNow()
  )
  onHarnessProfile(({ profile, cwd }) =>
    emit({ type: "harness-profile", profile, cwd })
  )
  handle("mako:harness-availability", () => {
    const available = new Set(installed())
    return Object.fromEntries(
      providerHost.profiles
        .list()
        .map((profile) => [profile.provider, available.has(profile.provider)])
    )
  })
  // What is known answers at once; a reading that is due runs behind it and
  // arrives as `runtime-updates`. `refresh` re-reads everything, registry included.
  handle("mako:harness-updates", (_e, refresh?: boolean) =>
    runtimeUpdates.read(refresh === true)
  )
  handle("mako:harness-update", (_e, provider: string) =>
    runtimeUpdates.update(provider)
  )
  handle("mako:harness-install", (_e, provider: string) =>
    runtimeUpdates.install(provider)
  )
  handle("mako:daemon-status", () => daemonStatus())
  handle("mako:daemon-login", () => daemonLoginEnabled())
  handle("mako:daemon-login-set", (_e, enabled: boolean) =>
    setDaemonLogin(enabled)
  )

  handle("mako:computer-permissions", () => readComputerPermissions())
  handle(
    "mako:control-preview-source",
    async (_event, conversationId: string) => {
      const target = controlPreviews.nativeWindow(conversationId)
      if (!target) return null
      const source = await appshots.source(target)
      const current = controlPreviews.nativeWindow(conversationId)
      return current?.pid === target.pid && current.windowId === target.windowId
        ? source
        : null
    }
  )
  handle("mako:appshot-windows", () => appshots.windows(true))
  handle(
    "mako:appshot-capture",
    (_event, target: import("./shared.js").AppshotTarget) =>
      appshots.capture(target)
  )
  handle(
    "mako:control-preview",
    (
      _event,
      conversationId: string,
      watching: boolean,
      watcher: string,
      box?: { width: number; height: number }
    ) => {
      const preview = controlPreviews.read(conversationId, watching, watcher, hostClient())
      return watching && preview ? controlPreviews.sized(preview, box) : null
    }
  )
  handle("mako:control-preview-viewers", (_event, conversationId: string) =>
    controlPreviews.viewers(conversationId, hostClient())
  )
  handle("mako:browser-control-status", () => browserControl.refresh())
  handle("mako:browser-control-prefer", (_event, browser: string | null) =>
    browserControl.prefer(browser)
  )
  handle("mako:browser-extension-setup", () =>
    prepareBrowserExtension(environment.appRoot, electronExecutable)
  )
  handle("mako:browser-control-connect", async (_event, browser: string) => {
    await browserControl.connect(browser)
    return browserControl.status()
  })
  handle("mako:browser-control-disconnect", (_event, browser: string) => {
    browserControl.disconnect(browser)
    return browserControl.status()
  })
  handle("mako:computer-permissions-request", () => {
    if (desktop.answers("computer-permissions-request")) return desktop.ask("computer-permissions-request", {})
    if (!shell.privacy) throw new Error("Open Mako's desktop app on this Mac to grant computer permissions.")
    return requestComputerPermissions(shell.privacy, () => shell.focusForPermission())
  })
  handle("mako:computer-driver", () =>
    cuaDriverStatus(resolveExecutable("cua-driver"))
  )
  // The driver's updater replaces the app bundle and stops running daemons,
  // so the embedded driver is restarted from the new binary afterwards. Tasks
  // mid-session receive a fresh driver session on their next call.
  handle("mako:computer-driver-update", async () => {
    const executable = resolveExecutable("cua-driver")
    if (!executable) throw new Error("CUA Driver is not installed")
    await updateCuaDriver(executable)
    stopCuaEmbedded()
    await ensureMakoLocalControl().catch(() => null)
    return cuaDriverStatus(resolveExecutable("cua-driver"))
  })

  handle("mako:mcp-discover", () =>
    withHost((host) => discoverMcpRegistry(host.workspace))
  )
  handle("mako:integrations", () =>
    withHost(async (host) => {
      await ensureMakoLocalControl().catch(() => null)
      const [snapshot, github, driver, permissions] = await Promise.all([
        discoverMcpRegistry(host.workspace),
        githubStatus(host.workspace),
        cuaDriverStatus(resolveExecutable("cua-driver")),
        readComputerPermissions().catch(() => computerPermissions(undefined)),
      ])
      return integrationCatalog(
        snapshot,
        permissions,
        github.authenticated,
        browserControl.status(),
        driver
      )
    })
  )
  handle(
    "mako:mcp-sync-preview",
    (_e, serverId: string, target: McpSyncTarget) =>
      withHost(async (host) =>
        previewMcpSync(
          await discoverMcpRegistry(host.workspace),
          serverId,
          target
        )
      )
  )
  handle("mako:mcp-sync-apply", (_e, serverId: string, target: McpSyncTarget) =>
    withHost(async (host) => {
      const snapshot = await discoverMcpRegistry(host.workspace)
      await applyMcpSync(snapshot, serverId, target)
      return discoverMcpRegistry(host.workspace)
    })
  )

  handle("mako:skills-discover", () =>
    withHost((host) => discoverSkillRegistry(host.workspace))
  )
  handle("mako:native-authoring-catalog", () => withHost((host) => nativeAuthoringCatalog(host.workspace)))
  handle("mako:native-authoring-list", (_e, target: NativeAuthoringTarget) => withHost((host) => listNativeAuthoring(host.workspace, target)))
  handle("mako:native-authoring-read", (_e, target: NativeAuthoringTarget, id: string) => withHost((host) => readNativeAuthoring(host.workspace, target, id)))
  handle("mako:native-authoring-write", (_e, input: NativeAuthoringWrite) => withHost((host) => writeNativeAuthoring(host.workspace, input)))
  handle("mako:native-authoring-remove", (_e, input: NativeAuthoringRemove) => withHost((host) => removeNativeAuthoring(host.workspace, input)))
  handle("mako:skills-resolve", (_e, names: string[], harness: string) =>
    withHost(async (host) =>
      resolveSkillReferences(
        await discoverSkillRegistry(host.workspace),
        names,
        harness
      )
    )
  )
  handle(
    "mako:skills-sync-preview",
    (_e, skillId: string, target: SkillSyncTarget) =>
      withHost(async (host) =>
        previewSkillSync(
          await discoverSkillRegistry(host.workspace),
          skillId,
          target
        )
      )
  )
  handle(
    "mako:skills-remove-preview",
    (_e, skillId: string, target: SkillSyncTarget) =>
      withHost(async (host) =>
        previewSkillRemove(
          await discoverSkillRegistry(host.workspace),
          skillId,
          target
        )
      )
  )
  handle(
    "mako:skills-sync-apply",
    (_e, skillId: string, targets: SkillSyncTarget[]) =>
      withHost(async (host) => {
        const snapshot = await discoverSkillRegistry(host.workspace)
        const source = snapshot.skills.find((skill) => skill.id === skillId)
          ?.origins[0]
        const ordered = [...targets].sort((left, right) => {
          const matches = (target: SkillSyncTarget) =>
            source?.provider === target.provider &&
            source.account === target.account &&
            source.scope === target.scope
          return Number(matches(left)) - Number(matches(right))
        })
        for (const target of ordered) {
          await applySkillSync(snapshot, skillId, target)
        }
        return discoverSkillRegistry(host.workspace)
      })
  )

  handle("mako:harness-descriptors", () => {
    const appPath = environment.appRoot
    return describeHarnesses(providerHost, {
      live: (provider) => providerHost.liveDrivers.get(provider)?.available(appPath) === true,
      resumable: new Set(resumableHarnesses()),
    })
  })
  handle(
    "mako:live-start",
    async (_event, harness: string, cwd: string, options: LiveStartOptions) => {
      const began = performance.now()
      const trace = (stage: string) => {
        if (process.env.MAKO_STARTUP_TRACE === "1")
          console.info(
            "[mako-startup]",
            JSON.stringify({ stage, elapsedMs: performance.now() - began })
          )
      }
      // A resume id is honoured only when the host's own plan reopens that
      // store live; renderer state that says otherwise is stale, not a vote.
      const continueOwned = async (resolved: Awaited<ReturnType<typeof continuation.resolve>>) => {
        if (resolved.transport !== "attached") throw new Error("The conversation owner is not ready")
        if (options.initialRequest) {
          const request = options.initialRequest
          const args = resolved.bindingId
            ? [resolved.conversationId, resolved.bindingId, request.id, request.text, request.attachments, options.tuning]
            : [resolved.conversationId, request.id, request.text, request.attachments, options.tuning]
          await invokeHost(resolved.bindingId ? "mako:live-continue" : "mako:live-prompt", args)
          return z.object({ value: z.json() }).parse(JSON.parse(await invokeHost("mako:live-snapshot", [resolved.conversationId]))).value
        }
        return resolved.snapshot
      }
      if (options.resume && options.threadPath) {
        const resolved = await continuation.resolve(options.threadPath)
        if (resolved.transport === "attached") return continueOwned(resolved)
        if (resolved.transport === "unavailable") throw new RuntimeDisconnectedError(false)
        if (resolved.transport !== "live" || resolved.provider !== harness || resolved.nativeId !== options.resume)
          throw new Error(resolved.transport === "refused" ? resolved.reason : "This native session cannot be resumed with the selected provider")
      }
      const remembered = options.resume
        ? sessionMemory?.recall(harness, options.resume)
        : undefined
      // A new Thread in a worktree starts there, and a new Thread outside any
      // project in a chat folder of its own; a resume or a new tab of an
      // existing Thread runs where that Thread already does.
      const fresh = !options.resume && !options.session
      const chat = fresh && standsForNoProject(cwd) ? newChatFolder() : undefined
      if (options.worktree && !chat && !threadWorktrees) throw new Error("Worktrees need the Thread store, which didn't open. Choose Project folder to work in the folder itself.")
      const making = options.worktree && fresh && !chat && threadWorktrees
        ? threadWorktrees.prepare(
            options.conversationId,
            cwd,
            options.title ?? options.displayPrompt ?? options.initialRequest?.text,
            options.worktreeStart ?? { kind: "newest" },
            (step) => emit({ type: "worktree-step", conversationId: options.conversationId, step })
          )
        : undefined
      const worktree = making && threadWorktrees ? await threadWorktrees.unlessSkipped(options.conversationId, making) : undefined
      if (worktree) {
        trace("worktree")
        emit({ type: "worktree-ready", conversationId: options.conversationId })
      }
      const startCwd = worktree?.cwd ?? chat ?? cwd
      const tuning = await resolveHarnessLaunch(
        harness,
        startCwd,
        options.tuning ?? remembered?.settings
      )
      trace("profile")
      try {
        await liveConversations.start(
          harness,
          startCwd,
          { ...options, worktree: undefined, purpose: undefined, tuning },
          undefined,
          options.purpose ? { kind: options.purpose, project: cwd } : undefined
        )
      } catch (error) {
        // A refused start gives its worktree back; one with anything in it stays, listed in Settings.
        if (worktree) await threadWorktrees?.abandon(options.conversationId).catch(() => undefined)
        if (chat) discardChatFolder(chat)
        if (!(error instanceof SessionHeldError) || !options.threadPath) throw error
        const resolved = await continuation.resolve(options.threadPath)
        if (resolved.transport !== "attached") throw error
        return continueOwned(resolved)
      }
      trace("accepted")
      if (fresh || options.resume)
        hostTelemetry?.threadCreated({ harness, origin: fresh ? "new" : "resume", worktree: Boolean(worktree), ...(options.purpose && { purpose: options.purpose }) })
      if (worktree)
        void threadWorktrees?.attach(options.conversationId).catch((error) =>
          hostWarn("threads", "a worktree could not be recorded against its Thread; the next list attaches it", { conversation: options.conversationId, error: error instanceof Error ? error.message : String(error) }))
      return liveConversations.snapshot(options.conversationId)
    }
  )
  handle(
    "mako:native-receipt",
    (_event, id: string) => nativeRequests?.receipt(id) ?? null
  )
  handle("mako:native-dismiss", (_event, id: string) =>
    nativeRequests?.dismiss(id)
  )
  handle("mako:native-edit-queued", (_event, input: QueuedPromptEdit) => {
    if (!nativeRequests)
      throw new Error("The native command service is not ready")
    return nativeRequests.editQueued(input)
  })
  handle("mako:native-requests", () => nativeRequests?.list() ?? [])
  handle("mako:native-submit", async (_event, input: NativeRequestInput) => {
    if (!nativeRequests)
      throw new Error("The native command service is not ready")
    await continuation.assertNative(input.path)
    return nativeRequests.submit(input)
  })
  handle("mako:live-child-cancel", (_event, id: string, childId: string) =>
    liveConversations.cancelChild(id, childId)
  )
  handle("mako:live-merge-fork", (_event, id: string, mergeId: string) =>
    liveConversations.mergeFork(id, mergeId)
  )
  handle(
    "mako:live-rewind-preview",
    (_event, id: string, requestId: string, position?: "before" | "after") =>
      liveConversations.previewRewind(id, requestId, position)
  )
  handle("mako:live-turn-changes", (_event, id: string, requestId: string) =>
    liveConversations.turnChanges(id, requestId)
  )
  handle("mako:live-turn-diff", (_event, id: string, requestId: string, path: string) =>
    liveConversations.turnDiff(id, requestId, path)
  )
  handle("mako:live-rewind", async (_event, id: string, input: RewindInput) => {
    const rewound = await liveConversations.rewind(id, input)
    hostTelemetry?.feature("turn.rewound", liveConversations.session(id)?.harness)
    return rewound
  })
  handle("mako:live-rewind-recover", () => liveConversations.recoverRewinds())
  handle("mako:live-action", (_event, id: string, input: LiveActionInput) =>
    liveConversations.act(id, input)
  )
  // A separate method advertises atomic queued steering to clients whose UI
  // can update while the shared host remains alive. Keep live-action for
  // existing clients and receipts written before this capability was named.
  handle("mako:live-steer-queued", (_event, id: string, input: Extract<LiveActionInput, { kind: "steer-queued" }>) =>
    liveConversations.act(id, input)
  )
  handle(
    "mako:live-action-acknowledge",
    (_event, id: string, actionId: string) =>
      liveConversations.acknowledgeAction(id, actionId)
  )
  handle("mako:live-fork", async (_event, id: string, input: ForkInput) => {
    const fork = input.worktree ? (await moveIntoWorktree(id, input)).conversation : await liveConversations.fork(id, input)
    hostTelemetry?.feature("thread.forked", liveConversations.session(id)?.harness)
    return fork
  })
  handle("mako:live-capture", (_event, id: string, path: string) =>
    liveConversations.capture(id, path)
  )
  handle(
    "mako:live-transfer",
    async (_event, id: string, input: TransferInput) => {
      const parsed = TransferInputSchema.parse(input)
      const tuning = await resolveHarnessLaunch(
        parsed.provider,
        liveConversations.session(id)?.cwd,
        parsed.tuning
      )
      const transferred = await liveConversations.transfer(id, { ...parsed, tuning })
      hostTelemetry?.feature("harness.switched", parsed.provider)
      return transferred
    }
  )
  handle(
    "mako:live-edit-queued",
    (_event, id: string, input: QueuedPromptEdit) =>
      liveConversations.editQueued(id, input)
  )
  handle("mako:live-clear-queue", (_event, id: string) =>
    liveConversations.clearQueue(id)
  )
  handle("mako:live-sign-in-readiness", (_event, id: string) =>
    liveConversations.signInReadiness(id)
  )
  handle("mako:live-sign-in-resume", (_event, id: string, anyway: boolean) =>
    liveConversations.resumeSignIn(id, anyway)
  )
  handle("mako:live-earlier", (_event, id: string) =>
    liveConversations.earlier(id)
  )
  handle("mako:live-bind", (_event, id: string, path: string) =>
    liveConversations.bind(id, path)
  )
  handle("mako:read-live-file", (_event, id: string, path: string) => {
    const session = liveConversations.session(id)
    if (!session) throw new Error("That conversation is unavailable")
    const dataDir = threadEnvironments ? () => threadEnvironments.fileDataDir({ conversationId: id, cwd: session.cwd }) : undefined
    return readConversationFile(session.cwd, path, dataDir)
  })
  handle("mako:live-snapshot", (_event, id: string) =>
    liveConversations.refreshedSnapshot(id)
  )
  handle("mako:live-context-breakdown", (_event, id: string) =>
    liveConversations.contextBreakdown(id)
  )
  handle("mako:live-read", (_event, id: string, input: LiveHistoryRead) =>
    liveHistory.read(id, LiveHistoryReadSchema.parse(input), () => liveConversations.refreshedSnapshot(id))
  )
  handle(
    "mako:live-state",
    (_event, id: string) => liveConversations.session(id) ?? null
  )
  handle("mako:live-continue", async (_event, id: string, bindingId: string,
    requestId: string, text: string, attachments?: PromptAttachment[], tuning?: SessionSettings) => {
    const snapshot = liveConversations.snapshot(id)
    const binding = snapshot?.control?.bindings.find((item) => item.id === bindingId)
    if (!snapshot || !binding) throw new Error("The selected native session is unavailable")
    const selected = await resolveHarnessLaunch(binding.provider, snapshot.session.cwd, tuning ?? binding.tuning)
    return liveConversations.continueBinding(id, bindingId, requestId, text, attachments, selected)
  })
  handle(
    "mako:live-prompt",
    async (
      _event,
      id: string,
      requestId: string,
      text: string,
      attachments?: PromptAttachment[],
      tuning?: SessionSettings
    ) => {
      const session = liveConversations.session(id)
      if (!session) throw new Error("This conversation is no longer available")
      const selected = await resolveHarnessLaunch(
        session.harness,
        session.cwd,
        tuning
      )
      return liveConversations.submit(
        id,
        requestId,
        text,
        attachments,
        selected
      )
    }
  )
  handle(
    "mako:live-permission",
    (_event, id: string, requestId: string, response: LivePermissionResponse) =>
      liveConversations.permission(id, requestId, response)
  )
  handle("mako:live-mode", (_event, id: string, modeId: string) =>
    liveConversations.setMode(id, modeId)
  )
  handle("mako:live-cancel", (_event, id: string) =>
    liveConversations.cancel(id)
  )
  handle("mako:live-close", (_event, id: string) => liveConversations.close(id))
  handle("mako:live-prewarm", (_event, id: string) => liveConversations.prewarm(id))
  /** Someone is writing a new conversation's first message in `cwd`; listing its MCP servers now lets the launch find them cached. */
  /** The desktop app heard the Mac resume or the screen unlock. */
  handle("mako:machine-woke", (_event, source: "resume" | "unlock-screen") => {
    wakeWatch?.notify(source)
  })
  handle("mako:launch-prewarm", (_event, cwd: string) => {
    if (isAbsolute(cwd)) void discoverMcpRegistry(cwd).catch(() => undefined)
  })

  /** A new conversation on another harness, from the main composer. */
  handle(
    "mako:harness-start",
    async (_e, harness: string, prompt: string, options?: SessionSettings) => {
      const live = await ready()
      const cwd = live.active.workspace
      const tuning = await resolveNativeLaunch(harness, cwd, options)
      return { run: await startFresh(harness, cwd, prompt, tuning), cwd }
    }
  )

  handle(
    "mako:harness-tuning",
    async (_e, harness: string, cwd?: string, force?: boolean) =>
      harnessProfile(harness, force, cwd ?? (await ready()).active.workspace)
  )

  handle("mako:thread-run", (_e, path: string) => threadRun(path))
  handle("mako:thread-abort-run", async (_e, path: string) => {
    const token = nativeStopToken(path)
    if (token) await threadLifecycle.stop({ kind: "native", path, token })
  })
  /**
   * Fork at an answer: the conversation up to that turn becomes a NEW
   * native session on the chosen harness — both lines stay open, and the
   * fork can wear a different agent than the original.
   */
  // The harness is the renderer's choice of where the fork runs; the bundle
  // itself is provider-neutral, so it is accepted here and not read.
  handle("mako:thread-fork", async (_e, path: string, upto: number, _harness: string, anchor?: MessageAnchor) => {
    const [thread, artifact] = await Promise.all([
      openThread(path),
      transcriptArtifactFor(
        path,
        "Start a new branch after the final answer in this bundle.",
        anchor ?? { index: upto }
      ),
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

  handle("mako:automations", () => automationList())
  handle(
    "mako:save-automations",
    (_e, next: Parameters<typeof saveAutomations>[1]) =>
      withHost((h) => saveAutomations(h.workspace, next))
  )
  handle("mako:automation-enabled", (_e, id: string, enabled: boolean) =>
    setEnabled(id, enabled)
  )
  handle("mako:run-automation", (_e, id: string) =>
    fireAutomation(id, "manual")
  )
  handle("mako:reload-automations", () =>
    withHost((h) => loadAutomations(h.workspace))
  )

  handle("mako:terminal-list", () => terminal().list())
  handle("mako:terminal-create", (_e, options: TerminalCreateOptions) =>
    terminal().create(options)
  )
  handle("mako:terminal-attach", (_e, sessionId: string) =>
    terminal().attach(sessionId)
  )
  handle("mako:terminal-detach", (_e, sessionId: string) =>
    terminal().detach(sessionId)
  )
  handle("mako:terminal-write", (_e, sessionId: string, data: string) =>
    terminal().write(sessionId, data)
  )
  handle(
    "mako:terminal-acknowledge",
    (_e, sessionId: string, sequence: number) =>
      terminal().acknowledge(sessionId, sequence)
  )
  handle(
    "mako:terminal-resize",
    (_e, sessionId: string, cols: number, rows: number) =>
      terminal().resize(sessionId, cols, rows)
  )
  handle("mako:terminal-kill", (_e, sessionId: string) =>
    terminal().kill(sessionId)
  )

  handle("mako:update-state", () => updateState())
  handle("mako:check-updates", () => check())
  handle("mako:install-update", () => {
    if (!application)
      throw new Error("Mako is still starting. Try again once it is ready.")
    return application.lifecycle.command({ kind: "wait", action: "install" })
  })
  handle("mako:relaunch", () => relaunch())
  handle("mako:open-preview-window", () => shell.openPreviewWindow())

  handle("mako:crashes", () => listCrashes())
  handle("mako:crashes-dir", () => crashesDir())
  handle("mako:host-log-path", () => hostLogPath() ?? "")
  handle("mako:provider-residency", () => liveConversations.residency())
  handle("mako:clear-crashes", () => clearCrashes())
  handle(
    "mako:report-crash",
    (
      _e,
      kind: "renderer-error" | "renderer-rejection",
      payload: { message: string; stack?: string; source?: string }
    ) => {
      const error = new Error(payload.message)
      error.stack = payload.stack
      record(kind, error, payload.source)
    }
  )

  // Client calls, answered here only for the standalone window: the socket
  // refuses them, and each client answers them itself (`contracts/client-calls.ts`).
  handle("mako:open-url", (_e, url: string) => openLink(url))

  handle("mako:copy", (_e, text: string) => presentMachine().copy(text))

  handle("mako:notify", (_e, notification: DesktopNotification) =>
    shell.notifier.notify(shell.notificationWindow(), notification)
  )
  handle("mako:notify-dismiss", (_e, subject: string) =>
    shell.notifier.dismiss(subject)
  )
  handle("mako:set-badge-count", (_e, count: number) =>
    shell.notifier.setBadgeCount(count)
  )
  handle("mako:notification-permission", () => shell.notifier.permission())
  handle("mako:request-notification-permission", () =>
    shell.notifier.permission()
  )
}

async function readFilePreview(request: Request): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405 })
  const artifact = resolveFilePreview(request.url)
  if (artifact)
    return fileResponse(
      await localFile(artifact, request.signal),
      artifact,
      request
    )
  const path = workspacePreviewPath(request.url)
  if (!path) return new Response("Not found", { status: 404 })
  try {
    return await withHost(async (host) => {
      const absolute = await host.resolvePath(path)
      return fileResponse(
        await localFile(absolute, request.signal),
        absolute,
        request
      )
    })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}

installCrashReporting({ root: environment.dataRoot, native: shell.nativeCrashes })

void shell.ready().then(async () => {
  stopOnSignals(lifecycle)
  const trace = (stage: string) => {
    if (process.env.MAKO_RUNTIME_TRACE === "1")
      console.info("[mako-runtime]", stage)
  }
  if (isDev && webSocket) {
    stopDevRendererWatch = watchDevRendererRegistration(
      dirname(webSocket),
      {
        profile: instanceProfile || "dev",
        sourceRoot: environment.appRoot,
      },
      (registration) => {
        void configureDevRenderer(registration)
      }
    )
  } else if (isDev && configuredDevServerUrl) {
    await configureDevRenderer({
      profile: instanceProfile || "dev",
      sourceRoot: environment.appRoot,
      url: configuredDevServerUrl,
    })
  }
  trace("electron ready")
  // Agents an earlier host left running are ended before this one starts any.
  await providerChildren.reap().catch((error) => {
    hostWarn("children", "reap failed", { error: error instanceof Error ? error.message : String(error) })
  })
  await shell.start(readFilePreview)
  terminalClients = new TerminalClients(
    join(__dirname, "terminal-daemon.js"),
    join(environment.dataRoot, "terminal"),
    (event, owner) => {
      webHost?.terminal(event, owner)
      shell.send("mako:terminal-event", event, owner)
    },
    buildTag()
  )
  shell.onSystemShutdown(() => {
    systemShutdown = true
  })
  wakeWatch = watchWake((source) => {
    hostLog("host", "woke", { source })
    emitTerminalWake()
    wakeCloudAccount()
  })
  const planBuilds = new PlanBuilds({
    file: join(environment.dataRoot, "plan-builds.json"),
    announce: (builds) => emit({ type: "plan-builds", builds }),
  })
  const telemetry = await installTelemetry({
    fixture: fixtureDesk,
    attended: () => (webHost?.clients().length ?? 0) > 0 || shell.windowVisible(),
    inventory: async () => ({
      harnesses: (await harnessProfiles()).filter((profile) => profile.available).map((profile) => profile.id),
      runtimes: runtimeUpdates.snapshot(),
      threads: listThreads().length,
    }),
  })
  hostTelemetry = telemetry
  liveConversations = new LiveConversations({
    turns: telemetry.turns,
    memory: sessionMemory ?? undefined,
    threads: threadStore ?? undefined,
    mcpSnapshot: (cwd) => discoverMcpRegistry(cwd),
    workspaceSnapshots: new WorkspaceSnapshots(
      join(environment.dataRoot, "workspace-snapshots")
    ),
    checkpoint: (path, provider) => {
      const sourceProvider = provider ?? catalogRef(path)?.harness
      const driver = sourceProvider
        ? providerHost.liveDrivers.get(sourceProvider)
        : undefined
      return driver?.resume.kind === "native" ? driver.resume.checkpoint(path) : Promise.resolve(undefined)
    },
    nativePath: nativePathForSession,
    accountEnv: bindingAccountEnv,
    emitSession: async (provider, thread) => {
      const emitter = providerHost.sessionEmitters.get(provider)
      return emitter ? emitter.emit(thread) : null
    },
    resumeVerdict: assessResume,
    appPath: environment.appRoot,
    root: join(environment.dataRoot, "conversations"),
    tools: async (bindingId, conversationId) => {
      const tools = conversationMcp?.mint(bindingId, conversationId)
      if (!tools) return undefined
      const browser = controlService?.mint(conversationId, bindingId)
      const control = await controlSessions.startOptional(bindingId, browser, async (reason) => {
        await controlService?.revoke(conversationId, bindingId)
        if (reason === "failed") emit({type:"notice",level:"error",message:"Local Control stopped unexpectedly. Its browser access has ended; start a new task before continuing control."})
      })
      if ("launch" in control) return { ...tools, control: control.launch }
      await controlService?.revoke(conversationId, bindingId)
      if (!controlUnavailableNotices.has(control.unavailable)) {
        controlUnavailableNotices.add(control.unavailable)
        emit({ type: "notice", level: "error", message: control.unavailable })
      }
      return tools
    },
    threadEnvironment: (conversationId, title, cwd) =>
      threadEnvironments?.forLaunch(conversationId, title, cwd).catch((error) => {
        hostWarn("threads", "a Thread's values could not be assigned; its agent starts without them", { conversation: conversationId, error: error instanceof Error ? error.message : String(error) })
        return undefined
      }) ?? Promise.resolve(undefined),
    controlInstructions: (bindingId, conversationId) => {
      const launched = threadEnvironments?.launchedWith(conversationId)
      if (launched) void threadProcesses?.touch(launched.app).catch(() => {})
      return launchLines(controlSessions.get(bindingId), launched)
    },
    revokeTools: async (bindingId, conversationId) => {
      conversationMcp?.revoke(bindingId, conversationId)
      await controlService?.revoke(conversationId, bindingId)
      await controlSessions.stop(bindingId)
    },
    driver: (provider) => providerHost.liveDrivers.get(provider),
    accountRemoving: accountRemoval.removing,
    history: pageThread,
    emit,
    planBuilt: (planId, build) => {
      try { planBuilds.record(planId, build) } catch (error) {
        hostWarn("plans", "a built plan could not be recorded", { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  await liveConversations.recoverRewinds().catch((error) =>
    emit({
      type: "notice",
      level: "error",
      message: `Workspace rewind recovery needs attention: ${error instanceof Error ? error.message : String(error)}`,
    })
  )
  void completePendingRemovals().catch((error) =>
    hostWarn("accounts", "pending removals could not be read", { error: error instanceof Error ? error.message : String(error) })
  )
  nativeRequests = new NativeRequests(
    join(environment.dataRoot, "native-requests"),
    {
      read: async (path) => (await openThread(path))?.ref ?? null,
      running: (path) => threadRun(path)?.status === "running",
      execute: async (ref, text, tuning) => {
        const selected = await resolveNativeLaunch(
          ref.harness,
          ref.cwd,
          tuning
        )
        await resumeNative(ref, text, { ...selected, captureOutput: true })
        const result = await waitForNativeRun(ref.path)
        if (result.state.status !== "done")
          throw new Error(
            result.state.error ?? "Native execution did not complete"
          )
      },
      changed: (requests) => emit({ type: "native-requests", requests }),
      failed: (message) => emit({ type: "notice", level: "error", message }),
    }
  )
  trace("journals ready")
  const moves = new WorkspaceMoves({
    file: join(environment.dataRoot, "workspace-moves.json"),
    source: (id) => {
      const snapshot = liveConversations.snapshot(id)
      if (!snapshot || snapshot.session.status === "closed") return undefined
      const { session } = snapshot
      const source: MoveSource = {
        cwd: session.cwd,
        harness: session.harness,
        busy: session.status === "starting" || session.status === "running" ||
          snapshot.requests.some((request) => request.status === "queued" || request.status === "dispatching"),
      }
      if (session.title) source.title = session.title
      return source
    },
    companions: threadCompanions,
    place: (id, cwd) => moveablePlace(threadWorktrees, id, moveProject(id) ?? cwd),
    move: (id) => moveOntoOwnBranch(id),
    follow: (id) => moveOntoOwnBranch(id, false),
    announce: (state) => emit({ type: "workspace-moves", moves: state }),
    failed: (_id, message) => emit({ type: "notice", level: "error", message }),
  })
  workspaceMoves = moves
  const appTools = threadEnvironments && threadProcesses ? environmentTools({
    cwd: (id) => liveConversations.session(id)?.cwd,
    environment: (id, cwd) => threadEnvironments.forConversation(id, liveConversations.session(id)?.title, cwd),
    launchedWith: (id) => threadEnvironments.launchedWith(id),
    conversation: (id) => {
      const session = liveConversations.session(id)
      return session && {
        title: session.title || "Untitled conversation",
        harness: session.harness,
        working: session.status === "running",
        checkWaitMs: providerHost.mcpSources.get(session.harness)?.callWaitMs,
      }
    },
    folder: (cwd, claim) => threadEnvironments.forFolder(cwd, claim),
    processes: threadProcesses,
    recipesRoot: threadRecipes,
    whose: whoseApp,
    history: fileHistory,
    owner: appOwner,
  }) : undefined
  const conversationCwd = (id: string) => liveConversations.session(id)?.cwd
  // An agent's tool changed a branch or its pull request: windows read both again at once.
  const branchChanged = () => {
    threadWorktrees?.forgetPulls()
    emit({ type: "worktrees-changed" })
    emit({ type: "github-changed" })
  }
  conversationMcp = await startConversationMcp(
    liveConversations,
    (bindingId, operation, signal) => controlSessions.request(bindingId, operation, signal),
    workspaceTools({
      cwd: conversationCwd,
      worktrees: threadWorktrees,
      moves,
      changed: branchChanged,
      pullsOf: listBranchPulls,
      recipesRoot: threadRecipes,
    }),
    appTools,
    pullRequestTools({
      cwd: conversationCwd,
      async startedFrom(id, cwd) {
        const worktree = threadWorktrees?.ofConversation(id)
        if (!worktree || !(await within(worktree.path, cwd))) return null
        return (await threadWorktrees?.startedFrom(worktree.path)) ?? null
      },
      changed: branchChanged,
    })
  )
  trace("conversation tools ready")
  controlService = await startControlService(
    browserControl,
    (conversationId, bindingId) => {
      liveConversations.authorizeAgent(conversationId, bindingId)
    },
    controlPreviews
  )
  browserControl.subscribe((browsers) =>
    emit({ type: "browser-control", browsers })
  )
  threadArchives = new ThreadArchives(
    join(environment.dataRoot, "thread-archives.sqlite")
  )
  threadLifecycle = new ThreadLifecycle({
    live: liveConversations,
    archives: threadArchives,
    native: nativeRequests,
    threads: listThreads,
    nativeToken: nativeStopToken,
    abortNative,
    external: (path) => Boolean(threadActivitySnapshot()[path]),
  })
  installThreadLifecycleIpc(threadLifecycle, threadArchives, emit)
  followNativeArchives(threadLifecycle, subscribeThreadEvents, emit)
  installThreadGroupsIpc(threadStore, liveConversations, threadStoreProblem, (message) => emit({ type: "notice", level: "error", message }))
  installThreadTitlesIpc({ store: threadStore, emit })
  installThreadWorktreesIpc(threadWorktrees, { heads: listPullHeads, branches: listBranchPulls })
  installChatFoldersIpc()
  installWorkspaceMovesIpc(moves)
  installPlanBuildsIpc(planBuilds)
  installTranscriptDocumentIpc({ snapshot: (id) => liveConversations.snapshot(id), openThread })
  const tidyWorktrees = () => void threadWorktrees?.tidy().catch((error) =>
    hostWarn("threads", "spare worktrees could not be tidied", { error: error instanceof Error ? error.message : String(error) }))
  tidyWorktrees()
  // Spares a project stopped wanting go after a day even while the host keeps running.
  setInterval(tidyWorktrees, 60 * 60_000).unref()
  installCheckoutHeadsIpc(checkoutHeads)
  if (appTools) {
    installThreadAppIpc(appTools.desk)
    worktreeCleanup = (path) => appTools.cleanup(path)
  }
  application = installApplicationIpc({
    live: liveConversations,
    native: nativeRequests,
    emit,
    clients: () => [
      ...(webHost?.clients() ?? []),
      ...shell.clients(),
    ],
    quitClient: () => shell.hideWindows(),
    finish: (action, install) => {
      install?.()
      void lifecycle.stop({ kind: "request", action })
    },
  })
  if (sessionMemory) {
    const conversations = new SharedConversations(sessionMemory, (event) => {
      if (hostClosing) return
      webHost?.conversationEvent(event)
      shell.send("mako:event", event)
    }, {
      snapshot: (id) => liveConversations.snapshot(id),
      find: (provider, nativeId) => {
        const id = liveConversations.connectedSession(provider, nativeId)
        return id ? liveConversations.snapshot(id) : null
      },
    })
    sharedConversations = conversations
    installConversationRouting((channel, args) => conversations.route(channel, args))
  }
  bindIpc()
  bindAcp((event) => liveConversations.observe(event))
  bindCodexApp((event) => liveConversations.observe(event))
  if (webSocket) {
    if (persistentHost) {
      await mkdir(dirname(webSocket), { recursive: true, mode: 0o700 })
      const stale = await lstat(webSocket).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null
          throw error
        }
      )
      if (stale) {
        if (
          !stale.isSocket() ||
          (process.getuid && stale.uid !== process.getuid()) ||
          (await runtimeInfo(webSocket))
        )
          throw new Error("The shared host socket is already owned")
        await unlink(webSocket)
      }
    }
    const runtime: RuntimeInfo = {
      protocol: RUNTIME_PROTOCOL,
      instanceId: crypto.randomUUID(),
      storageScope: basename(dirname(webSocket)),
      pid: process.pid,
      version: environment.version,
      devBuild: loadedDevBuild,
      methods: socketCalls(hostChannels),
      previewSizing: true,
    }
    if (fixtureDesk) runtime.fixture = true
    webHost = await startWebHost(
      webSocket,
      invokeHost,
      (request, client = "web") =>
        withHostClient(client, () => readFilePreview(request)),
      (client) => {
        terminalClients?.release(client)
        void workspaceClients.release(client)
      },
      runtime,
      invokeHostPreview,
      fixtureDesk ? undefined : hostSecretKeyHandover(),
      (request, response) => desktop.attach(request, response)
    )
  }
  trace("host listening")
  if (persistentHost && instanceProfile && webSocket)
    watchProfileHostIdle(dirname(webSocket))
  if (!webOnly) await shell.createWindow()
  installUpdates(emit, shell.updater)
  trace("updates ready")
  installThreads(emit, { readOnly: fixtureDesk })
  trace("catalog starting")
  bindDrivers(emit, {
    assessResume: (ref) => assessResume({
      id: ref.nativeId, provider: ref.harness, nativeId: ref.nativeId, path: ref.path,
      coveredBlocks: 0, includesBase: false,
    }),
    claimSession: (ref) => {
      const memory = sessionMemory
      if (!memory) throw new Error("Native session ownership is unavailable. Retry after the host reconnects.")
      const owner = randomUUID()
      memory.hold(ref.harness, ref.nativeId, owner)
      return () => memory.release(ref.harness, ref.nativeId, owner)
    },
    // A native reply runs with exactly these settings; the ledger keeps them
    // for a store that records none, the way a live session's report is kept.
    prepared: (ref, settings) =>
      sessionMemory?.remember(ref.harness, ref.nativeId, { settings }),
  })
  trace("drivers ready")
  // The last host's readings paint first; this host's own run a few seconds
  // behind startup, and hourly for the public versions.
  await runtimeUpdates.load()
  if (!fixtureDesk) runtimeUpdates.start()
  bindAutomations(emit, async (cwd, prompt) => {
    if (fixtureDesk) throw new Error("The fixture desk runs no automations")
    const resumable = new Set(resumableHarnesses())
    const profile = (await harnessProfiles()).find(
      (candidate) => candidate.available && resumable.has(candidate.id)
    )
    if (!profile)
      throw new Error("No provider is available for this automation")
    hostTelemetry?.feature("automation.ran", profile.id)
    await startFresh(
      profile.id,
      cwd,
      prompt,
      resolveHarnessTuning(profile, undefined)
    )
  })
  void ready().then((live) => {
    watchWorkspace(live.active.workspace)
  })
  shell.onActivate(() => {
    void reopenWindow()
  })
  void telemetry.started(performance.now())
})

shell.followQuit(lifecycle, () => !systemShutdown && (persistentHost || hasActiveWork()))

/** Everything the host holds, released once, in order, by its lifecycle. */
async function cleanupHost(): Promise<void> {
  hostClosing = true
  const callsDrained = stopHostCalls()
  // Close admission before disposing the UI lifecycle: pending preparation
  // must not inherit its reset admission callback and dispatch late.
  const providersDrained = Promise.all([stopDrivers(), stopHarnessProfiles()])
  void providersDrained.catch(() => {})
  shell.notifier.dispose()
  closeRepositories()
  application?.dispose()
  sharedConversations?.dispose()
  webHost?.close()
  if (persistentHost && webSocket) {
    // The runtime directory is this host's alone; leaving it behind is how
    // fifty of them piled up in the temp folder.
    try {
      rmSync(dirname(webSocket), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  wakeWatch?.stop()
  stopCloudAccountIpc()
  terminalClients?.dispose()
  void controlSessions.close()
  stopCuaEmbedded()
  void appshots.close()
  desktop.close()
  controlService?.close()
  stopDevRendererWatch?.()
  stopDevRendererWatch = undefined
  devRendererGeneration += 1
  removeDeskBrowserRegistration?.()
  removeDeskBrowserRegistration = undefined
  deskBrowser.close()
  stopWorkspaceIpc()
  stopWatching()
  runtimeUpdates.stop()
  stopThreads()
  await Promise.all([callsDrained, providersDrained, hostTelemetry?.close(), usageReader?.close()])
  await liveConversations?.stop()
  stopAcp()
  stopCodexApps()
  nativeRequests?.stop()
  conversationMcp?.close()
  sessionMemory?.close()
  installThreadStore(null)
  stopFollowingThreads()
  threadStore?.close()
  threadArchives?.close()
  checkoutHeads.close()
  void workspaceClients.dispose()
  hostLog("lifecycle", "stopped")
  await flushHostLog()
}
