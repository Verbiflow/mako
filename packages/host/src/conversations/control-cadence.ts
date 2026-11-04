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

/** The standing lines a binding's process last heard, under the start of that process (`Resident.bindingGenerations`). */
export interface ControlSaid {
  bindingId: string
  generation: number
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

/**
 * What a prompt carries of the standing lines: all of them for a process that
 * heard none, or heard them on another binding or start; then only the lines
 * that changed, nothing when none did, and all of them again when one of the
 * lines it heard went.
 */
export function standingLines(
  said: ControlSaid | undefined,
  at: Omit<ControlSaid, "lines">,
  standing: ControlInstructions["standing"]
): StandingNote {
  const now = new Map(Object.entries(standing).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const next: ControlSaid = { ...at, lines: now }
  const heard = said?.bindingId === at.bindingId && said.generation === at.generation ? said.lines : undefined
  if (!heard) return { lines: [...now.values()], said: next }
  if ([...heard.keys()].some((key) => !now.has(key))) return { lines: [REPLACED_LINE, ...now.values()], said: next }
  const changed = [...now].filter(([key, line]) => heard.get(key) !== line).map(([, line]) => line)
  return { lines: changed.length ? [CHANGED_LINE, ...changed] : [], said: next }
}
