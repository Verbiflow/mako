import { fixtureHarnesses } from "./harness-fixtures"
import { mockAppshots } from "./mock-appshots"
import { mockAuthoring } from "./mock-authoring"
import { encodeControlVideoBatch } from "@mako/control-runtime/contracts"
import { planContinuation, resumeLedger } from "@mako/host/contracts/thread-continuation"
import { workDefault } from "@mako/host/contracts/harness-defaults"
import { fixtureUsageSummary } from "./usage-fixture"
import type { CheckoutHead } from "@mako/host/contracts/checkout-heads"
import type { HandOffCandidate, HandOffResult, HandOffSettings, MoveCarried, ThreadHandOff, ThreadMoveStep, ThreadReturnOptions, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import type { ConversationSettings } from "@mako/host/contracts/turn-continuation"
import type { TurnUndoScope } from "@mako/host/contracts/turn-review"
import type { WorkspaceMoves } from "@mako/host/contracts/workspace-moves"
import type { PlanBuilds } from "@mako/host/contracts/plan-builds"
import type { AccessChoices } from "@mako/host/contracts/access-choices"
import { ThreadIdSchema, type ThreadId } from "@mako/host/contracts/thread-identity"
import { worktreeSlug, type ThreadWorktree, type WorktreeStart, type WorktreeReview, type WorktreeStartPoint, type WorktreeSummary, type WorktreeUpdate } from "@mako/host/contracts/thread-worktrees"
import { RAIL_PURPOSES, RAIL_RUNS, RAIL_SUMMARIES, RAIL_THREAD_GROUPS, RAIL_WORKTREES, railInventory, railRef, railSuiteRemoval } from "./mock-rail-worktrees"
import type { ThreadPurpose } from "@mako/host/contracts/thread-purposes"
import type { ThreadTitleEntry } from "@mako/host/contracts/thread-titles"
import type { FileWriters, RewindPreview, WorkspaceSnapshot } from "@mako/host/contracts/workspace-snapshots"
import type { UtilityModelOption, UtilityTask, UtilityTaskState, UtilityWorkChoices, UtilityWorkSettings } from "@mako/host/contracts/utility-work"
import type { NativeRequestInput, NativeRequest } from "@mako/host/contracts/native-requests"
import type { ForkInput, TransferInput } from "@mako/host/contracts/conversation-control"
import { PROVIDER_FAILURE_KINDS, type ProviderFailureKind } from "@mako/host/contracts/provider-failure"
import type { ContextBreakdown, Entry, GitStatus, ThreadRef, LivePermissionRequest, LiveSessionMode, LiveSnapshot, LiveStartOptions, LiveRequest, PullRequest, UpdateState, UtilityConnection, UtilityProviderInfo } from "@/lib/types"
import type { LivePermissionResponse } from "@mako/host/contracts/providers-acp"
import type { ConversationGoal, GoalCommand } from "@mako/host/contracts/live-goals"
import type { SideConversation, SideExchange, SideQuestionCommand } from "@mako/host/contracts/live-side-questions"
import { reviewDisplayText, type ReviewTarget } from "@mako/host/contracts/live-reviews"
import { REVIEW_FENCE, type ReviewReport } from "@mako/sessions/review"
import { confirmAccount, type ExecutionContext } from "@mako/host/contracts/execution-context"
import type { AccountRemovalOutcome, AccountRemovalWait } from "@mako/host/contracts/accounts"
import type { SignInHold, SignInReadiness } from "@mako/host/contracts/live-conversations"
import { continueTurnPrompt } from "@mako/host/contracts/turn-continuation"
import { z } from "zod"
import type { SessionSettings } from "@mako/sessions/settings"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import { mcpServerFailedEvent } from "@mako/sessions/events"
import type { RecordRef } from "@mako/sessions/entries"
import { restoreGate } from "@mako/sessions/record-writers"
import type { RestorePlan } from "@mako/host/contracts/restore-plan"
import type { HarnessBehind, ThreadHarnessCheck } from "@mako/host/contracts/cloud-harnesses"
import type { UnreadReport } from "@mako/host/contracts/unread-records"
import type { StoreFormats } from "@mako/host/contracts/store-formats"
import type { EntryOriginal, OriginalPart } from "@mako/sessions/record-original"
import type { LiveHistoryAddress, LiveHistoryRead } from "@mako/host/contracts/live-history"
import { ENVIRONMENT_SETUP_PROMPT } from "@mako/host/contracts/thread-environments"
import { playSetupTurn } from "./mock-setup-turn"
import { MOCK_GITHUB_USER_ID, mockCloudAccount } from "./mock-cloud-account"
import { mockCarriedFiles } from "./mock-carried-files"
import { mockGitHubToken } from "./mock-github-token"
import { matchPullRequests, pullSearchLimit, type PullRequestListing } from "@mako/host/contracts/pull-request-search"
import { mockSetupMoment } from "./mock-thread-app"
import { skillDeliveryFor } from "@mako/host/contracts/skill-reach"
import type { AccountLogin, AccountLoginResult, AccountProviderInfo, AccountRemovalPlan, AccountRemovalSession, AccountUsage, HarnessAccount, ResetCreditOutcome } from "@mako/host/contracts/accounts"
import type { ThreadFileContext } from "@mako/host/contracts/conversation-session"
import type {
  Automation,
  LiveSessionState,
  BootPayload,
  HostEvent,
  SessionMeta,
  TerminalEvent,
  TerminalSession,
} from "@/lib/types"
import {
  GIT,
  INTEGRATIONS,
  MCP,
  MESSAGES,
  META,
  MODELS,
  SKILLS,
  TREE,
  sessions,
} from "./mock-fixtures"
import {
  createCapabilities,
  initialTerminalSessions,
  mockThreads,
} from "./mock-runtime-fixtures"
import { busyRefs, busySnapshot, busySummaries, BUSY_SESSIONS, BUSY_THREAD, BUSY_TITLE } from "./mock-busy-thread"

/** The repository's pull requests as the `#` menu finds them. */
const MOCK_PULLS: PullRequestListing[] = [
  { number: 812, title: "Retry billing webhooks with backoff", state: "open", draft: false, url: "https://github.com/you/mako/pull/812", head: "mako/billing-webhooks", base: "main", author: "you", updatedAt: "2026-10-12T09:10:00Z" },
  { number: 806, title: "Queue payments behind the retry budget", state: "open", draft: true, url: "https://github.com/you/mako/pull/806", head: "mako/payments-queue", base: "main", author: "ada", updatedAt: "2026-10-11T16:40:00Z" },
  { number: 798, title: "Set up the API's local database", state: "merged", draft: false, url: "https://github.com/you/mako/pull/798", head: "mako/set-up-api", base: "main", author: "you", updatedAt: "2026-10-09T12:00:00Z" },
  { number: 781, title: "Drop the legacy webhook signer", state: "closed", draft: false, url: "https://github.com/you/mako/pull/781", head: "fix/retry-budget", base: "main", author: "grace", updatedAt: "2026-10-02T08:30:00Z" },
]

const SETUP_WORKTREE_ROOT = "/Users/you/.mako/worktrees"

/** The fixture projects' checkouts: one on its default branch, one mid-feature, one mid-rebase. */
export const MOCK_HEADS = new Map<string, CheckoutHead>([
  ["/Users/you/mako", { kind: "branch", name: "main" }],
  ["/Users/you/api", { kind: "branch", name: "billing-webhook-retries" }],
  ["/Users/you/site", { kind: "rebasing", name: "pricing-table" }],
])

async function mockThreadContexts(paths: string[]): Promise<Array<ThreadFileContext | null>> {
  return paths.map((path) => {
    const file = `/mock/transcripts/${encodeURIComponent(path)}/transcript.md`
    return {
      kind: "file" as const,
      file,
      note: `<mako_transcript>\nThis conversation's history (Codex, 1 turn) is in ${file}.\n</mako_transcript>`,
      title: "Referenced conversation",
      harness: "codex",
      turns: 1,
      digest: "0".repeat(64),
      losses: [],
    }
  })
}

/**
 * A fake agent host for design work.
 *
 * Load the dev server with `?mock` and the desk boots against fixtures instead
 * of a real agent, so layout, density, and motion can be judged in a browser
 * without spending tokens. Dev-only; never bundled into a production build.
 */

/** What the page staged, so a pasted or reloaded attachment reads back the words it was given. */
const STAGED_TEXT = new Map<string, string>()
const STAGED_MEDIA = new Map<string, string>()

const utilityChoices: UtilityWorkChoices = { commit: "auto" }
/** Whether a fixture hands agents to the cloud as the Mac sleeps. */
const mockHandOffOnSleep = { value: true }
/** The fixture's conversation settings, off as on a new Mac. */
interface MockConversationSettings { value: ConversationSettings }
const mockConversationSettings: MockConversationSettings = { value: { continueAfterRestart: false } }
/**
 * `?return=outdated`: the first way back stays, Codex here being older than the one that wrote it in the cloud;
 * `?return=outdated-devin`: Devin's, which Devin.app updates. `?return=project-gone`: the way back is refused before
 * the cloud is asked, the project the worktree was made from gone from this Mac, until the folder it moved to is
 * chosen (the folder chooser answers `MOCK_MOVED_PROJECT`). `?return=unsettled-cloud` and `?return=unsettled-here`: the
 * first way back is left unsettled, waiting on the cloud's answer or on this Mac's own work; asked again, it comes.
 * `?return=merged`: the person changed its worktree here meanwhile, so it comes back merged, one file in conflict and
 * one outside the worktree the person changed meanwhile, whose cloud copy is kept for them to compare.
 */
const mockReturnOutdated = { value: new URLSearchParams(globalThis.location?.search).get("return") ?? "" }
/** Where the fixture's project moved to, as the person chooses it in the folder chooser. */
const MOCK_MOVED_PROJECT = "/Users/you/Code/billing-api"
const MOCK_RETURN_WORKTREE = "/Users/you/.mako/worktrees/billing-api-3f2a91c0/retry-billing-webhooks"
/**
 * `?harnesses=`: this Mac's harnesses against a cloud on Codex 0.164.0, OpenCode 2.1.4, Devin 3000.11.205 and Grok
 * 1.0.70, as production met them. `behind`: Codex here is older, and Mako updates it; `several`: Codex and OpenCode
 * by Mako's update, Devin through Devin.app and Grok only by a newer Mako; `devin`: Devin alone; `failing`: Codex's
 * update fails; `ahead`: a Session a newer Codex wrote here, which the cloud can't resume. Without it, the fixture's
 * cloud doesn't say what it runs.
 */
const mockHarnessScene = new URLSearchParams(globalThis.location?.search).get("harnesses")
const MOCK_CLOUD_HARNESSES = new Map([["codex", "0.164.0"], ["opencode", "2.1.4"], ["devin", "3000.11.205"], ["grok", "1.0.70"]])
/** This Mac's versions in the scene: an update takes one to the cloud's; a test sets Devin's as Devin.app would. */
export const mockHarnessesHere = new Map([["codex", "0.159.3"], ["opencode", "2.0.1"], ["devin", "3000.10.23"], ["grok", "1.0.46"]])
const MOCK_HARNESS_OFFERS = new Map<string, Pick<HarnessBehind, "offer" | "to">>([
  ["codex", { offer: { kind: "update", runtimeId: "codex", label: "Update with npm" }, to: "0.164.0" }],
  ["opencode", { offer: { kind: "update", runtimeId: "opencode", label: "Update with npm" }, to: "2.1.4" }],
  ["devin", { offer: { kind: "owner", owner: "Devin" } }],
  ["grok", { offer: { kind: "owner", owner: "Mako" } }],
])

function mockHarnessCheck(): ThreadHarnessCheck {
  if (!mockHarnessScene) return { kind: "unknown", reason: "The cloud doesn't say which harness versions its machines run." }
  const image = "mako-machine-c3918df7b6f3"
  if (mockHarnessScene === "ahead")
    return { kind: "known", image, ahead: [{ harness: "codex", wrote: "0.165.0", cloud: "0.164.0" }], behind: [], refusal: "The cloud runs Codex 0.164.0, older than the 0.165.0 that wrote this Thread here, so it can't pick up there yet. It can move once the cloud runs 0.165.0 or newer." }
  const harnesses = mockHarnessScene === "several" ? ["codex", "opencode", "devin", "grok"] : mockHarnessScene === "devin" ? ["devin"] : ["codex"]
  const behind = harnesses.flatMap((harness): HarnessBehind[] => {
    const here = mockHarnessesHere.get(harness) ?? ""
    const cloud = MOCK_CLOUD_HARNESSES.get(harness) ?? ""
    const offer = MOCK_HARNESS_OFFERS.get(harness)
    return here === cloud || !offer ? [] : [{ harness, here, cloud, ...offer }]
  })
  return { kind: "known", image, ahead: [], behind }
}
const MOCK_PROVIDERS: UtilityProviderInfo[] = [
  { id: "google", name: "Google", description: "Gemini with a Google AI Studio API key" },
  { id: "openai", name: "OpenAI", description: "GPT models with an OpenAI API key" },
  { id: "anthropic", name: "Anthropic", description: "Claude with an Anthropic API key" },
  { id: "openai-compatible", name: "OpenAI-compatible", description: "OpenRouter, local models, or your own endpoint" },
]
// The mock drafts a message, so it starts with the key it drafts with; `?mock&keys=0` starts with none.
const MOCK_GITHUB_AVATAR = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.5 -0.5 6 6" shape-rendering="crispEdges"><rect x="-0.5" y="-0.5" width="6" height="6" fill="#f0f0f0"/><path fill="#3fae8c" d="${[
    [0, 0], [4, 0], [1, 1], [3, 1], [2, 1], [0, 2], [4, 2], [2, 2], [1, 3], [3, 3], [0, 4], [4, 4], [2, 4],
  ].map(([x, y]) => `M${x} ${y}h1v1h-1z`).join("")}"/></svg>`
)}`

let mockConnections: UtilityConnection[] = new URLSearchParams(globalThis.location?.search).get("keys") === "0"
  ? []
  : [{ provider: "google", model: "gemini-3.8-flash", name: "Gemini 3.8 Flash", contextTokens: 1_048_576 }]

let mockHarnessOrder: string[] = []
/** `harness:name` of fixture accounts signed in again, whose usage reads again. */
const mockRenewed = new Set<string>()
/** When each `harness:name` login was last signed in: Mako's own sign-in, or the fixture event standing in for a terminal's. */
const mockSignedInAt = new Map<string, number>()
if ("addEventListener" in globalThis)
  window.addEventListener("mako:fixture-terminal-login", (event) => {
    const harness = z.string().safeParse(event instanceof CustomEvent ? event.detail : undefined)
    if (harness.success) mockSignedInAt.set(`${harness.data}:default`, Date.now())
  })
/** Automatic resolves to the first connection, as the host's `UtilityWork` does. */
function mockUtilityWork(): UtilityWorkSettings {
  const options: UtilityModelOption[] = mockConnections.map((connection) => ({
    id: `${connection.provider}/${connection.model}`,
    label: connection.name ?? connection.model,
    via: MOCK_PROVIDERS.find((provider) => provider.id === connection.provider)?.name ?? connection.provider,
    source: connection.provider,
  }))
  const state = (task: UtilityTask): UtilityTaskState => {
    const choice = utilityChoices[task]
    const resolved = choice === "auto" ? options[0] : options.find((option) => option.id === choice)
    return { choice, options, resolved, reason: resolved ? undefined : "Connect an API key in Settings › Git to generate commit messages." }
  }
  return { commit: state("commit") }
}

/** What the mock "person" picks: the fixture pricing page's trial button, drawn here for its crop. */
function mockPick() {
  const canvas = document.createElement("canvas")
  canvas.width = 123
  canvas.height = 55
  const context = canvas.getContext("2d")
  if (context) {
    context.fillStyle = "#ffffff"
    context.fillRect(0, 0, 123, 55)
    context.fillStyle = "#24211e"
    context.beginPath()
    context.roundRect(8, 8, 107, 39, 8)
    context.fill()
    context.fillStyle = "#ffffff"
    context.font = "550 15px -apple-system, sans-serif"
    context.fillText("Start a trial", 22, 33)
  }
  const data = canvas.toDataURL("image/png").split(",")[1] ?? ""
  return {
    url: "http://rail-re-render-audit.thread.localhost:20140/pricing",
    title: "Pricing · Fixture app",
    comment: "Make this the primary colour",
    send: false,
    elements: [{
      tag: "button",
      selector: "article[aria-label=\"Team plan\"] button.cta",
      role: "button",
      name: "Start a trial",
      html: "<button type=\"button\" class=\"cta\">\n  Start a trial\n</button>",
      styles: "padding: 8px 14px\nborder-radius: 8px\nbackground-color: rgb(36, 33, 30)\ncolor: rgb(255, 255, 255)",
      box: { x: 628, y: 226, width: 107, height: 39 },
      component: "PlanCard",
      source: { file: "src/PlanCard.tsx", line: 13, column: 7 },
      label: "PlanCard",
      image: { data, mimeType: "image/png" as const },
      frame: false,
    }],
  }
}

export function installMockBridge() {
  const pickStarted = new Map<string, number>()
  const listeners = new Set<(event: HostEvent) => void>()
  const terminalListeners = new Set<(event: TerminalEvent) => void>()
  const emit = (event: HostEvent) =>
    listeners.forEach((listener) => listener(event))
  // `?events`: a UI check sends host events as the host would (another device's Thread listed), through the window's own path.
  if (new URLSearchParams(globalThis.location?.search).has("events")) Reflect.set(globalThis, "makoMockHost", { emit })
  const emitTerminal = (event: TerminalEvent) =>
    terminalListeners.forEach((listener) => listener(event))
  /**
   * `?app=rail&since=commits|behind|pull|landed`: the tab works in the
   * billing-webhooks worktree, with commits main lacks; `behind` adds 4 from
   * origin/main whose Update stops on a conflict, `pull` has its pull request
   * open, `failing` has it open with two checks failing, `landed` has its work in main. Merging lands it; opening a pull
   * request opens one.
   */
  const since = "location" in window ? new URLSearchParams(window.location.search).get("since") : null
  const sinceWorktree = since === "commits" || since === "behind" || since === "pull" || since === "failing" || since === "landed" ? RAIL_WORKTREES[0] : undefined
  let sinceLanded = since === "landed"
  const sincePull = (number: number): PullRequest => ({
    number, title: "Retry billing webhooks with backoff", body: "", state: "open", draft: false,
    url: `https://github.com/you/api/pull/${number}`, head: RAIL_WORKTREES[0].branch, base: "main",
    additions: 60, deletions: 9, files: 2, mergeable: "clean", reviewDecision: "required",
    checks: [{ name: "test", state: "passed" }, { name: "lint", state: "running" }], reviews: [],
  })
  let sinceOpen: PullRequest | null = since === "pull" ? sincePull(812)
    : since === "failing" ? { ...sincePull(812), checks: [{ name: "test", state: "failed" }, { name: "typecheck", state: "failed" }, { name: "lint", state: "passed" }] }
    : null
  const removedWorktrees = new Set<string>()
  const listedWorktrees = () => ({
    root: SETUP_WORKTREE_ROOT,
    worktrees: [...(setupWorktree ? [setupWorktree] : []), ...madeWorktrees, ...(scene === "rail" ? RAIL_WORKTREES : [])].filter((worktree) => !removedWorktrees.has(worktree.path)),
  })
  let meta = { ...META }
  if (sinceWorktree) meta.cwd = sinceWorktree.path
  let terminalSessions = initialTerminalSessions()
  const capabilities = createCapabilities()
  let sinceConflict = false
  const sinceBehind = () => ({ from: "origin/main", commits: since === "behind" && !sinceConflict && !sinceLanded ? 4 : 0 })
  const gitStatus = (): GitStatus => sinceWorktree
    ? {
        ...GIT,
        cwd: sinceWorktree.path,
        root: sinceWorktree.path,
        branch: sinceWorktree.branch,
        ahead: 0,
        behind: 0,
        operation: sinceConflict ? "merge" : undefined,
        files: sinceConflict
          ? [{ path: "src/billing/retry.ts", status: "conflicted", staged: false, insertions: null, deletions: null, binary: false }]
          : [],
      }
    : GIT

  const nativeRequests: NativeRequest[] = []
  const liveSnapshots = new Map<string, LiveSnapshot>()
  /** Sessions whose work is paused because the account signed out mid-turn, as the host pauses them. */
  const signInPauses = new Map<string, SignInHold>()
  const emitRequests = (id: string, next: LiveSnapshot, updates: LiveUpdate[] = []) => {
    liveSnapshots.set(id, next)
    acpSessions.set(id, next.session)
    emit({ type: "live-batch", batch: { id, revision: next.revision, updates, session: next.session, requests: next.requests } })
  }
  const signInReadiness = (id: string): SignInReadiness | null => {
    const hold = signInPauses.get(id)
    if (!hold) return null
    const selected = fixtureAccounts().find((account) => account.harness === hold.harness && account.active && !account.missing)
    if (selected && selected.name !== hold.account) return "ready"
    return (mockSignedInAt.get(`${hold.harness}:${hold.account}`) ?? 0) > hold.at ? "ready" : "signed-out"
  }
  /** The fixture's logins, read by live sessions to launch and switch accounts as the host does. */
  let fixtureAccounts: () => HarnessAccount[] = () => []
  /** What a session launched now runs as: the harness's selected login, confirmed where the harness reports one. */
  const accountContext = (harness: string): ExecutionContext | undefined => {
    const selected = fixtureAccounts().find((account) => account.harness === harness && account.active && !account.missing)
    if (!selected || selected.source === "model-provider") return undefined
    const reports = harness === "claude" || harness === "codex" || harness === "cursor"
    // The Claude login named "account-team" stays signed in natively as someone
    // else, so the fixture can show a session refusing to run as the wrong person.
    const principal = selected.name === "account-team" ? "personal@example.com" : selected.email
    const identity: ExecutionContext["identity"] = reports && principal
      ? { kind: "reported", principal, backend: "subscription", via: "fixture" }
      : { kind: "unavailable", reason: "The fixture harness does not report an identity." }
    return {
      transport: "fixture",
      runtime: { kind: "unavailable", reason: "Fixture." },
      account: { kind: "configured", name: selected.name, managed: selected.source === "mako" },
      identity,
      credential: { kind: "unavailable", reason: "Fixture." },
      confirmation: confirmAccount(identity, selected.email),
      service: { kind: "unavailable", reason: "Fixture." },
      store: { kind: "unavailable", reason: "Fixture." },
    }
  }
  const boot: BootPayload = {
    live: [],
    tabs: [
      {
        id: "tab-1",
        session: { meta, messages: MESSAGES, tree: TREE },
        git: gitStatus(),
        capabilities,
      },
    ],
    activeTabId: "tab-1",
    models: MODELS,
    platform: "darwin",
  }

  const update = (patch: Partial<SessionMeta>) => {
    meta = { ...meta, ...patch }
    emit({ type: "meta", meta })
  }

  // Tabs in the browser mock are cosmetic: there is no second runtime to run,
  // so a new tab is another view of the same fixture. Enough to lay out the
  // strip against, not enough to pretend it is the real thing.
  let tabCount = 1
  let acpCount = 0
  const acpSessions = new Map<string, LiveSessionState>()
  const mockTab = (id: string) => ({
    id,
    session: { meta, messages: MESSAGES, tree: TREE },
    git: gitStatus(),
    capabilities,
  })

  // Node tests install the bridge on a bare `window` with no address.
  const scene = "location" in window ? new URLSearchParams(window.location.search).get("app") : null
  const setupScene = scene === "setup" || scene === "setup-here" || scene === "setup-fallback"
  /**
   * `?app=kept`: sessions their harness deleted, at the top of the rail: one
   * whose records Mako's record store kept, and one only Mako's copy keeps
   * (`ThreadRef.copyOnly`), as the archive's migration leaves them.
   */
  const keptScene = scene === "kept"
  /** `?app=busy`: a long Thread of four Sessions, its first waiting on three agents and twenty-two commands. */
  if (scene === "busy") {
    BUSY_SESSIONS.forEach((entry, index) => liveSnapshots.set(entry.conversation, busySnapshot(index)))
    boot.live.push(...busySummaries())
  }
  /** `?app=slow-start`: a start the host takes 26 s to accept, as a cloud Thread's might, with its steps, to see the wait. */
  const slowStart = scene === "slow-start"
  /**
   * `?app=kept&outdated=1`: Codex 0.163.0 wrote the kept session's records,
   * and this Mac has 0.159.3, so the host's restore plan offers Update; the
   * update takes the reading to 0.163.0 and the plan turns native.
   */
  const outdatedScene = keptScene && "location" in window && new URLSearchParams(window.location.search).get("outdated") === "1"
  /** `?app=kept&outdated=unknown`: nothing names the version that wrote the kept session (written outside Mako, its harness left no trace), so Mako can't show the install here reads it. */
  const unknownWriterScene = keptScene && "location" in window && new URLSearchParams(window.location.search).get("outdated") === "unknown"
  /** `?app=kept&outdated=import`: a `cursor-agent` store last written after the Cursor SDK Mako ships was published, which the SDK would import to continue it. */
  const importScene = keptScene && "location" in window && new URLSearchParams(window.location.search).get("outdated") === "import"
  let keptCodexInstalled = "0.159.3"
  /** `?app=unread`: records Mako couldn't read, saved and live, for Settings › Diagnostics. */
  const unreadScene = scene === "unread"
  /**
   * `?app=newer-stores`: Mako 0.163.0 changed the Thread store and the
   * session ledger, which this build reads and doesn't change, and Mako
   * 0.170.0 changed the record store past what it reads. This build is a
   * release, so Update checks and then installs. `&later=1` opens with
   * every store this build's own and has 0.163.0 change the Thread store a
   * moment later, as a development host migrating it would.
   */
  const newerStoresScene = scene === "newer-stores"
  const storesLater = newerStoresScene && "location" in window && new URLSearchParams(window.location.search).get("later") === "1"
  const newerStores: StoreFormats = {
    stores: [
      { store: "threads", access: "read", build: 1, writableBy: 2, readableBy: 1, writtenBy: "0.163.0", readableFrom: "0.140.0" },
      { store: "session-memory", access: "read", build: 1, writableBy: 2, readableBy: 1, writtenBy: "0.163.0", readableFrom: "0.150.0" },
      { store: "records", access: "refused", build: 2, writableBy: 4, readableBy: 3, writtenBy: "0.170.0", readableFrom: "0.170.0" },
      { store: "unread", access: "write", build: 1, writableBy: 1, readableBy: 1 },
      { store: "outputs", access: "write", build: 1, writableBy: 1, readableBy: 1 },
      { store: "archive", access: "write", build: 1, writableBy: 1, readableBy: 1 },
    ],
  }
  const ownStores: StoreFormats = { stores: newerStores.stores.map((row) => ({ store: row.store, access: "write", build: row.build, writableBy: row.build, readableBy: row.build })) }
  if (storesLater) setTimeout(() => emit({ type: "store-formats", formats: { stores: [newerStores.stores[0]!, ...ownStores.stores.slice(1)] } }), 1500)
  let mockUpdate: "current" | "ready" = "current"
  const outdatedCodexReading = () => ({
    provider: "codex",
    primary: true,
    binary: "/Users/you/.nvm/versions/node/v24.19.0/bin/codex",
    installed: keptCodexInstalled,
    latest: "0.163.0",
    channel: "npm" as const,
    update: { label: "Update with npm", command: "npm", args: ["install", "-g", "--allow-scripts=@openai/codex", "@openai/codex@latest"] },
    checkedAt: Date.now() - 90_000,
    latestCheckedAt: Date.now() - 90_000,
    versions: { oldest: "0.146.0", tested: "0.159.3", standing: keptCodexInstalled === "0.159.3" ? "tested" as const : "newer" as const },
  })
  /** The records `?app=unread` counts: two saved kinds a newer Codex and Claude Code wrote, one with no version yet, and a live Grok kind. */
  const unreadReport = (): UnreadReport => unreadScene ? {
    rows: [
      { harness: "codex", version: "0.163.0", source: "record", from: "saved", kind: "response_item web_search_preview_call", reason: "unknown", count: 14, sessions: 3, newestAt: Date.now() - 4 * 60_000, example: { kind: "entry", path: "/mock/unread/codex-rollout.jsonl", id: "@48213", record: { ranges: [[48213, 48391]] } } },
      { harness: "codex", version: "0.159.3", source: "record", from: "saved", kind: "event_msg collab_waiting_begin", reason: "unreadable", count: 2, sessions: 1, newestAt: Date.now() - 3 * 3_600_000, example: { kind: "entry", path: "/mock/unread/codex-older.jsonl", id: "@9120", record: { ranges: [[9120, 9241]] } } },
      { harness: "claude", version: "2.1.295", source: "record", from: "saved", kind: "attachment hook_progress", reason: "unknown", count: 6, sessions: 2, newestAt: Date.now() - 26 * 60_000, example: { kind: "entry", path: "/mock/unread/claude-session.jsonl", id: "@3310", record: { ranges: [[3310, 3502]] } } },
      { harness: "claude", version: null, source: null, from: "saved", kind: "system scheduled_wakeup", reason: "unknown", count: 1, sessions: 1, newestAt: Date.now() - 2 * 86_400_000, example: { kind: "entry", path: "/mock/unread/claude-older.jsonl", id: "@120", record: { ranges: [[120, 260]] } } },
      { harness: "grok", version: "1.0.62", source: "reported", from: "live", kind: "_x.ai/session/checkpoint", reason: "unknown", count: 3, newestAt: Date.now() - 9 * 60_000, example: { kind: "stream", frame: { file: "mako-streams:grok/7f1e@2026-10-17T09-00-00-000Z-c.jsonl", ranges: [[4100, 4290]] } } },
    ],
    sessions: 7,
    records: 23,
    unattributed: 1,
    liveSince: Date.now() - 3 * 3_600_000,
  } : { rows: [], sessions: 0, records: 0, unattributed: 0, liveSince: Date.now() }
  const unreadSample = (path: string, from: number): string => `${JSON.stringify(path.includes("claude")
    ? { type: "attachment", attachment: { type: "hook_progress", hookName: "PostToolUse", status: "running" }, sessionId: "6676d8e9", version: "2.1.295" }
    : { timestamp: "2026-10-17T09:12:44.120Z", type: "response_item", payload: { type: "web_search_preview_call", id: "ws_0c7", status: "completed", action: { query: "zod 4 discriminated unions" } }, at: from })}\n`
  const keptThreads = (): ThreadRef[] => keptScene ? [
    { harness: "claude", nativeId: "cl-kept-copy", path: "/mock/claude-kept-copy.jsonl", cwd: "/Users/you/api", title: "Plan the billing ledger migration", model: "claude-opus-5", updatedAt: new Date(Date.now() - 60_000).toISOString(), archived: true, copyOnly: true, locked: false },
    { harness: "codex", nativeId: "cx-kept-records", path: "/mock/codex-kept-records.jsonl", cwd: "/Users/you/api", title: "Audit the webhook signatures", model: "gpt-5.2-codex", updatedAt: new Date(Date.now() - 120_000).toISOString(), archived: true, locked: false },
    ...importScene ? [{ harness: "cursor", nativeId: "39fc58cb-7793-4e80-b5d1-343da0f42fea", path: "/mock/.cursor/chats/68cb518f/39fc58cb-7793-4e80-b5d1-343da0f42fea/store.db", cwd: "/Users/you/api", title: "Trace the flaky upload retry", updatedAt: new Date(Date.now() - 180_000).toISOString(), locked: false }] : [],
  ] : []
  /** `?start=behind|ahead|diverged|level|alone|detached|offline` picks how the project folder's branch stands. */
  const mockStartPoint = (): WorktreeStartPoint => {
    const kind = ("location" in window ? new URLSearchParams(window.location.search).get("start") : null) ?? "behind"
    const commit = "4f1c2a9e0b7d3c5a8e6f1b2d9c0a7e3f5b8d1c2a"
    const fetched = { at: Date.now(), failed: kind === "offline" ? "Couldn't reach origin; using what was fetched last." : null }
    const base = { commit, branch: "main", upstream: "origin/main", fetched }
    if (kind === "ahead") return { ...base, from: "main", standing: { kind: "ahead", ahead: 2 } }
    if (kind === "diverged") return { ...base, from: "main", standing: { kind: "diverged", ahead: 2, behind: 3 } }
    if (kind === "level" || kind === "offline") return { ...base, from: "main", standing: { kind: "level" } }
    if (kind === "alone") return { ...base, from: "main", upstream: null, fetched: null, standing: { kind: "alone" } }
    if (kind === "detached") return { from: commit.slice(0, 7), commit, branch: null, upstream: null, fetched: null, standing: { kind: "detached" } }
    return { ...base, from: "origin/main", standing: { kind: "behind", behind: 4 } }
  }
  /** The setup Thread's worktree, once its Session has started in one. */
  let setupWorktree: ThreadWorktree | undefined
  /** `?making=slow|fast`: a new Thread on its own branch gets a worktree, slowly through each step or at once from a spare. */
  const making = "location" in window ? new URLSearchParams(window.location.search).get("making") : null
  const madeWorktrees: ThreadWorktree[] = []
  const worktreeSkips = new Map<string, () => void>()
  const makeWorktree = async (conversationId: string, cwd: string, thread: ThreadId, name: string | undefined, start: WorktreeStart | undefined): Promise<ThreadWorktree | undefined> => {
    const began = performance.now()
    let skipped = false
    const skip = new Promise<void>((resolve) => worktreeSkips.set(conversationId, () => {
      skipped = true
      resolve()
    }))
    const pause = (ms: number) => Promise.race([new Promise((resolve) => setTimeout(resolve, ms)), skip])
    if (making === "slow") {
      emit({ type: "worktree-step", conversationId, step: "checkout" })
      await pause(3_200)
      if (!skipped) emit({ type: "worktree-step", conversationId, step: "carry" })
      if (!skipped) await pause(1_400)
    } else await pause(380)
    worktreeSkips.delete(conversationId)
    if (skipped) return undefined
    const point = mockStartPoint()
    const adopted = start?.kind === "pull" ? (start.cross ? `pr-${start.number}` : start.branch) : start?.kind === "branch" ? start.branch.replace(/^origin\//, "") : undefined
    const slug = worktreeSlug(adopted?.replace(/[/_.]+/g, " ") ?? name ?? "")
    const worktree: ThreadWorktree = {
      path: `${SETUP_WORKTREE_ROOT}/${slug}`,
      thread,
      repoRoot: cwd,
      project: cwd,
      branch: adopted ?? `mako/${slug}`,
      base: point.commit,
      createdAt: Date.now(),
      start: {
        from: adopted ? null : start?.kind === "from" ? start.ref : point.from,
        adopted: Boolean(adopted),
        tookMs: Math.round(performance.now() - began),
        copied: 2,
        spare: making !== "slow",
      },
    }
    madeWorktrees.push(worktree)
    emit({ type: "worktree-ready", conversationId })
    return worktree
  }
  /** Threads started for a purpose, as the host records them on start. */
  const purposes: ThreadPurpose[] = scene === "rail" ? [...RAIL_PURPOSES] : []
  /** Threads renamed in this page, as the Thread store keeps them. */
  const titles = new Map<string, ThreadTitleEntry>()
  if (scene === "busy") titles.set(BUSY_THREAD, { thread: BUSY_THREAD, title: BUSY_TITLE, source: "user" })
  /** The rail scene's runs are reported once, as the host would after the catalog. */
  let railRunsSent = false
  // The host gives every profile Mako's default for new conversations.
  const profiles = () =>
    MOCK_PROFILES.map((profile) => ({ ...profile, settings: workDefault(fixtureHarnesses.find((entry) => entry.provider === profile.id)?.defaults, profile.models) ?? profile.settings })).map((profile) =>
      scene === "setup-fallback" && profile.id === "codex" ? { ...profile, available: false, error: "Not signed in" } : profile
    )
  /** A scripted turn's next updates, delivered the way the host batches them. */
  /** A prompt names the harness it went to, as the host's dispatch stamps it, so each turn keeps its own agent's name after a switch. */
  const withHarness = (harness: string, updates: LiveUpdate[]): LiveUpdate[] =>
    updates.map((update) => update.kind === "user" && !update.provider ? { ...update, provider: harness } : update)
  const pushLive = (id: string, sent: LiveUpdate[], finished = false) => {
    const snapshot = liveSnapshots.get(id)
    if (!snapshot) return
    const updates = withHarness(snapshot.session.harness, sent)
    const session: LiveSessionState = finished ? { ...snapshot.session, status: "ready" } : snapshot.session
    const requests = finished ? snapshot.requests.map((request) => ({ ...request, status: "completed" as const })) : snapshot.requests
    const next = { ...snapshot, session, requests, revision: snapshot.revision + 1, blocks: reduceLiveUpdates(snapshot.blocks, updates) }
    liveSnapshots.set(id, next)
    acpSessions.set(id, session)
    emit({ type: "live-batch", batch: { id, revision: next.revision, updates, session, requests } })
  }
  /**
   * `?app=streams`: each streamed update names the stream line it came
   * from, and a turn's record lands when the next prompt is sent, merged
   * the way a host merges them: record entries that keep their stream
   * frames, then the live turn. The fixture's native lines are the values
   * themselves, as `threadOriginal`'s are.
   */
  /**
   * `?app=fork-opening`: the streams scene, where each session's harness
   * reports MCP servers that failed as the session opens, before its first
   * prompt, and a fork goes on from its parent's record as the host's does:
   * the parent's turns are its history, and its own session's opening is
   * drawn under its first prompt.
   */
  const forkOpeningScene = scene === "fork-opening"
  /** `?app=rewind`: a changed turn's rewind shows whose each file is; `&checkpoint=refused`, why there is none. */
  const rewindScene = scene !== "rewind" ? undefined : "location" in window && new URLSearchParams(window.location.search).get("checkpoint") === "refused" ? "refused" : "shared"
  const streamsScene = scene === "streams" || forkOpeningScene
  const openingNotices = (snapshot: LiveSnapshot): LiveUpdate[] =>
    !forkOpeningScene || snapshot.requests.length ? [] : (snapshot.control?.ancestry?.kind === "fork" ? ["paper", "wisprflow"] : ["paper"])
      .map((server): LiveUpdate => ({ kind: "event", ...mcpServerFailedEvent(server, "could not connect") }))
  /** The views snapshots were presented with, by token: each fixed as it was read, as the host's are. */
  const views = new Map<string, LiveSnapshot>()
  /** A snapshot as the host presents it, with the view its entries are read from. */
  const presented = (snapshot: LiveSnapshot): LiveSnapshot => {
    if (!streamsScene) return snapshot
    const held = [...views].find(([, view]) => view.session.id === snapshot.session.id && view.revision === snapshot.revision)
    const token = held?.[0] ?? crypto.randomUUID()
    views.set(token, snapshot)
    return { ...snapshot, history: { token, blockStart: 0, blockEnd: snapshot.blocks.length, turnStart: 0, earlierRequests: [], before: null } }
  }
  const presentedRead = (snapshot: LiveSnapshot, input: LiveHistoryRead) => {
    if (input.kind === "original") {
      const view = views.get(input.token)
      if (!view || view.session.id !== snapshot.session.id) throw new Error("This history view expired. Open the conversation again to refresh it.")
      return mockOriginal(view, input.at)
    }
    if (input.kind === "snapshot" && input.ifCurrent && views.has(input.ifCurrent.token) && input.epoch !== undefined &&
        input.epoch === snapshot.epoch && input.ifCurrent.revision === snapshot.revision)
      return { kind: "unchanged" as const, token: input.ifCurrent.token, revision: snapshot.revision, epoch: input.epoch }
    return presented(snapshot)
  }
  /** Each stream and record file's text, by the name its refs give. */
  const mockFiles = new Map<string, string>()
  const utf8Bytes = (text: string) => new TextEncoder().encode(text).length
  const appendLine = (file: string, value: { at: string; message: LiveUpdate } | Omit<Entry, "stream">): [number, number] => {
    const before = mockFiles.get(file) ?? ""
    const line = `${JSON.stringify(value)}\n`
    mockFiles.set(file, before + line)
    const from = utf8Bytes(before)
    return [from, from + utf8Bytes(line)]
  }
  const framed = (id: string, harness: string, updates: LiveUpdate[]): LiveUpdate[] => !streamsScene ? updates : updates.map((update) => {
    if (update.kind === "retract") return update
    const file = `mako-streams:${harness}/mock-${id}.jsonl`
    return { ...update, stream: { file, ranges: [appendLine(file, { at: new Date().toISOString(), message: update })] } }
  })
  /** The record of every turn before the next one, with the stream frames each entry was drawn from. */
  const landRecord = (id: string, snapshot: LiveSnapshot): Pick<LiveSnapshot, "base" | "baseCoveredBlocks" | "baseLiveStart"> => {
    const path = `/Users/you/.${snapshot.session.harness}/sessions/mock-${id}.jsonl`
    const known = snapshot.base?.entries ?? []
    const landed = snapshot.blocks.slice(snapshot.baseCoveredBlocks ?? 0).map((block, index): Entry => {
      const { stream, ...said } = block
      return { ...block, id: `${id}:record:${known.length + index}`, record: { file: path, ranges: [appendLine(path, said)] }, ...stream && { stream } }
    })
    const entries = [...known, ...landed]
    const ref: ThreadRef = snapshot.base?.ref ?? { harness: snapshot.session.harness, nativeId: `mock-${id}`, path, cwd: snapshot.session.cwd, title: snapshot.session.title }
    return { base: { ref, entries, start: 0, total: entries.length, hasEarlier: false }, baseCoveredBlocks: snapshot.blocks.length, baseLiveStart: 0 }
  }
  /** What the host reads for "Show original": the record lines a saved entry names and the stream lines any entry names. */
  const mockOriginal = (snapshot: LiveSnapshot, at: LiveHistoryAddress): EntryOriginal => {
    const entry = at.kind === "live" ? snapshot.blocks[at.index] : snapshot.base?.entries.find((each) => each.id === at.id)
    if (!entry) throw new Error("That retained history item is unavailable.")
    const read = (ref: RecordRef): OriginalPart[] => (ref.ranges ?? []).map(([from, to]) => {
      const name = ref.file ?? ""
      const file = name.startsWith("mako-streams:") ? `/Users/you/.mako/records/streams/${name.slice("mako-streams:".length)}` : name
      const bytes = new TextEncoder().encode(mockFiles.get(name) ?? "").subarray(from, to)
      return bytes.length ? { kind: "range", file, from, to, text: new TextDecoder().decode(bytes) } : { kind: "missing", file, reason: "The stream file is gone." }
    })
    return { kept: false, parts: at.kind === "base" && entry.record ? read(entry.record) : [], ...entry.stream && { stream: read(entry.stream) } }
  }
  /** Side answers being written, by conversation: the word timers Stop and close cancel. */
  const sideAnswers = new Map<string, ReturnType<typeof setTimeout>[]>()
  const setSide = (id: string, side: SideConversation | undefined) => {
    const current = liveSnapshots.get(id)
    if (!current) throw new Error("This conversation is no longer available")
    const updated: LiveSnapshot = { ...current, side, revision: current.revision + 1 }
    liveSnapshots.set(id, updated)
    emit({ type: "live-batch", batch: { id, revision: updated.revision, side: side ?? null, updates: [] } })
    return updated
  }
  const changeExchange = (id: string, exchange: string, change: (current: SideExchange) => SideExchange) => {
    const side = liveSnapshots.get(id)?.side
    if (side) setSide(id, { ...side, exchanges: side.exchanges.map((entry) => entry.id === exchange ? change(entry) : entry) })
  }
  const stopSideAnswer = (id: string) => {
    for (const timer of sideAnswers.get(id) ?? []) clearTimeout(timer)
    sideAnswers.delete(id)
  }
  /** A turn that runs the suite for a while, so the composer shows a running turn to ask beside. */
  const playSuiteTurn = (id: string) => {
    pushLive(id, [{ kind: "text", id: "suite-say", text: "Running the rail's tests before I touch the status bar." }, { kind: "tool", id: "suite", title: "npm test -- rail", toolKind: "execute", status: "in_progress", input: '{"command":"npm test -- rail"}' }])
    setTimeout(() => pushLive(id, [
      { kind: "tool-update", id: "suite", status: "completed", output: "48 passed" },
      { kind: "text", id: "suite-done", text: "All 48 rail tests pass." },
    ], true), 24_000)
  }

  const startLiveReview = (id: string, target: ReviewTarget): LiveSnapshot => {
    const snapshot = liveSnapshots.get(id)
    if (!snapshot) throw new Error("This conversation is no longer available")
    const requestId = crypto.randomUUID()
    const shown = reviewDisplayText(target)
    const native = ["claude", "codex", "opencode"].includes(snapshot.session.harness)
    const request: LiveRequest = { id: requestId, text: shown, displayText: shown, attachments: [], review: target, status: "dispatching", ...(native && { verbatim: true }) }
    const session: LiveSessionState = { ...snapshot.session, status: "running" }
    liveSnapshots.set(id, { ...snapshot, session, requests: [...snapshot.requests, request] })
    acpSessions.set(id, session)
    pushLive(id, [{ kind: "user", requestId, text: shown }])
    playReviewTurn(id, snapshot.session.harness, snapshot.session.cwd)
    return liveSnapshots.get(id)!
  }

  /** A review turn: it reads the diff, then reports as the harness does. */
  const playReviewTurn = (id: string, harness: string, cwd: string) => {
    const report = mockReviewReport(harness === "codex" ? cwd : undefined)
    const reading: LiveUpdate[] = [
      { kind: "tool", id: "review-diff", title: "git diff", toolKind: "execute", status: "in_progress", input: '{"command":"git diff"}' },
    ]
    const read: LiveUpdate[] = [{ kind: "tool-update", id: "review-diff", status: "completed", output: " src/net/retry.ts     | 41 +++++++----\n src/upload/queue.ts  | 12 ++--\n 2 files changed, 37 insertions(+), 16 deletions(-)" }]
    const reported: LiveUpdate[] = harness === "codex"
      ? [
          { kind: "tool", id: "review", title: "Code review", toolKind: "review", status: "in_progress" },
          { kind: "tool-update", id: "review", status: "completed", details: [{ type: "review", ...report }] },
        ]
      : harness === "claude"
        ? [
            { kind: "tool", id: "review", title: "ReportFindings", toolKind: "review", status: "completed", details: [{ type: "review", ...report }] },
            { kind: "text", id: "review-say", text: report.findings.map((finding) => `- \`${finding.path}:${finding.line}\` — ${finding.title}`).join("\n") },
          ]
        : harness === "opencode"
          ? [{ kind: "text", id: "review-say", text: [
              "Two problems in the diff:",
              "",
              "- **Retries ignore the server's `Retry-After`** (`src/net/retry.ts:42`). `retry.ts` backs off on its own schedule, so a 429 that asks for 30 seconds is retried after 2.",
              "- **A canceled upload is sent again** (`src/upload/queue.ts:88`). `cancel()` clears the timer but leaves the entry in `pending`.",
            ].join("\n") }]
          : [{ kind: "text", id: "review-say", text: `I read the diff and the code around it.\n\n\`\`\`${REVIEW_FENCE}\n${JSON.stringify(report, null, 2)}\n\`\`\`` }]
    pushLive(id, reading)
    setTimeout(() => pushLive(id, read), 900)
    setTimeout(() => pushLive(id, reported, true), 2_200)
  }

  /** The scripted setup turn, played in the conversation that was asked, wherever it runs. */
  const beginSetup = (id: string, title: string, harness: string, cwd: string) => {
    mockSetupMoment({ at: "started", conversation: id, title, harness, cwd })
    playSetupTurn(
      (updates) => pushLive(id, updates),
      () => pushLive(id, [], true)
    )
  }

  const archivedThreads = new Set<string>()
  let archiveRevision = 0
  let workspaceMoves: WorkspaceMoves = { requests: [], alwaysAllowed: [] }
  let planBuilds: PlanBuilds = {}
  let accessChoices: AccessChoices = {}
  let mockTelemetry = { usage: true, errors: true }
  window.mako = {
    boot: async () => boot,
    threadArchives: async () => ({
      revision: archiveRevision,
      keys: [...archivedThreads],
    }),
    threadControls: async () => ({
      archived: false,
      stop: null,
      external: false,
    }),
    threadGroups: async () => (scene === "rail" ? RAIL_THREAD_GROUPS : []),
    threadPurposes: async () => [...purposes],
    threadTitles: async () => [...titles.values()],
    renameThread: async (_operationId: string, thread: string, title: string | null) => {
      const entry: ThreadTitleEntry = title === null ? { thread, title: null } : { thread, title, source: "user" }
      if (title === null) titles.delete(thread)
      else titles.set(thread, entry)
      emit({ type: "thread-titles", titles: [entry] })
      return entry
    },
    importThreadTitles: async () => [],
    worktrees: async () => listedWorktrees(),
    chatFolders: async () => ({ root: "/Users/you/Mako/Chats", projects: [] }),
    checkoutHeads: async (folders: string[]) =>
      Object.fromEntries(
        folders.map((folder) => {
          const own = folder === setupWorktree?.path ? setupWorktree : scene === "rail" ? RAIL_WORKTREES.find((worktree) => worktree.path === folder) : undefined
          return [folder, own ? { kind: "branch" as const, name: own.branch } : (MOCK_HEADS.get(folder) ?? null)]
        })
      ),
    threadApp: async () => {
      throw new Error("The mock desk runs no apps; ?app=<scenario> shows one.")
    },
    startThreadApp: async () => ({ problems: ["The mock desk runs no apps."] }),
    stopThreadApp: async () => {},
    restartThreadApp: async () => ({ problems: ["The mock desk runs no apps."] }),
    checkThreadApp: async () => ({ problems: ["The mock desk runs no apps."] }),
    makeRoomForThreadApp: async () => ({ problems: ["The mock desk runs no apps."] }),
    takeTurnForThreadApp: async () => ({ problems: ["The mock desk runs no apps."] }),
    threadAppOutput: async () => ({ text: "", cursor: { file: "", offset: 0 }, reset: false }),
    threadAppMarks: async () => [],
    probeThreadApp: async () => {
      throw new Error("The mock desk runs no apps; ?app=<scenario> shows one.")
    },
    threadAppRoom: async () => ({ at: Date.now(), pressure: "normal", apps: [], fits: [], marks: [] }),
    stopThreadApps: async () => {},
    projectAppSetup: async () => {
      throw new Error("The mock desk runs no apps; ?app=<scenario> shows one.")
    },
    worktreeRemoval: async (path: string) => {
      const suite = scene === "rail" ? railSuiteRemoval(path) : undefined
      if (suite) return suite
      const summary = RAIL_SUMMARIES.find((candidate) => candidate.path === path)
      if (!summary && path !== sinceWorktree?.path) throw new Error("Mako didn't make this worktree, so it won't remove it.")
      const folder = path.split("/").at(-1)
      const landing = path === sinceWorktree?.path
        ? sinceLanded ? { kind: "merged" as const, into: "main" } : { kind: "open" as const, into: "main", commits: 3 }
        : summary?.landing ?? { kind: "unknown" as const }
      return { held: summary?.changes && path !== sinceWorktree?.path ? `${folder} has changes that aren't committed. Commit or discard them, then remove the worktree.` : null, landing }
    },
    removeWorktree: async (path: string) => {
      if (scene !== "rail") throw new Error("The mock desk has no worktrees to remove.")
      removedWorktrees.add(path)
      return listedWorktrees()
    },
    wantWorktree: async () => {},
    worktreeStartPoint: async () => mockStartPoint(),
    skipWorktree: async (conversationId: string) => worktreeSkips.get(conversationId)?.(),
    worktreeBranches: async () => {
      const hours = (count: number) => Date.now() - count * 3_600_000
      return [
        { name: "main", remote: false, at: hours(1), checkedOut: "/Users/you/mako" },
        { name: "mako/retry-budget", remote: false, at: hours(3), checkedOut: "/Users/you/.mako/worktrees/mako-1a2b3c4d/retry-budget" },
        { name: "fix/login-redirect", remote: false, at: hours(20), checkedOut: null },
        { name: "origin/billing-webhooks", remote: true, at: hours(30), checkedOut: null },
        { name: "release/2026.10", remote: false, at: hours(80), checkedOut: null },
        { name: "origin/docs-refresh", remote: true, at: hours(200), checkedOut: null },
      ]
    },
    worktreeSummaries: async (): Promise<WorktreeSummary[]> => [
      ...madeWorktrees.map((worktree) => ({ path: worktree.path, into: "main", ahead: 0, changes: 0, landing: { kind: "empty" as const }, pull: null, behind: { from: "origin/main", commits: 0 } })),
      ...(scene === "rail" ? RAIL_SUMMARIES.map((summary) => summary.path !== sinceWorktree?.path ? summary : {
        ...summary,
        ahead: sinceLanded ? 0 : 3,
        landing: sinceLanded ? { kind: "merged" as const, into: "main" } : { kind: "open" as const, into: "main", commits: 3 },
        pull: sinceOpen && summary.pull ? {
          ...summary.pull,
          number: sinceOpen.number,
          state: sinceOpen.state === "merged" ? "merged" as const : "open" as const,
          checks: sinceOpen.checks.some((check) => check.state === "failed") ? "failed" as const : summary.pull.checks,
        } : null,
        behind: sinceBehind(),
      }) : []),
    ],
    worktreePulls: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
      return [
        { number: 812, title: "Fix the login redirect after SSO", branch: "fix/login-redirect", draft: false, author: "ann", updatedAt: ago(2), cross: false },
        { number: 809, title: "Billing webhooks retry with backoff", branch: "billing-webhooks", draft: true, author: "kashyab", updatedAt: ago(26), cross: false },
        { number: 801, title: "Typo in the README", branch: "patch-1", draft: false, author: "outside-contributor", updatedAt: ago(120), cross: true },
      ]
    },
    worktreeAhead: async () => null,
    worktreeInventory: async () => (scene === "rail" ? railInventory(removedWorktrees) : { worktrees: [], spares: { count: 0, bytes: null } }),
    worktreeReview: async (path: string): Promise<WorktreeReview> => {
      if (!sinceWorktree || path !== sinceWorktree.path) throw new Error("Worktrees are unavailable in the mock bridge")
      return {
        path,
        branch: sinceWorktree.branch,
        into: "main",
        base: sinceWorktree.base,
        commits: sinceLanded ? 0 : 3,
        files: sinceLanded ? [] : [{ path: "src/billing/webhooks.ts", insertions: 42, deletions: 7 }, { path: "src/billing/retry.ts", insertions: 18, deletions: 2 }],
        merge: sinceConflict ? { ok: false, reason: "Commit or discard this worktree's changes first." } : { ok: true, into: "main" },
        behind: sinceBehind(),
      }
    },
    worktreeUpdate: async (): Promise<WorktreeUpdate> => {
      await new Promise((resolve) => setTimeout(resolve, 700))
      sinceConflict = true
      return { kind: "conflicts", from: "origin/main", files: ["src/billing/retry.ts"] }
    },
    worktreeReviewDiffs: async () => ({ diffs: [], truncated: 0 }),
    mergeWorktree: async (path: string) => {
      if (!sinceWorktree || path !== sinceWorktree.path) throw new Error("Worktrees are unavailable in the mock bridge")
      await new Promise((resolve) => setTimeout(resolve, 600))
      sinceLanded = true
      return { branch: sinceWorktree.branch, into: "main" }
    },
    workspaceMoves: async () => workspaceMoves,
    workspaceMoveHold: async () => ({ companions: [] }),
    answerWorkspaceMove: async (id, answer) => {
      const request = workspaceMoves.requests.find((candidate) => candidate.id === id)
      if (!request) return
      workspaceMoves = {
        requests: workspaceMoves.requests.flatMap((candidate) =>
          candidate.id !== id ? [candidate] : answer === "deny" ? [] : [{ ...candidate, state: "allowed" as const }]),
        alwaysAllowed: answer === "always" && !workspaceMoves.alwaysAllowed.includes(request.project)
          ? [...workspaceMoves.alwaysAllowed, request.project]
          : workspaceMoves.alwaysAllowed,
      }
      emit({ type: "workspace-moves", moves: workspaceMoves })
    },
    forgetWorkspaceMoves: async (project) => {
      workspaceMoves = { ...workspaceMoves, alwaysAllowed: workspaceMoves.alwaysAllowed.filter((candidate) => candidate !== project) }
      emit({ type: "workspace-moves", moves: workspaceMoves })
    },
    bringWithWorkspaceMove: async (id, bring) => {
      workspaceMoves = { ...workspaceMoves, requests: workspaceMoves.requests.map((candidate) => (candidate.id === id ? { ...candidate, bring } : candidate)) }
      emit({ type: "workspace-moves", moves: workspaceMoves })
    },
    bringStayedChanges: async () => { throw new Error("Worktrees are unavailable in the mock bridge") },
    putBackMovedFiles: async () => { throw new Error("Worktrees are unavailable in the mock bridge") },
    workspaceMoveOutcome: async () => null,
    threadChanges: async () => null,
    changeUsage: async () => null,
    resolveFileReferences: async () => null,
    resolveTurnMedia: async (checks) => checks.map(() => ({ kind: "dropped" as const, reason: "The browser mock has no filesystem" })),
    chooseFileReference: async () => undefined,
    lostVersions: async () => [],
    restoreVersion: async () => { throw new Error("The mock bridge keeps no versions") },
    accessChoices: async () => accessChoices,
    chooseAccess: async (harness, mode) => {
      accessChoices = { ...accessChoices, [harness]: { mode } }
      emit({ type: "access-choices", choices: accessChoices })
      return accessChoices
    },
    adoptAccessChoices: async (modes) => {
      accessChoices = { ...Object.fromEntries(Object.entries(modes).map(([harness, mode]) => [harness, { mode }])), ...accessChoices }
      return accessChoices
    },
    planBuilds: async () => planBuilds,
    recordPlanBuild: async (planId, build) => {
      planBuilds = { ...planBuilds, [planId]: build }
      emit({ type: "plan-builds", builds: planBuilds })
    },
    claimPlanBuild: async (_claimId, planId, target, seen) => {
      const current = planBuilds[planId]
      if ((current?.at ?? null) !== seen) return { claimed: false, current }
      const build = { ...target, at: Date.now() }
      planBuilds = { ...planBuilds, [planId]: build }
      emit({ type: "plan-builds", builds: planBuilds })
      return { claimed: true, build }
    },
    releasePlanBuild: async () => {},
    threadCreateSession: async () => {
      throw new Error("The mock desk has no Thread store, so it can't add a session to a Thread.")
    },
    archiveThread: async (command) => {
      const { threadArchiveKey } =
        await import("@mako/host/contracts/thread-lifecycle")
      const key = threadArchiveKey(command.target)
      if (command.archived) archivedThreads.add(key)
      else archivedThreads.delete(key)
      const snapshot = {
        revision: ++archiveRevision,
        keys: [...archivedThreads],
      }
      emit({ type: "thread-archives", snapshot })
      return snapshot
    },
    stopThread: async () => false,
    openTab: async (options) => {
      const tab = mockTab(`tab-${++tabCount}`)
      const cwd = options?.cwd
      if (!cwd) return tab
      // A tab opened in a folder is a new Thread there, as the host opens it: nothing said yet.
      return {
        ...tab,
        session: { meta: { ...meta, cwd, sessionName: undefined }, messages: [], tree: [] },
        git: { ...GIT, cwd, root: cwd },
      }
    },
    closeTab: async (id: string) => ({ tabs: [id], activeId: "tab-1" }),
    activateTab: async () => true,
    fork: async () => ({
      cancelled: false as const,
      text: "",
      tab: mockTab(`tab-${++tabCount}`),
    }),
    listSessions: async () => sessions(),
    openSession: async () => ({ meta, messages: MESSAGES, tree: TREE }),
    newSession: async () => ({ meta, messages: [], tree: [] }),
    setCwd: async (cwd: string) => {
      meta = { ...meta, cwd }
      return { ...mockTab("tab-1"), git: { ...GIT, cwd, root: cwd } }
    },
    setName: async (name: string) => update({ sessionName: name }),
    prompt: async () => {
      update({ isStreaming: true, isIdle: false })
      emit({
        type: "stream",
        message: {
          id: "draft",
          role: "assistant",
          streaming: true,
          blocks: [],
        },
      })
      setTimeout(() => {
        emit({
          type: "stream",
          message: {
            id: "draft",
            role: "assistant",
            streaming: true,
            blocks: [{ type: "text", text: "Working on it…" }],
          },
        })
      }, 400)
      setTimeout(() => {
        emit({ type: "stream", message: null })
        update({ isStreaming: false, isIdle: true })
      }, 2400)
    },
    abort: async () => update({ isStreaming: false, isIdle: true }),
    clearQueue: async () => update({ queued: { steering: [], followUp: [] } }),
    navigateTree: async () => ({ meta, messages: MESSAGES, tree: TREE }),
    compact: async () => update({ isCompacting: false }),
    setAutoCompaction: async (enabled: boolean) =>
      update({ autoCompaction: enabled }),
    listModels: async () => MODELS,
    setModel: async (provider: string, id: string) => {
      const model = MODELS.find(
        (entry) => entry.provider === provider && entry.id === id
      )
      if (model) update({ model, thinkingLevels: model.thinkingLevels })
    },
    setThinking: async (level) => update({ thinkingLevel: level }),
    capabilities: async () => capabilities,
    setActiveTools: async () => {},
    runCommand: async () => {},
    search: async (query: string) => ({
      query,
      files: [
        {
          path: "src/state/session.ts",
          lines: [{ line: 1, text: `// ${query}` }],
          more: 0,
        },
      ],
      threads: [],
      total: 1,
      truncated: false,
      elapsed: 3,
    }),
    watchFile: async () => {},
    stageFilePath: async (sourcePath: string) => ({
      path: sourcePath,
      name: sourcePath.split("/").pop() ?? "f",
      size: 1,
    }),
    pathForFile: () => null,
    resolveFileUrl: (url) => url,
    unwatchFile: async () => {},
    createWorkspaceText: async (cwd: string, path: string) => `${cwd}/${path}`,
    readFile: async (path: string) => {
      const media = STAGED_MEDIA.get(path)
      if (media) return { path, contents: "", size: media.length, binary: true, truncated: false, media: "image" as const, mimeType: media.slice(5, media.indexOf(";")), previewUrl: media }
      const staged = STAGED_TEXT.get(path)
      if (staged !== undefined) return { path, contents: staged, size: staged.length, binary: false, truncated: false }
      return {
        path,
        contents: `// ${path}\n// The browser mock has no filesystem; this stands in for one.\n`,
        size: 96,
        binary: false,
        truncated: false,
      }
    },
    readThreadFile: async (_threadPath: string, path: string) => ({
      path,
      contents: `// ${path}\n// The browser mock has no filesystem; this stands in for one.\n`,
      size: 96,
      binary: false,
      truncated: false,
    }),
    listFiles: async () =>
      [
        "src/components/composer/composer.tsx",
        "src/components/rail/session-rail.tsx",
        "src/components/transcript/turn.tsx",
        "src/state/store.ts",
        "src/state/session.ts",
        "src/index.css",
        "electron/host.ts",
        "electron/shared.ts",
        "package.json",
        "README.md",
      ].map((path) => ({
        path,
        changed: GIT.files.some((file) => file.path === path),
      })),

    gitStage: async () => {},
    gitUnstage: async () => {},
    gitStageAll: async () => {},
    gitUnstageAll: async () => {},
    gitDiscard: async () => ({ stash: "0".repeat(40) }),
    gitRestoreDiscarded: async () => {},
    gitChangedSince: async () => ({ base: "b".repeat(40), files: GIT.files }),
    liveTurnChanges: async () => ({ root: GIT.root ?? "", files: GIT.files.slice(0, 2).map((file) => ({ ...file, staged: false })) }),
    liveTurnDiff: async (_id: string, _requestId: string, path: string) => ({ path, binary: false, oldFile: { name: path, contents: "const turn = 1\n" }, newFile: { name: path, contents: "const turn = 2\n" } }),
    liveTurnHunks: async (_id: string, _requestId: string, path: string) => ({ kind: "text" as const, path, hunks: [{ oldStart: 1, newStart: 1, kinds: "-+", lines: ["const turn = 1", "const turn = 2"] }], oldLines: 1, newLines: 1, limited: false, body: "journal" as const }),
    liveTurnWriters: async () => null,
    liveTurnUndoPreview: async (_id: string, scope: TurnUndoScope) => ({ scope, checkout: GIT.root ?? "", undo: [], kept: [], left: [], token: "mock" }),
    liveTurnUndo: async () => ({ files: 0, backup: "", left: [] }),
    gitDefaultBranch: async () => "main",
    gitSinceDiff: async (_base: string, path: string) => ({ path, binary: false, oldFile: { name: path, contents: "const base = 1\n" }, newFile: { name: path, contents: "const base = 2\n" } }),
    gitCommit: async () => {},
    gitPush: async () => {},
    gitCommitFiles: async () => [
      {
        path: "src/state/store.ts",
        status: "modified" as const,
        insertions: 41,
        deletions: 3,
        binary: false,
      },
      {
        path: "src/components/rail/session-rail.tsx",
        status: "modified" as const,
        insertions: 12,
        deletions: 9,
        binary: false,
      },
    ],
    gitCommitDiffAll: async () => ({
      diffs: [
        {
          path: "src/state/store.ts",
          binary: false,
          oldFile: {
            name: "src/state/store.ts",
            contents: "const before = 1\n",
          },
          newFile: {
            name: "src/state/store.ts",
            contents: "const after = 2\n",
          },
        },
        {
          path: "src/components/rail/session-rail.tsx",
          binary: false,
          oldFile: {
            name: "src/components/rail/session-rail.tsx",
            contents: "old\n",
          },
          newFile: {
            name: "src/components/rail/session-rail.tsx",
            contents: "new\n",
          },
        },
      ],
      truncated: 0,
    }),
    gitCommitFileDiff: async (_hash: string, path: string) => ({
      path,
      binary: false,
      oldFile: { name: path, contents: "const before = 1\n" },
      newFile: { name: path, contents: "const after = 2\n" },
    }),
    gitLog: async () => [
      {
        hash: "a1",
        shortHash: "a1b2c3d",
        subject: "Reconcile message identity across host updates",
        author: "You",
        date: new Date(Date.now() - 3_600_000).toISOString(),
        files: 3,
        insertions: 88,
        deletions: 12,
      },
      {
        hash: "b2",
        shortHash: "e4f5a6b",
        subject: "Group the transcript by exchange",
        author: "You",
        date: new Date(Date.now() - 9_000_000).toISOString(),
        files: 6,
        insertions: 240,
        deletions: 190,
      },
      {
        hash: "c3",
        shortHash: "c7d8e9f",
        subject: "Drop the brand hue for an achromatic ramp",
        author: "You",
        date: new Date(Date.now() - 86_400_000).toISOString(),
        files: 2,
        insertions: 41,
        deletions: 33,
      },
    ],
    generateCommitMessage: async () => ({
      message: "Reserve a gutter for the turn navigator",
      model: "agent:claude/claude-haiku-4-5",
      modelLabel: "Haiku 4.5 · Claude Code",
      scope: "staged",
      files: 2,
      warnings: [],
      requests: 1,
    }),
    cancelCommitGeneration: async () => {},
    chooseUtilityModel: async (task: UtilityTask, choice: string) => {
      utilityChoices[task] = choice
    },
    saveHarnessOrder: async (order: string[]) => {
      mockHarnessOrder = [...order]
    },
    savedHarnessOrder: async () => [...mockHarnessOrder],
    utilityModelSettings: async () => ({
      providers: MOCK_PROVIDERS,
      connections: [...mockConnections],
      issues: [],
      secureStorage: true,
      work: mockUtilityWork(),
    }),
    utilityModelCatalog: async (input) => ({
      source: input.source,
      models: [
        {
          id: "gemini-3.8-flash",
          name: "Gemini 3.8 Flash",
          contextTokens: 1_048_576,
        },
      ],
      fetchedAt: Date.now(),
      stale: false,
    }),
    connectUtilityModel: async (input) => {
      const connection: UtilityConnection = { provider: input.provider, model: input.model, name: input.name, baseUrl: input.baseUrl, contextTokens: input.contextTokens }
      mockConnections = [...mockConnections.filter((entry) => entry.provider !== input.provider), connection]
        .sort((a, b) => MOCK_PROVIDERS.findIndex(({ id }) => id === a.provider) - MOCK_PROVIDERS.findIndex(({ id }) => id === b.provider))
      return connection
    },
    disconnectUtilityModel: async (provider) => {
      mockConnections = mockConnections.filter((entry) => entry.provider !== provider)
      if (utilityChoices.commit.startsWith(`${provider}/`)) utilityChoices.commit = "auto"
    },

    stageFile: async (name: string, data: string) => {
      const path = `/tmp/mako-attachments/${name}`
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
      // A staged picture reads back as one, so a sent capture's chip can show it.
      const image = /\.(png|jpe?g)$/i.exec(name)
      if (image) STAGED_MEDIA.set(path, `data:image/${image[1]!.toLowerCase() === "png" ? "png" : "jpeg"};base64,${data}`)
      else STAGED_TEXT.set(path, new TextDecoder().decode(bytes))
      return { path, name, size: bytes.length }
    },
    defaultCommitPrompt: async () =>
      "You are an expert at writing Git commits.",
    computerDriver: async () => ({
      executable: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
      version: "0.28.0",
      verified: "0.28.0",
      outdated: false,
      detail: "CUA Driver 0.28.0",
    }),
    updateComputerDriver: async () => ({
      executable: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
      version: "0.28.0",
      verified: "0.28.0",
      outdated: false,
      detail: "CUA Driver 0.28.0",
    }),
    computerPermissions: async () => ({
      supported: true,
      persistentAcrossUpdates: true,
      accessibility: true,
      screenRecording: "granted" as const,
    }),
    requestComputerPermissions: async () => ({
      supported: true,
      persistentAcrossUpdates: true,
      accessibility: true,
      screenRecording: "granted" as const,
    }),
    nativeWindowVideo: false,
    controlPreviewSource: async () => null,
    ...mockAppshots,
    controlPreview: async () => null,
    controlVideo: async () => encodeControlVideoBatch({ live: false, packets: [] }),
    // Element picks: a fixture's tabs, and a pick the "person" finishes 1.5 s
    // after it starts (a cancel before then ends it), so the whole loop,
    // chips included, can be seen without a browser.
    elementPickTargets: async () => ({
      browsers: [
        { id: "chrome", name: "Chrome", kind: "browser" as const, status: "connected" as const },
        { id: "arc", name: "Arc", kind: "browser" as const, status: "setup-required" as const },
      ],
      tabs: [
        { browser: "chrome", tab: "t1", title: "Pricing · Fixture app", url: "http://rail-re-render-audit.thread.localhost:20140/pricing", inUse: false },
        { browser: "chrome", tab: "t2", title: "Checkout", url: "https://shop.example.com/checkout", inUse: true },
        { browser: "chrome", tab: "t3", title: "Design tokens – Docs", url: "https://docs.example.com/tokens", inUse: false },
      ],
    }),
    startElementPick: async (request: { id: string }) => {
      pickStarted.set(request.id, Date.now())
      return { status: "picking" as const, title: "Pricing · Fixture app", url: "http://rail-re-render-audit.thread.localhost:20140/pricing" }
    },
    waitElementPick: async (id: string, waitMs: number) => {
      const left = (pickStarted.get(id) ?? 0) + 1_500 - Date.now()
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(left, waitMs))))
      if (!pickStarted.has(id)) return { status: "cancelled" as const, by: "mako" as const, reason: "Cancelled in Mako." }
      if (left > waitMs) return { status: "picking" as const, title: "Pricing · Fixture app", url: "http://rail-re-render-audit.thread.localhost:20140/pricing" }
      return { status: "picked" as const, pick: mockPick() }
    },
    cancelElementPick: async (id: string) => {
      pickStarted.delete(id)
      return { status: "cancelled" as const, by: "mako" as const, reason: "Cancelled in Mako." }
    },
    surfaceWindow: async () => {},
    prepareBrowserExtension: async () => ({
      directory: "/fixture/mako-browser",
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    browserControlStatus: async () => [
      {
        id: "chrome",
        name: "Google Chrome",
        connection: { status: "disconnected" as const },
      },
    ],
    preferBrowser: async (browser) => [{ id: "chrome", name: "Google Chrome", preferred: browser === "chrome", connection: { status: "disconnected" as const } }],
    connectBrowser: async () => [
      {
        id: "chrome",
        name: "Google Chrome",
        connection: { status: "connected" as const, generation: "fixture" },
      },
    ],
    disconnectBrowser: async () => [
      {
        id: "chrome",
        name: "Google Chrome",
        connection: { status: "disconnected" as const },
      },
    ],
    integrations: async () => INTEGRATIONS,
    discoverMcp: async () => MCP,
    ...mockAuthoring(),
    previewMcpSync: async (serverId, target) => ({
      serverId,
      target,
      action: "add" as const,
      summary: `Add server to ${target.provider}`,
    }),
    applyMcpSync: async () => MCP,
    discoverSkills: async () => SKILLS,
    resolveSkillReferences: async (names, harness) =>
      names.map((name) => {
        const skill = SKILLS.skills.find((entry) => entry.name === name)
        const delivery = skillDeliveryFor(SKILLS.skills, SKILLS.providers, name, harness)
        return delivery.kind === "handover"
          ? { name, delivery, description: skill?.description, hash: skill?.hash, body: `# ${name}\n\nFixture instructions for ${name}.` }
          : { name, delivery, description: skill?.description, hash: skill?.hash }
      }),
    previewSkillSync: async (skillId, target) => ({
      skillId,
      target,
      action: "add" as const,
      summary: `Add skill to ${target.provider}`,
    }),
    previewSkillRemove: async (skillId, target) => ({
      skillId,
      target,
      action: "remove" as const,
      summary: `Remove skill from ${target.provider}`,
    }),
    applySkillSync: async () => SKILLS,

    selectGitRepository: async () => GIT,
    gitRemote: async () => ({ status: { cwd: META.cwd, ahead: 0, behind: 0, files: [] } }),
    gitStatus: async () => gitStatus(),
    gitDiff: async (path: string) => ({
      path,
      binary: false,
      oldFile: {
        name: path,
        contents: "const sessions = useSession((state) => state)\n",
      },
      newFile: {
        name: path,
        contents: "const sessions = useSession((state) => state.sessions)\n",
      },
    }),
    gitDiffAll: async () => ({
      diffs: [
        {
          path: "src/state/session.ts",
          binary: false,
          oldFile: {
            name: "src/state/session.ts",
            contents: "const sessions = useSession((state) => state)\n",
          },
          newFile: {
            name: "src/state/session.ts",
            contents:
              "const sessions = useSession((state) => state.sessions)\n",
          },
        },
      ],
      truncated: 0,
    }),
    listPlugins: async () => {
      const plugins = [
        {
          id: "thread-counter",
          source:
            "export function setup(){ mako.registerSlot('rail.footer', () => React.createElement('div', { style: { padding: '6px 10px', fontSize: 10.5, opacity: 0.5 } }, 'plugin: ' + mako.threads.read().threads.length + ' threads')) }",
        },
      ]
      // A recorded scene leaves out the demo's failing plugin and its notice.
      if (!setupScene)
        plugins.push({ id: "broken-example", source: "export function setup(){ throw new Error('deliberate failure for the demo') }" })
      return plugins
    },
    pluginsDir: async () => "/tmp/mako/plugins",
    writePlugin: async () => {},
    deletePlugin: async () => {},
    revealPlugins: async () => {},
    // `?github=off` is a desk whose gh CLI isn't signed in, and `?github=other` one signed in as someone else.
    githubStatus: async () => {
      const github = new URLSearchParams(globalThis.location?.search).get("github")
      if (github === "off") return { installed: true, authenticated: false }
      const user = github === "other" ? { login: "ada-work", userId: "9100224" } : { login: "you", userId: MOCK_GITHUB_USER_ID }
      return { installed: true, authenticated: true, ...user, repo: "you/mako", defaultBranch: "main" }
    },
    pullRequest: async () => sinceOpen,
    pullRequests: async () => [],
    // `?github=off` makes the window say why first; this answers only a signed-in desk.
    pullRequestSearch: async (request) => ({
      status: "ready",
      repository: "you/mako",
      pulls: matchPullRequests(MOCK_PULLS, request.query).slice(0, pullSearchLimit(request.limit)),
    }),
    pullBranches: async () => ["main", "release"],
    createPull: async (options) => {
      if (!sinceWorktree) return null
      await new Promise((resolve) => setTimeout(resolve, 600))
      sinceOpen = { ...sincePull(815), title: options.title, draft: Boolean(options.draft), reviewDecision: "none", checks: [{ name: "test", state: "passed" }] }
      return sinceOpen
    },
    mergePull: async () => {
      if (!sinceOpen) return null
      await new Promise((resolve) => setTimeout(resolve, 600))
      sinceOpen = { ...sinceOpen, state: "merged" }
      sinceLanded = true
      return sinceOpen
    },
    rerunChecks: async () => 0,
    repoAvatar: async () => undefined,
    // A GitHub-style identicon, so screenshots of the identity show a picture as GitHub would draw one.
    userAvatar: async () =>
      new URLSearchParams(globalThis.location?.search).get("github") === "off" ? undefined : MOCK_GITHUB_AVATAR,
    openUrl: async () => {},
    threads: async () => {
      const fixture = mockThreads()
      const threads = scene === "rail" ? fixture.threads.map(railRef) : [...keptThreads(), ...(scene === "busy" ? busyRefs() : []), ...fixture.threads]
      if (scene === "rail" && !railRunsSent) {
        railRunsSent = true
        setTimeout(() => {
          for (const run of RAIL_RUNS) emit({ type: "thread-run", run })
        }, 1_500)
      }
      return { ...fixture, threads, activity: {} }
    },
    openThread: async (path: string) => ({
      ref:
        [...keptThreads(), ...mockThreads().threads.map((ref) => (scene === "rail" ? railRef(ref) : ref))].find((ref) => ref.path === path) ??
        (path.includes("devin")
          ? {
              harness: "devin" as const,
              nativeId: "dv-1",
              path,
              cwd: "/Users/you/api",
              title: "Wire the payments retry queue",
              model: "adaptive",
              updatedAt: new Date().toISOString(),
              locked: true,
            }
          : path.includes("claude-2")
            ? {
                harness: "claude" as const,
                nativeId: "cl-2",
                path,
                cwd: "/Users/you/api",
                title: "Ship the billing webhooks",
                model: "claude-opus-5",
                updatedAt: new Date().toISOString(),
                lineage: [
                  {
                    harness: "devin" as const,
                    title: "Ship the billing webhooks",
                  },
                ],
              }
            : {
                harness: "codex" as const,
                nativeId: "cx-1",
                path,
                cwd: "/Users/you/api",
                title: "Trace the flaky webhook retry",
                model: "gpt-5.2-codex",
                updatedAt: new Date().toISOString(),
              }),
      entries: [
        { type: "user", id: "u1", text: "The webhook retry is flaky under load — trace it." },
        { type: "thinking", id: "a1:0", text: "Look at the queue consumer first." },
        { type: "tool", id: "a1:1", name: "shell", status: "completed", input: "rg 'retry' src/queue", output: "src/queue/consumer.ts:42" },
        { type: "tool", id: "a1:2", name: "read", status: "completed", input: "src/queue/consumer.ts", output: "const retry = attempt + 1" },
        { type: "tool", id: "a1:3", name: "edit", status: "completed", input: "src/queue/consumer.ts", output: "updated retry cap" },
        { type: "text", id: "a1:4", text: "The retry drops the idempotency key on the second attempt. Fixing." },
        { type: "user", id: "u2", text: "Does the dead-letter queue see these?" },
        { type: "text", id: "a2:0", text: "No — they retry forever. Adding a cap of 5 with backoff." },
        { type: "user", id: "u3", text: "Ship it with a regression test please." },
        { type: "tool", id: "a3:0", name: "shell", status: "completed", input: "npm test -- retry", output: "12 passing" },
        { type: "text", id: "a3:1", text: "Capped retries with jittered backoff, test locks the idempotency key." },
      ],
    }),
    pageThread: async (path: string, before?: number, limit = 100) => {
      const bridge = window.mako
      if (!bridge) return null
      const thread = await bridge.openThread(path)
      if (!thread) return null
      const total = thread.entries.length
      const end = Math.min(total, before ?? total)
      const size = Math.min(200, Math.max(1, limit))
      const start = Math.max(0, end - size)
      return {
        ref: thread.ref,
        entries: thread.entries.slice(start, end),
        start,
        total,
        hasEarlier: start > 0,
      }
    },
    previewThread: async () => null,
    transcriptDocument: async (source, depth) => {
      const thread = source.kind === "file" ? await window.mako?.openThread(source.path) : null
      if (!thread) throw new Error("The mock desk has no running session to read")
      // The builder writes files and hashes with Node, so the mock desk shows a stand-in for its copy.
      return { title: thread.ref.title, harness: thread.ref.harness, markdown: `# ${thread.ref.title ?? "Untitled session"}\n\nThe mock desk's ${depth} copy of ${thread.entries.length} entries; a real host builds it with \`buildTranscript\`.\n` }
    },
    threadEntry: async (path: string, id: string) => {
      const thread = await window.mako?.openThread(path)
      return thread?.entries.find((entry) => entry.id === id) ?? null
    },
    // The fixture has no native files: an entry's original is the entry
    // itself, written as a JSONL line at the place its record names.
    threadOriginal: async (path: string, id: string) => {
      if (path.startsWith("/mock/unread/")) {
        const from = Number(id.slice(1))
        const text = unreadSample(path, from)
        return { kept: false, parts: [{ kind: "range" as const, file: path, from, to: from + new TextEncoder().encode(text).length, text }] }
      }
      const thread = await window.mako?.openThread(path)
      const entry = thread?.entries.find((each) => each.id === id)
      if (!entry) return null
      const text = `${JSON.stringify(entry.type === "unread" && entry.raw !== undefined ? entry.raw : entry)}\n`
      const file = entry.record?.file ?? path.split("#")[0]!
      const rows = entry.record?.rows
      if (rows?.length)
        return { kept: false, parts: rows.map((row) => ({ kind: "row" as const, file, table: row.table, key: row.key, columns: { value: { type: "text" as const, text } } })) }
      const from = entry.record?.ranges?.[0]?.[0] ?? 0
      return { kept: false, parts: [{ kind: "range" as const, file, from, to: from + new TextEncoder().encode(text).length, text }] }
    },
    threadContexts: mockThreadContexts,
    ...mockCloudAccount(emit),
    ...mockCarriedFiles(),
    ...mockGitHubToken(),
    providerConnections: async () => [],
    providerConnectionAction: async () => {
      throw new Error("Fixture providers keep no sign-in")
    },
    ...(() => {
      // The fixture keeps its logins in memory, so switching, removing,
      // adding and signing in again can be tried without a host. Each
      // provider asks for what its real sign-in does: Claude takes a code
      // when the browser can't hand back, Grok the address the browser
      // ended on, Devin always a code, and Cursor's page is opened by the
      // window. A sign-in "finishes" 20 seconds after it starts, or a moment
      // after something is pasted. The Devin account selected here no longer
      // exists, as when its folder was deleted outside Mako.
      const providers = [
        { provider: "claude", label: "Claude Code", mode: "selectable", loginCommand: "claude /login", nativeLogin: true },
        { provider: "codex", label: "Codex", mode: "selectable", loginCommand: "codex login", nativeLogin: true },
        { provider: "cursor", label: "Cursor", mode: "selectable", loginCommand: "cursor-agent login", nativeLogin: true },
        { provider: "grok", label: "Grok", mode: "selectable", loginCommand: "grok login", nativeLogin: true },
        { provider: "devin", label: "Devin", mode: "selectable", loginCommand: "devin auth login", nativeLogin: true },
        {
          provider: "opencode",
          label: "OpenCode",
          mode: "observed",
          loginCommand: "opencode auth login",
          readOnlyReason: "OpenCode keeps its logins inside the database that holds its sessions, so a second OpenCode login would split your OpenCode history.",
        },
      ] satisfies AccountProviderInfo[]
      const pasteKinds = new Map<string, NonNullable<AccountLogin["paste"]>>([["claude", "code"], ["grok", "address"], ["devin", "code"]])
      const pageUrls = new Map([
        ["claude", "https://claude.ai/oauth/authorize?code=true&client_id=fixture"],
        ["codex", "https://auth.openai.com/oauth/authorize?client_id=fixture"],
        ["cursor", "https://cursor.com/loginDeepControl?challenge=fixture"],
        ["grok", "https://auth.x.ai/oauth2/authorize?client_id=fixture"],
        ["devin", "https://app.devin.ai/auth/cli/continue?state=fixture"],
      ])
      let list: HarnessAccount[] = [
        { harness: "claude", name: "default", email: "personal@example.com", dir: "~/.claude", active: true, route: "native" },
        {
          harness: "claude",
          name: "account-work",
          email: "work@example.com",
          dir: "~/.mako/accounts/claude/account-work",
          active: false,
          source: "mako",
          route: "managed",
          signedOut: true,
        },
        {
          harness: "claude",
          name: "account-team",
          email: "team@example.com",
          dir: "~/.mako/accounts/claude/account-team",
          active: false,
          source: "mako",
          route: "managed",
        },
        { harness: "codex", name: "default", email: "codex@example.com", dir: "~/.codex", active: false, route: "native" },
        {
          harness: "codex",
          name: "personal",
          email: "personal@work.dev",
          dir: "~/.mako/accounts/codex/personal",
          active: true,
          source: "mako",
          route: "managed",
        },
        { harness: "cursor", name: "default", email: "developer@example.com", dir: "~/.cursor", active: true, source: "cli" },
        { harness: "grok", name: "default", email: "developer@example.com", dir: "~/.grok/auth.json", active: true, source: "cli" },
        {
          harness: "devin",
          name: "default",
          email: "developer@example.com",
          dir: "~/.local/share/devin/credentials.toml",
          active: false,
          source: "cli",
        },
        { harness: "devin", name: "account-old", dir: "", active: true, source: "mako", missing: true },
        {
          harness: "opencode",
          name: "openai",
          providerId: "openai",
          authType: "oauth",
          email: "developer@example.com",
          accountId: "account-example",
          dir: "~/.local/share/opencode/opencode.db",
          active: true,
          source: "model-provider",
        },
        {
          harness: "opencode",
          name: "google",
          providerId: "google",
          authType: "api",
          dir: "~/.local/share/opencode/opencode.db",
          active: true,
          source: "model-provider",
        },
      ]
      const logins = new Map<string, { login: AccountLogin; finish: (result: AccountLoginResult) => void; result: Promise<AccountLoginResult> }>()
      let added = 0
      const startLogin = async (harness: string, renew?: string): Promise<AccountLogin> => {
        await new Promise((resolve) => setTimeout(resolve, 700))
        const id = `fixture-login-${Date.now()}`
        const login: AccountLogin = {
          id,
          harness,
          url: pageUrls.get(harness) ?? "https://example.com/fixture-sign-in",
          // A real window would open these; the fixture leaves the browser alone.
          openPage: false,
        }
        const paste = pasteKinds.get(harness)
        if (paste) login.paste = paste
        if (harness === "devin") login.pasteOnly = true
        if (renew) login.renew = renew
        let resolve!: (result: AccountLoginResult) => void
        const result = new Promise<AccountLoginResult>((done) => { resolve = done })
        logins.set(id, { login, finish: resolve, result })
        setTimeout(() => finish(id), 20_000)
        void result.finally(() => logins.delete(id))
        return login
      }
      const finish = (id: string) => {
        const running = logins.get(id)
        if (!running) return
        const { harness, renew } = running.login
        if (renew) {
          list = list.map((account) => {
            if (account.harness !== harness || account.name !== renew) return account
            const signedIn = { ...account }
            delete signedIn.signedOut
            return signedIn
          })
          mockRenewed.add(`${harness}:${renew}`)
          mockSignedInAt.set(`${harness}:${renew}`, Date.now())
          const email = list.find((account) => account.harness === harness && account.name === renew)?.email
          running.finish(email === undefined ? { status: "renewed", name: renew } : { status: "renewed", name: renew, email })
          return
        }
        added += 1
        const email = `teammate${added > 1 ? added : ""}@example.com`
        const name = `account-fixture${added}`
        list = [...list, { harness, name, email, dir: `~/.mako/accounts/${harness}/${name}`, active: false, source: "mako", route: "managed" }]
        running.finish({ status: "added", name, email })
      }
      fixtureAccounts = () => list
      const sessionsOn = (harness: string, name: string) => [...liveSnapshots].flatMap(([id, snapshot]) => {
        const account = snapshot.session.executionContext?.account
        return snapshot.session.harness === harness && account?.kind === "configured" && account.name === name &&
          snapshot.session.status !== "closed" && snapshot.session.connection !== "disconnected"
          ? [{ id, snapshot }]
          : []
      })
      const removalWait = (snapshot: LiveSnapshot): AccountRemovalWait | undefined =>
        snapshot.session.backgroundTasks ? "background" : snapshot.permissions.length ? "approval" : snapshot.session.status === "running" ? "turn" : undefined
      const watchRemoval = (harness: string, name: string) => {
        const timer = setInterval(() => {
          const account = list.find((entry) => entry.harness === harness && entry.name === name)
          if (!account?.removing) return clearInterval(timer)
          if (sessionsOn(harness, name).some(({ snapshot }) => removalWait(snapshot))) return
          clearInterval(timer)
          list = list.filter((entry) => entry !== account)
          emit({ type: "account-removal", harness, name, event: { status: "removed" } })
        }, 500)
      }
      return {
        accounts: async () => ({ providers, accounts: list }),
        captureAccount: async () => {},
        selectAccount: async (harness: string, name: string | null) => {
          await new Promise((resolve) => setTimeout(resolve, 250))
          list = list
            .filter((account) => account.harness !== harness || !account.missing)
            .map((account) => account.harness === harness ? { ...account, active: account.name === (name ?? "default") } : account)
        },
        accountRemovalPlan: async (harness: string, name: string): Promise<AccountRemovalPlan> => ({
          sessions: sessionsOn(harness, name).map(({ id, snapshot }) => {
            const entry: AccountRemovalSession = { conversation: id, title: snapshot.session.title || "Untitled conversation" }
            const waitingFor = removalWait(snapshot)
            if (waitingFor) entry.waitingFor = waitingFor
            return entry
          }),
          runs: 0,
          elsewhere: false,
        }),
        // As the host does: idle sessions let go at once, busy ones keep the
        // account until their work ends, and the last one finishes the removal.
        removeAccount: async (harness: string, name: string): Promise<AccountRemovalOutcome> => {
          if (sessionsOn(harness, name).some(({ snapshot }) => removalWait(snapshot))) {
            list = list.map((account) => account.harness === harness && account.name === name ? { ...account, removing: true } : account)
            watchRemoval(harness, name)
            return { status: "pending" }
          }
          list = list.filter((account) => account.harness !== harness || account.name !== name)
          return { status: "removed" }
        },
        keepAccount: async (harness: string, name: string) => {
          const pending = list.some((account) => account.harness === harness && account.name === name && account.removing)
          if (pending) list = list.map((account) => {
            if (account.harness !== harness || account.name !== name) return account
            const kept = { ...account }
            delete kept.removing
            return kept
          })
          return pending
        },
        startAccountLogin: (harness: string, renew?: string) => startLogin(harness, renew),
        waitAccountLogin: async (id: string) => {
          const running = logins.get(id)
          if (!running) throw new Error("This sign-in already ended.")
          return running.result
        },
        submitAccountLoginCode: async (id: string) => {
          await new Promise((resolve) => setTimeout(resolve, 600))
          finish(id)
        },
        cancelAccountLogin: async (id: string) => {
          logins.get(id)?.finish({ status: "cancelled" })
        },
      }
    })(),
    ...(() => {
    // Devin's daily window resets shortly after load, and a spent reset
    // empties the personal Codex account, so both are visible here.
    const loadedAt = Date.now()
    let personalReset = false
    return {
    useResetCredit: async (harness: string, name: string): Promise<ResetCreditOutcome> => {
      await new Promise((resolve) => setTimeout(resolve, 600))
      if (harness !== "codex" || name !== "personal") return "no-credit"
      personalReset = true
      return "reset"
    },
    accountUsage: async (harness: string, name: string): Promise<AccountUsage> => {
      // Each provider answers at its own pace; Grok starts a process to ask.
      await new Promise((resolve) => setTimeout(resolve, harness === "grok" ? 1_400 : 350))
      const hour = 3_600_000
      const day = 24 * hour
      const now = Date.now()
      const devinReset = loadedAt + 25_000
      const fixtures = new Map(Object.entries({
        "claude:default": {
          status: "ok",
          plan: "max",
          windows: [
            { usedPercent: 42, windowMinutes: 300, resetsAt: now + 2 * hour + 13 * 60_000 },
            { usedPercent: 18, windowMinutes: 10_080, resetsAt: now + 3 * day },
            { usedPercent: 81, windowMinutes: 10_080, resetsAt: now + 3 * day, scope: "Opus" },
          ],
          balances: [{ label: "Extra usage", remaining: 37.6, total: 50, unit: "usd" }],
        },
        "claude:account-work": mockRenewed.has("claude:account-work")
          ? {
              status: "ok",
              plan: "team",
              windows: [
                { usedPercent: 6, windowMinutes: 300, resetsAt: now + 4 * hour },
                { usedPercent: 31, windowMinutes: 10_080, resetsAt: now + 5 * day },
              ],
            }
          : { status: "missing-credentials" },
        "codex:default": {
          status: "ok",
          plan: "pro",
          windows: [{ usedPercent: 23, windowMinutes: 10_080, resetsAt: now + 4 * day }],
          balances: [{ label: "Credits", remaining: 62_494, unit: "credits" }],
        },
        "codex:personal": personalReset
          ? {
              status: "ok",
              plan: "plus",
              windows: [
                { usedPercent: 0, windowMinutes: 300, resetsAt: now + 5 * hour },
                { usedPercent: 0, windowMinutes: 10_080, resetsAt: now + 7 * day },
              ],
              resetCredits: { available: 1, expiresAt: loadedAt + 22 * day },
            }
          : {
              status: "ok",
              plan: "plus",
              windows: [
                { usedPercent: 34, windowMinutes: 300, resetsAt: loadedAt + 48 * 60_000 },
                { usedPercent: 92, windowMinutes: 10_080, resetsAt: loadedAt + 1.5 * day },
              ],
              resetCredits: { available: 2, expiresAt: loadedAt + 22 * day },
            },
        "cursor:default": {
          status: "ok",
          plan: "Team",
          windows: [{ usedPercent: 37, windowMinutes: 43_200, resetsAt: now + 25 * day }],
          balances: [
            { label: "On-demand", remaining: 20, total: 20, unit: "usd" },
            { label: "Promotional credit", remaining: 3_730.31, total: 5_000, unit: "usd" },
          ],
        },
        "grok:default": {
          status: "ok",
          plan: "X Premium+",
          windows: [{ usedPercent: 2, windowMinutes: 10_080, resetsAt: now + 2 * day }],
        },
        "devin:default": {
          status: "ok",
          plan: "Teams",
          windows: [
            now < devinReset
              ? { usedPercent: 97, windowMinutes: 1_440, resetsAt: devinReset }
              : { usedPercent: 0, windowMinutes: 1_440, resetsAt: devinReset + day },
            { usedPercent: 18, windowMinutes: 10_080, resetsAt: loadedAt + 3 * day },
          ],
          balances: [{ label: "Extra usage", remaining: 39.5, unit: "usd" }],
        },
        "opencode:openai": {
          status: "ok",
          plan: "plus",
          windows: [
            { usedPercent: 28, windowMinutes: 300, resetsAt: now + 40 * 60_000 },
            { usedPercent: 61, windowMinutes: 10_080, resetsAt: now + 3 * day },
          ],
        },
        "opencode:google": { status: "unavailable", detail: "API keys have no plan limits" },
      } satisfies Record<string, AccountUsage>))
      return fixtures.get(`${harness}:${name}`) ?? { status: "unavailable" }
    },
    }
    })(),
    harnessProfiles: async () => profiles(),
    harnessAvailability: async () => ({
      codex: true,
      claude: true,
      cursor: true,
      grok: true,
      devin: true,
      opencode: true,
    }),
    // One harness at each version standing: Codex below its oldest, OpenCode
    // between oldest and tested, Devin at tested and Grok newer than tested.
    harnessUpdates: async () => ({
      codex: outdatedScene || unknownWriterScene ? outdatedCodexReading() : {
        provider: "codex",
        binary: "/Users/you/.nvm/versions/node/v24.19.0/bin/codex",
        installed: "0.140.0",
        latest: "0.159.3",
        channel: "npm",
        update: {
          label: "Update with npm",
          command: "npm",
          args: ["install", "-g", "--allow-scripts=@openai/codex", "@openai/codex@0.159.3"],
        },
        checkedAt: Date.now() - 90_000,
        latestCheckedAt: Date.now() - 90_000,
        // A feature floor no harness declares today, so the review picker's unavailable line can be seen.
        versions: { oldest: "0.146.0", tested: "0.159.3", standing: "below-oldest", needs: { review: "0.155.0" } },
      },
      opencode: {
        provider: "opencode",
        label: "OpenCode 2",
        binary: "/Users/you/.nvm/versions/node/v24.19.0/bin/opencode",
        installed: "2.0.20",
        latest: "2.0.27",
        channel: "npm",
        update: {
          label: "Update with npm",
          command: "npm",
          args: ["install", "-g", "--allow-scripts=@opencode/cli", "@opencode/cli@2.0.27"],
        },
        checkedAt: Date.now() - 90_000,
        latestCheckedAt: Date.now() - 90_000,
        versions: { oldest: "2.0.0", tested: "2.0.27", standing: "supported" },
      },
      grok: {
        provider: "grok",
        binary: "/Users/you/.grok/bin/grok",
        installed: "1.0.52",
        latest: "1.0.46",
        channel: "self",
        checkedAt: Date.now() - 90_000,
        latestCheckedAt: Date.now() - 90_000,
        versions: { tested: "1.0.46", standing: "newer" },
      },
      claude: {
        binary: "/Users/you/.local/bin/claude",
        installed: "2.1.266",
        latest: "2.1.266",
        channel: "self",
        update: { label: "Update Claude Code", command: "/Users/you/.local/bin/claude", args: ["update"] },
        checkedAt: Date.now() - 90_000,
        latestCheckedAt: Date.now() - 90_000,
      },
      cursor: {
        binary: "/Users/you/.local/bin/cursor-agent",
        installed: "2026.09.10-fd3934a",
        channel: "self",
        update: { label: "Update Cursor Agent", command: "/Users/you/.local/bin/cursor-agent", args: ["update"] },
        checkedAt: Date.now() - 90_000,
      },
      devin: {
        provider: "devin",
        binary: "/Library/Application Support/Zed/external_agents/registry/devin/bin/devin",
        installed: "3000.10.23",
        channel: "managed",
        managedBy: "Zed",
        checkedAt: Date.now() - 90_000,
        versions: { tested: "3000.10.23", standing: "tested" },
      },
    }),
    // An update goes to the tested version, so the reading comes back at it.
    runHarnessUpdate: async (provider: string) => {
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      const cloud = mockHarnessScene ? MOCK_CLOUD_HARNESSES.get(provider) : undefined
      if (cloud) {
        const from = mockHarnessesHere.get(provider)
        const reading = { provider, binary: `/Users/you/.nvm/versions/node/v24.19.0/bin/${provider}`, channel: "npm" as const, checkedAt: Date.now() }
        if (mockHarnessScene === "failing")
          return { ...reading, installed: from, result: { at: Date.now() - 1_200, outcome: "failed" as const, from, message: "npm error code EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@openai'" } }
        // The updater finished, but the binary Mako runs didn't move: the host names where the update went and what Mako runs.
        if (mockHarnessScene === "elsewhere")
          return { ...reading, installed: from, result: { at: Date.now() - 1_200, outcome: "failed" as const, from, message: `npm installed Codex ${cloud} into /opt/homebrew, but Mako runs ${reading.binary}, still ${from}.` } }
        mockHarnessesHere.set(provider, cloud)
        return { ...reading, installed: cloud, result: { at: Date.now() - 1_200, outcome: "updated" as const, from, to: cloud }, versions: { tested: cloud, standing: "tested" as const } }
      }
      if (outdatedScene && provider === "codex") {
        const from = keptCodexInstalled
        keptCodexInstalled = "0.163.0"
        return { ...outdatedCodexReading(), result: { at: Date.now() - 1_200, outcome: "updated" as const, from, to: keptCodexInstalled } }
      }
      return {
        provider,
        binary: `/Users/you/.nvm/versions/node/v24.19.0/bin/${provider}`,
        installed: "0.159.3",
        latest: "0.159.3",
        channel: "npm",
        checkedAt: Date.now(),
        latestCheckedAt: Date.now(),
        result: { at: Date.now() - 1_200, outcome: "updated", from: "0.140.0", to: "0.159.3" },
        versions: { oldest: "0.146.0", tested: "0.159.3", standing: "tested" },
      }
    },
    runHarnessInstall: async (provider: string) => ({
      binary: `/Users/you/.local/bin/${provider}`,
      installed: "1.0.0",
      channel: "self",
      checkedAt: Date.now(),
      result: { at: Date.now(), outcome: "installed", to: "1.0.0" },
    }),
    daemonStatus: async () => ({
      pid: 4242,
      startedAt: Date.now() - 7_200_000,
      sessions: 414,
    }),
    daemonLogin: async () => false,
    setDaemonLogin: async () => {},
    followThread: async () => {},
    unfollowThread: async () => {},
    threadChildren: async () => null,
    followChildThread: async () => {},
    unfollowChildThread: async () => {},
    harnessDescriptors: async () => fixtureHarnesses.map((entry) => ({ ...entry, ...MOCK_MODES.get(entry.provider) })),
    resolveContinuation: async (path: string) => {
      const snapshot = await window.mako!.liveAttach(path)
      if (snapshot) return { transport: "attached", provider: snapshot.session.harness, conversationId: snapshot.session.id, snapshot }
      const plan = await window.mako!.continuationPlan(path)
      return plan.transport === "attached" ? { transport: "unavailable", reason: "Mock owner unavailable" } : plan
    },
    resolveOwner: async (path: string) => {
      const snapshot = await window.mako!.liveAttach(path)
      return snapshot ? { transport: "attached", provider: snapshot.session.harness, conversationId: snapshot.session.id, snapshot } : null
    },
    restorePlan: async (path: string): Promise<RestorePlan> => {
      const ref = keptThreads().find((thread) => thread.path === path)
      if (!ref || ref.copyOnly) return { kind: "none" }
      if (importScene && ref.harness === "cursor") return { kind: "update", outdated: { harness: "cursor", upTo: "2026.10.15", installed: "2026.09.03", line: "cursor-agent", reader: "Mako's @cursor/sdk 1.0.31, published 2026.09.03", offer: { kind: "owner", owner: "Mako" } } }
      if (unknownWriterScene && ref.harness === "codex") return { kind: "update", outdated: { harness: "codex", installed: keptCodexInstalled, offer: { kind: "update", runtimeId: "codex", label: "Update with npm" } } }
      if (!outdatedScene || ref.harness !== "codex") return { kind: "native" }
      const gate = restoreGate({ record: ["0.163.0"], observed: [] }, keptCodexInstalled)
      return gate.kind === "older"
        ? { kind: "update", outdated: { harness: "codex", wrote: gate.wrote, installed: gate.installed, offer: { kind: "update", runtimeId: "codex", label: "Update with npm" } } }
        : { kind: "native" }
    },
    unreadRecords: async () => unreadReport(),
    storeFormats: async (): Promise<StoreFormats> => newerStoresScene && !storesLater ? newerStores : ownStores,
    streamOriginal: async (frame: RecordRef): Promise<EntryOriginal> => {
      const from = frame.ranges?.[0]?.[0] ?? 0
      const text = `${JSON.stringify({ at: "2026-10-17T09:31:02.481Z", message: { jsonrpc: "2.0", method: "_x.ai/session/checkpoint", params: { sessionId: "7f1e", checkpoint: { turn: 4, files: 2 } } } })}\n`
      return { kept: false, parts: [], stream: [{ kind: "range", file: `/Users/you/.mako/records/streams/${(frame.file ?? "").split(":")[1] ?? ""}`, from, to: from + new TextEncoder().encode(text).length, text }] }
    },
    continuationPlan: async (path: string) => {
      const thread = await window.mako?.openThread(path)
      if (!thread)
        return { transport: "refused", reason: "Missing mock native thread" }
      // `?app=newer-stores`: the session ledger is a newer Mako's, so the host's rule plans the transcript (`resumeLedger`).
      if (newerStoresScene && !storesLater)
        return resumeLedger(thread.ref, "A newer Mako (0.163.0) updated how Mako keeps track of sessions; this one can show this session but can't resume it.", { available: true, canResume: true })
      return planContinuation(thread.ref, {
        live: { available: true, canResume: true },
        nativeInstalled: true,
        running: false,
        external: null,
      })
    },
    rememberThreadMode: async (path: string, modeId: string) => {
      const thread = await window.mako?.openThread(path)
      return thread ? { ...thread.ref, accessMode: modeId } : null
    },
    liveStart: async (
      harness: string,
      cwd: string,
      options: LiveStartOptions
    ) => {
      if (slowStart) {
        // As a cloud Thread's start reads: its project coming up, then its harness starting.
        emit({ type: "cloud-start-step", conversationId: options.conversationId, step: "preparing", project: "mako" })
        await new Promise((resolve) => setTimeout(resolve, 20_000))
        emit({ type: "cloud-start-step", conversationId: options.conversationId, step: "starting", project: "mako" })
        await new Promise((resolve) => setTimeout(resolve, 6_000))
      }
      const session: LiveSessionState = {
        id: options.conversationId,
        nativeId: `mock-${harness}-${++acpCount}`,
        harness,
        title: options.title,
        cwd,
        status: "ready",
        connection: "connected",
        modes: MOCK_MODES.get(harness)?.modes ?? [],
        currentMode: options.modeId ?? MOCK_MODES.get(harness)?.defaultMode ?? null,
        configOptions: [],
        // The host reports the tuning it started with until the provider says otherwise.
        settings: options.tuning,
        executionContext: accountContext(harness),
      }
      acpSessions.set(session.id, session)
      const base = options.threadPath
        ? ((await window.mako?.pageThread(options.threadPath)) ?? null)
        : null
      if (setupScene && options.initialRequest?.text === ENVIRONMENT_SETUP_PROMPT) {
        const thread = ThreadIdSchema.parse(crypto.randomUUID())
        if (options.worktree) {
          setupWorktree = {
            path: `${SETUP_WORKTREE_ROOT}/mako-set-up`,
            thread,
            repoRoot: cwd,
            project: cwd,
            branch: "mako/set-up",
            base: "4f1c2e9",
            createdAt: Date.now(),
          }
        }
        if (options.purpose) {
          purposes.push({ thread, kind: options.purpose, project: cwd, createdAt: Date.now() })
          emit({ type: "thread-purposes", purposes: [...purposes] })
        }
        const working: LiveSessionState = { ...session, cwd: setupWorktree?.path ?? cwd, status: "running" }
        acpSessions.set(session.id, working)
        const snapshot: LiveSnapshot = {
          session: working,
          revision: 0,
          createdAt: Date.now(),
          threadId: thread,
          threadPath: options.threadPath,
          base,
          permissions: [],
          requests: [{ ...options.initialRequest, status: "dispatching" }],
          blocks: [{ type: "user", requestId: options.initialRequest.id, text: options.initialRequest.text }],
        }
        liveSnapshots.set(session.id, snapshot)
        beginSetup(session.id, options.title ?? "Set up", harness, working.cwd)
        return snapshot
      }
      const thread = ThreadIdSchema.parse(crypto.randomUUID())
      if (making && options.worktree && !options.resume && !options.session) {
        const made = await makeWorktree(options.conversationId, cwd, thread, options.title ?? options.initialRequest?.text, options.worktreeStart)
        if (made) session.cwd = made.path
      }
      const request: LiveRequest | undefined = options.initialRequest
        ? { ...options.initialRequest, status: "completed" }
        : undefined
      const reply = request ? mockReply(session, request, options.tuning) : null
      const snapshot: LiveSnapshot = {
        session: reply?.permission ? { ...session, status: "running" } : session,
        revision: 0,
        createdAt: Date.now(),
        // The host files every session under a Thread; the mock stamps one so a new tab can open beside it.
        threadId: thread,
        threadPath: options.threadPath,
        base,
        permissions: reply?.permission ? [reply.permission] : [],
        requests: request ? [request] : [],
        blocks: request && reply ? reduceLiveUpdates([], withHarness(session.harness, framed(session.id, session.harness, reply.updates))) : [],
      }
      acpSessions.set(session.id, snapshot.session)
      liveSnapshots.set(session.id, snapshot)
      return options.review ? startLiveReview(session.id, options.review) : presented(snapshot)
    },
    liveCapture: async (id: string, path: string) => {
      const existing = [...liveSnapshots.values()].find(
        (snapshot) => snapshot.threadPath === path
      )
      if (existing) return existing
      const base = await window.mako?.pageThread(path)
      if (!base) throw new Error("Missing mock source")
      const snapshot: LiveSnapshot = {
        session: {
          id,
          harness: base.ref.harness,
          cwd: base.ref.cwd ?? "",
          title: base.ref.title,
          status: "ready",
          connection: "disconnected",
          modes: [],
          currentMode: null,
          configOptions: [],
        },
        revision: 0,
        createdAt: Date.now(),
        base,
        threadPath: path,
        blocks: [],
        requests: [],
        permissions: [],
      }
      liveSnapshots.set(id, snapshot)
      return snapshot
    },
    nativeReceipt: async (id: string) =>
      nativeRequests.find((request) => request.input.id === id) ?? null,
    nativeDismiss: async (id: string) => {
      const request = nativeRequests.find((request) => request.input.id === id)
      if (request) request.status = "dismissed"
    },
    nativeEditQueued: async () => [],
    nativeRequests: async () => nativeRequests,
    nativeSubmit: async (input: NativeRequestInput) => {
      const thread = await window.mako?.openThread(input.path)
      if (!thread) throw new Error("Missing mock native thread")
      const request: NativeRequest = {
        input,
        ref: thread.ref,
        status: "completed",
      }
      nativeRequests.push(request)
      return request
    },
    liveMergeFork: async (id: string, mergeId: string) => {
      const source = liveSnapshots.get(id)
      const parent = source?.control?.ancestry
        ? liveSnapshots.get(source.control.ancestry.parentId)
        : undefined
      if (!parent) throw new Error("Missing mock parent")
      const control = parent.control ?? {
        merges: [],
        activeBindingId: parent.session.id,
        bindings: [],
        transfers: [],
      }
      const next: LiveSnapshot = {
        ...parent,
        revision: parent.revision + 1,
        control: {
          ...control,
          merges: [
            ...control.merges,
            {
              id: mergeId,
              sourceId: id,
              sourceRevision: source?.revision ?? 0,
              status: "pending",
              manifest: {
                file: "/mock/fork.md",
                digest: "fixture",
                sourceRevision: source?.revision ?? 0,
                fromBlock: 0,
                toBlock: source?.blocks.length ?? 0,
                includesBase: false,
                losses: [],
              },
            },
          ],
        },
      }
      liveSnapshots.set(parent.session.id, next)
      return next
    },
    liveAction: async () => {
      throw new Error("Provider controls require the real host")
    },
    liveAcknowledgeAction: async () => {
      throw new Error("Provider controls require the real host")
    },
    // `?app=rewind`: a turn another Thread and the person worked alongside, its files' writers from the journal.
    liveRewindPreview: async (id: string, requestId: string) => {
      const live = liveSnapshots.get(id)
      const request = live?.requests.find((item) => item.id === requestId)
      const after = request?.snapshots?.after
      if (!live || after?.kind !== "ready") throw new Error("Workspace rewind requires the real host")
      return mockRewindPreview(after.snapshot, live.threadId ?? "", (thread, title) => {
        titles.set(thread, { thread, title, source: "user" })
        emit({ type: "thread-titles", titles: [{ thread, title, source: "user" }] })
      })
    },
    liveRewind: async () => {
      throw new Error("Workspace rewind requires the real host")
    },
    liveRecoverRewinds: async () => [],
    liveFork: async (id: string, input: ForkInput) => {
      const parent = liveSnapshots.get(id)
      if (!parent) throw new Error("Missing mock source")
      const fork: LiveSnapshot = {
        ...parent,
        ...forkOpeningScene && { blocks: [], base: landRecord(id, parent).base, baseCoveredBlocks: undefined, baseLiveStart: undefined },
        session: {
          ...parent.session,
          id: input.id,
          title: input.move ? parent.session.title : "Fork",
          harness: input.provider,
          connection: "disconnected",
        },
        control: {
          merges: [],
          ancestry: {
            kind: "fork",
            parentId: id,
            sourceRevision: parent.revision,
            point: JSON.stringify(input.point),
          },
          activeBindingId: input.id,
          bindings: [],
          transfers: [],
        },
        revision: 0,
        threadPath: undefined,
        requests: [],
      }
      liveSnapshots.set(input.id, fork)
      return fork
    },
    liveTransfer: async (id: string, input: TransferInput) => {
      const snapshot = liveSnapshots.get(id)
      if (!snapshot) throw new Error("Missing mock session")
      const control = snapshot.control ?? {
        activeBindingId: id,
        bindings: [
          {
            id,
            provider: snapshot.session.harness,
            coveredBlocks: snapshot.blocks.length,
            includesBase: true,
          },
        ],
        transfers: [],
      }
      if (control.transfers.some((transfer) => transfer.input.id === input.id))
        return snapshot
      const bindingId = crypto.randomUUID()
      // The transcript the new session reads, as the host's builder writes one: what the transcript's "Continued from" line opens.
      const asked = snapshot.blocks.filter((block) => block.type === "user" && !block.steeringFor)
      const file = `/mock/transcripts/${input.id}/transcript.md`
      STAGED_TEXT.set(file, [
        `# The conversation so far, from ${snapshot.session.harness}`,
        "",
        `${asked.length} turn${asked.length === 1 ? "" : "s"}, newest first after this index. Search this folder with rg, or call thread_history.`,
        "",
        "## Index",
        ...asked.map((block, index) => `${index + 1}. ${block.type === "user" ? block.text.split("\n")[0] : ""}`),
      ].join("\n"))
      const manifest = {
        file,
        digest: "fixture",
        sourceRevision: snapshot.revision,
        fromBlock: 0,
        toBlock: snapshot.blocks.length,
        includesBase: true,
        losses: [],
        turns: asked.length,
        from: [snapshot.session.harness],
      }
      const next: LiveSnapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        session: {
          ...snapshot.session,
          harness: input.provider,
          connection: "connected",
          status: "ready",
          currentMode: input.modeId ?? null,
          modes: input.modeId
            ? [{ id: input.modeId, name: input.modeId }]
            : [],
          settings: input.tuning,
        },
        requests: [
          ...snapshot.requests,
          {
            id: input.id,
            text: input.text,
            attachments: input.attachments,
            status: "completed",
            context: [manifest],
          },
        ],
        control: {
          merges: [],
          ...control,
          activeBindingId: bindingId,
          bindings: [
            ...control.bindings,
            {
              id: bindingId,
              provider: input.provider,
              coveredBlocks: snapshot.blocks.length,
              includesBase: true,
              tuning: input.tuning,
              modeId: input.modeId,
            },
          ],
          transfers: [
            ...control.transfers,
            {
              input,
              createdAt: Date.now(),
              state: {
                kind: "accepted",
                bindingId,
                manifest,
              },
            },
          ],
        },
        blocks: [
          ...snapshot.blocks,
          {
            type: "user",
            provider: input.provider,
            requestId: input.id,
            text: input.text,
          },
          {
            type: "text",
            text: `Finished with ${input.provider}: ${input.text}`,
          },
        ],
      }
      liveSnapshots.set(id, next)
      return next
    },
    liveEditQueued: async (id, input) => {
      const snapshot = liveSnapshots.get(id)
      if (!snapshot) throw new Error("Missing mock session")
      const next: LiveSnapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        requests: snapshot.requests.map((request) => {
          if (request.id !== input.requestId) return request
          if (request.status !== "queued" && request.status !== "held")
            throw new Error("This message has already started")
          switch (input.change.kind) {
            case "edit":
              return { ...request, status: request.signIn ? "held" : "queued", text: input.change.text }
            case "pause":
              return { ...request, status: "held", wake: undefined }
            case "resume":
              return { ...request, status: request.signIn ? "held" : "queued", wake: undefined }
            case "remove":
              return { ...request, status: "canceled", signIn: undefined }
          }
        }),
      }
      liveSnapshots.set(id, next)
      return next
    },
    // As the host does: a failed message's words, held until the time asked for.
    liveHoldUntil: async (id, requestId, input) => {
      const snapshot = liveSnapshots.get(id)
      const failed = snapshot?.requests.find((request) => request.id === input.after && request.status === "failed")
      if (!snapshot || !failed) throw new Error("That message is no longer waiting to be sent again.")
      const held: LiveRequest = { id: requestId, text: failed.text, attachments: failed.attachments, displayText: failed.displayText, status: "held", wake: { at: input.at, after: failed.id } }
      emitRequests(id, { ...snapshot, revision: snapshot.revision + 1, requests: [...snapshot.requests, held] })
      return held
    },
    liveClearQueue: async (id: string) => {
      const snapshot = liveSnapshots.get(id)
      if (!snapshot) throw new Error("Missing mock session")
      return snapshot
    },
    liveSignInReadiness: async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return signInReadiness(id)
    },
    liveSignInResume: async (id: string, anyway: boolean) => {
      const snapshot = liveSnapshots.get(id)
      const hold = signInPauses.get(id)
      if (!snapshot || !hold) return "resumed"
      if (!anyway && signInReadiness(id) !== "ready") return "signed-out"
      signInPauses.delete(id)
      await new Promise((resolve) => setTimeout(resolve, 900))
      const cut = snapshot.requests.find((request) => request.signIn && request.status === "interrupted")
      const updates: LiveUpdate[] = []
      const continuation: LiveRequest[] = []
      if (cut) {
        const request: LiveRequest = {
          id: crypto.randomUUID(), text: continueTurnPrompt("signed-out", "mako"), attachments: [], status: "completed",
          continues: { requestId: cut.id, reason: "signed-out", auto: true },
        }
        continuation.push(request)
        updates.push({ kind: "user", requestId: request.id, text: request.text },
          { kind: "text", text: "Picking up where I stopped: the sync worker now uses the shared retry policy, and its tests pass." })
      }
      const released = snapshot.requests.map((request): LiveRequest => {
        if (!request.signIn) return request
        const rest = { ...request }
        delete rest.signIn
        if (request.status !== "held") return rest
        updates.push(...mockReply(snapshot.session, request, snapshot.session.settings).updates)
        return { ...rest, status: "completed" }
      })
      const first = snapshot.requests.findIndex((request) => request.status === "held" && request.signIn)
      const requests = first === -1 ? [...released, ...continuation] : [...released.slice(0, first), ...continuation, ...released.slice(first)]
      const next: LiveSnapshot = {
        ...snapshot,
        session: { ...snapshot.session, status: "ready", error: undefined },
        revision: snapshot.revision + 1,
        requests,
        blocks: reduceLiveUpdates(snapshot.blocks, withHarness(snapshot.session.harness, updates)),
      }
      emitRequests(id, next, updates)
      return "resumed"
    },
    liveEarlier: async (id: string) => {
      const snapshot = liveSnapshots.get(id)
      if (!snapshot) throw new Error("Missing mock session")
      return snapshot
    },
    liveBind: async (id: string, path: string) => {
      const snapshot = liveSnapshots.get(id)
      if (!snapshot) throw new Error("Missing mock session")
      return { ...snapshot, threadPath: path }
    },
    readLiveFile: async (_id: string, path: string) => ({
      path,
      contents: "Mock file",
      size: 9,
      binary: false,
      truncated: false,
    }),
    liveAttach: async () => null,
    liveSnapshot: async (id: string) => liveSnapshots.get(id) ?? null,
    liveContextBreakdown: async (id: string) => {
      const session = liveSnapshots.get(id)?.session
      return session?.harness === "claude" && session.usage?.used && session.usage.size
        ? mockClaudeBreakdown(session.usage.used, session.usage.size)
        : null
    },
    liveRead: async (id: string, input: LiveHistoryRead) => {
      const snapshot = await window.mako!.liveSnapshot(id)
      const value = snapshot && streamsScene ? presentedRead(snapshot, input) : snapshot
      const data = JSON.stringify(value)
      return { record: "00000000-0000-4000-8000-000000000001", offset: 0, data, total: data.length, next: null }
    },
    liveContinue: async (id, _bindingId, requestId, text, attachments, tuning) => {
      await window.mako!.livePrompt(id, requestId, text, attachments, tuning)
      const snapshot = await window.mako!.liveSnapshot(id)
      if (!snapshot) throw new Error("Mock session is closed")
      return snapshot
    },
    livePrompt: async (
      id: string,
      requestId: string,
      text: string,
      attachments = [],
      tuning?: SessionSettings
    ) => {
      let snapshot = liveSnapshots.get(id)
      if (!snapshot) throw new Error("Mock session is closed")
      if (setupScene && text === ENVIRONMENT_SETUP_PROMPT) {
        const asked: LiveRequest = { id: requestId, text, attachments, status: "dispatching" }
        const session: LiveSessionState = { ...snapshot.session, status: "running" }
        liveSnapshots.set(id, { ...snapshot, session, requests: [...snapshot.requests, asked] })
        pushLive(id, [{ kind: "user", requestId, text }])
        beginSetup(id, snapshot.session.title ?? "Set up", snapshot.session.harness, session.cwd)
        return asked
      }
      // As the host does: the account follows the global selection on the
      // next message, waits while background work holds the old process,
      // and nothing sends when the agent reports someone else.
      const launched = snapshot.session.executionContext?.account
      const selected = accountContext(snapshot.session.harness)
      if (launched?.kind === "configured" && selected?.account.kind === "configured" && launched.name !== selected.account.name) {
        if (snapshot.session.backgroundTasks) {
          const waiting: LiveRequest = { id: requestId, text, attachments, status: "queued", accountSwitch: { reason: "selection", waitingFor: "background" } }
          const next = { ...snapshot, revision: snapshot.revision + 1, requests: [...snapshot.requests, waiting] }
          liveSnapshots.set(id, next)
          emit({ type: "live-batch", batch: { id, revision: next.revision, updates: [], session: snapshot.session, requests: next.requests } })
          return waiting
        }
        snapshot = { ...snapshot, session: { ...snapshot.session, executionContext: selected } }
      }
      const confirmation = snapshot.session.executionContext?.confirmation
      if (confirmation?.kind === "differs") {
        const refused: LiveRequest = {
          id: requestId, text, attachments, status: "failed", failure: "wrong-account",
          nativeDelivery: { attemptId: crypto.randomUUID(), bindingId: id, ownerEpoch: "fixture", evidence: { kind: "not-accepted", source: "preflight", reason: "signed in as someone else" } },
          error: `This agent is signed in as ${confirmation.principal}, not ${confirmation.expected}, the account this session started with. Nothing was sent. Sign ${confirmation.expected} in again in Settings › Agents, or choose the account it is signed in as.`,
        }
        const next = { ...snapshot, revision: snapshot.revision + 1, requests: [...snapshot.requests, refused] }
        liveSnapshots.set(id, next)
        acpSessions.set(id, next.session)
        emit({ type: "live-batch", batch: { id, revision: next.revision, updates: [], session: next.session, requests: next.requests } })
        return refused
      }
      // As the host does: while the account is signed out, new messages join the paused work.
      const paused = signInPauses.get(id)
      if (paused) {
        const waiting: LiveRequest = { id: requestId, text, attachments, status: "held", signIn: paused }
        emitRequests(id, { ...snapshot, revision: snapshot.revision + 1, requests: [...snapshot.requests, waiting] })
        return waiting
      }
      // A message that mentions signing out plays an account that signs out
      // partway through the turn, after the provider accepted it.
      if (/sign(?:s|ed)? out/i.test(text)) {
        const at = Date.now()
        const account = snapshot.session.executionContext?.account
        const hold: SignInHold = { harness: snapshot.session.harness, account: account?.kind === "configured" ? account.name : "default", credential: "fixture", at }
        signInPauses.set(id, hold)
        const error = "Failed to authenticate: OAuth session expired and could not be refreshed"
        const cut: LiveRequest = {
          id: requestId, text, attachments, status: "interrupted", failure: "auth", error, signIn: hold,
          interruption: { reason: "signed-out", at },
          nativeDelivery: { attemptId: crypto.randomUUID(), bindingId: id, ownerEpoch: "fixture", evidence: { kind: "accepted", source: "native-response" } },
        }
        const updates: LiveUpdate[] = [
          { kind: "user", requestId, text },
          { kind: "text", text: "Moved the retry policy into `src/net/retry.ts` and switched the fetch client and the upload queue over to it. Next: the sync worker and its tests." },
        ]
        emitRequests(id, {
          ...snapshot,
          session: { ...snapshot.session, status: "failed", error },
          revision: snapshot.revision + 1,
          requests: [...snapshot.requests, cut],
          blocks: reduceLiveUpdates(snapshot.blocks, withHarness(snapshot.session.harness, updates)),
        }, updates)
        return cut
      }
      // "fail as rate-limited", "fail as auth after it started", "hit the usage limit": a turn that fails the way
      // that kind does, with the provider's own words, so each failure row can be looked at.
      const failing = mockFailure(text)
      if (failing) {
        const at = Date.now()
        if (failing.limit) {
          const account = snapshot.session.executionContext?.account
          const name = account?.kind === "configured" ? account.name : "default"
          emit({ type: "account-usage", harness: snapshot.session.harness, name, usage: { status: "ok", plan: "max", windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: failing.limit }, { usedPercent: 64, windowMinutes: 10_080, resetsAt: at + 4 * 86_400_000 }] } })
        }
        const failed: LiveRequest = failing.kind === "uncertain"
          ? { id: requestId, text, attachments, status: "uncertain", nativeDelivery: { attemptId: crypto.randomUUID(), bindingId: id, ownerEpoch: "fixture", evidence: { kind: "submitted", source: "transport-call" } } }
          : failing.kind === "host-quit"
            ? { id: requestId, text, attachments, status: "interrupted", interruption: { reason: "host-quit", at }, nativeDelivery: { attemptId: crypto.randomUUID(), bindingId: id, ownerEpoch: "fixture", evidence: { kind: "accepted", source: "native-response" } } }
            : {
                id: requestId, text, attachments, status: "failed", failure: failing.kind, error: failing.error,
                nativeDelivery: { attemptId: crypto.randomUUID(), bindingId: id, ownerEpoch: "fixture", evidence: failing.started ? { kind: "accepted", source: "native-response" } : { kind: "not-accepted", source: "preflight", reason: "refused before it ran" } },
              }
        const updates: LiveUpdate[] = failing.unsent ? [] : [
          { kind: "user", requestId, text },
          ...failing.started || failing.kind === "host-quit" ? [{ kind: "text" as const, text: "Reading `src/net/retry.ts` and the two clients that call it." }] : [],
        ]
        const session: LiveSessionState = failing.kind === "host-quit" || failing.kind === "uncertain"
          ? { ...snapshot.session, status: "ready", connection: "hibernated" }
          : { ...snapshot.session, status: "failed", error: failing.error }
        emitRequests(id, { ...snapshot, session, revision: snapshot.revision + 1, requests: [...snapshot.requests, failed], blocks: reduceLiveUpdates(snapshot.blocks, withHarness(snapshot.session.harness, updates)) }, updates)
        return failed
      }
      // "ask and then exit": the agent asks to run a command, and its process exits before anyone answers.
      if (/ask (?:me )?and then exit/i.test(text)) {
        const updates: LiveUpdate[] = [{ kind: "user", requestId, text }, { kind: "text", text: "I'll run the suite to check the retry change." }]
        const asked: LivePermissionRequest = { id: crypto.randomUUID(), sessionId: id, title: "npm test -- --run src/net", kind: "execute", gone: true,
          options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }
        const session: LiveSessionState = { ...snapshot.session, status: "ready", connection: "disconnected" }
        const next = { ...snapshot, session, permissions: [asked], revision: snapshot.revision + 1, requests: [...snapshot.requests, { id: requestId, text, attachments, status: "completed" as const }], blocks: reduceLiveUpdates(snapshot.blocks, withHarness(snapshot.session.harness, updates)) }
        liveSnapshots.set(id, next)
        acpSessions.set(id, session)
        emit({ type: "live-batch", batch: { id, revision: next.revision, updates, session, permissions: [asked], requests: next.requests } })
        return next.requests.at(-1)!
      }
      if (/run the (?:\w+ )?(?:tests|suite)/i.test(text)) {
        const running: LiveRequest = { id: requestId, text, attachments, status: "dispatching" }
        const session: LiveSessionState = { ...snapshot.session, status: "running" }
        liveSnapshots.set(id, { ...snapshot, session, requests: [...snapshot.requests, running] })
        pushLive(id, [{ kind: "user", requestId, text }])
        playSuiteTurn(id)
        return running
      }
      const request: LiveRequest = {
        id: requestId,
        text,
        attachments,
        status: "completed",
      }
      const settings = tuning
        ? { ...snapshot.session.settings, ...tuning, options: { ...snapshot.session.settings?.options, ...tuning.options } }
        : snapshot.session.settings
      const reply = mockReply({ ...snapshot.session, settings }, request, settings)
      if (reply.changed) request.snapshots = mockTurnSnapshots(GIT.root ?? snapshot.session.cwd, rewindScene)
      const { permission } = reply
      const updates = framed(id, snapshot.session.harness, [...openingNotices(snapshot), ...reply.updates])
      if (streamsScene && snapshot.blocks.length) {
        // The record lands in a batch of its own, and the window reads a new view for it, before the reply streams.
        const landed = { ...snapshot, ...landRecord(id, snapshot), revision: snapshot.revision + 1 }
        liveSnapshots.set(id, landed)
        emit({ type: "live-batch", batch: { id, revision: landed.revision, updates: [], base: landed.base, baseCoveredBlocks: landed.baseCoveredBlocks } })
        await new Promise((resolve) => setTimeout(resolve, 400))
        snapshot = liveSnapshots.get(id) ?? landed
      }
      const session: LiveSessionState = {
        ...snapshot.session,
        settings,
        // "Keep working" leaves the turn running, for what a Thread at work offers (a handoff to the cloud).
        status: permission || /keep working/i.test(text) ? "running" : "ready",
      }
      if (/in the background/i.test(text)) session.backgroundTasks = 1
      const permissions = permission ? [permission] : []
      const next = {
        ...snapshot,
        session,
        permissions,
        revision: snapshot.revision + 1,
        requests: [...snapshot.requests, request],
        blocks: reduceLiveUpdates(snapshot.blocks, withHarness(snapshot.session.harness, updates)),
      }
      liveSnapshots.set(id, next)
      acpSessions.set(id, session)
      emit({
        type: "live-batch",
        batch: {
          id,
          revision: next.revision,
          updates,
          session,
          permissions,
          requests: next.requests,
        },
      })
      return request
    },
    livePermission: async (id: string, requestId: string, response: LivePermissionResponse) => {
      const snapshot = liveSnapshots.get(id)
      const asked = snapshot?.permissions.find((permission) => permission.id === requestId)
      if (!snapshot || !asked) return
      const approved = response.kind === "choice" && response.optionId === asked.implementsPlan?.approve
      const session: LiveSessionState = {
        ...snapshot.session,
        status: "ready",
        currentMode: approved ? (MOCK_PLAN_APPROVALS.get(snapshot.session.harness)?.after ?? null) : snapshot.session.currentMode,
      }
      const updates: LiveUpdate[] = asked.implementsPlan
        ? [{ kind: "text", text: approved ? "Plan approved. Implementing it now — Finished." : "Still planning. Tell me what to change." }]
        : []
      const next = { ...snapshot, session, permissions: [], revision: snapshot.revision + 1, blocks: reduceLiveUpdates(snapshot.blocks, withHarness(snapshot.session.harness, updates)) }
      liveSnapshots.set(id, next)
      acpSessions.set(id, session)
      emit({ type: "live-batch", batch: { id, revision: next.revision, updates, session, permissions: [] } })
      // As the host does: approving a plan builds it in this conversation.
      if (approved && asked.implementsPlan)
        await window.mako!.recordPlanBuild(asked.implementsPlan.plan, { at: Date.now(), conversation: id })
    },
    liveSetMode: async (id: string, modeId: string) => {
      const session = acpSessions.get(id)
      if (!session) return
      const next = { ...session, currentMode: modeId }
      acpSessions.set(id, next)
      const snapshot = liveSnapshots.get(id)
      if (snapshot) {
        const updated = {
          ...snapshot,
          session: next,
          revision: snapshot.revision + 1,
        }
        liveSnapshots.set(id, updated)
        emit({
          type: "live-batch",
          batch: { id, revision: updated.revision, session: next, updates: [] },
        })
      }
    },
    liveGoal: async (id: string, command: GoalCommand) => {
      const snapshot = liveSnapshots.get(id)
      if (!snapshot) throw new Error("This conversation is no longer available")
      const now = Date.now()
      const by = ["claude", "codex", "grok"].includes(snapshot.session.harness) ? "harness" : "mako"
      const current = snapshot.goal
      const goal: ConversationGoal | undefined = command.kind === "set"
        ? { objective: command.objective, status: "active", by, setAt: now, updatedAt: now, turns: 0, tokenBudget: command.tokenBudget, tokensUsed: command.tokenBudget && 0 }
        : command.kind === "clear" || !current ? undefined
          : { ...current, status: command.kind === "pause" ? "paused" : "active", note: undefined, updatedAt: now }
      const publish = (next: ConversationGoal | undefined) => {
        const latest = liveSnapshots.get(id)
        if (!latest) return latest
        const updated: LiveSnapshot = { ...latest, goal: next, revision: latest.revision + 1 }
        liveSnapshots.set(id, updated)
        emit({ type: "live-batch", batch: { id, revision: updated.revision, goal: next ?? null, updates: [] } })
        return updated
      }
      const updated = publish(goal)!
      // A budgeted goal spends most of its budget, then the rest, as turns would.
      const budget = goal?.tokenBudget
      if (command.kind === "set" && budget) {
        const spend = (share: number, status: ConversationGoal["status"], delay: number) => setTimeout(() => {
          const latest = liveSnapshots.get(id)?.goal
          if (latest?.setAt !== goal.setAt || latest.status !== "active") return
          publish({ ...latest, status, tokensUsed: Math.round(budget * share), turns: (latest.turns ?? 0) + 1, updatedAt: Date.now() })
        }, delay)
        spend(0.62, "active", 900)
        spend(1.04, "budget-limited", 2_400)
      }
      return updated
    },
    // As the host does: a turn of the conversation, queued behind a running
    // one; each harness reports its findings the way it does natively.
    liveReview: async (id: string, target: ReviewTarget) => startLiveReview(id, target),
    // As the host does: one answer at a time, streamed into the side
    // conversation, which never joins the transcript and ends on close.
    liveSideQuestion: async (id: string, command: SideQuestionCommand) => {
      const snapshot = liveSnapshots.get(id)
      if (!snapshot) throw new Error("This conversation is no longer available")
      if (command.kind === "close") {
        stopSideAnswer(id)
        return setSide(id, undefined)
      }
      const answering = snapshot.side?.exchanges.find((exchange) => exchange.status === "answering")
      if (command.kind === "stop") {
        stopSideAnswer(id)
        if (answering) changeExchange(id, answering.id, (current) => ({ ...current, status: "stopped", answeredAt: Date.now() }))
        return liveSnapshots.get(id)!
      }
      if (answering) throw new Error("Wait for the answer, or stop it, before asking another.")
      if (!snapshot.requests.length) throw new Error("Send a message first, then ask a side question.")
      const side = snapshot.side ?? { id: crypto.randomUUID(), by: snapshot.session.harness === "cursor" ? "fork" : "harness", exchanges: [] }
      const exchange: SideExchange = { id: crypto.randomUUID(), question: command.question, answer: "", status: "answering", askedAt: Date.now() }
      const updated = setSide(id, { ...side, exchanges: [...side.exchanges, exchange] })
      const reply = mockSideAnswer(command.question, side.exchanges)
      const timers: ReturnType<typeof setTimeout>[] = []
      if (reply.kind === "failed") {
        timers.push(setTimeout(() => changeExchange(id, exchange.id, (current) => ({ ...current, status: "failed", error: reply.error, answeredAt: Date.now() })), 1_200))
      } else {
        const words = reply.text.split(/(?<=\s)/)
        let at = 1_100
        words.forEach((word, index) => {
          at += /\n/.test(word) ? 120 : 28 + (index % 5) * 9
          timers.push(setTimeout(() => changeExchange(id, exchange.id, (current) => ({ ...current, answer: current.answer + word })), at))
        })
        timers.push(setTimeout(() => {
          sideAnswers.delete(id)
          changeExchange(id, exchange.id, (current) => ({ ...current, status: "answered", answeredAt: Date.now() }))
        }, at + 60))
      }
      sideAnswers.set(id, timers)
      return updated
    },
    liveStopAgent: async (id: string, nativeId: string) => {
      const snapshot = liveSnapshots.get(id)
      const agent = snapshot?.nativeAgents?.agents.find((candidate) => candidate.nativeId === nativeId && candidate.stoppable && (candidate.state.kind === "working" || candidate.state.kind === "waiting"))
      if (!snapshot?.nativeAgents || !agent) return false
      const nativeAgents = { ...snapshot.nativeAgents, agents: snapshot.nativeAgents.agents.map((candidate) => candidate === agent ? { ...candidate, stoppable: false, state: { kind: "canceled" as const }, settledAt: Date.now() } : candidate) }
      const next = { ...snapshot, revision: snapshot.revision + 1, nativeAgents }
      liveSnapshots.set(id, next)
      emit({ type: "live-batch", batch: { id, revision: next.revision, updates: [], nativeAgents } })
      return true
    },
    liveCancel: async (id: string) => {
      const session = acpSessions.get(id)
      if (!session) return
      const next: LiveSessionState = {
        ...session,
        status: "ready",
        lastStop: "canceled",
        backgroundTasks: 0,
      }
      acpSessions.set(id, next)
      const snapshot = liveSnapshots.get(id)
      if (snapshot) {
        const waiting = snapshot.requests.find((request) => request.status === "queued" && request.accountSwitch)
        const requests = snapshot.requests.filter((request) => request !== waiting)
        const updated = {
          ...snapshot,
          session: next,
          permissions: [],
          requests,
          revision: snapshot.revision + 1,
        }
        liveSnapshots.set(id, updated)
        emit({
          type: "live-batch",
          batch: { id, revision: updated.revision, session: next, permissions: [], updates: [], requests },
        })
        // Stopping the background work frees the session; the waiting message switches it and sends.
        if (waiting) {
          await new Promise((resolve) => setTimeout(resolve, 600))
          await window.mako!.livePrompt(id, waiting.id, waiting.text, waiting.attachments)
        }
      }
    },
    livePrewarm: async () => "unchanged" as const,
    launchPrewarm: async () => {},
    cloudPrepare: async () => "none" as const,
    cloudOfferProjects: async () => "none" as const,
    /**
     * A fixture's move: its steps a moment apart, as a real one takes them; `?move=busy` stays here, as a Thread
     * with a turn running does. `?move=main`: a Thread in the main checkout goes onto its own branch first, and takes
     * files from outside its folder and two repositories along, a secret staying. `?follow=stopped`: once moved, the
     * person changes its worktree here and following stops.
     */
    threadMove: async (conversationId: string, move: string, handOff?: ThreadHandOff) => {
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const step = (next: ThreadMoveStep) => emit({ type: "thread-move-step", conversationId, move, step: next })
      const scene = new URLSearchParams(globalThis.location?.search)
      if (!handOff && scene.get("move") === "busy") {
        const reason = "Moves happen between turns: Codex is running a turn."
        step({ kind: "kept-here", reason })
        return { kind: "kept-here" as const, reason }
      }
      const main = scene.get("move") === "main"
      const steps: ThreadMoveStep[] = handOff ? [{ kind: "packing" }, { kind: "pausing" }, { kind: "handing-over" }, { kind: "resuming" }] : [...main ? [{ kind: "own-branch" } as const] : [], { kind: "packing" }, { kind: "handing-over" }, { kind: "resuming" }]
      for (const next of steps) {
        step(next)
        await pause(900)
      }
      const carried: MoveCarried | undefined = main ? { repositories: 2, outside: 3, left: [{ path: "/Users/you/.aws/credentials", why: "secret" }] } : undefined
      step({ kind: "moved", conversations: [conversationId], ...handOff && { continued: true }, ...carried && { carried } })
      if (scene.get("follow") === "stopped") {
        await pause(600)
        emit({ type: "thread-follow-stopped", conversations: [conversationId], folders: [MOCK_RETURN_WORKTREE], at: Date.now() })
      }
      return { kind: "moved" as const, cloudThread: "t-0123456789abcdef" }
    },
    /** What this Mac's harnesses mean against the fixture cloud's, by the `?harnesses=` scene. */
    threadHarnessCheck: async (): Promise<ThreadHarnessCheck> => mockHarnessCheck(),
    /** A fixture has no agents at work unless a review page says so (`application-review`). */
    handOffCandidates: async (): Promise<HandOffCandidate[]> => [],
    handOff: async (handOff: string): Promise<HandOffResult[]> => {
      const candidates = (await window.mako!.handOffCandidates()).filter((candidate) => !candidate.refusal)
      return Promise.all(candidates.map(async (candidate) => ({ conversationId: candidate.conversationId, outcome: await window.mako!.threadMove(candidate.conversationId, `${handOff}:${candidate.thread}`, { why: "quit" }) })))
    },
    conversationSettings: async (): Promise<ConversationSettings> => mockConversationSettings.value,
    setConversationSettings: async (settings: ConversationSettings): Promise<ConversationSettings> => {
      mockConversationSettings.value = settings
      emit({ type: "conversation-settings", settings })
      return settings
    },
    handOffSettings: async (): Promise<HandOffSettings> => ({ onSleep: mockHandOffOnSleep.value }),
    setHandOffOnSleep: async (onSleep: boolean): Promise<HandOffSettings> => {
      mockHandOffOnSleep.value = onSleep
      emit({ type: "handoff-settings", settings: { onSleep } })
      return { onSleep }
    },
    /** A fixture's way back: its steps a moment apart, as a real one takes them. */
    threadReturn: async (conversationId: string, move: string, options?: ThreadReturnOptions) => {
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const step = (next: ThreadReturnStep) => emit({ type: "thread-return-step", conversationId, move, step: next })
      if (mockReturnOutdated.value === "project-gone") {
        // Refused before the cloud is asked anything, until the person chooses where the project is now.
        if (options?.project !== MOCK_MOVED_PROJECT) {
          const reason = "Its project, /Users/you/Projects/billing-api, isn't on this Mac anymore: it was moved or deleted. It goes on in the cloud."
          const missing = { folder: MOCK_RETURN_WORKTREE, project: "/Users/you/Projects/billing-api" }
          step({ kind: "stayed", reason, missing })
          return { kind: "stayed" as const, reason, missing }
        }
        mockReturnOutdated.value = ""
      }
      for (const next of [{ kind: "packing" }, { kind: "bringing" }] as const) {
        step(next)
        await pause(900)
      }
      if (mockReturnOutdated.value === "outdated") {
        mockReturnOutdated.value = ""
        const reason = "Codex 0.163.0 wrote its sessions in the cloud, and this Mac has 0.159.3."
        const outdated = { harness: "codex", wrote: { version: "0.163.0", source: "record" as const }, installed: "0.159.3", offer: { kind: "update" as const, runtimeId: "codex", label: "Update with npm" } }
        step({ kind: "stayed", reason, outdated })
        return { kind: "stayed" as const, reason, outdated }
      }
      if (mockReturnOutdated.value === "unsettled-cloud" || mockReturnOutdated.value === "unsettled-here") {
        const waitsOn = mockReturnOutdated.value === "unsettled-cloud" ? "cloud" as const : "here" as const
        mockReturnOutdated.value = ""
        const reason = waitsOn === "cloud"
          ? "Mako couldn't hear the cloud: The network connection was lost. The cloud let the Thread go and this Mac hasn't taken it, so it runs nowhere until Mako hears. Ask again, or Mako asks when it next starts."
          : "This Mac couldn't finish taking the Thread: database is locked. The cloud let it go, so it runs nowhere until this Mac does. Ask again, or Mako asks when it next starts."
        step({ kind: "unsettled", reason, waitsOn })
        return { kind: "unsettled" as const, reason, waitsOn }
      }
      if (mockReturnOutdated.value === "outdated-devin") {
        mockReturnOutdated.value = ""
        const reason = "Devin 3000.11.205 wrote its sessions in the cloud, and this Mac has 3000.10.23."
        const outdated = { harness: "devin", wrote: { version: "3000.11.205", source: "record" as const }, installed: "3000.10.23", offer: { kind: "owner" as const, owner: "Devin" } }
        step({ kind: "stayed", reason, outdated })
        return { kind: "stayed" as const, reason, outdated }
      }
      if (mockReturnOutdated.value === "merged") {
        // The person changed its worktree and a file outside it while it was away: merged, one conflict, one waiting.
        mockReturnOutdated.value = ""
        const landed = { merged: ["src/webhooks/retry.ts", "notes/todo.md"], conflicts: ["src/webhooks/retry.ts"], outside: { placed: ["/tmp/billing-replay.sh"], removed: [], waiting: ["/Users/you/.config/billing/state.json"], failed: [{ path: "/Users/you/bin/billing-sync", why: "permission denied" }], kept: "/Users/you/.mako/cloud/outside/thread-billing" } }
        step({ kind: "back", conversations: [conversationId], landed })
        return { kind: "back" as const, landed }
      }
      step({ kind: "back", conversations: [conversationId] })
      return { kind: "back" as const }
    },
    liveClose: async (id: string) => {
      const session = acpSessions.get(id)
      if (!session) return
      const snapshot = liveSnapshots.get(id)
      if (snapshot) {
        const closed: LiveSessionState = {
          ...session,
          status: "closed",
          connection: "disconnected",
        }
        const updated = {
          ...snapshot,
          session: closed,
          revision: snapshot.revision + 1,
        }
        liveSnapshots.set(id, updated)
        emit({
          type: "live-batch",
          batch: {
            id,
            revision: updated.revision,
            session: closed,
            updates: [],
          },
        })
      }
      acpSessions.delete(id)
    },
    threadRun: async () => null,
    startHarness: async (harness: string) => ({
      run: { path: `fresh:${harness}:1`, harness, status: "running" as const },
      cwd: "/Users/you/mako",
    }),
    harnessTuning: async (harness: string) =>
      profiles().find((profile) => profile.id === harness) ?? {
        id: harness,
        label: harness,
        available: false,
        transport: "acp" as const,
        models: [],
      },
    abortThreadRun: async () => {},
    usage: async () => fixtureUsageSummary(),
    automations: async () => [
      {
        id: "a1",
        name: "Check the schema doc",
        prompt: "A migration changed. Check docs/schema.md still matches.",
        trigger: { kind: "files" as const, paths: ["migrations/*.sql"] },
        enabled: false,
      },
    ],
    saveAutomations: async (next: Automation[]) => next,
    setAutomationEnabled: async () => [],
    runAutomation: async () => {},
    reloadAutomations: async () => [],
    terminalList: async () => terminalSessions,
    terminalCreate: async (options) => {
      const now = Date.now()
      const session: TerminalSession = {
        id: `mock-terminal-${terminalSessions.length + 1}`,
        title: options.title ?? options.cwd.split("/").pop() ?? "Terminal",
        cwd: options.cwd,
        createdAt: now,
        updatedAt: now,
        status: "running",
        cols: options.cols,
        rows: options.rows,
        sequence: 0,
      }
      terminalSessions = [session, ...terminalSessions]
      emitTerminal({ type: "status", session })
      return session
    },
    terminalAttach: async (sessionId: string) => {
      const session = terminalSessions.find((entry) => entry.id === sessionId)
      if (!session) throw new Error("Terminal session was not found")
      return {
        session,
        data:
          sessionId === "mock-terminal-1"
            ? "printf 'Mako terminal mock ready\\n'\r\nMako terminal mock ready\r\n$ "
            : "$ ",
        sequence: session.sequence,
      }
    },
    terminalDetach: async () => {},
    terminalWrite: async (sessionId: string, data: string) => {
      const current = terminalSessions.find(
        (session) => session.id === sessionId
      )
      if (!current) throw new Error("Terminal session was not found")
      const sequence = current.sequence + 1
      terminalSessions = terminalSessions.map((session) =>
        session.id === sessionId
          ? { ...session, sequence, updatedAt: Date.now() }
          : session
      )
      emitTerminal({ type: "output", sessionId, sequence, data })
    },
    terminalAcknowledge: async () => {},
    terminalResize: async () => {},
    terminalKill: async (sessionId: string) => {
      terminalSessions = terminalSessions.filter(
        (session) => session.id !== sessionId
      )
      emitTerminal({ type: "removed", sessionId })
    },
    onTerminalEvent: (listener) => {
      terminalListeners.add(listener)
      queueMicrotask(() => listener({ type: "connection", state: "ready" }))
      return () => terminalListeners.delete(listener)
    },
    lifecycleState: async () => ({
      work: [],
      revision: "fixture",
      operation: { kind: "idle" as const },
    }),
    lifecycleCommand: async () => ({
      work: [],
      revision: "fixture",
      operation: { kind: "idle" as const },
    }),
    quitClient: async () => {},
    acknowledgeShutdown: async () => {},
    installationState: async () => ({
      distribution: newerStoresScene ? "signed" as const : "development" as const,
      build: null,
      source: null,
      local: { kind: "idle" as const },
      checkout: null,
      reading: false,
      installed: null,
    }),
    selectUpdateSource: async () => ({
      distribution: "development" as const,
      build: null,
      source: null,
      local: { kind: "idle" as const },
      checkout: null,
      reading: false,
      installed: null,
    }),
    checkUpdateSource: async () => ({
      distribution: "development" as const,
      build: null,
      source: null,
      local: { kind: "idle" as const },
      checkout: null,
      reading: false,
      installed: null,
    }),
    buildUpdate: async () => {},
    updateState: async (): Promise<UpdateState> => {
      if (!newerStoresScene) return { status: "unsupported", version: "0.0.0-mock" }
      if (mockUpdate === "ready") return { status: "ready", version: "0.161.2", available: "0.163.0" }
      return { status: "current", version: "0.161.2" }
    },
    checkUpdates: async () => {
      if (!newerStoresScene) return { status: "unsupported" as const, version: "0.0.0-mock" }
      mockUpdate = "ready"
      return { status: "ready" as const, version: "0.161.2", available: "0.163.0" }
    },
    installUpdate: async () => {},
    relaunch: async () => {},
    openPreviewWindow: async () => {},
    crashes: async () => [],
    crashesDir: async () => "/tmp/mako/crashes",
    hostLogPath: async () => "",
    sessionReaderHistory: async () => ({ since: new Date().toISOString(), lost: 0, events: [], logPath: "" }),
    syncReadings: async () => ({ at: Date.now(), follows: [], list: { gaps: [], changeMs: { samples: 0 } } }),
    providerResidency: async () => ({
      entries: [],
      active: 0,
      warm: 0,
      protected: 0,
      hibernated: 0,
      disconnected: 0,
      warmLimit: 2,
      idleMs: 10 * 60_000,
      memory: { loaded: 0, unloaded: 0, bytes: 0, pinnedBytes: 0, budget: 128 * 1024 * 1024, loads: [], held: [] },
    }),
    clearCrashes: async () => {},
    reportCrash: async () => {},
    telemetry: async () => ({ ...mockTelemetry }),
    chooseTelemetry: async (choice) => {
      mockTelemetry = { ...mockTelemetry, ...choice }
      return { ...mockTelemetry }
    },
    pickFolder: async () => (mockReturnOutdated.value === "project-gone" ? MOCK_MOVED_PROJECT : null),
    externalEditors: async () => [
      { id: "zed", label: "Zed", available: true },
      { id: "cursor", label: "Cursor", available: true },
      { id: "vscode", label: "Visual Studio Code", available: true },
    ],
    openInEditor: async () => {},
    revealPath: async () => {},
    copy: async () => {},
    notify: async () => ({ delivered: false, reason: "unsupported" }),
    dismissNotification: async () => {},
    setBadgeCount: async () => {},
    notificationPermission: async () => "unsupported",
    requestNotificationPermission: async () => "unsupported",
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    setLiveSnapshot(snapshot: LiveSnapshot): void {
      liveSnapshots.set(snapshot.session.id, snapshot)
      acpSessions.set(snapshot.session.id, snapshot.session)
    },
  }
}

