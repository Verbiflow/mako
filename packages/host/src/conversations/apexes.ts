import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { z } from "zod"
import { hostLog } from "../base/host-log.js"
import { publishFileSync } from "../base/published-files.js"
import { sessionAccessTier, type AccessTier } from "../contracts/access.js"
import { ACCESS_LADDER, APEX_WORD, FIN_WORD, type AgentCaller, type ThreadParent } from "../contracts/agents.js"
import {
  AFTER_APEX,
  APEX_NOTE_PREFIX,
  APEX_NAME_CHARS,
  APEX_PURPOSE_CHARS,
  MEMORY_KEPT,
  MemorySchema,
  PLAN_CHARS,
  PLAN_FILE,
  RULE_LAYER_CHARS,
  RULES_BUDGET_CHARS,
  ApexStartSchema,
  apexDigest,
  checkPlanItem,
  digestNote,
  gatherWords,
  needsChanged,
  planNote,
  ruleLayerLines,
  ruleParts,
  seedPlan,
  type ApexActInput,
  type ApexActResult,
  type ApexChange,
  type ApexCreateInput,
  type ApexCreateResult,
  type ApexDigest,
  type ApexEntry,
  type ApexOwnRules,
  type PersonLayers,
  type ApexGatherResult,
  type ApexPlanInput,
  type ApexPlanReading,
  type ApexPlanResult,
  type ApexProfile,
  type ApexProfileResult,
  type ApexRefused,
  type ApexRulesInput,
  type ApexRulesReading,
  type ApexRulesResult,
  type ApexStandingLines,
  type ApexStart,
  type GatherRefused,
  type Memory,
  type MemoryScope,
  type MemorySaveInput,
  type MemorySaveResult,
  type RuleLayer,
  type RuleReading,
} from "../contracts/apexes.js"
import { fromAgent } from "../contracts/children.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { LiveStartOptions, LiveSummary } from "../contracts/live-conversations.js"
import type { LiveSessionState, PromptAttachment } from "../contracts/providers-acp.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { NativeAgent } from "../contracts/native-agents.js"
import { threadHandle } from "../contracts/thread-handles.js"
import { SessionIdSchema, ThreadIdSchema, type Actor } from "../contracts/thread-identity.js"
import { projectFolder } from "../contracts/worktree-paths.js"
import type { ThreadStore } from "../threads/index.js"
import { namedUuid } from "./cloud-moves.js"

/** Mako's own words to an Apex, never the person's: a Thread moved in, handed over, or let go. */
const APEX_ACTOR: Actor = { kind: "service", name: "apex" }

/** What the Apexes read of the agents engine: rosters, and how to tell windows a Shiver changed. */
export interface ApexAgents {
  roster(conversation: string): readonly NativeAgent[]
  isApex(conversation: string): boolean
  conversationFor(thread: string): string | undefined
  /** A Thread came under an Apex or left one: each named Apex's roster reads it again. */
  membersChanged(...parents: string[]): void
}

/** What the Apexes read and send of the live conversations. */
export interface ApexLive {
  session(id: string): LiveSessionState | undefined
  listed(): readonly LiveSummary[]
  held(id: string): { requests: readonly { id: string }[] } | undefined
  submit(id: string, requestId: string, text: string, attachments: PromptAttachment[], tuning?: SessionSettings, targetBindingId?: string, displayText?: string, actor?: Actor): void
}

export interface ApexesDeps {
  store(): ThreadStore | undefined
  live: ApexLive
  agents(): ApexAgents | undefined
  /** Starts a conversation as `mako:live-start` does. */
  startLive(harness: string, cwd: string, options: LiveStartOptions): Promise<void>
  archived?(conversation: string): boolean
  /** The person's data: each Apex's files are in `apexes/<thread>`, the layered rules in `rule-layers.json`. */
  userRoot: string
  emit(event: HostEvent): void
  /** The person's rules for every Apex or every Fin (Settings › Fins), which the preview shows as their own line. */
  roleRules?(as: "apex" | "fin"): string | undefined
  now?(): number
}

/** What a conversation reads of every layer, and the project folder it works in. */
interface ConversationReading {
  reading: RuleReading
  folder?: string
}

/** `rule-layers.json`: the person's own layers, by folder, and the lessons agents saved. Unknown fields stay. */
const RuleLayersFileSchema = z.looseObject({
  version: z.literal(1),
  you: z.string().max(RULE_LAYER_CHARS).optional(),
  folders: z.record(z.string(), z.looseObject({ you: z.string().max(RULE_LAYER_CHARS).optional(), shared: z.string().max(RULE_LAYER_CHARS).optional() })).catch({}),
  memories: z.array(z.unknown()).catch([]),
})
type RuleLayersFile = z.infer<typeof RuleLayersFileSchema>

const RULES_FILE = "RULES.md"
const FIN_RULES_FILE = "FIN-RULES.md"

/**
 * Deliberate Apexes (`contracts/apexes.ts`): making one, a Thread made one and back, Threads gathered under one or
 * handed to another, its plan and rules, the person's layered rules and the lessons agents save, and what an Apex
 * and its Fins read of them at a turn's start. Its profile is the Thread store's (`apexes`); its plan and rules are
 * files in its folder of the person's data, which every device reads through this host.
 */
export class Apexes {
  private readonly created = new Map<string, ApexCreateResult>()
  private readonly deps: ApexesDeps

