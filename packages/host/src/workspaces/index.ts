import type { Git } from "@mako/git"
import { realpathSync } from "node:fs"
import { rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { declareSessionMethods, type SessionMethodsDeps } from "./session-methods.js"
import type { MethodTable } from "../base/methods.js"
import type { HostJobs } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { ThreadStore, ThreadLifecycle } from "../threads/index.js"
import { portListening, ThreadEnvironments } from "./thread-environment.js"
import { ThreadProcesses } from "./thread-processes.js"
import type { MoveLedger } from "./worktree-move.js"
import { ThreadWorktreeService, type CheckoutConversations } from "./thread-worktrees.js"
import { moveHold, moveSource, ThreadWorktreeMoves } from "./thread-worktree-moves.js"
import { WorkspaceMoves } from "./moves.js"
import { WorktreeLeaves } from "./worktree-leaves.js"
import { moveablePlace, registerWorkspaceTools, within, workspaceTools } from "./tools.js"
import { projectRecipe, type RecipeAccounts, type RecipeWhere } from "./thread-recipe.js"
export { RecipeAccounts } from "./thread-recipe.js"
import { CheckoutHeadService } from "./checkout-heads.js"
import { PlanBuilds } from "./plan-builds.js"
import { beginTrace, SAMPLE_EVERY_MS, TraceRefresh } from "./app-probe.js"
import { childHistory } from "./watch-backend.js"
import { commandEnvironment, environmentTools, registerEnvironmentTools, type EnvironmentTools } from "./environment-tools.js"
import { spareInstaller } from "./spare-install.js"
import { isSpareCheckout } from "./worktree-carry.js"
import { AppKeySchema, type AppKey } from "../contracts/thread-environments.js"
import { ThreadIdSchema } from "../contracts/thread-identity.js"
import { listExternalEditors, openInExternalEditor } from "./editors.js"
import { revealAction } from "./reveal-policy.js"
import { presentMachine, type MachineCapability } from "../base/machine.js"
import type { Automations } from "./automations.js"
import type { Automation } from "../contracts/automations-usage-updates.js"
import { declareFileMethods, type WatchedFile } from "./file-methods.js"
import { declareWorktreeMethods } from "./worktree-methods.js"
import { declareMoveMethods } from "./move-methods.js"
import { declarePlanBuildMethods } from "./plan-build-methods.js"
import { declareCheckoutHeadMethods } from "./checkout-head-methods.js"
import { declareThreadAppMethods } from "./app-methods.js"
import { listBranchPulls, listPullHeads, pullRequestTools, registerPullRequestTools } from "../git/index.js"
import type { MakoTools } from "../tools/index.js"
import type { WorkspaceConversations } from "./conversations.js"
import type { AgentHost } from "./agent-host.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { ThreadWorktreeMoveDeps } from "./thread-worktree-moves.js"

export { ArtifactPreviews, type ProviderArtifactPreview } from "./artifact-previews.js"
export { Automations } from "./automations.js"
export { checkoutConversations } from "./checkout-conversations.js"
export { WorkspaceClients } from "./clients.js"
export type { Relocation, WorkspaceConversations } from "./conversations.js"
export { resolveFilePreview } from "./file-previews.js"
export { fileResponse, localFile } from "./file-response.js"
export { ConversationFiles } from "./files.js"
export type { AgentHost, TabServices } from "./agent-host.js"
export type { HostPool } from "./pool.js"
export { workspacePreviewPath } from "./preview-path.js"
export { WorkspaceSnapshots } from "./snapshots.js"
export { applyThreadEnvironment, threadEnvironmentInstructions } from "./thread-environment.js"
export { childBackend } from "./watch-backend.js"
export { watchTree } from "./tree-watcher.js"
export { watchOutsideGitDir } from "./git-dir-watch.js"
export type { MoveLedger } from "./worktree-move.js"

/** A long quiet, not a short timer: a stopped app keeps its files and data, and restarting it for nothing costs more than it frees. */
const THREAD_APP_IDLE_MS = 6 * 60 * 60 * 1000

/** Worktrees, spares, checkouts, recipes, and each Thread's apps and their processes. */
export interface Workspaces {
  checkoutHeads: CheckoutHeadService
  planBuilds: PlanBuilds
  /** Each Thread's values and data folder; beside the Thread store, so a Thread keeps one whichever host starts its agents. */
  environments: ThreadEnvironments | null
  /** Each running app's records, so any host sees and stops the processes another host started. */
  processes: ThreadProcesses | null
  /** Beside the Thread store, so every profile sharing the store shares its worktrees. */
  worktrees: ThreadWorktreeService | null
  /** The recipe Mako keeps for each project, one file per repository, outside every checkout. */
  recipes: string | undefined
  /** Where recipes run here: this computer or a cloud machine. */
  where: RecipeWhere | undefined
  /** Whose app a key is, in words: a Worktree Thread's, or a folder's that Threads share. */
  whoseApp(app: AppKey): string | undefined
  /** The Worktree Thread an app belongs to, for the Room. */
  appOwner(app: AppKey): { id: string; title: string } | undefined
  /** What changed on disk while apps ran, for their probes; FSEvents keeps that history, so macOS only. */
  fileHistory: ReturnType<typeof childHistory>
  close(): void
}

export interface WorkspacesDeps {
  git: Git
  dataRoot: string
  /** Where recipes run here: this computer or a cloud machine, and what it is (`recipeIn`). */
  where?: RecipeWhere
  /** The account's authority for projects it keeps the recipes of. */
  recipes?: RecipeAccounts
  /** A fixture desk stops no one's apps. */
  readOnly: boolean
  store: ThreadStore | null
  jobs: HostJobs
  emit(event: HostEvent): void
  /** What holds a worktree: its conversations and terminals, as a person would name them. */
  inUse(path: string): Promise<string[]>
  /** Conversations mid-turn in a worktree. */
  working(path: string): Promise<string[]>
  /** What holds a removed worktree, and its conversations going on in the main checkout. */
  conversations: CheckoutConversations
  /** The recipe's cleanup for a worktree about to be removed, once the app tools exist. */
  cleanup(path: string): Promise<string | undefined> | undefined
  /** Who changed what, once the journal is open: a move into a worktree takes only the Thread's own lines. */
  ledger?: () => MoveLedger | undefined
}

export function openWorkspaces(deps: WorkspacesDeps): Workspaces {
  const { git } = deps
  const { store, emit } = deps
  const checkoutHeads = new CheckoutHeadService((heads) => emit({ type: "checkout-heads", heads }))
  const planBuilds = new PlanBuilds({
    file: join(deps.dataRoot, "plan-builds.json"),
    announce: (builds) => emit({ type: "plan-builds", builds }),
  })
  const shared = store ? realpathSync(dirname(store.path)) : undefined
  const recipes = shared ? join(shared, "recipes") : undefined
  const environments = store && shared
    ? new ThreadEnvironments({ git, store, dataRoot: join(shared, "thread-data"), recipesRoot: recipes, where: deps.where, recipes: deps.recipes })
    : null
  const fileHistory = childHistory()
  const whoseApp = (app: AppKey): string | undefined => {
    const thread = ThreadIdSchema.safeParse(app)
    if (thread.success) {
      const title = store?.thread(thread.data)?.title
      return title ? `the Thread “${title}”` : undefined
    }
    const folder = processes?.checkoutOf(app)
    if (folder && isSpareCheckout(folder)) return "the install of a checkout kept ready for a new Thread"
    return folder ? `the ${basename(folder)} folder` : undefined
  }
  const appOwner = (app: AppKey) => {
    const thread = ThreadIdSchema.safeParse(app)
    const found = thread.success ? store?.thread(thread.data) : undefined
    return found ? { id: found.id, title: found.title || "Untitled Thread" } : undefined
  }
  const processes = shared
    ? new ThreadProcesses({
        root: join(shared, "thread-environments"),
        listening: portListening,
        whose: whoseApp,
        cameUp: (folder, at) => beginTrace(folder, at, fileHistory),
      })
    : null
  if (processes) {
    if (!deps.readOnly)
      deps.jobs.every("stop thread apps unused for six hours", 10 * 60_000, async () => {
        const stopped = await processes.stopIdle(THREAD_APP_IDLE_MS)
        if (stopped.length) hostLog("threads", "stopped apps unused for six hours", { threads: stopped.join(", ") })
      })
    /** Each running copy's peak counts toward its project's "about N at once"; with nothing running a look reads no process table. */
    deps.jobs.every("measure thread apps' memory", 30_000, async () => { await processes.memory() })
  }
  const worktrees = store && shared
    ? new ThreadWorktreeService(git, join(shared, "worktrees"), store, deps.inUse, deps.working, processes && environments ? {
        stop: async (thread) => { await processes.stop(AppKeySchema.parse(thread)) },
        cleanup: async (thread, path) => {
          const done = await deps.cleanup(path)?.catch((error: Error) => `cleanup couldn't run: ${error.message}`)
          if (done) hostLog("threads", "worktree cleanup", { thread, path, result: done })
        },
        discard: async (thread, path) => {
          await processes.discard(AppKeySchema.parse(thread))
          await processes.forgetPrepared(path)
          await rm(environments.dataDir(AppKeySchema.parse(thread)), { recursive: true, force: true })
        },
      } : undefined, processes ? {
        recipe: (checkout) => projectRecipe(git, checkout, recipes),
        prepared: (checkout) => processes.prepared(checkout),
        savePrepared: (checkout, prepared) => processes.savePrepared(checkout, prepared),
        forgetPrepared: (checkout) => processes.forgetPrepared(checkout),
        spareInstall: spareInstaller({
          git,
          processes,
          recipe: (checkout) => projectRecipe(git, checkout, recipes),
          env: (values) => ({ ...commandEnvironment(), ...values }),
        }),
      } : undefined, deps.conversations, deps.ledger)
    : null
  if (worktrees) {
    const tidy = () => worktrees.tidy()
    void tidy().catch((error: Error) => hostWarn("threads", "spare worktrees could not be tidied", { error: error.message }))
    // Spares a project stopped wanting go after a day even while the host keeps running.
    deps.jobs.every("tidy spare worktrees", 60 * 60_000, tidy)
  }
  return {
    checkoutHeads,
    planBuilds,
    environments,
    processes,
    worktrees,
    recipes,
    where: deps.where,
    whoseApp,
    appOwner,
    fileHistory,
    close: () => checkoutHeads.close(),
  }
}

/** The Thread's Sessions moving into its worktree, and agents' app tools; made once the conversations are open. */
export interface WorkspaceMovers {
  worktreeMoves: ThreadWorktreeMoves | undefined
  moves: WorkspaceMoves
  leaves: WorktreeLeaves
  appTools: EnvironmentTools | undefined
  /** The `mako` server's tools: the Thread's worktree, its app and recipe, and its pull request. */
  agentTools: MakoTools[]
}

export interface WorkspaceMoversDeps {
  /** Whether this host's environment has a value for a secret a recipe names (`secretNames`), checked before a cloud start. */
  hasSecret?(name: string): boolean
  /** The account's authority for projects it keeps the recipes of. */
  recipes?: RecipeAccounts
  git: Git
  dataRoot: string
  workspaces: Workspaces
  live: WorkspaceConversations
  store: ThreadStore | null
  lifecycle: ThreadLifecycle
  launch: ThreadWorktreeMoveDeps["launch"]
  movedPaths: NonNullable<ThreadWorktreeMoveDeps["movedPaths"]>
  /** How long a harness's MCP calls may wait, for an app check to fit inside one. */
  checkWaitMs(harness: string): number | undefined
  jobs: HostJobs
  emit(event: HostEvent): void
  warn(message: string, facts: Record<string, string | number | boolean | undefined>): void
}

export function openWorkspaceMovers(deps: WorkspaceMoversDeps): WorkspaceMovers {
  const { git } = deps
  const { workspaces, live, store, emit } = deps
  const { worktrees, environments, processes } = workspaces
  const worktreeMoves = worktrees ? new ThreadWorktreeMoves({
    conversations: live,
    worktrees,
    threadOf: (id) => store?.journalPlacement(id)?.thread,
    archived: (id) => deps.lifecycle.controls({ kind: "live", id }).archived,
    archive: (id) => emit({ type: "thread-archives", snapshot: deps.lifecycle.archive({ id: crypto.randomUUID(), target: { kind: "live", id }, archived: true }) }),
    moved: (event) => emit(event),
    launch: deps.launch,
    movedPaths: deps.movedPaths,
    warn: deps.warn,
  }) : undefined
  const worktreeMove = (): ThreadWorktreeMoves => {
    if (!worktreeMoves) throw new Error("Worktrees need the Thread store, which didn't open.")
    return worktreeMoves
  }
  const moves = new WorkspaceMoves({
    file: join(deps.dataRoot, "workspace-moves.json"),
    source: (id) => moveSource(live, id),
    companions: (id) => worktreeMoves?.companions(id) ?? [],
    place: (id, cwd) => moveablePlace(git, worktrees, id, worktreeMoves?.project(id) ?? cwd),
    move: async (id, bring) => (await worktreeMove().carry(id, { lead: true, tell: true, bring })).session.id,
    follow: async (id, told, lead) => { await worktreeMove().carry(id, { lead: false, tell: told, after: lead }) },
    announce: (state) => emit({ type: "workspace-moves", moves: state }),
    failed: (_id, message) => emit({ type: "notice", level: "error", message }),
  })
  const leaves = new WorktreeLeaves({
    quiet: (id) => live.relocation(id).kind !== "wait",
    remove: async (path) => {
      if (!worktrees) throw new Error("Worktrees need the Thread store, which didn't open.")
      await worktrees.remove(path)
    },
    removed: () => worktreesChanged(worktrees, emit),
    failed: (message) => emit({ type: "notice", level: "error", message }),
  })
  const appTools = environments && processes ? environmentTools({
    git,
    cwd: (id) => live.session(id)?.cwd,
    environment: (id, cwd) => environments.forConversation(id, live.session(id)?.title, cwd),
    launchedWith: (id) => environments.launchedWith(id),
    conversation: (id) => {
      const session = live.session(id)
      return session && {
        title: session.title || "Untitled conversation",
        harness: session.harness,
        working: session.status === "running",
        checkWaitMs: deps.checkWaitMs(session.harness),
      }
    },
    folder: (cwd, claim) => environments.forFolder(cwd, claim),
    processes,
    traces: new TraceRefresh(),
    recipesRoot: workspaces.recipes,
    where: workspaces.where,
    hasSecret: deps.hasSecret,
    recipes: deps.recipes,
    whose: workspaces.whoseApp,
    history: workspaces.fileHistory,
    owner: workspaces.appOwner,
  }) : undefined
  if (appTools) deps.jobs.every("trace running thread apps", SAMPLE_EVERY_MS, appTools.traceApps)
  return { worktreeMoves, moves, leaves, appTools, agentTools: agentTools(deps, moves, leaves, appTools) }
}

/** An agent's tool changed a branch or its pull request, or a worktree went: windows read both again at once. */
function worktreesChanged(worktrees: Workspaces["worktrees"], emit: (event: HostEvent) => void): void {
  worktrees?.forgetPulls()
  emit({ type: "worktrees-changed" })
  emit({ type: "github-changed" })
}

function agentTools({ git, workspaces, live, emit }: WorkspaceMoversDeps, moves: WorkspaceMoves, leaves: WorktreeLeaves, appTools: EnvironmentTools | undefined): MakoTools[] {
  const { worktrees } = workspaces
  const cwd = (id: string) => live.session(id)?.cwd
  const changed = () => worktreesChanged(worktrees, emit)
  const workspace = workspaceTools({ git, cwd, worktrees, moves, leaves, changed, pullsOf: listBranchPulls, recipesRoot: workspaces.recipes })
  const pulls = pullRequestTools({
    git,
    cwd,
    async startedFrom(id, folder) {
      const worktree = worktrees?.ofConversation(id)
      if (!worktree || !(await within(worktree.path, folder))) return null
      return (await worktrees?.startedFrom(worktree.path)) ?? null
    },
    changed,
  })
  return [
    (server, conversationId) => registerWorkspaceTools(server, workspace, conversationId),
    ...(appTools ? [(server, conversationId) => registerEnvironmentTools(server, appTools, conversationId)] satisfies MakoTools[] : []),
    (server, conversationId) => registerPullRequestTools(server, pulls, conversationId),
  ]
}

export interface WorkspaceMethodsDeps {
  workspaces: Workspaces
  movers: WorkspaceMovers
  live: WorkspaceConversations
  automations: Automations
  withHost<T>(run: (host: AgentHost) => T | Promise<T>): Promise<T>
  /** What a window loads first, and its tabs. */
  session: SessionMethodsDeps
  emit(event: HostEvent): void
  /** The machine the host runs on, which opens, reveals and picks what people ask for. */
  machine: MachineCapability
}

/** The files people open, the editors and folders they reach for, worktrees, moves, apps and automations. */
export function declareWorkspaceMethods(methods: MethodTable, { workspaces, movers, live, automations, withHost, session, emit, machine }: WorkspaceMethodsDeps): WatchedFile {
  declareSessionMethods(methods, session)
  const files = declareFileMethods(methods, { withHost, emit, machine })
  methods.handle("mako:pick-folder", () => presentMachine(machine).chooseFolder("Choose a folder"))
  methods.handle("mako:external-editors", () => listExternalEditors())
  methods.handle("mako:open-in-editor", (path: string, editor?: string) =>
    withHost(async (h) => {
      const absolute = await h.resolvePath(path)
      await openInExternalEditor(machine, absolute, editor)
    })
  )
  methods.handle("mako:reveal", (path: string) =>
    withHost(async (h) => {
      // Documents open in their default app; anything the default handler
      // would run (bundles, executables, `.command`) is only shown in Finder.
      // The path may come from anywhere, including an agent's answer.
      const absolute = await h.resolvePath(path)
      const info = await stat(absolute)
      const present = presentMachine(machine)
      if (revealAction(absolute, info) === "open" && (await present.open(absolute))) return
      await present.reveal(absolute)
    })
  )
  methods.handle("mako:automations", () => automations.list())
  methods.handle("mako:save-automations", (next: Automation[]) =>
    withHost((h) => automations.save(h.workspace, next))
  )
  methods.handle("mako:automation-enabled", (id: string, enabled: boolean) => automations.setEnabled(id, enabled))
  methods.handle("mako:run-automation", (id: string) => automations.fire(id, "manual"))
  methods.handle("mako:reload-automations", () => withHost((h) => automations.load(h.workspace)))
  declareWorktreeMethods(methods, workspaces.worktrees, { heads: listPullHeads, branches: listBranchPulls })
  declareMoveMethods(methods, movers.moves, (target) => moveHold(live, movers.worktreeMoves, movers.moves, target), workspaces.worktrees)
  declarePlanBuildMethods(methods, workspaces.planBuilds)
  declareCheckoutHeadMethods(methods, workspaces.checkoutHeads)
  declareThreadAppMethods(methods, movers.appTools?.desk)
  return files
}
