import { fetch as fetchWith } from "undici"
import { KeptSaveSchema, type MachineSave } from "@mako/protocol/saves"
import { SessionSettingsSchema } from "@mako/sessions/settings"
import { hostLog, hostWarn } from "../base/host-log.js"
import { HandoffSchema, MoveIdSchema } from "../contracts/thread-execution.js"
import type { Actor } from "../contracts/thread-identity.js"
import { namedUuid } from "./cloud-moves.js"
import type { MachineSaveLink } from "./machine-saves.js"
import { applyArrivalCheckout, openArrivedSessions, type MoveArrivalDeps, type MoveArrivalInput } from "./move-arrival.js"

/**
 * A machine made for a Thread whose machine was lost, or replaced on purpose, picking the Thread up where its last
 * save left it, before its runtime speaks: the checkout onto its clone, each session's records into its harness's
 * store, the Thread into its store under the same IDs, each conversation opened as the same native session, and each
 * turn the save says was running continued with Mako's continuation, its reason `machine-lost`. Only then does its
 * runtime connect, so the first message waiting for it finds the conversation as it was.
 *
 * It restores a save of an earlier generation only, once: the restore is an arrival under an ID named by the machine
 * and both generations, whose mark in the clone's Git folder makes a repeat (this host restarting) change nothing.
 * A machine with nothing saved before it, a new Thread's first, finds nothing to do.
 */

export type MachineRestoreDeps = {
  arrival: MoveArrivalDeps
  continueTurn(conversationId: string, input: { requestId: string; reason: "machine-lost"; continues: string; actor: Actor }): void
}

export type Restored = { from: number; ms: number; conversations: number; continued: number; checkout: "applied" | "staged" | "arrived" | "none" }

/** The save the Thread's object keeps, and the generation that took it. */
export async function readSave(link: MachineSaveLink): Promise<{ save: MachineSave; generation: number } | undefined> {
  const response = await fetchWith(link.save.url, { headers: { authorization: link.save.authorization }, signal: AbortSignal.timeout(30_000) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`the Thread's save couldn't be read: the cloud answered ${response.status}`)
  const kept = KeptSaveSchema.parse(await response.json())
  return kept.save && kept.generation !== undefined ? { save: kept.save, generation: kept.generation } : undefined
}

/** Restores the Thread's save onto this machine, generation `generation` of `machine`, if an earlier one took it. */
export async function restoreSave(deps: MachineRestoreDeps, link: MachineSaveLink, machine: string, generation: number): Promise<Restored | undefined> {
  const began = performance.now()
  const kept = await readSave(link)
  if (!kept || kept.generation >= generation) return undefined
  const { save } = kept
  const move = MoveIdSchema.parse(namedUuid(`mako restore\0${machine}\0${kept.generation}\0${generation}`))
  const sessions: MoveArrivalInput["sessions"] = save.conversations.map((conversation) => {
    const tuning = conversation.tuning === undefined ? undefined : SessionSettingsSchema.safeParse(conversation.tuning)
    if (tuning && !tuning.success) hostWarn("machine", "a saved conversation's settings don't read here; it opens with its harness's own", { conversation: conversation.conversationId, harness: conversation.harness })
    const open: NonNullable<MoveArrivalInput["sessions"][number]["open"]> = { conversationId: conversation.conversationId }
    if (conversation.modeId) open.modeId = conversation.modeId
    if (tuning?.success) open.tuning = tuning.data
    return { harness: conversation.harness, nativeId: conversation.nativeId, open }
  })
  const handoff = save.handoff === undefined ? undefined : HandoffSchema.safeParse(save.handoff)
  if (handoff && !handoff.success) hostWarn("machine", "a save's Thread doesn't read here; its conversations open under new IDs", { from: kept.generation })
  const records = deps.arrival.records()
  if (!records) throw new Error("This host isn't linked to its Thread's records, so it can't restore its save.")
  const workspace = deps.arrival.workspace()
  if (workspace !== save.folder) throw new Error(`This machine's folder is ${workspace ?? "not made"}, not the saved ${save.folder}.`)
  // The checkout first, then the sessions, as an arrival does; either may be absent (a Thread with no commits yet,
  // or none of its conversations started).
  // The checkout and, where the save took one, the rest as a move carries it (other repositories, outside files, file
  // history): the save's checkpoint governs the first repository, the carry the others.
  const checkout: Restored["checkout"] = save.checkpoint
    ? (await applyArrivalCheckout(deps.arrival, { move, folder: save.folder, checkpoint: save.checkpoint, ...save.carry && { carry: save.carry }, restoring: true }, records)).checkout
    : "none"
  const arriving: Pick<MoveArrivalInput, "folder" | "sessions" | "handoff"> = { folder: save.folder, sessions }
  // Under the restore's move: a repeat takes the Thread once.
  if (handoff?.success) arriving.handoff = { ...handoff.data, move }
  if (sessions.length) await openArrivedSessions(deps.arrival, arriving, records)
  let continued = 0
  for (const conversation of save.conversations) {
    if (!conversation.turn) continue
    deps.continueTurn(conversation.conversationId, {
      requestId: namedUuid(`mako restore\0${move}\0${conversation.conversationId}\0continue`),
      reason: "machine-lost",
      continues: conversation.turn.requestId,
      // The machine carrying the Thread across, as a handoff does: Mako's own continuation, never the person's.
      actor: { kind: "service", name: "handoff" },
    })
    continued += 1
  }
  const restored: Restored = { from: kept.generation, ms: Math.round(performance.now() - began), conversations: sessions.length, continued, checkout }
  hostLog("machine", "restored a save", { ...restored, savedAt: new Date(save.at).toISOString(), checkpoint: save.checkpoint?.sha256.slice(0, 12) ?? "none", generation })
  return restored
}