  constructor(deps: ApexesDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private store(): ThreadStore | undefined {
    return this.deps.store()
  }

  // ── Who's who ──

  /** Every deliberate Apex whose Thread is here, newest made last. */
  list(): ApexEntry[] {
    const store = this.store()
    if (!store) return []
    return store.apexes().flatMap((profile) => {
      const entry = this.entryOf(profile)
      return entry ? [entry] : []
    })
  }

  profileOf(thread: string): ApexProfile | undefined {
    return this.store()?.apex(thread)
  }

  private entryOf(profile: ApexProfile): ApexEntry | undefined {
    const store = this.store()
    if (!store || !store.thread(ThreadIdSchema.parse(profile.thread))) return undefined
    const conversation = this.deps.agents()?.conversationFor(profile.thread)
    const session = conversation ? this.deps.live.session(conversation) : undefined
    const folder = this.folderOf(conversation)
    return {
      ...profile,
      handle: threadHandle(profile.thread, folder, store.handleLength(profile.thread)),
      ...(conversation && { conversation }),
      ...(folder && { folder }),
      ...(session?.harness && { harness: session.harness }),
    }
  }

  /** The project folder a conversation works in: its main checkout for a worktree. */
  folderOf(conversation: string | undefined): string | undefined {
    const cwd = conversation ? this.deps.live.session(conversation)?.cwd : undefined
    return projectFolder(this.store()?.worktrees(), cwd) ?? cwd
  }

  private threadOf(conversation: string): string | undefined {
    return this.store()?.journalPlacement(conversation)?.thread
  }

  /** The caller's own Thread and conversation, for an agent's tool call; the person names the conversation. */
  private callerThread(caller: AgentCaller, conversation?: string): { thread: string; conversation: string } | ApexRefused {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: "Apexes need the Thread store, which didn't open on this host." }
    if (caller.kind === "agent") {
      const session = SessionIdSchema.safeParse(caller.session)
      const placed = session.success ? store.sessionPlacement(session.data) : undefined
      const found = placed && store.conversationsOf(placed.session).at(-1)
      if (!placed || !found) return { refused: "no-thread", why: "No Thread has that Session." }
      return { thread: placed.thread, conversation: found }
    }
    if (caller.kind === "person" && conversation) {
      const thread = this.threadOf(conversation)
      return thread ? { thread, conversation } : { refused: "no-thread", why: "That conversation has no Thread yet." }
    }
    return { refused: "not-yours", why: `Name the conversation of the ${APEX_WORD}.` }
  }

  private changed(): void {
    this.deps.emit({ type: "apexes", apexes: this.list() })
  }

  // ── Making one ──

  /**
   * A new Apex: its Thread, started in `cwd` on its harness, with its profile written before its harness starts, so
   * its first turn already reads as an Apex. With a first message it starts on it; without, it waits for the
   * person's, which its note says is what it's for.
   */
  async create(input: ApexCreateInput, by: "person" | "agent", from?: { title?: string }): Promise<ApexCreateResult> {
    const op = `apex-create:${input.clientKey}`
    const kept = this.created.get(op)
    if (kept) return "refused" in kept ? kept : { ...kept, deduped: true }
    const name = input.name.trim().slice(0, APEX_NAME_CHARS)
    if (!name) return { refused: "invalid", why: `An ${APEX_WORD} needs a name.` }
    const purpose = input.purpose?.trim()
    if (purpose && purpose.length > APEX_PURPOSE_CHARS) return { refused: "invalid", why: `A purpose is at most ${APEX_PURPOSE_CHARS} characters; this one is ${purpose.length}.` }
    if (!existsSync(input.cwd)) return { refused: "invalid", why: `${input.cwd} isn't a folder on this device.` }
    const conversationId = namedUuid(op)
    if (this.deps.live.session(conversationId)) {
      const thread = this.threadOf(conversationId)
      if (thread) return { thread, conversation: conversationId, name, deduped: true }
    }
    const message = input.message?.trim()
    const apex: ApexStart = ApexStartSchema.parse({
      name,
      ...(purpose && { purpose }),
      ...(input.fins && Object.keys(input.fins).length && { fins: input.fins }),
      from: "new",
      by,
    })
    const text = message && by === "agent" ? `${fromAgent(`the Thread "${from?.title ?? "another Thread"}", which made this ${APEX_WORD} for the person`)}\n${message}` : message
    try {
      await this.deps.startLive(input.harness, input.cwd, {
        conversationId,
        title: name,
        apex,
        ...(text && { initialRequest: { id: namedUuid(`${op}:first`), text, attachments: [] } }),
        ...((input.model || input.reasoning) && { tuning: { ...(input.model && { model: input.model }), ...(input.reasoning && { reasoning: input.reasoning }) } }),
        ...(input.modeId && { modeId: input.modeId }),
      })
    } catch (error) {
      return { refused: "failed", why: error instanceof Error ? error.message : String(error) }
    }
    const thread = this.threadOf(conversationId)
    if (!thread) return { refused: "failed", why: `Its Thread didn't start.` }
    const result = { thread, conversation: conversationId, name }
    this.created.set(op, result)
    hostLog("apexes", "created", { thread, by, first: message ? "message" : "none" })
    return result
  }

  /** A start that makes an Apex wrote its Thread (`LiveStartOptions.apex`): its profile and its files, before it runs. */
  made(thread: string, start: ApexStart): void {
    const store = this.store()
    if (!store) return
    const profile = store.keepApex({ ...ApexStartSchema.parse(start), thread, createdAt: this.now() })
    const title = store.keepThreadTitle(ThreadIdSchema.parse(thread), profile.name)
    if (title) this.deps.emit({ type: "thread-titles", titles: [title] })
    this.seedFiles(profile)
    this.changed()
  }

