import type { GitFile } from "@/lib/types"
import { countedChanges, type RequestChanges, type TurnChangedFile, type TurnChangeShare } from "@mako/host/contracts/turn-changes"

/** Changed lines, and files not counted by lines, not sure whose. */
export interface Unsure {
  lines: number
  files: number
}

export const NOTHING_UNSURE: Unsure = { lines: 0, files: 0 }

/** What one finished turn changed: the line under its answer. */
export interface TurnChangeSummary {
  files: number
  /** Lines added across the files that report a count; null when none does (all binary, say). */
  insertions: number | null
  deletions: number | null
  /**
   * What the journal can't say is the agent's or anyone else's (a save of
   * the person's or another app's while the turn ran fits as well): "not
   * sure whose", counted apart, never in `files` or the line counts. Lines,
   * as the writer rows and the undo count them; a file whose content isn't
   * counted by lines (a picture) counts whole.
   */
  unsure: Unsure
  /** Counted before the journal settled every change: the numbers may still move. */
  settling: boolean
}

/**
 * A turn's line from its request's record (`LiveRequest.changes`), the one
 * the journal counted: the agent's own files and net lines, and what of
 * it is not sure whose. Undefined while the record is pending, or for a turn from
 * before Mako kept one. With `root`, only what it changed in that
 * repository, as Changes › Turn shows it there: the record's own counts
 * when every file of it is there, so the line and the header read the same.
 */
export function recordedTurnChanges(changes: RequestChanges | undefined, root?: string): TurnChangeSummary | undefined {
  const counted = countedChanges(changes)
  if (!counted) return undefined
  const settling = counted.state === "settling"
  const here = root === undefined ? counted.files : counted.files.filter((file) => fileRoot(file) === root)
  // Files not counted by lines (a picture, an empty file made) are read from the files listed; past the list's cap, only lines are known.
  const unlined = here.filter((file) => file.maybe === null || (file.maybe && file.maybe.added + file.maybe.removed === 0)).length
  if (here.length === counted.files.length) return summaryOf(counted.own, { lines: counted.maybe.added + counted.maybe.removed, files: unlined }, settling)
  const own = { files: 0, added: 0, removed: 0 }
  let lines = 0
  for (const file of here) {
    if (file.own !== undefined) {
      own.files++
      own.added += file.own?.added ?? 0
      own.removed += file.own?.removed ?? 0
    }
    lines += (file.maybe?.added ?? 0) + (file.maybe?.removed ?? 0)
  }
  return summaryOf(own, { lines, files: unlined }, settling)
}

function summaryOf(own: TurnChangeShare, unsure: Unsure, settling: boolean): TurnChangeSummary {
  const lines = own.added + own.removed > 0
  return { files: own.files, insertions: lines ? own.added : null, deletions: lines ? own.removed : null, unsure, settling }
}

/** Whether anything of a turn is not sure whose. */
export const anyUnsure = (unsure: Unsure) => unsure.lines + unsure.files > 0

/** The files a turn from before the journal counted turns changed, from its checkpoints; a file without a count (a binary) adds to the files and nothing else. */
export function turnChangeSummary(files: readonly Pick<GitFile, "insertions" | "deletions">[]): TurnChangeSummary {
  let insertions: number | null = null
  let deletions: number | null = null
  for (const file of files) {
    if (file.insertions !== null) insertions = (insertions ?? 0) + file.insertions
    if (file.deletions !== null) deletions = (deletions ?? 0) + file.deletions
  }
  return { files: files.length, insertions, deletions, unsure: NOTHING_UNSURE, settling: false }
}

/** The line's words: "Changed a file", "Changed 4 files". */
export function turnChangeWords(files: number): string {
  return files === 1 ? "Changed a file" : `Changed ${files.toLocaleString()} files`
}

/**
 * The one name for what the journal can't put on anyone: it might be this
 * thread's, it might be the person's or another app's. Every surface that
 * counts or names such a change says it this way.
 */
export const UNSURE = "not sure whose"
/** The same, where it starts a label: a writer row. */
export const UNSURE_LABEL = "Not sure whose"

/** "2 lines not sure whose", "1 file not sure whose", "3 lines and 1 file not sure whose". */
export function unsureWords({ lines, files }: Unsure): string {
  const counts = [lines ? `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}` : "", files ? `${files.toLocaleString()} ${files === 1 ? "file" : "files"}` : ""]
  return `${counts.filter(Boolean).join(" and ")} ${UNSURE}`
}

/** What "not sure whose" means, for the hover on every place that says it. */
export const UNSURE_MEANING = "Changed while the turn ran, with nothing tying the change to the agent or to anyone else: a save of yours or another app's fits as well as the agent's. Not counted as the turn's."

/** The repository a record's file is in: its path less its path inside the journal's root. */
export function fileRoot(file: Pick<TurnChangedFile, "path" | "relative">): string {
  return file.path.slice(0, file.path.length - file.relative.length - 1)
}

/**
 * The repositories a turn's record names, in its order: what Review opens
 * when its checkpoints weren't both saved. Empty while the record is
 * pending, or for a turn that changed nothing.
 */
export function recordRoots(changes: RequestChanges | undefined): string[] {
  return [...new Set(countedChanges(changes)?.files.map(fileRoot) ?? [])]
}
