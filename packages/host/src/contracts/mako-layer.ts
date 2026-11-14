import { MAKO_COMPUTER_SERVER, MAKO_THREAD_SERVER } from "./mcp-reach.js"
import type { RoutedThread } from "./native-routing.js"

/**
 * The Mako layer: everything Mako adds to an agent, for one launch, written
 * once and harness-blind. The host computes it from the Thread
 * (`layerOf`), never from a harness; each harness's adapter maps it onto
 * that harness's own launch options and declares, capability by capability,
 * how it does so (`LayerCapabilities`). A new harness gets the whole layer
 * by writing one adapter, and the conformance suite grades every adapter on
 * the same cases. Model connections are the driver's own declaration
 * (`ProviderLiveDriver.modelRoutes`, `contracts/model-routes.ts`).
 *
 * The registries below are the only lists to extend: a new Mako tool
 * family, native capability or instruction block is one entry, and every
 * adapter reads it from here.
 */

/** Mako's tool families, each served by one of Mako's servers. `hot`: worth serving in-process where an adapter can. */
export const TOOL_FAMILIES = {
  agents: { server: MAKO_THREAD_SERVER, hot: true },
  worktree: { server: MAKO_THREAD_SERVER, hot: true },
  "pull-request": { server: MAKO_THREAD_SERVER, hot: true },
  app: { server: MAKO_THREAD_SERVER, hot: false },
  recipe: { server: MAKO_THREAD_SERVER, hot: false },
  "thread-history": { server: MAKO_THREAD_SERVER, hot: false },
  show: { server: MAKO_THREAD_SERVER, hot: false },
  computer: { server: MAKO_COMPUTER_SERVER, hot: false },
} as const satisfies Record<string, { server: string; hot: boolean }>
export type ToolFamily = keyof typeof TOOL_FAMILIES

/** What a harness can do natively that Mako supplies instead, by what it does; each adapter knows its own tool names for it. */
export const NATIVE_CAPABILITIES = {
  "spawn-subagent": { by: "agents" },
  "agent-team": { by: "agents" },
  worktree: { by: "worktree" },
  "open-pr": { by: "pull-request" },
  "merge-pr": { by: "pull-request" },
  browser: { by: "computer" },
  computer: { by: "computer" },
} as const satisfies Record<string, { by: ToolFamily }>
export type NativeCapability = keyof typeof NATIVE_CAPABILITIES

/** The named blocks of Mako's instructions, so the suite can check each reached the model and an adapter can place them apart. */
export const INSTRUCTION_BLOCKS = {
  "show-media": { cadence: "session" },
  orchestration: { cadence: "session" },
  routes: { cadence: "session" },
  policy: { cadence: "session" },
  "front-door": { cadence: "per-message" },
  rules: { cadence: "per-message" },
  /** The person's standing rules for every Fin and every Apex (`roleRuleLines`): standing lines of Mako's note, read once and again when they change. */
  "person-rules": { cadence: "session" },
} as const satisfies Record<string, { cadence: "session" | "per-message" }>
export type InstructionBlockId = keyof typeof INSTRUCTION_BLOCKS

export interface InstructionBlock {
  id: InstructionBlockId
  text: string
}

/** One of Mako's servers as this launch reaches it, with the families it serves. */
export interface LayerServer {
  name: string
  url: string
  /** The launch's grant, sent as a bearer token. Host-only: never logged or written to a file. */
  token: string
  families: readonly ToolFamily[]
}

/**
 * A native capability Mako supplies instead, and how firmly. `guide` is the
 * usual one: the tool stays offered, and when the agent uses it a short note
 * names Mako's tool and why, and the agent decides. `intercept` refuses the
 * call, and `remove` takes the tool out at launch: only where using the
 * native tool is clearly wrong for this launch, such as an Apex starting
 * work the person can't see.
 */
export interface Replacement {
  native: NativeCapability
  strength: "remove" | "intercept" | "guide"
}

export interface MakoLayer {
  role: RoutedThread["role"]
  instructions: readonly InstructionBlock[]
  servers: readonly LayerServer[]
  replaces: readonly Replacement[]
  /** The person's own harness setup (settings, instruction files, skills, hooks, MCP) loads as it would without Mako. */
  keepsPersonSetup: true
}

/** Whether a launch replaces `native`, and how strictly. */
export function replacement(layer: MakoLayer, native: NativeCapability): Replacement["strength"] | undefined {
  return layer.replaces.find((each) => each.native === native)?.strength
}

/** Mako's instructions as one text, in block order, for a harness that takes them in one place. */
export function instructionText(layer: MakoLayer): string | undefined {
  return layer.instructions.length ? layer.instructions.map((block) => block.text).join("\n\n") : undefined
}

// ── What an adapter declares ──

/** The contract's own fallbacks, in the order each capability tries them. */
export type LayerFallback =
  /** Instructions in Mako's note before each prompt, which every reader of history strips. */
  | "prompt-note"
  /** A tool that can't be removed is refused per call. */
  | "intercept"
  /** A tool that can't be removed or intercepted is named in the instructions. */
  | "words"
  /** A tool that can't be served in-process is served by Mako's HTTP MCP. */
  | "http-mcp"

/**
 * How one harness does one capability: natively (`via` names the option, in
 * use or not yet), by one of the contract's fallbacks (`loses` says what),
 * or not at all (`reason`).
 */
export type LayerSupport<Via extends string> =
  | { kind: "native"; via: Via; how: string; inUse: boolean; verified?: { version: string; how: string } }
  | { kind: "fallback"; via: LayerFallback; loses: string }
  | { kind: "absent"; reason: string }

export interface LayerCapabilities {
  /** Where Mako's instructions go. Never a slot that replaces the vendor's own prompt. */
  instructions: LayerSupport<"system-append" | "developer-context" | "instructions-file" | "agent-prompt">
  toolServing: LayerSupport<"in-process" | "http-mcp" | "stdio-mcp">
  /** Taking a native tool out of what the model is offered, at launch. */
  removal: LayerSupport<"tool-list" | "config-switch" | "environment-switch">
  /** Answering a native call as it's made: a note naming Mako's tool (the call goes on), or a refusal where the replacement says so. */
  interception: LayerSupport<"pre-tool-hook" | "shell-guard" | "plugin" | "client-hook">
  /** Declaring Mako's subagents, so asking for one lands on Mako's primitive without a refusal. */
  subagents: LayerSupport<"declared">
  hooks: LayerSupport<"sdk-hooks" | "config-hooks" | "plugin" | "client-hooks">
  /** Must stay `kept`: Mako's layer never drops the person's own harness setup. */
  personSetup: "kept"
}

/** One harness's mapping of the layer: its declared capabilities, and the launch fragment its driver passes on. */
export interface LayerAdapter<Fragment> {
  harness: string
  capabilities: LayerCapabilities
  /** Pure: the part of the harness's launch options the layer decides. `conversation` names the launch in logs. */
  apply(layer: MakoLayer, conversation: string): Fragment
}

/**
 * How a replacement is carried out on a harness: removed at launch only when
 * it's `remove` and the harness can; otherwise answered per call (refused for
 * `intercept`, a note for `guide`) where the harness can; otherwise named in
 * the instructions.
 */
export function replacementPath(capabilities: LayerCapabilities, strength: Replacement["strength"]): "removal" | "intercept" | "guide" | "words" {
  if (strength === "remove" && capabilities.removal.kind === "native") return "removal"
  if (capabilities.interception.kind !== "native") return "words"
  return strength === "guide" ? "guide" : "intercept"
}