  /** Make an existing top-level Thread an Apex: it keeps its history, branch, machine and any Fins it started. */
  promote(conversation: string, change: ApexChange, by: "person" | "agent"): ApexProfileResult {
    const store = this.store()
    const thread = this.threadOf(conversation)
    if (!store || !thread) return { refused: "no-thread", why: "That conversation has no Thread yet." }
    if (store.edges().of(thread)) return { refused: "not-top-level", why: `This Thread is a ${FIN_WORD}: its ${APEX_WORD} speaks for it. Make that one the ${APEX_WORD}, or move this one out first.` }
    const before = store.apex(thread)
    const record = store.thread(ThreadIdSchema.parse(thread))
    const name = (change.name?.trim() || before?.name || record?.title || this.deps.live.session(conversation)?.title || APEX_WORD).slice(0, APEX_NAME_CHARS)
    const purpose = change.purpose === null ? undefined : change.purpose?.trim() || before?.purpose
    if (purpose && purpose.length > APEX_PURPOSE_CHARS) return { refused: "invalid", why: `A purpose is at most ${APEX_PURPOSE_CHARS} characters; this one is ${purpose.length}.` }
    const next: ApexProfile = { from: before?.from ?? "thread", by: before?.by ?? by, createdAt: before?.createdAt ?? this.now(), thread, name }
    if (before?.seenAt !== undefined) next.seenAt = before.seenAt
    if (before?.needsSaid) next.needsSaid = before.needsSaid
    if (purpose) next.purpose = purpose
    const fins = change.fins === null ? undefined : change.fins ?? before?.fins
    if (fins) next.fins = fins
    const profile = store.keepApex(next)
    if (change.name?.trim() && record?.title !== name) {
      const entry = store.titleEntry(store.renameThread({ operationId: namedUuid(`apex-name:${thread}:${name}`), thread: ThreadIdSchema.parse(thread), title: name, actor: store.person() }).id)
      if (entry) this.deps.emit({ type: "thread-titles", titles: [entry] })
    } else if (!record?.title) {
      const entry = store.keepThreadTitle(ThreadIdSchema.parse(thread), name)
      if (entry) this.deps.emit({ type: "thread-titles", titles: [entry] })
    }
    this.seedFiles(profile)
    this.changed()
    hostLog("apexes", before ? "updated" : "promoted", { thread, by })
    return { apex: this.entryOf(profile)! }
  }

  /** Back to a Thread: its profile goes; its history, files and the Fins it started stay. Threads moved in go back to being their own. */
  demote(thread: string): { released: string[] } | ApexRefused {
    const store = this.store()
    if (!store) return { refused: "unavailable", why: "Apexes need the Thread store, which didn't open on this host." }
    if (!store.apex(thread)) return { refused: "not-apex", why: `This Thread isn't a deliberate ${APEX_WORD}.` }
    const released = store.edges().children(thread).filter((edge) => edge.origin === "attached").flatMap((edge) => (store.releaseEdge(edge.child) ? [edge.child] : []))
    store.dropApex(thread)
    this.deps.agents()?.membersChanged(thread)
    this.changed()
    hostLog("apexes", "demoted", { thread, released: released.length })
    return { released }
  }

  update(thread: string, change: ApexChange): ApexProfileResult {
    const conversation = this.deps.agents()?.conversationFor(thread)
    if (!conversation || !this.store()?.apex(thread)) return { refused: "not-apex", why: `This Thread isn't a deliberate ${APEX_WORD}.` }
    return this.promote(conversation, change, "person")
  }

  /** The person read the Apex's digest: what finished before now is no longer new. */
  seen(thread: string): void {
    const store = this.store()
    const profile = store?.apex(thread)
    if (!store || !profile) return
    store.keepApex({ ...profile, seenAt: this.now() })
    this.changed()
  }

  // ── Gathering Threads ──

  /**
   * Existing top-level Threads become this Apex's Fins, keeping their history, folder and branch: one Apex per Thread,
   * in the Apex's folder. A Thread on wider access than the Apex is lowered to it only once the person confirms.
   * The Apex hears who joined, once, as Mako's note after its turn.
   */
  async gather(apexThread: string, refs: readonly string[], confirm: boolean, actor: "person" | "agent"): Promise<ApexGatherResult> {
    const store = this.store()
    const agents = this.deps.agents()
    if (!store || !agents) return { refused: "unavailable", why: "Apexes need the Thread store, which didn't open on this host." }
    const apex = store.apex(apexThread)
    const apexConversation = agents.conversationFor(apexThread)
    const apexPlacement = apexConversation ? store.journalPlacement(apexConversation) : undefined
    if (!apex || !apexConversation || !apexPlacement) return { refused: "not-apex", why: `That Thread isn't a deliberate ${APEX_WORD} on this device.` }
    const apexFolder = this.folderOf(apexConversation)
    const apexTier = sessionAccessTier(this.deps.live.session(apexConversation))
    const moved: { thread: string; title: string; name: string }[] = []
    const stayed: GatherRefused[] = []
    for (const ref of refs) {
      const found = this.findThread(ref)
      const title = found?.title ?? ref
      const facts = { title, apex: apex.name, apexFolder: apexFolder && basename(apexFolder) }
      const refuse = (reason: GatherRefused["refused"], more: Partial<Parameters<typeof gatherWords>[1]> = {}, confirmable = false) =>
        stayed.push({ thread: found?.thread ?? ref, title, refused: reason, why: gatherWords(reason, { ...facts, ...more }), ...(confirmable && { confirmable: true as const }) })
      if (!found) { refuse("not-found"); continue }
      if (found.thread === apexThread) { refuse("self"); continue }
      const edge = store.edges().of(found.thread)
      if (edge) {
        const above = store.edges().of(edge.parent)
        if (above) refuse("not-top-level")
        else if (edge.parent === apexThread) moved.push({ thread: found.thread, title, name: edge.name })
        else refuse("in-another-apex", { other: store.apex(edge.parent)?.name ?? store.thread(ThreadIdSchema.parse(edge.parent))?.title ?? `another ${APEX_WORD}` })
        continue
      }
      if (!found.conversation) { refuse(found.elsewhere ? "other-device" : "not-open", { ...(found.elsewhere && { device: found.elsewhere }) }); continue }
      if (found.elsewhere) { refuse("other-device", { device: found.elsewhere }); continue }
      if (this.deps.archived?.(found.conversation)) { refuse("archived"); continue }
      if (store.apex(found.thread) || store.edges().children(found.thread).some((child) => child.closedAt === undefined)) { refuse("is-apex"); continue }
      const folder = this.folderOf(found.conversation)
      if (apexFolder && folder && folder !== apexFolder) { refuse("other-folder", { folder: basename(folder) }); continue }
      const tier = sessionAccessTier(this.deps.live.session(found.conversation))
      if (tier && apexTier && ACCESS_LADDER.indexOf(tier) > ACCESS_LADDER.indexOf(apexTier) && !confirm) {
        refuse("access-wider", { access: accessWords(tier), apexAccess: accessWords(apexTier) }, true)
        continue
      }
      const name = this.uniqueName(store, apexThread, title)
      const lowered = tier && apexTier && ACCESS_LADDER.indexOf(tier) > ACCESS_LADDER.indexOf(apexTier) ? apexTier : undefined
      const attached: ThreadParent = {
        child: ThreadIdSchema.parse(found.thread),
        parent: ThreadIdSchema.parse(apexThread),
        parentSession: apexPlacement.session,
        name,
        role: "worker",
        origin: "attached",
        asked: { brief: { objective: `${title}: a Thread the person moved into ${apex.name}. Its own conversation is its brief.` }, ...(lowered && { access: lowered }) },
        op: `gather:${apexThread}:${found.thread}`,
        startedBy: actor === "person" ? store.person() : APEX_ACTOR,
        createdAt: this.now(),
      }
      const kept = store.keepEdge(attached)
      if (kept.parent !== apexThread) { refuse("in-another-apex", { other: store.apex(kept.parent)?.name }); continue }
      moved.push({ thread: found.thread, title, name: kept.name })
    }
    if (moved.length) {
      agents.membersChanged(apexThread)
      this.tellApex(apexConversation, `gather:${moved.map((each) => each.thread).join(",")}`,
        `${moved.length === 1 ? `fin:${moved[0]!.name} (“${moved[0]!.title}”) joined your ${SHIVER}` : `${moved.length} Threads joined your ${SHIVER}: ${moved.map((each) => `fin:${each.name} (“${each.title}”)`).join(", ")}`}. The person moved ${moved.length === 1 ? "it" : "them"} in with ${moved.length === 1 ? "its" : "their"} history. Read ${moved.length === 1 ? "it" : "each"} with agents_read and fold ${moved.length === 1 ? "it" : "them"} into your plan under Now; reply to the person only if something needs them.`)
      this.changed()
    }
    hostLog("apexes", "gathered", { apex: apexThread, moved: moved.length, stayed: stayed.length })
    return { moved, stayed }
  }

