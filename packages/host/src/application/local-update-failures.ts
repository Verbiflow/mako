import type { BuildFailure, BuildPhase, UpdateBuildFrom } from "../contracts/app-lifecycle.js"
import { shortRevision } from "../contracts/update-source-text.js"

/**
 * Why an update stopped, in the person's words: which step, whether it's the
 * code's fault, the Mac's or the checkout's, and what to do next. A failure
 * used to be the step's name and the last 1,500 characters of whatever the
 * failing command printed, so a test that broke on old code, a Mac out of
 * file handles and a missing package all read alike.
 */

/** A step that failed, with what it printed. `blame` is set when the step knows better than its output says. */
export class StepError extends Error {
  readonly step: BuildPhase
  readonly blame: BuildFailure["blame"] | undefined
  readonly next: string | undefined
  readonly details: string | undefined
  /** The npm script or command that failed, when it was one. */
  readonly script: string | undefined
  constructor(step: BuildPhase, message: string, options: { blame?: BuildFailure["blame"]; next?: string; details?: string; script?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = "StepError"
    this.step = step
    this.blame = options.blame
    this.next = options.next
    this.details = options.details
    this.script = options.script
  }
}

/** What the build was making, for saying whose code failed. */
export interface FailureContext {
  from: UpdateBuildFrom | undefined
  revision: string | undefined
  /** The upstream's name, `origin/main`. */
  upstream: string | undefined
  /** Uncommitted files the build took. */
  uncommitted: number
  /** The other source offers a way out: an upstream newer than what failed. */
  otherSource: UpdateBuildFrom | null
}

/**
 * The Mac's own troubles, as the failing command prints them: out of disk,
 * memory, file handles or time, a process killed, a host already running,
 * the keychain locked, the network down. Anything else reads as the code's.
 */
const MACHINE: { pattern: RegExp; what: string; next: string }[] = [
  { pattern: /ENOSPC|no space left on device|Not enough free disk space/i, what: "The disk filled up", next: "Free some disk space, then build again." },
  { pattern: /ENOMEM|JavaScript heap out of memory|Cannot allocate memory/i, what: "The Mac ran out of memory", next: "Close some apps or wait for agents to finish, then build again." },
  { pattern: /EMFILE|ENFILE|too many open files/i, what: "The Mac ran out of open files", next: "Wait for agents and builds to finish, then build again." },
  { pattern: /exceeded its time limit|timed out after|didn't finish within/i, what: "A step took longer than its limit", next: "The Mac may be very busy. Build again when it's quieter." },
  { pattern: /exited with a signal|SIGKILL|SIGTERM/, what: "A step was killed before it finished", next: "Build again. If it keeps happening, the Mac may be short of memory." },
  { pattern: /Mako is already running|address already in use|EADDRINUSE/i, what: "A check collided with something already running on this Mac", next: "Build again. If it keeps happening, quit any extra Mako windows started from a terminal." },
  { pattern: /errSecInternalComponent|User interaction is not allowed|keychain/i, what: "macOS wouldn't let Mako sign the app", next: "Unlock your login keychain, then build again." },
  { pattern: /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|registry\.npmjs/i, what: "The network didn't answer", next: "Check your connection, then build again." },
]

const STEP_WORDS = {
  copying: "Preparing the build",
  installing: "Installing dependencies",
  compiling: "Compiling",
  checking: "Checking",
  packaging: "Packaging",
  verifying: "Verifying the signature",
} satisfies Record<BuildPhase, string>

/** The build's code, named: `origin/main at 53cad1f4`, or `the checkout at d630b62d with 8 uncommitted files`. */
function whose(context: FailureContext): string {
  const at = context.revision ? shortRevision(context.revision) : "its commit"
  if (context.from === "upstream") return `${context.upstream ?? "the upstream"} at ${at}`
  const taken = context.uncommitted ? ` with ${context.uncommitted} uncommitted ${context.uncommitted === 1 ? "file" : "files"}` : ""
  return `the checkout at ${at}${taken}`
}

/** `BuildFailure` for an error a build threw. */
export function describeFailure(error: Error, context: FailureContext, fallback: BuildPhase): BuildFailure {
  const step = error instanceof StepError ? error.step : fallback
  const raw = error.message
  const details = error instanceof StepError ? error.details ?? raw : raw
  if (error instanceof StepError && error.blame && error.next) return { step, blame: error.blame, what: error.message, next: error.next, ...details !== error.message && { details } }
  const machine = MACHINE.find(({ pattern }) => pattern.test(raw) || pattern.test(details))
  if (machine) return { step, blame: "machine", what: `${STEP_WORDS[step]} failed: ${machine.what.charAt(0).toLowerCase()}${machine.what.slice(1)}.`, next: `This is the Mac, not the code. ${machine.next}`, details }
  const script = error instanceof StepError && error.script ? ` (${error.script})` : ""
  const code = whose(context)
  const next = context.from === "upstream"
    ? context.otherSource === "checkout"
      ? `It fails the same way for anyone on this commit, so wait for a fix on ${context.upstream ?? "the upstream"}, or build your checkout as it is.`
      : `It fails the same way for anyone on this commit, so wait for a fix on ${context.upstream ?? "the upstream"}, then build again.`
    : context.otherSource === "upstream"
      ? `Build ${context.upstream ?? "the upstream"} instead: it doesn't take the checkout's own changes. Or fix the checkout and build again.`
      : "Fix the checkout, then build again."
  return { step, blame: step === "copying" || step === "installing" ? "checkout" : "code", what: `${STEP_WORDS[step]}${script} failed on ${code}.`, next, details }
}

/** The whole failure in one paragraph, as `LocalBuildState.message` carries it. */
export function failureMessage(failure: BuildFailure): string {
  return `${failure.what} ${failure.next} Your installed app and agents were not changed.`
}
