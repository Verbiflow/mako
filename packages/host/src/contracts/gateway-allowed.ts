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
  "mako:thread-move",
  "mako:thread-return",
  "mako:worktrees",
  "mako:harness-tuning",
  "mako:harness-order-saved",
  "mako:fin-defaults",
  "mako:fin-limit-set",
  "mako:resolve-file-references",
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
 * What a machine (`gateway:runtime:…`: a cloud machine, or a Mac borrowing a simulator under a lease) may call: a
 * Thread's agent's own doors, each of which takes a machine only as its agent, never as the person (`machineCall`);
 * a borrowed simulator; and a Thread's moves. Everything else on `GATEWAY_ALLOWED` is the person's, from a device of
 * theirs: a machine that could start an agent here (`mako:live-start`), make a Session, run an app, or answer an
 * approval would act on this Mac as the person, which a compromised or prompt-injected machine must never do.
 */
const MACHINE_ALLOWED_CALLS: readonly string[] = [
  "mako:agents-start", "mako:agents-list", "mako:agents-read", "mako:agents-send", "mako:agents-answer", "mako:agents-stop",
  "mako:agents-move", "mako:agents-report", "mako:agents-wait", "mako:agents-link", "mako:agents-settle",
  "mako:threads-move", "mako:threads-act", "mako:settings-act", "mako:automations-act", "mako:harnesses-act",
  "mako:simulators-list", "mako:simulators-open", "mako:simulators-act", "mako:simulators-read", "mako:simulators-shot",
  "mako:simulators-record", "mako:simulators-release", "mako:simulators-watch",
  "mako:move-stage", "mako:move-arrive", "mako:move-ready", "mako:move-depart", "mako:move-stay", "mako:move-follow",
]

export const MACHINE_ALLOWED: ReadonlySet<string> = new Set(MACHINE_ALLOWED_CALLS)

/** How the gateway names a machine's calls (`gatewayClientId`): `gateway:runtime:<runtime>`. */
export const MACHINE_CALLER = "gateway:runtime:"

/** Why a machine was refused a call that is the person's. */
export const MACHINE_REFUSED = "A machine calls as its Thread's agent, never as the person: this call is the person's"

/**
 * The runtime id the gateway itself stamps when it acts on a Thread (`gateway:<thread>`), as it does to see whether a
 * machine's conversation still runs before packing the Thread off it (mako-cloud's `#depart`). No machine can claim
 * it: a machine's own id is its runtime's.
 */
export const GATEWAY_RUNTIME = "gateway:"

/** What the gateway itself may ask of a machine beyond a machine's own calls: whether a conversation still runs. */
export const GATEWAY_RUNTIME_ALLOWED: ReadonlySet<string> = new Set(["mako:live-state"])

/** Whether a runtime caller (`runtimeId`) may make `channel`: a machine its own calls, the gateway also a conversation's state. */
export function runtimeAllows(channel: string, runtimeId: string): boolean {
  return MACHINE_ALLOWED.has(channel) || (runtimeId.startsWith(GATEWAY_RUNTIME) && GATEWAY_RUNTIME_ALLOWED.has(channel))
}

/** Whether a `gateway:` caller may make `channel`: a person's device anything allowed, a machine only its own. */
export function gatewayAllows(channel: string, client: string): boolean {
  return GATEWAY_ALLOWED.has(channel) && (!client.startsWith(MACHINE_CALLER) || runtimeAllows(channel, client.slice(MACHINE_CALLER.length)))
}
