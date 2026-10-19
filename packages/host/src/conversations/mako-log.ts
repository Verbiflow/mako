import { z } from "zod"
import type { ConversationControl } from "../contracts/conversation-control.js"
import type { ConversationGoal } from "../contracts/live-goals.js"
import type { LiveRequest, LiveSnapshot } from "../contracts/live-conversations.js"
import type { LivePermissionRequest } from "../contracts/providers-acp.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"

/**
 * Mako's log: what Mako itself did in a conversation, in the order it did
 * it, never rewritten. The requests it sent and each step of their lives, the
 * approvals a harness asked for and how they were answered, the bindings it
 * opened, its switches, forks, actions, questions, merges and goal.
 *
 * Each event names one change to one of these facts and holds only what
 * changed: a new item whole, then each later change as the fields it set and
 * the fields it removed, named by the state it reached (`request.completed`,
 * `transfer.accepted`) or `.changed`. Folding the log in order gives the
 * facts back exactly, so a conversation's rows of them are the log's cache,
 * written in the same transaction (`LiveJournal`).
 */
export const MAKO_LOG_SCHEMA = 1

/** Mako's own facts in a conversation, as the snapshot holds them. */
export interface MakoFacts {
  requests: readonly LiveRequest[]
  permissions: readonly LivePermissionRequest[]
  control?: ConversationControl
  goal?: ConversationGoal
}

export function makoFacts(snapshot: Pick<LiveSnapshot, "requests" | "permissions" | "control" | "goal">): MakoFacts {
  return { requests: snapshot.requests, permissions: snapshot.permissions, control: snapshot.control, goal: snapshot.goal }
}

/** Control's lists, in the order its schema declares them. */
const CONTROL_LIST_NAMES = z.enum(["questions", "approvalResponses", "approvalObservations", "actions", "merges", "bindings", "transfers"])
type ControlList = z.infer<typeof CONTROL_LIST_NAMES>
/** The name each list's events take. */
const CONTROL_LISTS = {
  questions: "question",
  approvalResponses: "approvalResponse",
  approvalObservations: "approvalObservation",
  actions: "action",
  merges: "merge",
  bindings: "binding",
  transfers: "transfer",
} as const satisfies Record<ControlList, string>
type LoggedItem = LiveRequest | LivePermissionRequest | NonNullable<ConversationControl[ControlList]>[number]
/**
 * A fact as the log's state holds it: the snapshot's own object, so a loaded
 * conversation keeps one copy of its facts, or, folded from the log, its
 * JSON. A field the snapshot left `undefined` is absent, as writing drops it.
 */
type Fact = LoggedItem | ConversationGoal | JsonObject

export interface MakoLogEvent {
  kind: string
  value: Fact
}

/**
 * Control's own fields, each change its own event named for what it means.
 * `lists` names the lists control holds, since an absent list and an empty
 * one read differently.
 */
const CONTROL_FIELDS = [
  ["activeBindingId", "activeBinding"],
  ["ancestry", "ancestry"],
  ["session", "session"],
  ["lists", "control"],
] as const
const CONTROL_FIELD_EVENTS = new Set<string>(CONTROL_FIELDS.map(([, kind]) => kind))

const ById = z.looseObject({ id: z.string() })
const ByInput = z.looseObject({ input: z.looseObject({ id: z.string() }) })
const ByIdentity = z.looseObject({ bindingId: z.string(), identity: z.json() })
const Status = z.looseObject({ status: z.string() })
const State = z.looseObject({ state: z.looseObject({ kind: z.string() }) })
const Decided = z.looseObject({ decision: z.json().optional() })

/** A list of Mako's facts: each item has a key, and some a state their events are named by. */
interface List {
  kind: string
  read(facts: MakoFacts): readonly LoggedItem[] | undefined
  key(item: Fact): string
  state?(item: Fact): string | undefined
}

const controlList = (name: ControlList) => (facts: MakoFacts): readonly LoggedItem[] | undefined => facts.control?.[name]
const byId = (item: Fact) => ById.parse(item).id
const byInput = (item: Fact) => ByInput.parse(item).input.id
const stateOf = (item: Fact) => State.safeParse(item).data?.state.kind
const statusOf = (item: Fact) => Status.safeParse(item).data?.status

const LISTS: readonly List[] = [
  { kind: "request", read: (facts) => facts.requests, key: byId, state: statusOf },
  { kind: "permission", read: (facts) => facts.permissions, key: byId },
  { kind: "question", read: controlList("questions"), key: byId },
  { kind: "approvalResponse", read: controlList("approvalResponses"), key: byId, state: stateOf },
  {
    kind: "approvalObservation",
    read: controlList("approvalObservations"),
    key: (item) => {
      const { bindingId, identity } = ByIdentity.parse(item)
      return `${bindingId} ${canonical(identity)}`
    },
    state: (item) => (Decided.safeParse(item).data?.decision ? "decided" : undefined),
  },
  { kind: "action", read: controlList("actions"), key: byInput, state: stateOf },
  { kind: "merge", read: controlList("merges"), key: byId, state: statusOf },
  { kind: "binding", read: controlList("bindings"), key: byId },
  { kind: "transfer", read: controlList("transfers"), key: byInput, state: stateOf },
]
const LIST_BY_KIND = new Map(LISTS.map((list) => [list.kind, list]))

