import { z } from "zod"
import { machineCall, NOT_THE_PERSON } from "../base/host-client.js"
import type { MethodTable } from "../base/methods.js"
import type { AccessTier } from "../contracts/access.js"
import type { AgentAskWant } from "../contracts/agent-asks.js"
import type { AgentCaller } from "../contracts/agents.js"
import type { JsonValue } from "../contracts/json.js"
import { AFTER_ACT, type ThreadActInput, type ThreadActResult } from "../contracts/thread-tools.js"
import type { AgentAskGate } from "./agent-ask-gate.js"
import { namedUuid } from "./cloud-moves.js"

export interface ThreadActToolDeps {
  /** The conversation a Session's agent runs in here. */
  conversationOf(session: string): string | undefined
  /** The Thread a conversation is in, as `mako:thread-rename` names it. */
  threadOf(conversationId: string): string | undefined
  tier(conversationId: string): AccessTier | undefined
  /** A host call through the table every client calls: Rename and Archive as the app presses them. */
  invoke(channel: "mako:thread-rename" | "mako:thread-archive", args: unknown[]): Promise<JsonValue | undefined>
  gate: AgentAskGate
}

const ArchiveAnswerSchema = z.object({ cloud: z.object({ kind: z.string(), reason: z.string().optional().default("The cloud refused it.") }).loose().optional() }).loose()

type Done = Extract<ThreadActResult, { outcome: "renamed" | "archived" | "restored" }>
type Act = Extract<AgentAskWant, { kind: "rename" | "archive" | "restore" }>

/**
 * An agent's or a shell's Rename, Archive and Restore of a Thread, through the host calls the app presses. An agent acts
 * on its own Thread: on full access at once, below it once the person allows it. The person's own call (a shell outside
 * a Thread) names the conversation.
 */
export class ThreadActTool {
  readonly #deps: ThreadActToolDeps

  constructor(deps: ThreadActToolDeps) {
    this.#deps = deps
  }

  async act(caller: AgentCaller, input: ThreadActInput): Promise<ThreadActResult> {
    const own = caller.kind === "agent" ? this.#deps.conversationOf(caller.session) : undefined
    if (caller.kind === "agent" && !own) return { refused: "no-thread", why: "No conversation here has that Session. Call it from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it." }
    if (own && input.conversation && input.conversation !== own) return { refused: "not-yours", why: "An agent acts on its own Thread only: leave conversation out." }
    const conversationId = own ?? input.conversation
    if (!conversationId) return { refused: "no-thread", why: "Name the conversation (--conversation), or call it from a Thread's shell." }
    if (input.action === "rename" && !input.title?.trim()) return { refused: "no-title", why: "Rename needs a title." }
    const op = namedUuid(`thread act\0${caller.kind === "agent" ? caller.session : "person"}\0${input.clientKey}`)
    const want: Act = input.action === "rename" ? { kind: "rename", op, title: input.title?.trim() ?? "" } : { kind: input.action, op }
    if (own && this.#deps.tier(conversationId) !== "full") {
      const ask = this.#deps.gate.ask(conversationId, want, (open) => open.kind === want.kind && (want.kind !== "rename" || (open.kind === "rename" && open.title === want.title)))
      return { outcome: "asked", ask: ask.id, next: AFTER_ACT.asked }
    }
    return this.run(conversationId, want).catch((error: Error) => ({ refused: "failed" as const, why: error.message }))
  }

  /** Rename, Archive or Restore, as the app presses them; a repeat under one key is one operation. */
  async run(conversationId: string, want: Act): Promise<Done> {
    if (want.kind === "rename") {
      const thread = this.#deps.threadOf(conversationId)
      if (!thread) throw new Error("This conversation has no Thread to rename.")
      await this.#deps.invoke("mako:thread-rename", [want.op, thread, want.title])
      return { outcome: "renamed", title: want.title }
    }
    const archived = want.kind === "archive"
    // A cloud Thread's archive is its object's to refuse, which the host answers rather than throws.
    const cloud = ArchiveAnswerSchema.safeParse(await this.#deps.invoke("mako:thread-archive", [{ id: want.op, target: { kind: "live", id: conversationId }, archived }])).data?.cloud
    if (cloud?.kind === "refused") throw new Error(cloud.reason)
    return archived ? { outcome: "archived", next: AFTER_ACT.archived } : { outcome: "restored" }
  }
}

/** `mako:threads-act`. */
export function declareThreadActMethods(methods: MethodTable, tool: () => Pick<ThreadActTool, "act"> | undefined): void {
  methods.handle("mako:threads-act", (caller: AgentCaller, input: ThreadActInput) =>
    caller.kind === "person" && machineCall() ? { refused: "not-yours" as const, why: NOT_THE_PERSON } : tool()?.act(caller, input) ?? { refused: "unavailable", why: "This host doesn't act on Threads." })
}
