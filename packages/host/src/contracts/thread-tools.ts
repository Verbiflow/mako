import type { HostCallReplay } from "./host-call-policy.js"
import type { JsonValue } from "./json.js"
import type { ReturnLanded } from "./cloud-threads.js"

/**
 * The Thread's own place as an agent or a shell moves it: Move to the cloud, Bring it back to this Mac and Continue in
 * the cloud, through the host's own moves (`mako:thread-move`, `mako:thread-return`, `mako:thread-continue`), never a
 * second way. One host call, `mako:threads-move`, is every door's: the in-Thread `mako` server's `thread_move`,
 * `mako thread move` and `mako mcp`.
 */

/** Where a Thread goes: `cloud`, as Move to the cloud (or Continue in the cloud, for another device's Thread while it's off); `back`, as Bring it back to this Mac. */
export type ThreadDestination = "cloud" | "back"

export interface ThreadsMoveInput {
  to: ThreadDestination
  /** The person's own call only (a shell outside any Thread): the conversation whose Thread moves. An agent moves its own. */
  conversation?: string
  /** The caller's own key for this move: a repeat with it joins the same move. */
  clientKey: string
}

/** Why a move wasn't taken up, said as the app says it. */
export type ThreadMoveRefusal = "unavailable" | "no-thread" | "not-yours" | "already-there" | "from-the-mac" | "kept-here"

export interface ThreadMoveRefused {
  refused: ThreadMoveRefusal
  why: string
}

/**
 * What a move came to. An agent's call answers at once: `handing-off` (its running turn pauses here and goes on in the
 * cloud), `after-turn` (it moves once the turn ends) or `asked` (the person decides, above the composer). The person's
 * own call answers as the move ended, in the app's words: `moved`, `kept-here`, `back`, `stayed`, `continued`,
 * `failed`, or `unsettled` while the cloud's answer isn't known.
 */
export type ThreadsMoveResult =
  | { outcome: "handing-off"; move: string; next: string }
  | { outcome: "after-turn"; move: string; next: string }
  | { outcome: "asked"; ask: string; next: string }
  | { outcome: "moved"; cloudThread: string; conversation?: string }
  | { outcome: "back"; landed?: ReturnLanded }
  | { outcome: "continued"; cloudThread: string }
  | { outcome: "kept-here" | "stayed" | "failed" | "unsettled"; reason: string }
  | ThreadMoveRefused

/** What the app does to a Thread from its menu, for `thread`. */
export type ThreadAction = "rename" | "archive" | "restore"

export interface ThreadActInput {
  action: ThreadAction
  /** Rename: the new title. */
  title?: string
  /** The person's own call only (a shell outside any Thread): the conversation whose Thread it is. An agent acts on its own. */
  conversation?: string
  /** The caller's own key for this: a repeat with it is the same action. */
  clientKey: string
}

export type ThreadActRefusal = "unavailable" | "no-thread" | "not-yours" | "no-title" | "failed"

export type ThreadActResult =
  | { outcome: "renamed"; title: string }
  | { outcome: "archived"; next: string }
  | { outcome: "restored" }
  | { outcome: "asked"; ask: string; next: string }
  | { refused: ThreadActRefusal; why: string }

/** Reads what `settings` covers, or changes one. `value` is the setting's own: true or false, a list of harnesses, a model. */
export interface SettingsInput {
  action: "read" | "set"
  /** set: hand-off-on-sleep, continue-after-restart, harness-order, commit-model, keep-awake or keep-awake-lid-closed. */
  setting?: string
  value?: boolean | string | string[]
  /** The caller's own key for this. */
  clientKey: string
}

export type SettingsResult =
  | { outcome: "read"; settings: { handOff: JsonValue; conversations: JsonValue; harnessOrder: JsonValue; keepAwake: JsonValue } }
  /** `note`: kept, but it can't take effect yet, and why. */
  | { outcome: "set"; setting: string; value: boolean | string | string[]; note?: string }
  | { outcome: "asked"; ask: string; next: string }
  | { refused: "unavailable" | "no-thread" | "bad-value" | "failed"; why: string }

