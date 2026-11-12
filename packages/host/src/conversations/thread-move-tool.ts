import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { MethodTable } from "../base/methods.js"
import { machineCall, NOT_THE_PERSON } from "../base/host-client.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { AccessTier } from "../contracts/access.js"
import type { AgentCaller } from "../contracts/agents.js"
import type { ThreadContinueOutcome, ThreadHandOff, ThreadMoveOutcome, ThreadReturnOutcome } from "../contracts/cloud-threads.js"
import { hostCallSchema } from "../contracts/host-call-inputs.js"
import type { AgentAskWant } from "../contracts/agent-asks.js"
import { AFTER_MOVE, THREAD_TOOLS, type ThreadMoveRefused, type ThreadToolDefinition, type ThreadsMoveInput, type ThreadsMoveResult } from "../contracts/thread-tools.js"
import { namedUuid } from "./cloud-moves.js"
import type { AgentAskGate } from "./agent-ask-gate.js"
import { logMoveDiagnostic, moveDiagnosticReason } from "./move-diagnostics.js"

/** Where a conversation's Thread runs, as its row says it: here, in the cloud, or on another device. */
export type ThreadPlace = "here" | "cloud" | "device"

/** The host's own moves, as the app presses them: `mako:thread-move`, `mako:thread-return` and `mako:thread-continue`. */
export interface HostMoves {
  move(conversationId: string, move: string, handOff?: ThreadHandOff): Promise<ThreadMoveOutcome>
  /** Why a handoff of the Thread couldn't go now, read without changing anything; undefined when it could. */
  refusal(conversationId: string): Promise<string | undefined>
  bringBack(conversationId: string, move: string): Promise<ThreadReturnOutcome>
  continue(conversationId: string, op: string): Promise<ThreadContinueOutcome>
}

export interface ThreadMoveToolDeps {
  /** The conversation a Session's agent runs in here. */
  conversationOf(session: string): string | undefined
  place(conversationId: string): ThreadPlace | undefined
  tier(conversationId: string): AccessTier | undefined
  /** In a turn, or holding prompts that will start one. */
  busy(conversationId: string): boolean
  /** The Thread works in its own worktree, from which a move hands off. */
  ownWorktree(conversationId: string): boolean
  /** This host is a cloud machine: its Threads are brought back from their Mac. */
  machine: boolean
  moves(): HostMoves | undefined
  /** Where an agent's asks wait for the person. */
  gate: AgentAskGate
  /** How long after an agent's answer its handoff starts, so the answer reaches it first. */
  handOffAfterMs?: number
}

type Pending = { conversationId: string; move: string }

const refused = (reason: ThreadMoveRefused["refused"], why: string): ThreadMoveRefused => ({ refused: reason, why })

/**
 * An agent's or a shell's move of a Thread between this Mac and the cloud, through the moves the app presses. An agent
 * moves its own Thread: on full access at once, below it once the person allows it (`AgentAsk`).
 * A Thread in its own worktree hands off, its running turn paused here and going on in the cloud; one in the main
 * checkout waits for its turns to end, then goes onto its own branch and to the cloud, as Move to the cloud does. The
 * person's own call (a shell outside a Thread) names the conversation and waits for the move's end.
 */
export class ThreadMoveTool {
  readonly #deps: ThreadMoveToolDeps
  /** Moves of Threads in the main checkout, waiting for their turns to end. */
  readonly #afterTurn = new Map<string, Pending>()

  constructor(deps: ThreadMoveToolDeps) {
    this.#deps = deps
  }