  /** One of an Apex's Fins goes to another Apex in the same folder: a move, with the same refusals. */
  async hand(fromThread: string, ref: string, to: string, confirm: boolean): Promise<{ thread: string; to: string } | ApexRefused | { refused: GatherRefused["refused"]; why: string; confirmable?: true }> {
    const store = this.store()
    const agents = this.deps.agents()
    if (!store || !agents) return { refused: "unavailable", why: "Apexes need the Thread store, which didn't open on this host." }
    const target = this.findApex(to)
    if (!target) return { refused: "unknown-apex", why: `No ${APEX_WORD} called ${to}: apex list names them.` }
    const found = this.findThread(ref)
    const edge = found ? store.edges().of(found.thread) : undefined
    if (!found || !edge || edge.parent !== fromThread) return { refused: "invalid", why: `${ref} isn't one of your ${FIN_WORD}s.` }
    if (target.thread === fromThread) return { refused: "invalid", why: `${ref} is yours already.` }
    if (edge.origin !== "attached" && edge.origin !== "started") return { refused: "invalid", why: `${ref} runs in your shell's process; it can't change ${APEX_WORD}s.` }
    // Its edge goes, and the other Apex gathers it, every refusal as for a Thread moved in by the person.
    const released = store.releaseEdge(edge.child, true)
    if (!released) return { refused: "failed", why: `Mako couldn't let ${ref} go.` }
    const result = await this.gather(target.thread, [found.thread], confirm, "agent")
    if ("refused" in result || !result.moved.length) {
      // It stays where it was: its edge goes back as it was.
      store.keepEdge(released)
      agents.membersChanged(fromThread)
      const why = "refused" in result ? result : result.stayed[0]
      return why ? { refused: why.refused, why: why.why, ...("confirmable" in why && why.confirmable && { confirmable: true as const }) } : { refused: "failed", why: "It didn't move." }
    }
    agents.membersChanged(fromThread, target.thread)
    return { thread: found.thread, to: target.thread }
  }

  private uniqueName(store: ThreadStore, apex: string, title: string): string {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "thread"
    const taken = new Set(store.edges().children(apex).map((edge) => edge.name))
    if (!taken.has(base)) return base
    for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }

  /** A Thread by its ID, handle or title, as the person or an agent names it: its conversation here, if any. */
  private findThread(ref: string): { thread: string; title: string; conversation?: string; elsewhere?: string } | undefined {
    const store = this.store()
    if (!store) return undefined
    const typed = ref.trim().replace(/^apex:|^fin:/, "")
    const byId = ThreadIdSchema.safeParse(typed)
    const handled = byId.success ? undefined : store.threadByHandle(typed)
    let thread = byId.success ? byId.data : handled?.kind === "found" ? handled.thread : undefined
    const summaries = this.deps.live.listed()
    if (!thread) {
      const words = typed.toLowerCase()
      const titled = summaries.filter((summary) => {
        const placed = store.journalPlacement(summary.session.id)
        const title = placed ? store.thread(placed.thread)?.title ?? summary.session.title : summary.session.title
        return title?.trim().toLowerCase() === words
      })
      const threads = new Set(titled.flatMap((summary) => store.journalPlacement(summary.session.id)?.thread ?? []))
      if (threads.size === 1) thread = [...threads][0]
    }
    if (!thread) return undefined
    const record = store.thread(ThreadIdSchema.parse(thread))
    if (!record) return undefined
    const conversation = this.deps.agents()?.conversationFor(thread)
    const summary = conversation ? summaries.find((each) => each.session.id === conversation) : undefined
    // The name its row shows: the person's, else the one Mako gave it, else its first words.
    const named = store.titleEntry(ThreadIdSchema.parse(thread))?.title ?? undefined
    return {
      thread,
      title: named ?? record.title ?? summary?.session.title ?? (conversation && this.deps.live.session(conversation)?.title) ?? "Untitled Thread",
      ...(conversation && { conversation }),
      ...(summary?.elsewhere && { elsewhere: summary.elsewhere }),
    }
  }