/** Reads each harness's versions, or installs or updates one. */
export interface HarnessActInput {
  action: "read" | "install" | "update"
  /** install, update: claude, codex, cursor, grok, opencode or devin. */
  harness?: string
  /** The caller's own key for this. */
  clientKey: string
}

export type HarnessActResult =
  | { outcome: "read"; harnesses: JsonValue }
  | { outcome: "started"; action: string; harness: string; next: string }
  /** `result`: what it came to, when the host says: installed, updated, or unchanged because it was already there. */
  | { outcome: "finished"; action: string; harness: string; result?: string }
  | { outcome: "asked"; ask: string; next: string }
  | { refused: "unavailable" | "no-thread" | "no-harness" | "cloud-machine" | "failed"; why: string }

/**
 * The person's automations (`contracts/automations.ts`), for an agent: read them and their runs, run one now, turn one
 * off, and propose creating, changing, deleting or turning one on, which waits for the person's approval.
 */
export type AutomationAction = "list" | "get" | "runs" | "create" | "update" | "delete" | "enable" | "disable" | "run_now" | "proposal"

export interface AutomationActInput {
  action: AutomationAction
  /** The project folder; absent: the caller's Thread's folder, else the folder in front. */
  project?: string
  /** Every action but list, create and proposal: the automation, as list gives it. create may name it here or in definition. */
  id?: string
  /** create: the whole definition. update: the parts that change, merged over the current one. */
  definition?: JsonValue
  /** create, update, delete, enable: why, in a sentence the person reads with the proposal. */
  why?: string
  /** proposal: the proposal's id, to read how it stands. */
  proposal?: string
  /** runs: at most this many, newest first (default 10). */
  limit?: number
  /** The caller's own key for this: a repeat with it is the same action. */
  clientKey: string
}

export type AutomationActResult =
  | { outcome: "listed"; automations: JsonValue }
  | { outcome: "got"; automation: JsonValue }
  | { outcome: "runs"; runs: JsonValue }
  /** A create, update, delete or enable waits for the person: the agent isn't held, and hears the decision as Mako's note. */
  | { outcome: "proposed"; proposal: string; status: "pending"; expiresAt: string; diff: JsonValue; next: string }
  | { outcome: "proposal"; proposal: JsonValue }
  /** disable and run_now: done now. `run` names the run run_now recorded, and its Thread once it has one. */
  | { outcome: "done"; action: string; id: string; run?: JsonValue }
  | { outcome: "asked"; ask: string; next: string }
  | { refused: "unavailable" | "no-thread" | "no-automation" | "no-project" | "invalid" | "failed"; why: string }

/** One thing a turn waits on, as the agent names it: a Fin of this Thread, a pull request until checks, review or merge, or this Thread's app check under way. */
export type TurnWaitOn = { fin: string } | { pull: string; until?: "checks" | "review" | "merge" } | { check: "quick" | "full"; target?: string }

/**
 * A turn's wait (`contracts/turn-waits.ts`): start one, cancel it, or read it. A start names what it waits on, a time
 * (`seconds` or `at`), or both, the time then the longest it waits; Mako wakes the Thread with a note when it's over.
 */
export interface TurnWaitInput {
  action?: "start" | "cancel" | "list"
  /** start: a few words the person reads while it waits, "Waiting for CI on #412". */
  description?: string
  /** start: up to 16 things to wait on. */
  on?: TurnWaitOn[]
  /** start: seconds to wait, at most 604800 (7 days); with `on`, the longest it waits. */
  seconds?: number
  /** start: an ISO time to wake at, within 7 days; not with seconds. */
  at?: string
  /** start: wake on the first thing (`any`, the default) or the last (`all`). */
  returnWhen?: "any" | "all"
  /** The person's own call only (a shell outside any Thread): the conversation that waits. An agent waits in its own. */
  conversation?: string
  /** The caller's own key for this: a repeat with it is the same wait. */
  clientKey: string
}