/** What Claude's `/context` itemizes, scaled to the session's reading. */
function mockClaudeBreakdown(used: number, size: number): ContextBreakdown {
  const fixed = { system: 3_100, tools: 14_600, mcp: 9_800, memory: 2_400, agents: 900 }
  const messages = Math.max(0, used - Object.values(fixed).reduce((sum, tokens) => sum + tokens, 0))
  const buffer = Math.round(size * 0.165)
  return {
    used,
    size,
    categories: [
      { name: "System prompt", tokens: fixed.system, kind: "used" },
      { name: "System tools", tokens: fixed.tools, kind: "used" },
      { name: "MCP tools", tokens: fixed.mcp, kind: "used" },
      { name: "Custom agents", tokens: fixed.agents, kind: "used" },
      { name: "Memory files", tokens: fixed.memory, kind: "used" },
      { name: "Messages", tokens: messages, kind: "used" },
      { name: "Free space", tokens: Math.max(0, size - used - buffer), kind: "free" },
      { name: "Autocompact buffer", tokens: buffer, kind: "buffer" },
    ],
    items: [
      { group: "mcp", name: "linear", tokens: 6_200 },
      { group: "mcp", name: "github", tokens: 3_600 },
      { group: "memory", name: "~/project/CLAUDE.md", tokens: 1_700 },
      { group: "memory", name: "~/.claude/CLAUDE.md", tokens: 700 },
    ],
  }
}