const Fields = z.record(z.string(), z.json())
const ChangeSchema = z.object({ key: z.string().optional(), set: Fields.optional(), unset: z.array(z.string()).optional() })
const OrderSchema = z.object({ keys: z.array(z.string()) })

/** The facts as the log's JSON. */
export interface FoldedFacts {
  requests: JsonObject[]
  permissions: JsonObject[]
  control?: JsonObject
  goal?: JsonObject
}

/** The facts as the log has them, folded event by event. */
export class MakoLogState {
  private readonly lists = new Map<string, Map<string, Fact>>(LISTS.map((list) => [list.kind, new Map()]))
  /** Each item's key, so an item the facts still hold costs a lookup. */
  private readonly keys = new WeakMap<Fact, string>()
  /** Control's own fields, and `lists`. */
  private control?: JsonObject
  private goal?: Fact
  /** The facts last brought here, so a commit that changed none of them costs nothing. */
  private seen?: MakoFacts

  /** Applies one event; a kind this build doesn't know stays in the log and changes nothing here. */
  apply(event: MakoLogEvent): void {
    const dot = event.kind.indexOf(".")
    const entity = dot < 0 ? event.kind : event.kind.slice(0, dot)
    const suffix = dot < 0 ? "" : event.kind.slice(dot + 1)
    const list = LIST_BY_KIND.get(entity)
    if (list) applyToList(this.lists.get(entity)!, list, suffix, event.value)
    else if (entity === "goal") this.goal = suffix === "" ? event.value : suffix === "removed" ? undefined : patched(this.goal, event.value)
    else if (event.kind === "control.removed") this.dropControl()
    else if (CONTROL_FIELD_EVENTS.has(entity)) this.control = patched(this.control, event.value)
    this.seen = undefined
  }

  /** The facts, as the log's JSON. */
  facts(): FoldedFacts {
    const facts: FoldedFacts = {
      requests: this.items("request"),
      permissions: this.items("permission"),
    }
    if (this.control) facts.control = this.controlOf(this.control)
    if (this.goal) facts.goal = jsonOf(this.goal)
    return facts
  }

  /**
   * The events that bring this state to `facts`, applied as they're made.
   * Items are compared by identity, then field by field; an item changed in
   * place keeps its key, so each change is one event holding only what
   * changed.
   */
  advance(facts: MakoFacts): MakoLogEvent[] {
    const seen = this.seen
    if (seen && seen.requests === facts.requests && seen.permissions === facts.permissions && seen.control === facts.control && seen.goal === facts.goal)
      return []
    // Control's fields first, so a fold meets a new binding's activation in the same commit as the binding.
    const events = this.advanceControl(facts.control)
    for (const list of LISTS) {
      const items = list.read(facts)
      if (!seen || list.read(seen) !== items) events.push(...this.advanceList(list, items ?? []))
    }
    events.push(...this.advanceGoal(facts.goal))
    this.seen = facts
    return events
  }

  private items(kind: string): JsonObject[] {
    return [...this.lists.get(kind)!.values()].map(jsonOf)
  }

  /** Control gone, and its lists with it. */
  private dropControl(): void {
    this.control = undefined
    for (const name of CONTROL_LIST_NAMES.options) this.lists.get(CONTROL_LISTS[name])!.clear()
  }

  private controlOf(fields: JsonObject): JsonObject {
    const { lists, ...control } = jsonOf(fields)
    for (const name of z.array(CONTROL_LIST_NAMES).catch([]).parse(lists)) control[name] = this.items(CONTROL_LISTS[name])
    return control
  }

  private advanceControl(control: ConversationControl | undefined): MakoLogEvent[] {
    if (!control) {
      if (!this.control) return []
      this.dropControl()
      return [{ kind: "control.removed", value: {} }]
    }
    // Control's schema reads an absent `merges` as empty, as the journal's rows do.
    const next: JsonObject = { lists: CONTROL_LIST_NAMES.options.filter((name) => name === "merges" || control[name] !== undefined) }
    for (const [name, value] of Object.entries(control)) if (value !== undefined && !CONTROL_LIST_NAMES.safeParse(name).success) next[name] = value
    const before = this.control ?? {}
    const events: MakoLogEvent[] = []
    for (const [name, kind] of CONTROL_FIELDS) {
      const after = next[name]
      const was = before[name]
      if (after === was || (after !== undefined && was !== undefined && canonical(after) === canonical(was))) continue
      events.push({ kind, value: after === undefined ? { unset: [name] } : { set: { [name]: after } } })
    }
    this.control = next
    return events
  }

