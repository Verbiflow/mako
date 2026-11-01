import { z } from "zod"
import { BACKGROUND_AGENTS_BINDING, type NativeAgent } from "./native-agents.js"

/**
 * A background agent: a harness's own headless run that a conversation
 * started to work for it (Claude Code's `claude -p`, `cursor-agent -p`,
 * `codex exec`, …), which outlives the turn that started it. Its transcript
 * is its harness's own Session, which the catalog lists like a terminal's;
 * the Thread store links that Session to the conversation's, so it is never
 * a Thread of its own and every surface shows it under its parent
 * (`ThreadStore.backgroundAgents`).
 *
 * `started`: Mako ran it for the conversation (`agent_start`). `discovered`:
 * a run of a harness's CLI from the conversation's own shell, found by the
 * conversation's Session in its environment (`MAKO_SESSION_ID`). `linked`:
 * one the conversation named afterwards (`agent_link`).
 */
export const BackgroundAgentOriginSchema = z.enum(["started", "discovered", "linked"])
export type BackgroundAgentOrigin = z.infer<typeof BackgroundAgentOriginSchema>

/** How a background agent ended, once that is known: said once and kept. */
export const BackgroundAgentEndSchema = z.object({
  at: z.number(),
  kind: z.enum(["done", "failed", "stopped", "unknown"]),
  detail: z.string().max(2000).optional(),
  /** The calls it made, as last counted: its Session isn't read again once it ended. */
  toolUses: z.number().int().nonnegative().optional(),
})
export type BackgroundAgentEnd = z.infer<typeof BackgroundAgentEndSchema>

/** Its process on the device it runs on: a pid alone is reused, so its start time says it's the same process. */
export const BackgroundAgentProcessSchema = z.object({
  pid: z.number().int().positive(),
  /** When the process started, to the second (`processStartedAt`), once read. */
  startedAt: z.number().optional(),
})
export type BackgroundAgentProcess = z.infer<typeof BackgroundAgentProcessSchema>

export const BackgroundAgentRecordSchema = z.object({
  /** Mako's own ID for it. */
  id: z.string().uuid(),
  /** The Session of the conversation it works for (`ThreadPlacement.session`). */
  parent: z.string().uuid(),
  harness: z.string().min(1).max(64),
  /** Its harness's ID for its Session, once known: what the catalog lists it by. */
  nativeId: z.string().min(1).max(512).optional(),
  title: z.string().max(512),
  /** What it was asked, as much as a row shows. */
  detail: z.string().max(8192).optional(),
  model: z.string().max(256).optional(),
  origin: BackgroundAgentOriginSchema,
  /** The device it runs on (`ThreadStore.deviceId`): only that device's hosts can see its process. */
  device: z.string().uuid(),
  process: BackgroundAgentProcessSchema.optional(),
  /** Where Mako keeps what a run it started printed and how it exited (`BackgroundAgents`). */
  runDir: z.string().max(4096).optional(),
  startedAt: z.number(),
  ended: BackgroundAgentEndSchema.optional(),
})
export type BackgroundAgentRecord = z.infer<typeof BackgroundAgentRecordSchema>

/** What its follower last read of it, beside the record. */
export interface BackgroundAgentReading {
  /** Its process still runs (`true`), has gone (`false`), or can't be seen from here (undefined: another device's, or none named). */
  alive?: boolean
  /** Its Session as the catalog lists it, once it does. */
  session?: { path: string; updatedAt?: number; title?: string }
  /** The last thing its Session shows it doing (`lastStep`), and how many calls it made, from its tail. */
  step?: string
  toolUses?: number
  /** Its harness's process probe says the Session is at work (`active`) or waits on a person (`needs-input`). */
  activity?: "active" | "needs-input" | "open"
}

/** A run with no Session listed yet reads as starting for this long; past it, as not heard from. */
export const BACKGROUND_AGENT_START_MS = 120_000

/**
 * The roster entry a background agent is, from its record and its last
 * reading. Every surface draws this one entry (the Agents panel, the
 * transcript's line, the composer's toggle, the phone), so no surface words
 * a background agent on its own. A run never shows at work once its end is
 * known, and one this device can't see shows as it was last heard of,
 * never as running.
 */
export function backgroundAgentEntry(record: BackgroundAgentRecord, reading: BackgroundAgentReading, now: number): NativeAgent {
  const entry: NativeAgent = {
    nativeId: `mako-agent:${record.id}`,
    title: record.title,
    work: "agent",
    background: true,
    stoppable: false,
    state: backgroundAgentState(record, reading, now),
    bindingId: BACKGROUND_AGENTS_BINDING,
    provider: record.harness,
    observedAt: reading.session?.updatedAt ?? record.startedAt,
    startedAt: record.startedAt,
    detached: { id: record.id, origin: record.origin },
  }
  if (record.detail) entry.detail = record.detail
  if (record.model) entry.model = record.model
  if (record.nativeId) entry.detached!.session = record.nativeId
  if (reading.session?.path) entry.detached!.path = reading.session.path
  const toolUses = reading.toolUses ?? record.ended?.toolUses
  if (toolUses) entry.usage = { toolUses }
  if (record.ended) {
    entry.settledAt = record.ended.at
    entry.observedAt = record.ended.at
  } else if (reading.alive && record.process) entry.stoppable = true
  return entry
}

function backgroundAgentState(record: BackgroundAgentRecord, reading: BackgroundAgentReading, now: number): NativeAgent["state"] {
  const ended = record.ended
  if (ended) {
    if (ended.kind === "done") return ended.detail ? { kind: "completed", summary: ended.detail } : { kind: "completed" }
    if (ended.kind === "failed") return { kind: "failed", error: ended.detail ?? "It ended with an error." }
    if (ended.kind === "stopped") return { kind: "canceled" }
    return { kind: "unknown", reason: ended.detail ?? "It ended without saying how." }
  }
  if (reading.activity === "needs-input") return { kind: "waiting", reason: "Waiting on you in its own terminal" }
  if (reading.alive || reading.activity === "active" || reading.activity === "open")
    return reading.step ? { kind: "working", activity: reading.step } : reading.session ? { kind: "working" } : { kind: "working", activity: "Starting" }
  if (reading.alive === undefined && !reading.session && now - record.startedAt < BACKGROUND_AGENT_START_MS) return { kind: "working", activity: "Starting" }
  return { kind: "unknown", reason: reading.alive === false ? "Its process ended before Mako read how." : "Mako can't see its process from here." }
}
