import { z } from "zod"
import type { MethodTable } from "../base/methods.js"
import { NOT_THE_PERSON, machineCall } from "../base/host-client.js"
import type { AgentCaller } from "../contracts/agents.js"
import {
  RULE_LAYERS,
  type ApexActInput,
  type ApexActResult,
  type ApexChange,
  type ApexCreateInput,
  type ApexCreateResult,
  type ApexEntry,
  type ApexGatherResult,
  type ApexPlanReading,
  type ApexProfileResult,
  type ApexRefused,
  type ApexRulesReading,
  type Memory,
  type MemorySaveInput,
  type MemorySaveResult,
  type RuleLayer,
} from "../contracts/apexes.js"
import { ThreadIdSchema } from "../contracts/thread-identity.js"
import type { Apexes } from "./apexes.js"

const UNAVAILABLE: ApexRefused = { refused: "unavailable", why: "Apexes need the Thread store, which didn't open on this host." }
const MACHINE: ApexRefused = { refused: "not-yours", why: NOT_THE_PERSON }
const LayerSchema = z.enum(RULE_LAYERS)
const ThreadsSchema = z.array(z.string().min(1).max(512)).max(20)
const TextSchema = z.string()
const ItemSchema = z.number().int().nonnegative()
const ReaderSchema = z.enum(["apex", "fin"])

/**
 * Deliberate Apexes for every window and device (`mako:apex-*`), and the two tools an agent calls (`apex`,
 * `memory_save`), each the same operation of `Apexes`.
 */
export function declareApexMethods(methods: MethodTable, apexes: () => Apexes | undefined): void {
  const machineAsPerson = (caller: AgentCaller) => caller.kind === "person" && machineCall()
  methods.handle("mako:apexes", (): ApexEntry[] => apexes()?.list() ?? [])
  methods.handle("mako:apex-create", async (input: ApexCreateInput): Promise<ApexCreateResult> => apexes()?.create(input, "person") ?? UNAVAILABLE)
  methods.handle("mako:apex-promote", (conversation: string, change: ApexChange): ApexProfileResult => apexes()?.promote(conversation, change, "person") ?? UNAVAILABLE)
  methods.handle("mako:apex-update", (thread: string, change: ApexChange): ApexProfileResult => apexes()?.update(ThreadIdSchema.parse(thread), change) ?? UNAVAILABLE)
  methods.handle("mako:apex-demote", (thread: string): { released: string[] } | ApexRefused => apexes()?.demote(ThreadIdSchema.parse(thread)) ?? UNAVAILABLE)
  methods.handle("mako:apex-gather", async (apex: string, threads: string[], confirm?: boolean): Promise<ApexGatherResult> =>
    apexes()?.gather(ThreadIdSchema.parse(apex), ThreadsSchema.parse(threads), confirm === true, "person") ?? UNAVAILABLE)
  methods.handle("mako:apex-seen", (thread: string): void => apexes()?.seen(ThreadIdSchema.parse(thread)))
  methods.handle("mako:apex-plan-read", (thread: string): ApexPlanReading => apexes()?.plan(ThreadIdSchema.parse(thread)) ?? { text: "", chars: 0 })
  methods.handle("mako:apex-plan-save", (thread: string, text: string): ApexPlanReading | ApexRefused => apexes()?.savePlan(ThreadIdSchema.parse(thread), TextSchema.parse(text)) ?? UNAVAILABLE)
  methods.handle("mako:apex-plan-answer", (thread: string, section: string, item: number, answer: string): ApexPlanReading | ApexRefused =>
    apexes()?.answerPlan(ThreadIdSchema.parse(thread), section, ItemSchema.parse(item), TextSchema.parse(answer)) ?? UNAVAILABLE)
  methods.handle("mako:apex-plan-check", (thread: string, section: string, item: number, done: boolean): ApexPlanReading | ApexRefused =>
    apexes()?.checkPlan(ThreadIdSchema.parse(thread), section, ItemSchema.parse(item), done) ?? UNAVAILABLE)
  methods.handle("mako:apex-rules-read", (thread: string, as: "apex" | "fin"): ApexRulesReading | ApexRefused => apexes()?.rules(ThreadIdSchema.parse(thread), ReaderSchema.parse(as)) ?? UNAVAILABLE)
  methods.handle("mako:apex-rule-save", (layer: RuleLayer, text: string, at: { thread?: string; folder?: string }): { chars: number } | ApexRefused =>
    apexes()?.saveRule(LayerSchema.parse(layer), text, at) ?? UNAVAILABLE)
  methods.handle("mako:rule-layers", (folder?: string): { you: string; youFolder: string; folder: string; memories: Memory[] } =>
    apexes()?.personLayers(folder) ?? { you: "", youFolder: "", folder: "", memories: [] })
  methods.handle("mako:memory-forget", (id: string): boolean => apexes()?.forgetMemory(id) ?? false)
  // The tools, the caller named by the door.
  methods.handle("mako:apex-act", async (caller: AgentCaller, input: ApexActInput): Promise<ApexActResult> => machineAsPerson(caller) ? MACHINE : (await apexes()?.act(caller, input)) ?? UNAVAILABLE)
  methods.handle("mako:memory-save", (caller: AgentCaller, input: MemorySaveInput): MemorySaveResult => machineAsPerson(caller) ? MACHINE : apexes()?.memoryAct(caller, input) ?? UNAVAILABLE)
}