  private findApex(ref: string): ApexEntry | undefined {
    const words = ref.trim().replace(/^apex:/, "").toLowerCase()
    const apexes = this.list()
    return apexes.find((apex) => apex.thread === words || apex.handle.toLowerCase() === words || apex.handle.toLowerCase().endsWith(`-${words}`))
      ?? apexes.find((apex) => apex.name.toLowerCase() === words)
      ?? (apexes.filter((apex) => apex.name.toLowerCase().startsWith(words)).length === 1 ? apexes.find((apex) => apex.name.toLowerCase().startsWith(words)) : undefined)
  }

  /** Mako's note to an Apex, after its turn: once by its key, never the person's words. */
  private tellApex(conversation: string, key: string, text: string): void {
    const request = namedUuid(`apex-note:${conversation}:${key}`)
    if (this.deps.live.held(conversation)?.requests.some((asked) => asked.id === request)) return
    try {
      this.deps.live.submit(conversation, request, `${APEX_NOTE_PREFIX}${text}`, [], undefined, undefined, undefined, APEX_ACTOR)
    } catch (error) {
      hostLog("apexes", "note not sent", { conversation, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // ── Files ──

  private folder(thread: string): string {
    return join(this.deps.userRoot, "apexes", ThreadIdSchema.parse(thread))
  }

  private read(thread: string, file: string): string | undefined {
    try {
      return readFileSync(join(this.folder(thread), file), "utf8")
    } catch {
      return undefined
    }
  }

  private write(thread: string, file: string, text: string): void {
    mkdirSync(this.folder(thread), { recursive: true })
    publishFileSync(join(this.folder(thread), file), text)
  }

  private seedFiles(profile: ApexProfile): void {
    if (this.read(profile.thread, PLAN_FILE) === undefined) this.write(profile.thread, PLAN_FILE, seedPlan(profile.name, profile.purpose))
  }

  plan(thread: string): ApexPlanReading {
    const text = this.read(thread, PLAN_FILE) ?? ""
    return { text, chars: text.length, path: join(this.folder(thread), PLAN_FILE) }
  }

  savePlan(thread: string, text: string): ApexPlanReading | ApexRefused {
    if (!this.store()?.apex(thread)) return { refused: "not-apex", why: `This Thread isn't a deliberate ${APEX_WORD}.` }
    if (text.length > PLAN_CHARS) return { refused: "invalid", why: `A plan is at most ${PLAN_CHARS} characters; this one is ${text.length}. Move what's done out of it.` }
    this.write(thread, PLAN_FILE, text.endsWith("\n") ? text : `${text}\n`)
    this.planChanged(thread)
    return this.plan(thread)
  }

  checkPlan(thread: string, section: string, index: number, done: boolean): ApexPlanReading | ApexRefused {
    const next = checkPlanItem(this.plan(thread).text, section, index, done)
    if (next === undefined) return { refused: "invalid", why: `${section} has no item ${index}.` }
    return this.savePlan(thread, next)
  }

  /** A plan changed: every window reads it again, and a line it checked may leave Needs you. */
  private planChanged(thread: string): void {
    this.deps.emit({ type: "apex-plan", thread, plan: this.plan(thread).text })
  }

  private apexRules(thread: string): ApexOwnRules {
    const rules = this.read(thread, RULES_FILE)?.trim()
    const finRules = this.read(thread, FIN_RULES_FILE)?.trim()
    return { ...(rules && { rules }), ...(finRules && { finRules }) }
  }

  // ── Layers ──

  /**
   * The file as it stands; none yet is empty. One that can't be read (a newer build's, or broken) reads as empty and
   * is never written over (`unreadable`), so nothing the person wrote is lost to this build.
   */
  private layers(): RuleLayersFile & { unreadable?: true } {
    const path = join(this.deps.userRoot, "rule-layers.json")
    if (!existsSync(path)) return { version: 1, folders: {}, memories: [] }
    try {
      const parsed = RuleLayersFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
      if (parsed.success) return parsed.data
      hostLog("apexes", "rule layers unreadable", { error: parsed.error.message.slice(0, 200) })
    } catch (error) {
      hostLog("apexes", "rule layers unreadable", { error: error instanceof Error ? error.message : String(error) })
    }
    return { version: 1, folders: {}, memories: [], unreadable: true }
  }

  private saveLayers(file: RuleLayersFile & { unreadable?: true }): void {
    if (file.unreadable) throw new Error("Mako can't read your saved rules file (rule-layers.json), so it won't write over it. A newer Mako may have written it: update Mako.")
    mkdirSync(this.deps.userRoot, { recursive: true })
    publishFileSync(join(this.deps.userRoot, "rule-layers.json"), `${JSON.stringify(file, null, 2)}\n`)
  }

  private memories(file: RuleLayersFile, folder: string | undefined): Memory[] {
    return file.memories.flatMap((raw) => {
      const memory = MemorySchema.safeParse(raw).data
      if (!memory) return []
      return memory.scope === "you" || memory.folder === folder ? [memory] : []
    })
  }

  /** What one reader takes of every layer, for a conversation: an Apex its own, a Fin its Apex's Fin rules. */
  private reading(conversation: string): ConversationReading {
    const store = this.store()
    const thread = this.threadOf(conversation)
    const folder = this.folderOf(conversation)
    const file = this.layers()
    const own = folder ? file.folders[folder] : undefined
    const base = {
      ...(file.you?.trim() && { you: file.you }),
      ...(own?.you?.trim() && { youFolder: own.you }),
      ...(own?.shared?.trim() && { folder: own.shared }),
      ...(folder && { folderName: basename(folder) }),
      memories: this.memories(file, folder),
    }
    const apex = thread ? store?.apex(thread) : undefined
    if (apex && thread) return { reading: { ...base, as: "apex", apex: { name: apex.name, ...this.apexRules(thread) } }, ...(folder && { folder }) }
    const edge = thread ? store?.edges().of(thread) : undefined
    const above = edge ? store?.apex(edge.parent) : undefined
    if (edge && above) return { reading: { ...base, as: "fin", apex: { name: above.name, ...this.apexRules(edge.parent) } }, ...(folder && { folder }) }
    return { reading: { ...base, as: edge ? "fin" : "thread" }, ...(folder && { folder }) }
  }

  /**
   * The standing lines this conversation reads (`standingLines`): each layer, said whole once and again when it
   * changes; and for a deliberate Apex and its Fins, what each is to the other.
   */
  standing(conversation: string, read: ReadonlySet<string>): ApexStandingLines {
    const { reading } = this.reading(conversation)
    const lines: ApexStandingLines = ruleLayerLines(ruleParts(reading), read)
    if (reading.as === "apex" && reading.apex) lines["apex-role"] = apexRole(reading.apex.name, this.profileOf(this.threadOf(conversation)!)?.purpose)
    else if (reading.as === "fin" && reading.apex) lines["apex-fin-role"] = finRole(reading.apex.name)
    else if (read.has("apex-role")) lines["apex-role"] = `This Thread is no longer a deliberate ${APEX_WORD}: what you were told of being one no longer applies.`
    return lines
  }

  /**
   * What a deliberate Apex reads at the start of every turn: its plan (capped) and what needs the person, with
   * whether that changed since its last turn, which is when it speaks to them. Kept so the next turn can tell.
   */
  turnLines(conversation: string): string[] {
    const store = this.store()
    const thread = this.threadOf(conversation)
    const profile = thread ? store?.apex(thread) : undefined
    if (!store || !thread || !profile) return []
    const plan = this.plan(thread).text
    const digest = this.digest(conversation, profile, plan)
    const changed = needsChanged(profile.needsSaid, digest)
    if (changed) store.keepApex({ ...profile, needsSaid: digest.needs.map((item) => item.key).slice(0, 64) })
    const fresh = plan.trim() === seedPlan(profile.name, profile.purpose).trim() && !this.apexRules(thread).rules
    return [
      ...(fresh ? [`You're new: your plan and rules are empty. The person's message says what you're for: write that into your rules (apex rules_write, layer apex), the rules your ${FIN_WORD}s should follow (layer fins), and your plan (apex plan_write), then answer them.`] : []),
      ...(planNote(profile.name, plan) ? [planNote(profile.name, plan)!] : []),
      digestNote(digest, changed),
    ]
  }

  digest(conversation: string, profile: ApexProfile, plan?: string): ApexDigest {
    return apexDigest(this.deps.agents()?.roster(conversation) ?? [], plan ?? this.plan(profile.thread).text, profile.seenAt)
  }

  /** What the Overview's context preview shows: every layer as this Apex reads it, or as one of its Fins does. */
  rules(thread: string, as: "apex" | "fin"): ApexRulesReading | ApexRefused {
    const role = this.deps.roleRules?.(as)
    const store = this.store()
    const profile = store?.apex(thread)
    const conversation = this.deps.agents()?.conversationFor(thread)
    if (!store || !profile || !conversation) return { refused: "not-apex", why: `This Thread isn't a deliberate ${APEX_WORD} on this device.` }
    const { reading, folder } = this.reading(conversation)
    const own = this.apexRules(thread)
    const read: RuleReading = { ...reading, as, apex: { name: profile.name, ...own } }
    const file = this.layers()
    const texts = {
      you: file.you ?? "",
      ...(folder && { "you-folder": file.folders[folder]?.you ?? "", folder: file.folders[folder]?.shared ?? "" }),
      apex: own.rules ?? "",
      "apex-fins": own.finRules ?? "",
    } satisfies ApexRulesReading["texts"]
    return { as, parts: ruleParts(read), budget: RULES_BUDGET_CHARS, texts, ...(folder && { folder, folderName: basename(folder) }), memories: [...reading.memories], ...(role && { role }) }
  }

  /** One layer's words, from the Overview or Settings: the person's own layers by folder, an Apex's two by its Thread. */
  saveRule(layer: RuleLayer, text: string, at: { thread?: string; folder?: string }): { chars: number } | ApexRefused {
    const words = text.trim()
    if (words.length > RULE_LAYER_CHARS) return { refused: "invalid", why: `A layer is at most ${RULE_LAYER_CHARS} characters; this one is ${words.length}.` }
    if (layer === "apex" || layer === "apex-fins") {
      if (!at.thread || !this.store()?.apex(at.thread)) return { refused: "not-apex", why: `That Thread isn't a deliberate ${APEX_WORD}.` }
      this.write(at.thread, layer === "apex" ? RULES_FILE : FIN_RULES_FILE, words ? `${words}\n` : "")
      this.deps.emit({ type: "apex-rules", thread: at.thread })
      return { chars: words.length }
    }
    const file = this.layers()
    if (layer === "you") file.you = words || undefined
    else {
      if (!at.folder) return { refused: "invalid", why: "Name the folder these rules are for." }
      const folder = { ...file.folders[at.folder] }
      if (layer === "you-folder") folder.you = words || undefined
      else folder.shared = words || undefined
      file.folders[at.folder] = folder
    }
    this.saveLayers(file)
    this.deps.emit({ type: "apex-rules" })
    return { chars: words.length }
  }

  /** A lesson an agent keeps for the person; the same topic in the same scope replaces the last and is confirmed today. */
  saveMemory(input: { scope: MemoryScope; topic: string; lesson: string; folder?: string; by?: string }): { id: string; replaced: boolean } | ApexRefused {
    const topic = input.topic.trim()
    const lesson = input.lesson.trim()
    const parsed = MemorySchema.safeParse({ id: "x", scope: input.scope, topic, lesson, savedAt: 0, confirmedAt: 0, ...(input.folder && { folder: input.folder }) })
    if (!parsed.success) return { refused: "invalid", why: `A lesson needs a topic of at most 80 characters and a lesson of at most 600.` }
    if (input.scope !== "you" && !input.folder) return { refused: "invalid", why: "This Thread has no folder to keep it in: save it to scope you." }
    const file = this.layers()
    const now = this.now()
    const same = (memory: Memory) => memory.scope === input.scope && (memory.folder ?? "") === (input.folder ?? "") && memory.topic.toLowerCase() === topic.toLowerCase()
    const memories = file.memories.flatMap((raw) => MemorySchema.safeParse(raw).data ?? [])
    const before = memories.find(same)
    const id = before?.id ?? namedUuid(`memory:${input.scope}:${input.folder ?? ""}:${topic.toLowerCase()}`)
    const next: Memory = { id, scope: input.scope, ...(input.folder && input.scope !== "you" && { folder: input.folder }), topic, lesson, savedAt: before?.savedAt ?? now, confirmedAt: now, ...(input.by && { by: input.by }) }
    let kept = [...memories.filter((memory) => !same(memory)), next]
    const scoped = kept.filter((memory) => memory.scope === next.scope && memory.folder === next.folder).sort((a, b) => a.confirmedAt - b.confirmedAt)
    if (scoped.length > MEMORY_KEPT) kept = kept.filter((memory) => memory !== scoped[0])
    file.memories = kept
    this.saveLayers(file)
    this.deps.emit({ type: "apex-rules" })
    return { id, replaced: before !== undefined }
  }

  forgetMemory(id: string): boolean {
    const file = this.layers()
    const before = file.memories.length
    file.memories = file.memories.filter((raw) => MemorySchema.safeParse(raw).data?.id !== id)
    if (file.memories.length === before) return false
    this.saveLayers(file)
    this.deps.emit({ type: "apex-rules" })
    return true
  }

  /** The person's own layers for a folder, as Settings edits them. */
  personLayers(folder?: string): PersonLayers {
    const file = this.layers()
    const own = folder ? file.folders[folder] : undefined
    return { you: file.you ?? "", youFolder: own?.you ?? "", folder: own?.shared ?? "", memories: this.memories(file, folder) }
  }

  // ── The tools ──

  async act(caller: AgentCaller, input: ApexActInput): Promise<ApexActResult> {
    const own = this.callerThread(caller, input.conversation)
    if ("refused" in own) return own
    const by = caller.kind === "agent" ? "agent" : "person"
    const store = this.store()!
    switch (input.action) {
      case "create": {
        const session = this.deps.live.session(own.conversation)
        const cwd = input.folder ?? session?.cwd
        if (!cwd || !input.name) return { refused: "invalid", why: `create needs a name${cwd ? "" : " and a folder"}.` }
        const created = await this.create({
          name: input.name,
          ...(input.purpose && { purpose: input.purpose }),
          cwd,
          harness: input.harness ?? session?.harness ?? "claude",
          ...(input.model && { model: input.model }),
          ...(input.message && { message: input.message }),
          ...(input.finsRun && { fins: { run: input.finsRun } }),
          ...(session?.launchMode && { modeId: session.launchMode }),
          clientKey: `${own.thread}:${input.clientKey}`,
        }, by, { title: store.thread(ThreadIdSchema.parse(own.thread))?.title ?? session?.title })
        if ("refused" in created) return created
        return { outcome: "created", apex: { thread: created.thread, name: created.name, conversation: created.conversation }, next: AFTER_APEX.created }
      }
      case "promote":
      case "update": {
        if (input.action === "update" && !store.apex(own.thread)) return { refused: "not-apex", why: `This Thread isn't an ${APEX_WORD}: promote makes it one.` }
        const made = this.promote(own.conversation, { ...(input.name && { name: input.name }), ...(input.purpose !== undefined && { purpose: input.purpose }), ...(input.finsRun && { fins: { run: input.finsRun } }) }, by)
        if ("refused" in made) return made
        return { outcome: input.action === "promote" ? "promoted" : "updated", apex: made.apex, next: input.action === "promote" ? AFTER_APEX.promoted : AFTER_APEX.updated }
      }
      case "demote": {
        const done = this.demote(own.thread)
        return "refused" in done ? done : { outcome: "demoted", released: done.released, next: AFTER_APEX.demoted }
      }
      case "list":
        return {
          outcome: "listed",
          apexes: this.list().map((apex) => ({
            handle: apex.handle,
            name: apex.name,
            ...(apex.purpose && { purpose: apex.purpose }),
            ...(apex.folder && { folder: basename(apex.folder) }),
            fins: store.edges().children(apex.thread).filter((edge) => edge.closedAt === undefined).length,
            ...(apex.thread === own.thread && { you: true as const }),
          })),
        }
      case "get": {
        const apex = input.to ? this.findApex(input.to) : this.list().find((each) => each.thread === own.thread)
        if (!apex || !apex.conversation) return { refused: "unknown-apex", why: `No ${APEX_WORD} called ${input.to ?? "this"}: apex list names them.` }
        const plan = this.plan(apex.thread).text
        const got: Extract<ApexActResult, { outcome: "got" }> = { outcome: "got", apex, digest: this.digest(apex.conversation, apex, plan) }
        // Another Apex's plan, to read before a handoff; its own is in its note already.
        if (apex.thread !== own.thread) got.plan = plan.slice(0, 4_000)
        return got
      }
      case "gather": {
        if (!store.apex(own.thread)) return { refused: "not-apex", why: `Only a deliberate ${APEX_WORD} gathers Threads: promote this one first, or the person moves them from a Thread's menu.` }
        const gathered = await this.gather(own.thread, input.threads ?? [], input.confirm === true, by)
        if ("refused" in gathered) return gathered
        return { outcome: "gathered", moved: gathered.moved, stayed: gathered.stayed, next: AFTER_APEX.gathered }
      }
      case "plan":
        return this.planAct(caller, { action: "read", ...(input.conversation && { conversation: input.conversation }), clientKey: input.clientKey })
      case "plan_write":
      case "plan_edit":
      case "plan_check":
        return this.planAct(caller, {
          action: input.action === "plan_write" ? "write" : input.action === "plan_edit" ? "edit" : "check",
          ...(input.text !== undefined && { text: input.text }),
          ...(input.old !== undefined && { old: input.old }),
          ...(input.new !== undefined && { new: input.new }),
          ...(input.section !== undefined && { section: input.section }),
          ...(input.item !== undefined && { item: input.item }),
          ...(input.done !== undefined && { done: input.done }),
          ...(input.conversation && { conversation: input.conversation }),
          clientKey: input.clientKey,
        })
      case "rules":
      case "rules_write":
        return this.rulesAct(caller, {
          action: input.action === "rules" ? "read" : "write",
          ...(input.layer && { layer: input.layer }),
          ...(input.text !== undefined && { text: input.text }),
          ...(input.conversation && { conversation: input.conversation }),
          clientKey: input.clientKey,
        })
      case "hand": {
        const [ref] = input.threads ?? []
        if (!ref || !input.to) return { refused: "invalid", why: "hand needs threads: [the Fin] and to: the Apex." }
        const handed = await this.hand(own.thread, ref, input.to, input.confirm === true)
        if ("refused" in handed) return { refused: apexRefusal(handed.refused), why: handed.why }
        return { outcome: "handed", thread: handed.thread, to: handed.to, next: AFTER_APEX.handed }
      }
    }
  }

  planAct(caller: AgentCaller, input: ApexPlanInput): ApexPlanResult {
    const own = this.callerThread(caller, input.conversation)
    if ("refused" in own) return own
    if (!this.store()?.apex(own.thread)) return { refused: "not-apex", why: `This Thread isn't a deliberate ${APEX_WORD}: apex promote makes it one.` }
    const current = this.plan(own.thread).text
    switch (input.action ?? "read") {
      case "read":
        return { outcome: "read", plan: current, chars: current.length }
      case "write": {
        if (input.text === undefined) return { refused: "invalid", why: "write needs text: the whole plan." }
        const saved = this.savePlan(own.thread, input.text)
        return "refused" in saved ? saved : { outcome: "written", chars: saved.chars, next: AFTER_APEX.planWritten }
      }
      case "edit": {
        if (!input.old) return { refused: "invalid", why: "edit needs old: the exact text to replace." }
        const count = current.split(input.old).length - 1
        if (!count) return { refused: "invalid", why: "old isn't in the plan: read it again, then edit." }
        const saved = this.savePlan(own.thread, current.split(input.old).join(input.new ?? ""))
        return "refused" in saved ? saved : { outcome: "edited", replacements: count, chars: saved.chars }
      }
      case "check": {
        if (!input.section || input.item === undefined) return { refused: "invalid", why: "check needs section and item." }
        const saved = this.checkPlan(own.thread, input.section, input.item, input.done ?? true)
        return "refused" in saved ? saved : { outcome: "edited", replacements: 1, chars: saved.chars }
      }
    }
  }

  rulesAct(caller: AgentCaller, input: ApexRulesInput): ApexRulesResult {
    const own = this.callerThread(caller, input.conversation)
    if ("refused" in own) return own
    if (!this.store()?.apex(own.thread)) return { refused: "not-apex", why: `This Thread isn't a deliberate ${APEX_WORD}: apex promote makes it one.` }
    if ((input.action ?? "read") === "read") {
      const apex = this.rules(own.thread, "apex")
      const fins = this.rules(own.thread, "fin")
      if ("refused" in apex) return apex
      if ("refused" in fins) return fins
      return { outcome: "read", apex: apex.parts, fins: fins.parts }
    }
    if (!input.layer) return { refused: "invalid", why: "write needs layer: apex or fins." }
    const saved = this.saveRule(input.layer === "apex" ? "apex" : "apex-fins", input.text ?? "", { thread: own.thread })
    return "refused" in saved ? saved : { outcome: "written", layer: input.layer, chars: saved.chars, next: AFTER_APEX.rulesWritten }
  }

  memoryAct(caller: AgentCaller, input: MemorySaveInput): MemorySaveResult {
    const own = this.callerThread(caller, input.conversation)
    if ("refused" in own) return own
    const folder = this.folderOf(own.conversation)
    const saved = this.saveMemory({ scope: input.scope, topic: input.topic, lesson: input.lesson, ...(folder && { folder }), by: own.thread })
    if ("refused" in saved) return saved
    return { outcome: "saved", id: saved.id, ...(saved.replaced && { replaced: true as const }), scope: input.scope, next: AFTER_APEX.memorySaved }
  }
}

const SHIVER = "Shiver"

/** A hand-over's refusal as the tool says it: the gathering's reasons, in the tool's fewer words. */
function apexRefusal(reason: GatherRefused["refused"] | ApexRefused["refused"]): ApexRefused["refused"] {
  switch (reason) {
    case "not-top-level":
    case "is-apex":
    case "unavailable":
    case "no-thread":
    case "not-yours":
    case "not-apex":
    case "invalid":
    case "unknown-apex":
    case "failed":
      return reason
    default:
      return "invalid"
  }
}

const ACCESS_WORDS = { plan: "Plan", chat: "Chat", ask: "Ask first", edits: "Edits", auto: "Auto", full: "Full access", deny: "No access" } as const satisfies Record<AccessTier, string>

function accessWords(tier: AccessTier): string {
  return ACCESS_WORDS[tier]
}

/** What a deliberate Apex is to itself, said once and again only if it changes: how it works and when it speaks. */
function apexRole(name: string, purpose: string | undefined): string {
  return [
    `You're ${name}, an ${APEX_WORD} the person keeps${purpose ? ` for: ${purpose}` : ""}. You own this area: you break work into ${FIN_WORD}s (agents_start, in parallel where they don't depend on each other, with after for one that does), keep your plan true (apex plan_write, plan_edit), and keep the person's lasting instructions in your rules (apex rules_write) and lessons in memory_save, so they never repeat themselves.`,
    `Speak to the person only when what needs them changed; a report that changes nothing for them ends your turn with a line in your plan, or nothing. When you do speak, lead with the decision, then what you recommend.`,
    `Your ${FIN_WORD}s report to you; they may message each other directly. apex gather takes Threads the person points you to; apex hand gives one to another ${APEX_WORD}.`,
  ].join(" ")
}

/** What a Fin of a deliberate Apex is told of its Shiver, once. */
function finRole(apex: string): string {
  return `You're a ${FIN_WORD} of ${apex}, an ${APEX_WORD} the person keeps. Report to it with agents_report. When another ${FIN_WORD} of ${apex} owns what you need (its files, its branch, an answer only it has), message it directly with agents_send to fin:<name> (queue, or steer when what it's doing now is wrong; at most 3 an hour to one), never for status or thanks; agents_list scope shiver names them.`
}
