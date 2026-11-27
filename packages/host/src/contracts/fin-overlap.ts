import { FIN_WORD } from "./agents.js"

/*
 * Whether a Fin about to start would edit what another Fin already edits (`AgentsStartInput.touches`). Two Fins on
 * the same files each load the same context, can't share decisions and meet at merge, so an agent's start that
 * overlaps is refused once, naming the files and the three ways on: send it to that Fin, start it after that Fin, or
 * start it anyway with a reason (`proceed`). Paths here are repo-relative and `/`-separated, as Git writes them.
 */

/** The most entries `touches` takes: past it, name directories instead. */
export const TOUCHES_LIMIT = 50
/** The longest one entry of `touches`. */
export const TOUCH_CHARS = 300
/** The longest reason `proceed` gives. */
export const PROCEED_CHARS = 300
/** Files an overlap's refusal names; the rest are counted. */
const NAMED_FILES = 3

/**
 * `touch` as a repo-relative path: `./`, `.` segments and doubled or trailing slashes gone, `..` folded, `\` read as
 * `/`. The repository's own root is "". Undefined for one that climbs out of the repository.
 */
export function touchPath(touch: string): string | undefined {
  const parts: string[] = []
  for (const part of touch.trim().replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part !== "..") parts.push(part)
    else if (!parts.pop()) return undefined
  }
  return parts.join("/")
}

/** Whether two repo-relative paths meet: the same file, or a directory and what's in it ("" holds everything). */
export function pathsMeet(a: string, b: string): boolean {
  return a === b || a === "" || b === "" || b.startsWith(`${a}/`) || a.startsWith(`${b}/`)
}

/** Where `mine` meets `theirs`: for each meeting, the narrower of the two paths, each once, in `mine`'s order. */
export function meetings(mine: readonly string[], theirs: readonly string[]): string[] {
  const found = new Set<string>()
  for (const one of mine) for (const other of theirs) if (pathsMeet(one, other)) found.add(one.length >= other.length ? one : other)
  return [...found]
}

/** Why `touches` or `proceed` can't be taken as given, or undefined when they can. */
export function touchesRefusal(input: { touches?: readonly string[]; proceed?: string }): string | undefined {
  if (input.touches && input.touches.length > TOUCHES_LIMIT) return `touches names ${input.touches.length} paths; it takes at most ${TOUCHES_LIMIT}. Name the directories instead.`
  if (input.touches?.some((touch) => !touch.trim() || touch.length > TOUCH_CHARS)) return `Each path in touches is 1 to ${TOUCH_CHARS} characters.`
  if (input.proceed !== undefined && (!input.proceed.trim() || input.proceed.length > PROCEED_CHARS)) return `proceed says why these don't collide in 1 to ${PROCEED_CHARS} characters.`
  return undefined
}

/** What another Thread of the caller's does to files the new Fin would touch. */
export interface OverlapMate {
  /** The Fin's name; absent for the caller itself. */
  name?: string
  /** Where they meet, repo-relative. */
  files: readonly string[]
  /** `editing`: at work and touching them; `changed`: it changed them since it started; `will edit`: queued or starting. */
  how: "editing" | "changed" | "will edit"
  /** Its branch, where it works on one of its own: the new Fin could start on it instead. */
  branch?: string
}

function filesWords(files: readonly string[]): string {
  const named = files.slice(0, NAMED_FILES).join(", ")
  return files.length > NAMED_FILES ? `${named} and ${files.length - NAMED_FILES} more` : named
}

function mateWords(mate: OverlapMate): string {
  if (!mate.name) return `you changed ${filesWords(mate.files)}`
  return `fin:${mate.name} ${mate.how === "editing" ? "is editing" : mate.how} ${filesWords(mate.files)}`
}

/**
 * The refusal's words: who meets the new Fin on which files, what that costs, and the three ways on, by the first Fin
 * named. `ownWorktree`: the new Fin would work in a worktree of its own, so it meets them at merge rather than in the
 * folder.
 */
export function overlapWhy(mates: readonly OverlapMate[], ownWorktree: boolean): string {
  const fins = mates.filter((mate) => mate.name !== undefined)
  const said = mates.map(mateWords).join("; ")
  // A Fin's handle stays as it's written, `fin:docs`; the caller's own words start a sentence.
  const head = `${said.startsWith("you ") ? `Y${said.slice(1)}` : said}, which this ${FIN_WORD} would touch.`
  const cost = ownWorktree
    ? "In its own worktree it would conflict with that work at merge."
    : fins.length
      ? `Two ${FIN_WORD}s on the same files load the same context twice and meet at merge.`
      : "In your folder it would edit them under you."
  const anyway = `start it anyway with proceed: "<why these don't collide>"`
  const first = fins[0]
  const ways = first
    ? `Send this to fin:${first.name} with agents_send, start it after: ${JSON.stringify(fins.map((fin) => fin.name))}${ownWorktree && first.branch ? ` or on its branch (workspace base: ${JSON.stringify(first.branch)})` : ""}, or ${anyway}.`
    : `Do it yourself, or ${anyway}.`
  return `${head} ${cost} ${ways} Keep this clientKey when you start it again.`
}