  async move(caller: AgentCaller, input: ThreadsMoveInput): Promise<ThreadsMoveResult> {
    const own = caller.kind === "agent" ? this.#deps.conversationOf(caller.session) : undefined
    if (caller.kind === "agent" && !own) {
      if (this.#deps.machine) return this.#fromTheMac(input, undefined)
      return refused("no-thread", "No conversation here has that Session. Call it from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it.")
    }
    if (own && input.conversation && input.conversation !== own) return refused("not-yours", "An agent moves its own Thread only: leave conversation out.")
    const conversationId = own ?? input.conversation
    if (!conversationId) return refused("no-thread", "Name the conversation whose Thread moves (--conversation), or call it from a Thread's shell.")
    if (this.#deps.machine) return this.#fromTheMac(input, own)
    const moves = this.#deps.moves()
    if (!moves) return refused("unavailable", "Moving to the cloud needs this Mac signed in to Mako Cloud.")
    const place = this.#deps.place(conversationId)
    if (!place) return refused("no-thread", "Mako doesn't know that conversation here.")
    const key = namedUuid(`thread move\0${caller.kind === "agent" ? caller.session : "person"}\0${input.clientKey}`)
    if (input.to === "back") {
      if (place === "here") return refused("already-there", "This Thread runs on this Mac already.")
      if (place === "device") return refused("not-yours", "This Thread runs on another device: bring it back from there, or continue it in the cloud.")
      return returned(await moves.bringBack(conversationId, key))
    }
    if (place === "cloud") return refused("already-there", "This Thread runs in the cloud already.")
    if (place === "device") {
      if (own) return refused("not-yours", "An agent moves its own Thread only.")
      return continued(await moves.continue(conversationId, key))
    }
    if (!own) return moved(await moves.move(conversationId, key, this.#deps.busy(conversationId) ? { why: "asked" } : undefined))
    const handsOff = this.#deps.ownWorktree(conversationId)
    if (handsOff) {
      const refusal = await moves.refusal(conversationId)
      if (refusal) return refused("kept-here", refusal)
    }
    if (this.#deps.tier(conversationId) !== "full") return this.#ask(conversationId, key, handsOff)
    return this.#go(conversationId, key, handsOff)
  }

  /** The person allowed an agent's ask: the Thread moves as a full-access agent's would, if it's still here. */
  allowed(conversationId: string, want: Extract<AgentAskWant, { kind: "move" }>): void {
    if (this.#deps.place(conversationId) === "here") this.#go(conversationId, want.move, this.#deps.ownWorktree(conversationId))
  }

  /** Acknowledge the person's choice on its cloud owner; the answering client opens Bring it back on their Mac. */
  allowedBack(conversationId: string): void {
    if (!this.#deps.machine || !this.#deps.place(conversationId)) throw new Error("That cloud Thread is no longer here to answer. Open its Thread on your Mac to bring it back.")
    // No host move runs here, and this acknowledgement says nothing of whether the client completed its return.
  }

  /** A conversation's turn ended: a move waiting for it goes now. */
  settled(conversationId: string): void {
    const pending = this.#afterTurn.get(conversationId)
    if (!pending || this.#deps.busy(conversationId)) return
    this.#afterTurn.delete(conversationId)
    this.#start(pending.conversationId, pending.move)
  }

  /** Whether a move of this conversation's Thread waits: on the person, or on its turns. */
  pending(conversationId: string): boolean {
    return this.#afterTurn.has(conversationId) || this.#deps.gate.open(conversationId).some((ask) => ask.want.kind === "move")
  }

  #ask(conversationId: string, move: string, handsOff: boolean): ThreadsMoveResult {
    const ask = this.#deps.gate.ask(conversationId, { kind: "move", move, handsOff }, (open) => open.kind === "move")
    return { outcome: "asked", ask: ask.id, next: AFTER_MOVE.asked(ask.want.kind === "move" ? ask.want.handsOff : handsOff) }
  }

  #go(conversationId: string, move: string, handsOff: boolean): ThreadsMoveResult {
    if (handsOff) {
      // After the agent's answer reaches it: the handoff pauses the very turn that asked.
      setTimeout(() => this.#start(conversationId, move, { why: "asked" }), this.#deps.handOffAfterMs ?? 1_000).unref?.()
      return { outcome: "handing-off", move, next: AFTER_MOVE.handingOff }
    }
    this.#afterTurn.set(conversationId, { conversationId, move })
    this.settled(conversationId)
    return { outcome: "after-turn", move, next: AFTER_MOVE.afterTurn }
  }

  #start(conversationId: string, move: string, handOff?: ThreadHandOff): void {
    const moves = this.#deps.moves()
    if (!moves) return logMoveDiagnostic(() => hostWarn("thread-moves", "an agent's move found this Mac signed out of the cloud", { conversation: conversationId, move, stage: "dispatch", ...moveDiagnosticReason({ error: "Moving to the cloud needs this Mac signed in to Mako Cloud." }) }))
    // Its steps reach the window as the app's own move's do (`thread-move-step`).
    void Promise.resolve().then(() => moves.move(conversationId, move, handOff)).then(
      (outcome) => logMoveDiagnostic(() => hostLog("thread-moves", "an agent's move ended", { conversation: conversationId, move, outcome: outcome.kind, ...outcome.kind === "kept-here" && { stage: "move-result", ...moveDiagnosticReason({ error: outcome.reason }) } })),
      (error) => logMoveDiagnostic(() => hostWarn("thread-moves", "an agent's move failed", { conversation: conversationId, move, stage: "move-call", ...moveDiagnosticReason({ error }) })),
    )
  }

  /** A cloud machine can't reach its Mac: its agent asks, and the person's allow presses Bring it back where they are. */
  #fromTheMac(input: ThreadsMoveInput, own: string | undefined): ThreadsMoveResult {
    if (input.to === "cloud") return refused("already-there", "This Thread runs in the cloud already.")
    if (!own) return refused("from-the-mac", "A cloud Thread comes back from the Mac it came from: the person presses Bring it back to this Mac there, or runs `mako thread move back --conversation <id>` in a shell on it.")
    return { outcome: "asked", ask: this.#deps.gate.ask(own, { kind: "back" }).id, next: AFTER_MOVE.askedBack }
  }
}

function moved(outcome: ThreadMoveOutcome): ThreadsMoveResult {
  if (outcome.kind === "moved" || outcome.kind === "released") return { outcome: "moved", cloudThread: outcome.cloudThread, ...(outcome.kind === "moved" && outcome.conversation && { conversation: outcome.conversation }) }
  return { outcome: outcome.kind, reason: outcome.reason }
}

function returned(outcome: ThreadReturnOutcome): ThreadsMoveResult {
  if (outcome.kind === "back") return { outcome: "back", ...(outcome.landed && { landed: outcome.landed }) }
  return { outcome: outcome.kind, reason: outcome.reason }
}

function continued(outcome: ThreadContinueOutcome): ThreadsMoveResult {
  if (outcome.kind === "continued") return { outcome: "continued", cloudThread: outcome.cloudThread }
  return outcome.kind === "failed" ? { outcome: "failed", reason: outcome.reason } : { outcome: "unsettled", reason: "This host stopped following the continue; its steps say how it ends." }
}

/** `mako:threads-move`, and the person's answers to agents' asks. */
export function declareThreadMoveMethods(methods: MethodTable, tool: () => Pick<ThreadMoveTool, "move"> | undefined): void {
  methods.handle("mako:threads-move", (caller: AgentCaller, input: ThreadsMoveInput) =>
    caller.kind === "person" && machineCall() ? refused("not-yours", NOT_THE_PERSON) : (tool()?.move(caller, input) ?? refused("unavailable", "This host doesn't move Threads.")))
}

/** The MCP input schema of a Thread tool: its host call's generated schema, less what the door fills in. */
export function threadToolSchema(tool: ThreadToolDefinition): z.ZodType {
  const input = hostCallSchema(tool.channel).def.items[1]
  if (!(input instanceof z.ZodObject)) throw new Error(`${tool.channel}'s input isn't an object`)
  const generated = z.toJSONSchema(input, { io: "input" })
  const asked = (field: string) => !tool.filled.some((filled) => filled === field)
  const properties = Object.entries(generated.properties ?? {}).flatMap(([field, schema]): [string, z.core.JSONSchema._JSONSchema][] => {
    if (!asked(field)) return []
    const description = tool.mcp.fields[field]
    return [[field, description && schema !== true && schema !== false ? { ...schema, description } : schema]]
  })
  return z.fromJSONSchema({ ...generated, properties: Object.fromEntries(properties), required: generated.required?.filter(asked) })
}

/** A move's answer as a door relays it: the JSON the host sent, a refusal named by `refused`. */
export const ThreadMoveAnswerSchema = z.looseObject({ refused: z.string().optional(), outcome: z.string().optional() })
export type ThreadMoveAnswer = z.infer<typeof ThreadMoveAnswerSchema>

export interface ThreadToolDoor {
  /** Calls the host as a client would, its answer parsed (`ThreadMoveAnswerSchema`). */
  invoke(channel: ThreadToolDefinition["channel"], args: unknown[]): Promise<ThreadMoveAnswer>
  caller(): AgentCaller
}

const ToolArgumentsSchema = z.record(z.string(), z.json())

/** What a door says back: the answer as JSON, a refusal's first line naming it. */
export function threadToolText(answer: ThreadMoveAnswer): string {
  const json = JSON.stringify(answer, null, 2)
  return answer.refused === undefined ? json : `refused: ${answer.refused}\n${json}`
}

/** Every Thread tool on a `mako` server, each projected from its definition. */
export function registerThreadTools(server: McpServer, door: ThreadToolDoor): void {
  for (const tool of THREAD_TOOLS) {
    const { mcp } = tool
    server.registerTool(mcp.name, { description: mcp.description, inputSchema: threadToolSchema(tool), annotations: mcp.annotations }, async (input) => {
      try {
        const answer = await door.invoke(tool.channel, [door.caller(), ToolArgumentsSchema.parse(input)])
        return { ...(answer.refused !== undefined && { isError: true }), content: [{ type: "text" as const, text: threadToolText(answer) }] }
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }
      }
    })
  }
}