export type TurnWaitResult =
  | { outcome: "armed"; wait: string; waitsOn: string[]; endsBy?: string; replaced?: string[]; next: string }
  | { outcome: "already-done"; met: string[]; next: string }
  | { outcome: "cancelled"; wait?: string }
  | { outcome: "listed"; wait?: { id: string; description: string; waitsOn: { what: string; met: boolean }[]; returnWhen: "any" | "all"; endsBy?: string } }
  | { refused: "unavailable" | "no-thread" | "not-yours" | "never" | "too-long" | "invalid" | "unknown-fin"; why: string }

/** What the MCP door shows the model of an operation; its input schema is the host call's. */
export interface ThreadToolDefinition {
  channel: "mako:threads-move" | "mako:threads-act" | "mako:settings-act" | "mako:harnesses-act" | "mako:automations-act" | "mako:turn-wait"
  replay: HostCallReplay
  /** Inputs the MCP door leaves out: an agent moves its own Thread. */
  filled: readonly "conversation"[]
  mcp: {
    name: string
    description: string
    fields: Readonly<Record<string, string>>
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
  }
}

export const THREAD_MOVE_TOOL: ThreadToolDefinition = {
  channel: "mako:threads-move",
  replay: "replay",
  filled: ["conversation"],
  mcp: {
    name: "thread_move",
    description: [
      "Move this Thread to the cloud, as Move to the cloud does in the app: its worktree, branch, files and every Session in it. Call it when the person asks to continue, move or hand off this work to the cloud, or to keep it going while their Mac is closed or off. Not agents_start: a Fin is new work beside this Thread, which stays on this Mac.",
      "On full access it goes now; on other access Mako asks the person first.",
      "A Thread in its own worktree hands off: keep working, and your turn pauses here and goes on in the cloud. One in the main checkout moves onto its own branch first, once your turn ends.",
      "In a cloud Thread, to: back asks the person to bring it back.",
    ].join(" "),
    fields: {
      to: "cloud, or back from a cloud Thread.",
      clientKey: "Your own key for this move: a repeat with it is the same move.",
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
}

export const THREAD_ACT_TOOL: ThreadToolDefinition = {
  channel: "mako:threads-act",
  replay: "replay",
  filled: ["conversation"],
  mcp: {
    name: "thread",
    description: "Rename, Archive or Restore this Thread, as its menu does in the app. Call it when the person asks, or to give this Thread the title its work earned. On full access it happens now; on other access Mako asks the person first. Archive once the work is finished: it leaves the list, and a turn still running stops.",
    fields: {
      action: "rename, archive or restore.",
      title: "rename: the new title.",
      clientKey: "Your own key for this: a repeat with it is the same action.",
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
}

export const SETTINGS_TOOL: ThreadToolDefinition = {
  channel: "mako:settings-act",
  replay: "replay",
  filled: [],
  mcp: {
    name: "settings",
    description: "Read or change the settings an agent may change for the person, as Settings does: hand-off-on-sleep, continue-after-restart, harness-order, commit-model, keep-awake and keep-awake-lid-closed. Call it when the person asks for one of these. read answers at once; set happens now on full access, and on other access Mako asks the person first. Sign-ins, access and spend are the person's own: this can't change them.",
    fields: {
      action: "read or set.",
      setting: "set: which one.",
      value: "set: true or false, a list of harnesses first to last, or a model.",
      clientKey: "Your own key for this: a repeat with it is the same change.",
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
}

export const HARNESS_TOOL: ThreadToolDefinition = {
  channel: "mako:harnesses-act",
  replay: "replay",
  filled: [],
  mcp: {
    name: "harness",
    description: "Read each harness's installed and latest versions, or Install or Update one, as Settings › Harnesses does. Call it when the person asks, or when a harness you need is missing or too old. read answers at once; install and update start now on full access, and on other access Mako asks the person first.",
    fields: {
      action: "read, install or update.",
      harness: "install, update: claude, codex, cursor, grok, opencode or devin.",
      clientKey: "Your own key for this: a repeat with it is the same action.",
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
}

export const AUTOMATION_TOOL: ThreadToolDefinition = {
  channel: "mako:automations-act",
  replay: "never",
  filled: [],
  mcp: {
    name: "automation",
    description: "The person's automations: prompts Mako starts as Threads on a schedule, on a commit or on Run now. list, get and runs read; disable and run_now act now (on full access, else after the person allows). create, update, delete and enable are proposals the person approves: you get {proposal, status: pending} at once and hear the decision later, so go on. Call it when the person asks.",
    fields: {
      action: "list, get, runs, create, update, delete, enable, disable, run_now, or proposal (how one stands).",
      project: "The project folder; absent: this Thread's.",
      id: "The automation's id, from list.",
      definition: "create: {id, name, prompt: {objective, doneWhen, boundaries, output}, start, triggers, gate, limits, result}. update: only what changes.",
      why: "create, update, delete, enable: one sentence the person reads.",
      proposal: "proposal: its id.",
      limit: "runs: at most this many.",
      clientKey: "Your own key for this: a repeat with it is the same action.",
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
}

export const WAIT_TOOL: ThreadToolDefinition = {
  channel: "mako:turn-wait",
  replay: "replay",
  filled: ["conversation"],
  mcp: {
    name: "wait",
    description: [
      "Wait for your Fins, a pull request or a time, then end your turn: Mako wakes this Thread with a note once it's over, so never poll or sleep.",
      "Name what you wait on in `on` ({fin: name} for its next result or end; {pull: \"owner/name#412\", until: checks|review|merge}; {check: quick|full} for this Thread's app check under way, which app_check left running), a time (`seconds`, or `at` as an ISO time), or both, the time then the longest it waits; up to 7 days.",
      "`returnWhen: all` wakes on the last instead of the first. One wait per Thread: a new one replaces the last. A wait that could never end is refused.",
      "action cancel ends it; list says what it waits on. agents_wait is for a result you need within 30 seconds.",
    ].join(" "),
    fields: {
      action: "start (the default), cancel or list.",
      description: "start: 5 to 10 words the person reads while it waits, \"Waiting for CI on #412\".",
      on: "start: what to wait on, up to 16: {fin}, {pull, until} or {check}.",
      seconds: "start: how long to wait, at most 604800 (7 days); with on, the longest.",
      at: "start: an ISO time to wake at, within 7 days; not with seconds.",
      returnWhen: "start: any (the default) or all.",
      clientKey: "Your own key for this: a repeat with it is the same wait.",
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
}

/** Every tool on a `mako` server that acts for the person through one host call. */
export const THREAD_TOOLS: readonly ThreadToolDefinition[] = [THREAD_MOVE_TOOL, THREAD_ACT_TOOL, SETTINGS_TOOL, HARNESS_TOOL, AUTOMATION_TOOL, WAIT_TOOL]

/** What a wait's answer tells an agent to do next. */
export const AFTER_WAIT = {
  armed: "End your turn now: Mako wakes this Thread with a note when the wait is over. Don't poll or sleep meanwhile.",
  alreadyDone: "Everything it names is done already: go on in this turn.",
} as const

/** What an answer tells an agent to do next. */
export const AFTER_ACT = {
  asked: "Asked the person: their answer is in a card above the composer. Keep working; it happens once they allow it.",
  archived: "Archived. If your work is done, end your turn: the Thread stays archived until the person restores it.",
  started: "It's under way and goes on without you, and it may still fail. Read harness again: its result says how it ended. Settings › Harnesses shows it too.",
} as const

/** What a move's answer tells an agent to do next. */
export const AFTER_MOVE = {
  handingOff: "Mako hands this Thread to the cloud now. Keep working as you were: in a few seconds this turn pauses here, and it goes on in the cloud from where it paused, in the same worktree and branch. If your work is done, end your turn; the Thread still moves.",
  afterTurn: "This Thread is in the main checkout, so it moves onto its own branch and then to the cloud once this turn ends. Finish now: make no further edits here, tell the person it continues in the cloud, and end your turn. Its next message runs there.",
  askedBack: "Asked the person: their answer is in a card above the composer. If they allow it, this Thread goes back to its Mac and this machine ends, so push or commit what you need kept. Until then, keep working here.",
  asked: (handsOff: boolean) => `Asked the person: their answer is in a card above the composer. If they allow it, the Thread moves to the cloud${handsOff ? "; if your turn is still running then, it pauses here and goes on there" : ", onto its own branch first, once this turn ends"}. Until then, keep working here.`,
} as const
