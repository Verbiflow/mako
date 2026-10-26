/** How a Thread came by a file, strongest first. */
export type TouchKind = "wrote" | "read" | "named"

export interface Touch {
  kind: TouchKind
  /** When the Thread last touched it this way, in milliseconds. */
  at: number
}

/** Why a spelling means the file it links to. */
export type ResolveReason =
  /** The spelling is the file's full path. */
  | "absolute"
  /** The spelling is relative to a folder the Thread's calls ran in. */
  | "from-folder"
  /** The Thread touched the one file that ends this way. */
  | "touched"
  /** It meant a file renamed since; this is its name now. */
  | "renamed"
  /** It meant a file in a checkout the Thread has left; this is the same file where it works now. */
  | "twin"
  /** The only file in the Thread's places that ends this way. */
  | "only-match"
  /** The person picked it among several. */
  | "chosen"

export interface FileCandidate {
  /** The file now, as an absolute path. */
  path: string
  /** What the spelling meant when it was written, where that differs. */
  was?: string
  /** The checkout or folder it's in, by name, and the folder inside it. */
  place?: { name: string; folder: string }
  touch?: Touch
  reason: ResolveReason
  /**
   * The line the spelling named as of its answer (`was`), and where that
   * line is in the file now, followed through every change since by the
   * journal's own line diff; null once it was removed. Absent when the
   * spelling names no line, or the versions between aren't kept.
   */
  line?: { was: number; now: number | null }
}

export type FileResolution =
  /** `others`: for a file the person picked, the rest that fit, so they can pick again. */
  | { kind: "file"; file: FileCandidate; others?: FileCandidate[] }
  /** Several files fit equally well; the person picks. Ranked, most likely first. */
  | { kind: "choice"; candidates: FileCandidate[] }
  | { kind: "none" }

/**
 * What a Thread's agent should hear when its checkout moves, beyond "paths
 * under the old root are under the new one": files it used that were
 * renamed since, and files it used that didn't come along. Its own spellings,
 * most recently used first.
 */
export interface MovedPaths {
  /** The checkout's old root and its new one. */
  root: { from: string; to: string }
  renamed: { was: string; now: string }[]
  stayed: string[]
  /** Files left off both lists to keep the notice short. */
  more: number
}

/**
 * A live conversation's id, as a host call takes it.
 * @wire z.string().min(1).max(200)
 */
type LiveId = string

/**
 * A saved record's path, as a host call takes it.
 * @wire z.string().min(1).max(16_384)
 */
type RecordPath = string

/**
 * When an answer was written, in milliseconds.
 * @wire z.number().int().nonnegative().max(8_640_000_000_000_000)
 */
type Instant = number

/**
 * The message whose spellings are resolved: a live conversation, or a saved
 * record. `asOf`, once its answer is finished: the spellings mean what they
 * meant then, from what the Thread had touched by then. Without it, now.
 */
export interface FileReferenceSource {
  liveId?: LiveId
  threadPath?: RecordPath
  asOf?: Instant
}

/**
 * A file the person picked for a spelling, as an absolute path.
 * @wire z.string().min(2).max(4_096).startsWith("/")
 */
export type ChosenFile = string

/**
 * One spelling, as `FileSpellings` holds them.
 * @wire z.string().min(1).max(4_096)
 */
export type FileSpelling = string

/**
 * One message's file spellings, each with its line if it has one, resolved
 * in one call; `MAX_SPELLINGS` of them at most.
 * @wire z.array(z.string().min(1).max(4_096)).max(400)
 */
export type FileSpellings = string[]