/** Effort levels in the catalog's words (`model-catalog.ts`): "Medium", "Extra high". */
const mockEffort = (current: string, values: string[]) => ({
  kind: "select" as const,
  id: "effort",
  label: "Reasoning",
  role: "reasoning" as const,
  current,
  values: values.map((value) => ({ value, label: value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1) })),
})
const mockFast = {
  kind: "boolean" as const,
  id: "fast",
  label: "Fast mode",
  role: "speed" as const,
  current: false,
}
const mockPlan = {
  kind: "boolean" as const,
  id: "plan",
  label: "Plan mode",
  role: "plan" as const,
  current: false,
}
const mockContext = (current: string, values: string[]) => ({
  kind: "select" as const,
  id: "context",
  label: "Context",
  role: "context" as const,
  current,
  values: values.map((value) => ({ value, label: value.toUpperCase() })),
})
const mockModel = (
  id: string,
  label: string,
  options: (ReturnType<typeof mockEffort> | ReturnType<typeof mockContext> | typeof mockFast | typeof mockPlan)[] = [],
  contextWindow?: number
) => ({ id, label, options, contextWindow })

/** Catalogs shaped like the real harnesses report, so fixture pickers read true. */
const MOCK_PROFILES = [
  {
    id: "claude",
    label: "Claude Code",
    available: true,
    transport: "acp" as const,
    defaultModel: "opus[1m]",
    settings: { model: "opus[1m]" },
    models: [
      mockModel("claude-opus-5-5", "Opus 5.5", [mockEffort("medium", ["low", "medium", "high", "xhigh", "max"]), mockFast], 1_000_000),
      mockModel("opus[1m]", "Opus 5", [mockEffort("high", ["low", "medium", "high", "xhigh", "max"]), mockFast], 1_000_000),
      mockModel("claude-fable-5-1", "Fable 5.1", [mockEffort("high", ["low", "medium", "high", "xhigh", "max"])], 1_000_000),
      mockModel("claude-sonnet-5", "Sonnet 5", [mockEffort("medium", ["low", "medium", "high"])], 400_000),
      { ...mockModel("claude-sonnet-5-5", "Sonnet 5.5", [], 1_000_000), unavailable: "This version of Claude Code doesn't support it yet. Update Claude Code to use it." },
      mockModel("claude-haiku-4-5", "Haiku 4.5", [], 200_000),
    ],
  },
  {
    id: "codex",
    label: "Codex",
    available: true,
    transport: "app-server" as const,
    defaultModel: "gpt-5.6-sol",
    settings: { model: "gpt-5.6-sol" },
    models: [
      mockModel("gpt-6.1-sol", "GPT-6.1 Sol", [mockEffort("low", ["low", "medium", "high", "xhigh", "max", "ultra"]), mockFast]),
      mockModel("gpt-6-astra", "GPT-6 Astra", [mockEffort("high", ["low", "medium", "high", "xhigh"]), mockFast]),
      mockModel("gpt-6-luna", "GPT-6 Luna", [mockEffort("medium", ["low", "medium", "high", "xhigh", "max"]), mockFast]),
      mockModel("gpt-5.6-sol", "GPT-5.6 Sol", [mockEffort("medium", ["low", "medium", "high", "xhigh", "max", "ultra"]), mockFast]),
      mockModel("gpt-5.6-terra", "GPT-5.6 Terra", [mockEffort("medium", ["low", "medium", "high"])]),
      mockModel("gpt-5.6-luna", "GPT-5.6 Luna", [mockEffort("low", ["low", "medium"])]),
      mockModel("gpt-5.5", "GPT-5.5", [mockEffort("medium", ["low", "medium", "high"])]),
    ].map((model) => ({ ...model, options: [...model.options, mockPlan] })),
  },
  {
    id: "cursor",
    label: "Cursor",
    available: true,
    transport: "acp" as const,
    defaultModel: "claude-fable-5",
    settings: { model: "claude-fable-5" },
    models: [
      mockModel("claude-fable-5", "Claude Fable 5", [mockContext("1m", ["300k", "1m"]), mockEffort("high", ["low", "medium", "high", "xhigh", "max"])]),
      mockModel("auto-smart", "Auto"),
      mockModel("composer-2.5", "Composer 2.5", [mockFast]),
      mockModel("claude-opus-5-5", "Claude Opus 5.5", [mockContext("1m", ["300k", "1m"]), mockEffort("medium", ["low", "medium", "high", "xhigh", "max"]), mockFast]),
      mockModel("gpt-5.6-sol", "GPT-5.6 Sol", [mockContext("1m", ["272k", "1m"]), mockEffort("medium", ["low", "medium", "high"]), mockFast]),
      mockModel("grok-4.7", "Grok 4.7", [mockEffort("high", ["low", "medium", "high", "xhigh"]), mockFast]),
    ].map((model) => ({ ...model, options: [...model.options, mockPlan] })),
  },
  {
    id: "grok",
    label: "Grok",
    available: true,
    transport: "acp" as const,
    defaultModel: "grok-4.7",
    settings: { model: "grok-4.7" },
    models: [
      mockModel("grok-4.7", "Grok 4.7", [mockEffort("high", ["low", "high"])]),
      mockModel("grok-4.7-build-fast", "Grok 4.7 Build Fast"),
      mockModel("grok-4.6", "Grok 4.6"),
      mockModel("grok-4.5", "Grok 4.5"),
    ],
  },
  {
    id: "devin",
    label: "Devin",
    available: true,
    transport: "acp" as const,
    defaultModel: "adaptive",
    settings: { model: "adaptive" },
    models: [
      mockModel("adaptive", "Adaptive"),
      mockModel("swe-2", "SWE-2", [mockEffort("medium", ["medium", "high", "max"])]),
      mockModel("gpt-6-astra", "GPT-6 Astra", [mockEffort("high", ["low", "medium", "high"])]),
      mockModel("gpt-6-luna", "GPT-6 Luna", [mockEffort("medium", ["none", "low", "medium", "high", "xhigh", "max"]), mockFast]),
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    available: true,
    transport: "acp" as const,
    defaultModel: "opencode/x-preview-f-free",
    settings: { model: "opencode/x-preview-f-free" },
    models: [
      mockModel("opencode/x-preview-f-free", "Ox Alpha Free (Unlimited)", [mockEffort("high", ["minimal", "low", "medium", "high", "xhigh"])]),
      mockModel("openai/gpt-5.4", "GPT-5.4", [mockEffort("medium", ["low", "medium", "high"])]),
      mockModel("anthropic/claude-opus-5-5", "Claude Opus 5.5"),
    ],
  },
]

interface MockModes {
  modes: LiveSessionMode[]
  defaultMode: string
}

/** Access ladders shaped like the real harnesses declare them, plan included where they plan by mode. */
const MOCK_MODES = new Map<string, MockModes>([
  ["claude", {
    defaultMode: "default",
    modes: [
      { id: "default", name: "Default", access: "ask" },
      { id: "acceptEdits", name: "Accept edits", access: "edits" },
      { id: "plan", name: "Plan", access: "plan" },
      { id: "bypassPermissions", name: "Bypass permissions", access: "full" },
    ],
  }],
  ["opencode", {
    defaultMode: "build",
    modes: [
      { id: "build", name: "Build", access: "full" },
      { id: "plan", name: "Plan", access: "plan" },
    ],
  }],
  ["grok", {
    defaultMode: "access:ask",
    modes: [
      { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
      { id: "access:ask", name: "Ask before acting", access: "ask", enforcement: "launch" },
      { id: "access:auto", name: "Auto review", access: "auto", enforcement: "launch" },
      { id: "access:full", name: "Full access", access: "full", enforcement: "launch" },
    ],
  }],
  ["devin", {
    defaultMode: "accept-edits",
    modes: [
      { id: "accept-edits", name: "Code", access: "edits" },
      { id: "ask", name: "Ask", access: "chat" },
      { id: "plan", name: "Plan", access: "plan" },
      { id: "bypass", name: "Bypass Permissions", access: "full" },
    ],
  }],
])

interface MockPlanApproval {
  request: Omit<LivePermissionRequest, "id" | "sessionId" | "implementsPlan">
  approve: string
  /** The mode the harness moves to once the plan is approved. */
  after: string
}

/** Each harness's own plan approval, as its adapter presents it; OpenCode's plan is its reply and asks nothing. */
const MOCK_PLAN_APPROVALS = new Map<string, MockPlanApproval>([
  ["claude", {
    approve: "allow_once",
    after: "acceptEdits",
    request: {
      title: "Start implementing the proposed plan?",
      kind: "ExitPlanMode",
      options: [
        { optionId: "allow_once", name: "Approve plan", kind: "allow_once" },
        { optionId: "reject_once", name: "Keep planning", kind: "reject_once" },
      ],
    },
  }],
  ["grok", {
    approve: "approved",
    after: "access:ask",
    request: {
      title: "Build the proposed plan?",
      kind: "switch_mode",
      options: [
        { optionId: "approved", name: "Yes, build it", kind: "allow_once" },
        { optionId: "keep-planning", name: "No, keep planning", kind: "reject_once" },
        { optionId: "abandoned", name: "Abandon the plan", kind: "reject_always" },
      ],
    },
  }],
  ["devin", {
    approve: "plan_accept_edits",
    after: "accept-edits",
    request: {
      title: "Exit plan mode",
      kind: "switch_mode",
      options: [
        { optionId: "plan_normal", name: "Yes, implement plan", kind: "allow_once" },
        { optionId: "plan_accept_edits", name: "Yes, implement plan and accept edits", kind: "allow_once" },
        { optionId: "plan_bypass", name: "Yes, implement plan and bypass permissions", kind: "allow_once" },
        { optionId: "reject_once", name: "No, plan needs changes", kind: "reject_once" },
      ],
    },
  }],
])

let mockPlans = 0

interface MockReply {
  updates: LiveUpdate[]
  permission?: LivePermissionRequest
  /** The reply edited files: its request gets checkpoints either side, as the host saves them, for `liveTurnChanges`. */
  changed?: boolean
}

/** Checkpoints either side of a turn in `scope`, both saved. */
function mockTurnSnapshots(scope: string, rewind?: "shared" | "refused"): NonNullable<LiveRequest["snapshots"]> {
  const snapshot = (createdAt: number) => ({ kind: "ready" as const, snapshot: { id: crypto.randomUUID(), scope, createdAt, files: 2, ...rewind === "shared" && { shared: [crypto.randomUUID()] } } })
  if (rewind === "refused") return { before: snapshot(Date.now() - 1_000), after: { kind: "unavailable", reason: "Resolve this workspace's merge conflicts before a checkpoint can be taken." } }
  return { before: snapshot(Date.now() - 1_000), after: snapshot(Date.now()) }
}

/** A rewind's preview with the journal's writers: this Thread's files, the person's save, and another Thread's. */
function mockRewindPreview(target: WorkspaceSnapshot, thread: string, named: (thread: string, title: string) => void): RewindPreview {
  const other = "mock-thread-retry-tests"
  named(other, "Fix the flaky retry test")
  const writers = {
    "src/components/session-rail.tsx": [{ kind: "thread", thread, sure: true }],
    "src/state/session-store.ts": [{ kind: "thread", thread, sure: true }],
    "src/net/retry.test.ts": [{ kind: "thread", thread: other, sure: true }],
    "src/net/retry.ts": [{ kind: "thread", thread: other, sure: true }, { kind: "thread", thread, sure: false }],
    "README.md": [{ kind: "person" }],
  } satisfies FileWriters
  const changedFiles = Object.keys(writers)
  return { target, current: { ...target, id: crypto.randomUUID(), createdAt: Date.now() }, changedFiles, changedFileCount: changedFiles.length, stagingChanged: false, writers }
}

/** A planning turn answers with a Markdown plan, and waits on the harness's own plan approval where it has one. */
/** What the fixture's side question answers: the rail audit the fixture conversation shows. */
function mockSideAnswer(question: string, earlier: readonly SideExchange[]): { kind: "answered"; text: string } | { kind: "failed"; error: string } {
  if (/\bfail/i.test(question)) return { kind: "failed", error: "The answer stopped partway: the provider closed the connection." }
  if (/in detail|walk me through/i.test(question)) return {
    kind: "answered",
    text: [
      "The rail called `useSession((state) => state)`, so its selector returned the **whole store object**.",
      "",
      "1. Every streamed token replaces the store object, because the store never mutates in place.",
      "2. The hook compares the selected value by identity, sees a new object each time, and re-renders the rail.",
      "3. The rail rebuilds every session row, even though none of them changed.",
      "",
      "Selecting `state.sessions` returns the same array until the session list itself changes, so a token no longer reaches the rail at all.",
    ].join("\n"),
  }
  if (/re-?render|rail|token/i.test(question)) return {
    kind: "answered",
    text: [
      "Because the rail selected the **entire store object**:",
      "",
      "```ts",
      "const sessions = useSession((state) => state)",
      "```",
      "",
      "Each streamed token makes a new store object, so the rail saw a change every time. Selecting `state.sessions` alone means it only wakes when the session list changes.",
    ].join("\n"),
  }
  if (/other|else|left|still/i.test(question)) return {
    kind: "answered",
    text: earlier.length
      ? "Only the **status bar**. It reads five scalars from the store and could collapse them into one shallow-compared selector. `chat-pane.tsx` had the same pattern, but this change deletes it."
      : "The status bar reads five scalars and could collapse them into one shallow-compared selector.",
  }
  return { kind: "answered", text: `That hasn't come up in this conversation yet, so I can't say. Ask the agent once its turn ends.` }
}

/** The mock project's review: Codex names files by absolute path, the others relative to the project. */
function mockReviewReport(root?: string): ReviewReport {
  const at = (path: string) => root ? `${root}/${path}` : path
  return {
    summary: "The retry policy is sound, but it ignores the server's own back-off, and the upload queue can resend a canceled upload.",
    findings: [
      {
        title: "Retries ignore the server's Retry-After header",
        body: "`retry.ts` backs off on its own schedule, so a 429 that asks for 30 seconds is retried after 2. The upload queue then spends its third attempt early and drops the file.",
        path: at("src/net/retry.ts"), line: 42, endLine: 48, priority: 1,
      },
      {
        title: "A canceled upload is sent again",
        body: "`cancel()` clears the timer but leaves the entry in `pending`, so the next retry tick sends it.",
        path: at("src/upload/queue.ts"), line: 88, priority: 2,
      },
      {
        title: "No test covers the last retry",
        body: "`retry.test.ts` stops at the second attempt; the give-up path after the third has no test.",
        path: at("src/net/retry.test.ts"), line: 12, priority: 3,
      },
    ],
  }
}

function mockReply(
  session: LiveSessionState,
  request: LiveRequest,
  tuning: SessionSettings | undefined
): MockReply {
  const user: LiveUpdate = { kind: "user", requestId: request.id, text: request.text }
  const planning = tuning?.options?.plan === true ||
    session.modes.some((mode) => mode.id === session.currentMode && mode.access === "plan")
  if (!planning && /re-?renders? on every token/i.test(request.text)) return { updates: [user, { kind: "text", text: [
    "The rail selected the entire store object, so every streamed token re-rendered it:",
    "",
    "```ts",
    "const sessions = useSession((state) => state)",
    "```",
    "",
    "I changed it to select only `state.sessions`. The status bar reads five scalars the same way; I'll look at it next.",
  ].join("\n") }], changed: true }
  if (!planning) return { updates: [user, { kind: "text", text: `Finished: ${request.text}` }] }
  const id = `mock-plan-${++mockPlans}`
  const subject = request.text.replace(/\s+/g, " ").trim().slice(0, 60) || "the change"
  const text = [
    `# Plan: ${subject}`,
    "",
    "## Context",
    "The composer resolves settings per target; the change touches the state layer and one control, nothing in the host.",
    "",
    "## Steps",
    "1. Add the state in `src/state/` with a pure mapping and tests for each harness shape.",
    "2. Wire the control into the composer's routing row, beside access, and write the new value through `/Users/you/mako/src/components/composer/use-composer-settings.ts` so every target resolves it once.",
    "3. Cover the edge cases: a session that is starting, a launch-only mode, a failed start.",
    "4. Keep the native mode in step: when the harness reports its own mode change, follow it instead of re-sending ours.",
    "",
    "## Files",
    "- `src/state/composer-settings.ts`: the mapping and its target resolution",
    "- `src/components/composer/composer-routing.tsx`: the control beside access",
    "- `scripts/test-composer-settings.ts`: one case per harness shape",
    "",
    "## Risks",
    "- A harness that only accepts the mode at launch: the control locks once the session runs, and says why.",
    "- Two windows changing the same session: the host's value wins and both windows follow it.",
    "",
    "## Verification",
    "- `npm run lint` and `npm run typecheck`",
    "- The plan and approval suites, then a look in the dev desk",
  ].join("\n")
  const updates: LiveUpdate[] = [
    user,
    { kind: "proposed-plan", id, text, status: "proposed", replace: true },
  ]
  const approval = MOCK_PLAN_APPROVALS.get(session.harness)
  if (!approval) return { updates }
  return {
    updates,
    permission: {
      ...approval.request,
      id: `approval-${id}`,
      sessionId: session.id,
      implementsPlan: { plan: id, approve: approval.approve },
    },
  }
}

const MOCK_FAILURES = new Map<ProviderFailureKind, string>([
  ["rate-limited", "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"}}"],
  ["auth", "401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"OAuth token has expired. Please obtain a new token or refresh your existing token.\"}}"],
  ["context-exhausted", "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 213456 tokens > 200000 maximum\"}}"],
  ["transcript-rejected", "400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"messages.14: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01Q8\"}}"],
  ["provider-unavailable", "500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"}}"],
  ["network", "request to https://api.anthropic.com/v1/messages failed, reason: socket hang up"],
  ["plan", "402 Payment Required: your credit balance is too low to access the Anthropic API."],
  ["launch-failed", "claude exited with code 1 during initialize: Error: invalid MCP config at .mcp.json: servers.linear.command must be a string"],
  ["launch-stalled", "Claude Code produced no output for 20s during session/new (initialize had finished; the process is alive)"],
  ["missing-folder", "/Users/you/mako-feature no longer exists. Open this in a folder that exists."],
  ["wrong-account", "This agent is signed in as sam@work.dev, not you@mako.dev, the account this session started with."],
  ["unknown", "The agent ended the turn without a result."],
])

/** The failure a mock message asks for, by its words; see the livePrompt branch that plays it. */
function mockFailure(text: string): { kind: ProviderFailureKind | "uncertain" | "host-quit"; error?: string; started: boolean; unsent: boolean; limit?: number } | undefined {
  if (/hit the usage limit/i.test(text)) {
    const reset = new Date()
    reset.setHours(reset.getHours() + 2, 40, 0, 0)
    return { kind: "rate-limited", error: "Claude AI usage limit reached|" + Math.floor(reset.getTime() / 1000), started: false, unsent: false, limit: reset.getTime() }
  }
  if (/lose the reply/i.test(text)) return { kind: "uncertain", started: true, unsent: false }
  if (/quit mid-?turn/i.test(text)) return { kind: "host-quit", started: true, unsent: false }
  const named = /^fail as ([a-z-]+)/i.exec(text.trim())?.[1]
  const kind = PROVIDER_FAILURE_KINDS.find((candidate) => candidate === named)
  if (!kind) return undefined
  return { kind, error: MOCK_FAILURES.get(kind), started: /after it started/i.test(text), unsent: kind === "missing-folder" || kind === "wrong-account" || kind === "launch-failed" }
}
