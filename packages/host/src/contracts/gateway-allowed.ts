import { conversationCalls } from "./conversation-calls.js"

/**
 * The host calls another device may make through the gateway, each because a client that reaches a host that way
 * sends it: everything else a host answers is for its own windows on its own socket, and is refused to a `gateway:`
 * caller (`fromHostOperation`). Any device on the account reaches a host through the gateway, so a call is added here
 * only for a sender that needs it, and a call that names a path confines it to the Thread's folders
 * (`WorkspaceFiles.read`'s `confined`). Kept apart from what those senders import, so the host's list and theirs
 * can't drift silently: `scripts/test-host-gateway.ts` holds each entry to a declared host call.
 */
const ALLOWED: readonly string[] = [
  // A conversation's calls, sent to the host running it by the web app, the phone, the CLI and another Mac's windows
  // (`conversationCalls`, which `mako:read-live-file` is among, confined); and those whose target names one.
  ...conversationCalls,
  "mako:thread-controls",
  "mako:thread-stop",
  "mako:workspace-move-hold",
  // The web app and phone (`src/web-client`): its boot, starting a conversation, its rail's Thread actions and
  // worktrees, the harness picker and Fin defaults, and the file links a reply names.
  "mako:boot",
  "mako:live-start",
  "mako:live-state",
  "mako:live-capture",
  "mako:live-close",
  "mako:thread-create-session",
  "mako:thread-archive",
  "mako:thread-rename",
  "mako:thread-mark",
  // An Apex's digest and plan on the phone and iPad: read, and a plan line checked off.
  "mako:apexes",
  "mako:apex-plan-read",
  "mako:apex-plan-check",
  "mako:apex-plan-answer",
  "mako:apex-seen",
  "mako:thread-move",
  "mako:thread-return",
  "mako:worktrees",
  "mako:harness-tuning",
  "mako:harness-order-saved",
  "mako:fin-defaults",
  "mako:fin-limit-set",
  "mako:resolve-file-references",
  // The browser's Pull requests page: a project's lists, asked of the computer that runs it, and one pull request
  // opened. They read the named folders' Git remotes and GitHub, nothing else of the folders, and change nothing.
  "mako:project-board",
  "mako:board-pull",
  // A Mac's host for a Thread on a cloud machine or another device (`cloud-conversations`, `cloud-moves`,
  // `cloud-returns`, `cloud-follow`, `cloud-archives`): preparing and starting it there, and its moves either way.
  "mako:cloud-prepare",
  "mako:cloud-offer-projects",
  "mako:live-continue-turn",
  "mako:move-stage",
  "mako:move-arrive",
  "mako:move-ready",
  "mako:move-depart",
  "mako:move-stay",
  "mako:move-follow",
  // A window looking at a conversation whose folder is a cloud machine's (`ELSEWHERE_CALLS`, `ELSEWHERE_APP_CALLS`):
  // its files and its Git there, and its app; `mako:read-file` is confined as a conversation's read is.
  "mako:list-files",
  "mako:files-folders",
  "mako:files-find",
  "mako:files-grep",
  "mako:read-file",
  "mako:search",
  "mako:git-status",
  "mako:git-diff",
  "mako:git-diff-all",
  "mako:git-log",
  "mako:git-commit-files",
  "mako:git-commit-file-diff",
  "mako:git-commit-diff-all",
  "mako:git-changed-since",
  "mako:git-since-diff",
  "mako:git-default-branch",
  "mako:git-remote",
  "mako:git-select-repository",
  "mako:git-doctor",
  "mako:git-stage",
  "mako:git-unstage",
  "mako:git-stage-all",
  "mako:git-unstage-all",
  "mako:git-discard",
  "mako:git-restore-discarded",
  "mako:git-commit",
  "mako:git-push",
  "mako:thread-app",
  "mako:thread-app-start",
  "mako:thread-app-stop",
  "mako:thread-app-restart",
  "mako:thread-app-check",
  "mako:thread-app-output",
  "mako:thread-app-probe",
  "mako:thread-app-make-room",
  "mako:thread-app-take-turn",
  // A Fin placed on another device (`agent-places`), and its Apex's operations on it, with the Apex as the caller.
  "mako:agents-capabilities",
  "mako:agents-place",
  "mako:agents-notice",
  "mako:agents-cancel",
  "mako:agents-start",
  "mako:agents-list",
  "mako:agents-read",
  "mako:agents-send",
  "mako:agents-answer",
  "mako:agents-stop",
  "mako:agents-move",
  // A Thread's agent on a cloud machine calls the tools of the host that holds its Thread, as its agent (`machineCall`:
  // a machine is never the person at these doors), and the person's own device calls them as the person.
  "mako:agents-report",
  "mako:agents-wait",
  "mako:agents-link",
  "mako:agents-settle",
  "mako:threads-move",
  "mako:threads-act",
  "mako:settings-act",
  "mako:automations-act",
  "mako:apex-act",
  "mako:memory-save",
  // The person's Mac reads a cloud run's agent's proposals from its cloud Thread's host, and says how each went there
  // (`AutomationCloud`): the project's file, and so the decision, is the Mac's.
  "mako:automations-forwarded",
  "mako:automations-forward-settle",
  // The account starts a cloud run on its Thread's host, as the Mac that registered it, mapped as a run on that Mac is.
  "mako:automations-cloud-start",
  "mako:harnesses-act",
  // A simulator another device borrows under a lease (`BorrowedSimulators`), with its caller stamped by the host.
  "mako:simulators-list",
  "mako:simulators-open",
  "mako:simulators-act",
  "mako:simulators-read",
  "mako:simulators-shot",
  "mako:simulators-record",
  "mako:simulators-release",
  "mako:simulators-watch",
]

