import { createHash } from "node:crypto"
import type { ConversationControl, NoteHeard } from "../contracts/conversation-control.js"

/**
 * The lines of Mako's note on a prompt (`controlNote`). `standing` holds what
 * stays true for the binding's process, each line under a name of its own, so
 * a changed line replaces the one before it; a line that doesn't apply is
 * left out or undefined. `notices` are events, each said once, on the prompt
 * after it happened.
 */
export interface ControlInstructions {
  standing: Readonly<Record<string, string | undefined>>
  notices: readonly string[]
}

/**
 * The standing lines a binding's process last heard, under the start of that process (`Resident.bindingGenerations`),
 * each by its fingerprint (`noteLineMark`).
 */
export interface ControlSaid {
  bindingId: string
  generation: number
  /** The native session it went into, when the binding had named one. */
  nativeId?: string
  lines: ReadonlyMap<string, string>
}

/** The standing lines a prompt carries, and what its process will have heard once it does. */
export interface StandingNote {
  lines: string[]
  said: ControlSaid
}

/** Ahead of standing lines that changed since the process last heard them. */
export const CHANGED_LINE = "Changed since Mako's earlier note in this session:"
/** Ahead of the whole note again when a line it heard no longer applies. */
export const REPLACED_LINE = "This replaces Mako's earlier notes in this session; what they said and this doesn't no longer applies."

/** A standing line's fingerprint: what the journal keeps of a line a transcript holds, never the line itself. */
export function noteLineMark(line: string): string {
  return createHash("sha256").update(line).digest("base64url").slice(0, 16)
}

/**
 * What a prompt carries of the standing lines: all of them for a transcript
 * that holds none, then only the lines that changed, nothing when none did,
 * and all of them again when one of the lines it heard went. `said` is what
 * the transcript holds (`heardBy`), or nothing.
 */
export function standingLines(
  said: ControlSaid | undefined,
  at: Omit<ControlSaid, "lines">,
  standing: ControlInstructions["standing"]
): StandingNote {
  const now = new Map(Object.entries(standing).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const next: ControlSaid = { ...at, lines: new Map([...now].map(([key, line]) => [key, noteLineMark(line)])) }
  const heard = said?.lines
  if (!heard) return { lines: [...now.values()], said: next }
  if ([...heard.keys()].some((key) => !now.has(key))) return { lines: [REPLACED_LINE, ...now.values()], said: next }
  const changed = [...now].filter(([key, line]) => heard.get(key) !== noteLineMark(line)).map(([, line]) => line)
  return { lines: changed.length ? [CHANGED_LINE, ...changed] : [], said: next }
}

/** Where a prompt goes: the binding, the start of its process, its native session and the folder it works in. */
export interface NoteTarget {
  bindingId: string
  generation: number
  nativeId: string | undefined
  cwd: string
}

/**
 * What the transcript a prompt goes into already holds of Mako's note. The
 * process's own record while the same start of the same binding runs; else
 * what the journal keeps (`ConversationControl.noteHeard`) for the same
 * binding, native session and folder, once the model answered a prompt that
 * carried it. A new native session, another binding (a harness switch), a
 * moved folder, or a compaction or rewind since (which clears it) holds none.
 */
export function heardBy(said: ControlSaid | undefined, kept: ConversationControl["noteHeard"], at: NoteTarget): ControlSaid | undefined {
  const sameSession = said?.nativeId === undefined || at.nativeId === undefined || said.nativeId === at.nativeId
  if (said?.bindingId === at.bindingId && said.generation === at.generation && sameSession) return said
  if (!kept || at.nativeId === undefined) return undefined
  if (kept.bindingId !== at.bindingId || kept.nativeId !== at.nativeId || kept.cwd !== at.cwd) return undefined
  return { bindingId: at.bindingId, generation: at.generation, nativeId: at.nativeId, lines: new Map(Object.entries(kept.lines)) }
}

/** What the journal keeps once the model answered a prompt that carried `said`. */
export function noteHeard(said: ControlSaid, nativeId: string, cwd: string): NoteHeard {
  return { bindingId: said.bindingId, nativeId, cwd, lines: Object.fromEntries(said.lines) }
}

/** Whether the journal already keeps exactly this. */
export function sameNoteHeard(a: NoteHeard | undefined, b: NoteHeard): boolean {
  if (!a || a.bindingId !== b.bindingId || a.nativeId !== b.nativeId || a.cwd !== b.cwd) return false
  const keys = Object.keys(b.lines)
  return keys.length === Object.keys(a.lines).length && keys.every((key) => a.lines[key] === b.lines[key])
}