  private advanceList(list: List, next: readonly LoggedItem[]): MakoLogEvent[] {
    const items = this.lists.get(list.kind)!
    const events: MakoLogEvent[] = []
    const order: string[] = []
    for (const item of next) {
      const known = this.keys.get(item)
      if (known !== undefined && items.get(known) === item) {
        order.push(known)
        continue
      }
      const key = list.key(item)
      order.push(key)
      const before = items.get(key)
      items.set(key, item)
      this.keys.set(item, key)
      if (!before) {
        events.push({ kind: list.kind, value: item })
        continue
      }
      const change = fieldChanges(before, item)
      if (!change) continue
      const state = list.state?.(item)
      const reached = state !== undefined && state !== list.state?.(before)
      events.push({ kind: `${list.kind}.${reached ? state : "changed"}`, value: { key, ...change } })
    }
    const present = new Set(order)
    for (const key of items.keys())
      if (!present.has(key)) {
        items.delete(key)
        events.push({ kind: `${list.kind}.removed`, value: { key } })
      }
    if (!sameOrder([...items.keys()], order)) {
      reorder(items, order)
      events.push({ kind: `${list.kind}.order`, value: { keys: order } })
    }
    return events
  }

  private advanceGoal(goal: ConversationGoal | undefined): MakoLogEvent[] {
    const before = this.goal
    if (goal === before) return []
    this.goal = goal
    if (!goal) return [{ kind: "goal.removed", value: {} }]
    if (!before) return [{ kind: "goal", value: goal }]
    const change = fieldChanges(before, goal)
    return change ? [{ kind: "goal.changed", value: change }] : []
  }
}

export function foldMakoLog(events: Iterable<MakoLogEvent>): MakoLogState {
  const state = new MakoLogState()
  for (const event of events) state.apply(event)
  return state
}

/**
 * Where folding `events` afresh gives other facts than `facts`, or
 * `undefined` when it gives them exactly. Both sides go through the same
 * JSON, so only a lost or wrong event differs.
 */
export function makoLogDifference(events: Iterable<MakoLogEvent>, facts: MakoFacts): string | undefined {
  const folded = foldMakoLog(events).facts()
  const expected = new MakoLogState()
  expected.advance(facts)
  const wanted = expected.facts()
  for (const part of ["requests", "permissions", "control", "goal"] as const) {
    const left = canonical(folded[part] ?? null)
    const right = canonical(wanted[part] ?? null)
    if (left === right) continue
    let at = 0
    while (at < left.length && left[at] === right[at]) at++
    return `${part}: the log folds to …${left.slice(Math.max(0, at - 80), at + 160)}… where the facts are …${right.slice(Math.max(0, at - 80), at + 160)}…`
  }
  return undefined
}

/** A change's `set` and `unset` applied to `before`. */
function patched(before: Fact | undefined, value: Fact): JsonObject {
  const change = ChangeSchema.parse(value)
  const next: JsonObject = {}
  for (const [name, field] of Object.entries(before ?? {})) if (field !== undefined) next[name] = field
  Object.assign(next, change.set)
  for (const name of change.unset ?? []) delete next[name]
  return next
}

function applyToList(items: Map<string, Fact>, list: List, suffix: string, value: Fact): void {
  if (suffix === "") {
    items.set(list.key(value), value)
    return
  }
  if (suffix === "order") {
    reorder(items, OrderSchema.parse(value).keys)
    return
  }
  const key = ChangeSchema.parse(value).key ?? ""
  if (suffix === "removed") items.delete(key)
  else {
    const before = items.get(key)
    if (before) items.set(key, patched(before, value))
  }
}

/** `keys` first in their order, then any the list holds that they don't name. */
function reorder(items: Map<string, Fact>, keys: readonly string[]): void {
  const before = new Map(items)
  items.clear()
  for (const key of keys) {
    const item = before.get(key)
    if (item) items.set(key, item)
  }
  for (const [key, item] of before) if (!items.has(key)) items.set(key, item)
}

/**
 * One item's change, `set` the fields it set and `unset` the ones it
 * removed, or `undefined` when it changed none. A field still the same
 * object costs nothing, so a request that moved on is its new fields only.
 */
function fieldChanges(before: Fact, after: Fact): JsonObject | undefined {
  const old = new Map(Object.entries(before))
  const now = new Map(Object.entries(after))
  const set: JsonObject = {}
  let changed = false
  for (const [name, value] of now) {
    if (value === undefined) continue
    const was = old.get(name)
    if (value === was || (was !== undefined && canonical(value) === canonical(was))) continue
    set[name] = value
    changed = true
  }
  const unset = [...old].filter(([name, value]) => value !== undefined && now.get(name) === undefined).map(([name]) => name)
  if (!changed && !unset.length) return undefined
  const change: JsonObject = {}
  if (changed) change.set = set
  if (unset.length) change.unset = unset
  return change
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/** The value as JSON carries it, its `undefined` fields gone. */
function jsonOf<Value>(value: Value): JsonObject {
  return Fields.parse(JSON.parse(JSON.stringify(value)))
}

/** An object's entries sorted by key, so two equal values serialise alike however they were built. */
const sortedKeys = (_key: string, value: JsonValue): JsonValue =>
  value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
    : value

/** JSON with every object's keys in order: equal for equal values. */
export function canonical(value: JsonValue): string {
  return JSON.stringify(value, sortedKeys)
}
