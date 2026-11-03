/**
 * What an agent is told when its turn goes on from a point older than work it
 * already did: a harness resumed it from its last saved step after a dropped
 * connection (Cursor's SDK does, inside the same run), or Mako continued a
 * turn that was cut short. The calls that ran after that point and what
 * changed in its checkout since are facts the agent can't see in its own
 * history, so they are spelled out, call by call, before its next step.
 */

/** One call that ran after the point the agent goes on from, as its stream showed it. */
export interface ResumedCall {
  tool: string
  /** Its input in words: a command, a path, else its arguments' JSON. */
  input?: string
  /** `finished` with its result, or `started` when no result came back. */
  state: "finished" | "failed" | "started"
  result?: string
}

/** One repository of the checkout, and what moved in it since that point (`checkoutSince`). */
export interface RepositoryChanges {
  /** Its folder, as the agent knows the checkout: relative to it, or `.` for the checkout itself. */
  name: string
  head?: { from?: string; to: string; moves: string[] }
  commits: { sha: string; subject: string }[]
  /** Remote-tracking refs of the branch that moved: a push (or a fetch, as the reflog says). */
  remotes: { ref: string; from?: string; to: string; how: string }[]
  files: string[]
  moreFiles: number
}

export interface ResumeAccount {
  calls: readonly ResumedCall[]
  checkout: readonly RepositoryChanges[]
  /** Why the turn goes on from an older point. */
  cause: "reconnected" | "continued"
}

const RESULT_CHARS = 1_500
const INPUT_CHARS = 600
const TOTAL_CHARS = 24_000

const HEADER = /^\[mako · (reconnected|continued): you go on from your last saved step, before (\d+) calls? you had already run\]\n/

function header(cause: ResumeAccount["cause"], calls: number): string {
  return `[mako · ${cause}: you go on from your last saved step, before ${calls} ${calls === 1 ? "call" : "calls"} you had already run]\n`
}

const OPENING = {
  reconnected:
    "The connection to the model dropped mid-turn, and this turn resumed from your last saved step. The calls below ran after that step and their effects are in place, but your history doesn't show them.",
  continued:
    "Your previous turn was cut short, and this one goes on from your last saved step. The calls below ran after that step and their effects are in place, but your history doesn't show all of them.",
} as const satisfies Record<ResumeAccount["cause"], string>

const CLOSING =
  "Go on from this state: check what an unfinished call did before running it again, and treat everything here as your own work, not someone else's."

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

function callLines(call: ResumedCall, index: number): string {
  const clipped = call.input === undefined ? undefined : clip(call.input, INPUT_CHARS)
  const head = clipped === undefined
    ? `${index + 1}. ${call.tool}`
    : inline(clipped)
      ? `${index + 1}. ${call.tool}: \`${clipped}\``
      : `${index + 1}. ${call.tool}, with input:\n${indent(fence(clipped))}`
  const state =
    call.state === "started"
      ? "   Started, and no result came back: it may have run in full, in part, or not at all."
      : call.state === "failed"
        ? "   Finished with an error."
        : "   Finished."
  const result = call.result?.trim() ? `\n   Its result:\n${indent(fence(clip(call.result.trim(), RESULT_CHARS)))}` : ""
  return `${head}\n${state}${result}`
}

function inline(text: string): boolean {
  return !text.includes("\n") && !text.includes("`")
}

function fence(text: string): string {
  const ticks = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)))
  return `${ticks}\n${text}\n${ticks}`
}

function indent(text: string): string {
  return text.split("\n").map((line) => (line ? `   ${line}` : line)).join("\n")
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : "nothing"
}

function repositoryLine(repository: RepositoryChanges): string | undefined {
  const parts: string[] = []
  if (repository.head) {
    const moves = repository.head.moves.length ? ` (${repository.head.moves.map((move) => clip(move, 160)).join("; ")})` : ""
    parts.push(`HEAD moved ${short(repository.head.from)} → ${short(repository.head.to)}${moves}.`)
  }
  if (repository.commits.length)
    parts.push(`New ${repository.commits.length === 1 ? "commit" : "commits"}: ${repository.commits.map((commit) => `${short(commit.sha)} ${clip(commit.subject, 160)}`).join("; ")}.`)
  for (const remote of repository.remotes) parts.push(`${remote.ref} moved ${short(remote.from)} → ${short(remote.to)} (${remote.how}).`)
  if (repository.files.length)
    parts.push(`Files changed: ${repository.files.join(", ")}${repository.moreFiles ? `, and ${repository.moreFiles} more` : ""}.`)
  return parts.length ? `- ${repository.name}: ${parts.join(" ")}` : undefined
}

/** One line per repository where something moved: HEAD, new commits, its branch's remote-tracking refs, files. */
export function checkoutLines(changes: readonly RepositoryChanges[]): string[] {
  return changes.map(repositoryLine).filter((line): line is string => line !== undefined)
}

/** The words the agent is told, or `undefined` when no call ran past the point it goes on from. */
export function resumeAccountText(account: ResumeAccount): string | undefined {
  if (!account.calls.length) return undefined
  const calls: string[] = []
  let used = 0
  for (const [index, call] of account.calls.entries()) {
    const lines = callLines(call, index)
    if (used + lines.length > TOTAL_CHARS && calls.length) {
      calls.push(`…and ${account.calls.length - index} more ${account.calls.length - index === 1 ? "call" : "calls"}, left out for length.`)
      break
    }
    calls.push(lines)
    used += lines.length
  }
  const repositories = checkoutLines(account.checkout)
  const checkout = repositories.length
    ? `In the checkout since that step:\n${repositories.join("\n")}`
    : "Nothing else moved in the checkout since that step: no commit, push or other file change."
  return `${header(account.cause, account.calls.length)}${OPENING[account.cause]}\n\n${calls.join("\n\n")}\n\n${checkout}\n\n${CLOSING}`
}

/** A message that is a resume account, read back by its header: why, and how many calls it names. */
export function savedResumeAccount(text: string): { cause: ResumeAccount["cause"]; calls: number } | undefined {
  const start = text.search(/\S/)
  const match = HEADER.exec(start > 0 ? text.slice(start) : text)
  return match ? { cause: match[1] === "continued" ? "continued" : "reconnected", calls: Number(match[2]) } : undefined
}

/** The Thread's line for one: what the person is shown instead of the words the agent read. */
export function resumeAccountLine(saved: { cause: ResumeAccount["cause"]; calls: number }): string {
  const calls = `${saved.calls} ${saved.calls === 1 ? "call" : "calls"} it had already run`
  return saved.cause === "reconnected" ? `Reconnected; resumed with ${calls}` : `Continued; told it of ${calls}`
}
