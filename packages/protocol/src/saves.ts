import { z } from "zod"
import { MoveCarryRefSchema, MoveCheckpointSchema } from "./moves.js"

/**
 * A cloud machine's save of its Thread: everything a new machine needs to carry the Thread on if this one is lost.
 *
 * The machine's host takes one after each tool call that could change files, at each turn's end, and every
 * `MACHINE_SAVE_EVERY_MS` while anything works. Its checkout is a move checkpoint (`moves.ts`), sent beside the
 * Thread's records by its hash; the save itself names it, with each conversation as a new machine opens it again, the
 * machine store's Thread under its IDs, and the disk's free space. The Thread's object keeps the newest save from the
 * runtime that runs it now, and refuses one from any other (`fenced`): a machine whose generation moved on can't save
 * over its successor.
 *
 * A new machine of the Thread reads the save before its runtime connects (`GET`), and restores it once: the
 * checkout onto its clone, each session's records into its harness's store, the Thread into its store, each
 * conversation opened as the same native session, and a turn the save says was running continued. A save is taken
 * whole or not at all, and the same checkout makes the same checkpoint, so a repeat costs nothing.
 */

/** While anything works, a machine saves at least this often (when its checkout changed). */
export const MACHINE_SAVE_EVERY_MS = 30_000

/** A machine's disk with less free than this is low: logged for Mako's operators. */
export const DISK_LOW_BYTES = 2 * 1024 ** 3
/** And with less than this, full: its Thread moves to a fresh machine at its next turn boundary. */
export const DISK_FULL_BYTES = 256 * 1024 ** 2

export const DiskSchema = z.object({
  freeBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
}).strict()
export type Disk = z.infer<typeof DiskSchema>

export type DiskLevel = "ok" | "low" | "full"

export function diskLevel(disk: Disk): DiskLevel {
  return disk.freeBytes < DISK_FULL_BYTES ? "full" : disk.freeBytes < DISK_LOW_BYTES ? "low" : "ok"
}

/** One conversation of the Thread as a new machine opens it again: its harness's session, under its mode and settings. */
export const SavedConversationSchema = z.object({
  conversationId: z.uuid(),
  harness: z.string().min(1).max(64),
  nativeId: z.string().min(1).max(512),
  modeId: z.string().min(1).max(200).optional(),
  /** Its launch settings as its harness's own (a model, an effort), read by the host that opens it. */
  tuning: z.json().optional(),
  /** The turn that was running when the save was taken: the request it answers, and the call it was in, in a line. */
  turn: z.object({ requestId: z.string().min(1).max(200), running: z.string().min(1).max(200).optional() }).strict().optional(),
}).strict()
export type SavedConversation = z.infer<typeof SavedConversationSchema>

/** Why a save holds an older checkout than the machine's: the newest couldn't be captured, and the person is told. */
/** Why a save couldn't take the newest changes: too large to carry, a merge in progress, or anything else. */
export const SaveProblemKindSchema = z.enum(["too-large", "conflicts", "failed"])

export const SaveProblemSchema = z.object({
  kind: SaveProblemKindSchema,
  message: z.string().min(1).max(2_000),
  at: z.number(),
}).strict()
export type SaveProblem = z.infer<typeof SaveProblemSchema>

export const MachineSaveSchema = z.object({
  version: z.literal(1),
  /** When its checkout was captured, by the machine's clock. */
  at: z.number(),
  /** The folder the Thread works in: a moved Thread's is its device's own path. */
  folder: z.string().min(1).max(4_096),
  /** The newest checkout that could be captured; absent before the first. */
  checkpoint: MoveCheckpointSchema.optional(),
  /**
   * The rest of the Thread, as a move carries it (`MoveCarry`): its other repositories, its files outside its folder and
   * its file history. Taken at each turn's end and while work goes on, not after every call, so it may be a turn older
   * than `checkpoint`, which governs the first repository; a restore lays both down.
   */
  carry: MoveCarryRefSchema.optional(),
  conversations: z.array(SavedConversationSchema).max(256),
  /**
   * The machine store's Thread, as a release would hand it over but without releasing it: what a new machine's store
   * takes, so the Thread and its Sessions keep their IDs on every device.
   */
  handoff: z.json().optional(),
  disk: DiskSchema.optional(),
  problem: SaveProblemSchema.optional(),
  /** The first save of a machine that restored a lost one's: what it restored, and how long that took. */
  restored: z.object({ from: z.number().int().positive(), ms: z.number().int().nonnegative(), conversations: z.number().int().nonnegative() }).strict().optional(),
}).strict()
export type MachineSave = z.infer<typeof MachineSaveSchema>

/** The most a save's record takes, as JSON: a handoff of a long Thread fits. */
export const MACHINE_SAVE_MAX_BYTES = 256 * 1024

/** `GET /v1/machines/<m>/save`: the Thread's newest save and the generation that took it, or none yet. */
export const KeptSaveSchema = z.object({
  save: MachineSaveSchema.nullable(),
  generation: z.number().int().positive().optional(),
}).strict()
export type KeptSave = z.infer<typeof KeptSaveSchema>

/**
 * The cloud's word to a cloud Thread's person about its machine, written by the Thread's object into the Thread's own
 * stream so every device says the same, and only when their own work is affected. A machine lost and replaced, a planned
 * move, a full disk are routine: they're logged for Mako's operators and the person hears nothing (a message sent
 * meanwhile waits and runs). What's said:
 * - `changes-lost`: the Thread carried on, but changes made on the old machine couldn't be brought back: those after
 *   `savedAt` (its last save), or, with no save at all (a machine from before saves), whatever wasn't pushed. `reason`:
 *   why the newest changes couldn't be saved, when a save said so.
 * - `failed`: new machines kept failing to take the Thread up; its save is kept, and the person's next message tries
 *   again.
 * The newest stands.
 */
export const ThreadMachineNoticeSchema = z.object({
  type: z.literal("machine"),
  at: z.number(),
  state: z.enum(["changes-lost", "failed"]),
  savedAt: z.number().optional(),
  reason: SaveProblemKindSchema.optional(),
}).strict()
export type ThreadMachineNotice = z.infer<typeof ThreadMachineNoticeSchema>

/**
 * How a Thread's object writes a notice into its stream: JSON whose first key is its type, so a reader tells it from a
 * runtime's events by its first bytes (`MACHINE_NOTICE_PREFIX`) without parsing every event.
 */
export function machineNoticeText(notice: Omit<ThreadMachineNotice, "type">): string {
  return JSON.stringify({ type: "machine", ...notice } satisfies ThreadMachineNotice)
}

export const MACHINE_NOTICE_PREFIX = '{"type":"machine"'