export const GATEWAY_ALLOWED: ReadonlySet<string> = new Set(ALLOWED)

/**
 * What a runtime caller (`gateway:runtime:…`) may call. The gateway refuses any connection that names an actor but
 * its own device's client (the gateway's hub), so a runtime actor reaches a host only two ways: the gateway itself,
 * acting on a Thread (`gateway:<thread>`, `GATEWAY_RUNTIME_ALLOWED`), and a simulator borrower under a lease, which
 * stamps its own actor and so may say anything of itself. Neither runs a Thread on this host, so neither may act as a
 * Thread's agent here (`agents-*`, `threads-*`, `settings-act`, …: their caller names a session, and nothing ties
 * it to the runtime), nor as the person: a borrower reaches its simulator, and nothing else. The one `agents-*` call
 * the gateway makes as itself is a notice's delivery, which names no caller (`GATEWAY_RUNTIME`).
 */
const MACHINE_ALLOWED_CALLS: readonly string[] = [
  "mako:simulators-list", "mako:simulators-open", "mako:simulators-act", "mako:simulators-read", "mako:simulators-shot",
  "mako:simulators-record", "mako:simulators-release", "mako:simulators-watch",
]

export const MACHINE_ALLOWED: ReadonlySet<string> = new Set(MACHINE_ALLOWED_CALLS)

/** How the gateway names a runtime's calls (`gatewayClientId`): `gateway:runtime:<runtime>`. */
export const MACHINE_CALLER = "gateway:runtime:"

/** Why a runtime was refused a call that is the person's or a Thread's agent's. */
export const MACHINE_REFUSED = "A machine runs no Thread here, so it calls neither as the person nor as a Thread's agent"

/**
 * The runtime id the gateway itself stamps when it acts on a Thread (`gateway:<thread>`). A borrower writes its own
 * actor, so this is no proof on its own: what it opens is only what the gateway sends a host as itself. To a machine
 * (the gateway's `#callMachine`) that is reading a conversation's state and a Thread's departure or stay. To a device
 * it is a Fin's notice the account held for its Apex's Session (`mako:agents-notice` as `TREE_NOTICE_OP` delivers it),
 * and nothing else of an agent's door, never a start. A host can't tell an operation the gateway made from one a
 * borrower wrote, so the notice rests on the account's own rule that a lease's calls reach a device only as the
 * operations of what it lent (a simulator's): under it a notice with this id is the account's alone. `Agents.notice`
 * takes the account's word on who sent one (`from`) from this caller only, and holds it to the Fin's own start, place
 * and Apex before it keeps anything.
 */
export const GATEWAY_RUNTIME = "gateway:"

/**
 * What the gateway itself asks of a host: of a machine as it packs a Thread off it, whether a conversation runs, and
 * the move; of a device, to take a notice it held for one of its Apexes.
 */
export const GATEWAY_RUNTIME_ALLOWED: ReadonlySet<string> = new Set([
  "mako:live-state", "mako:move-depart", "mako:move-stay", "mako:move-stage", "mako:move-arrive", "mako:move-ready", "mako:move-follow",
  "mako:agents-notice",
])

/** Whether a runtime caller (`runtimeId`) may make `channel`: a borrower its simulator, the gateway also its moves and its notices. */
export function runtimeAllows(channel: string, runtimeId: string): boolean {
  return MACHINE_ALLOWED.has(channel) || (runtimeId.startsWith(GATEWAY_RUNTIME) && GATEWAY_RUNTIME_ALLOWED.has(channel))
}

/** Whether a `gateway:` caller may make `channel`: a person's device anything allowed, a runtime only its own. */
export function gatewayAllows(channel: string, client: string): boolean {
  return GATEWAY_ALLOWED.has(channel) && (!client.startsWith(MACHINE_CALLER) || runtimeAllows(channel, client.slice(MACHINE_CALLER.length)))
}
