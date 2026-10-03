import { z } from "zod"

/** One of a check's named steps: a command of its own, timed and reported apart from the others. */
export interface CheckStep {
  name: string
  command: string
  /** Runs at the same time as the steps beside it that say so too. */
  parallel?: boolean
}

/** Where a run of steps keeps each step's records; Mako sets it for the run, and the run unsets it before any step starts. */
export const STEPS_FOLDER_VARIABLE = "MAKO_CHECK_STEPS"

const HEADER = "# mako check steps "

const StepsSchema = z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), command: z.string(), parallel: z.literal(true).optional() }).strict()).min(1)

/** The steps in order, each run of consecutive `parallel` steps together. */
export function stepGroups(steps: readonly CheckStep[]): CheckStep[][] {
  const groups: CheckStep[][] = []
  for (const step of steps) {
    const last = groups.at(-1)
    if (step.parallel && last?.[0]?.parallel) last.push(step)
    else groups.push([step])
  }
  return groups
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * One shell command that runs `steps` as a single run, so a check of steps
 * is started, stopped, outlives its host and is waited on like a check of
 * one command. A failed step ends it once the steps running beside it have
 * finished. Each step leaves `<name>.start` (when it began), `<name>.cmd`,
 * `<name>.log` (its own output, which also goes to the run's) and, once it
 * ends, `<name>.exit` with its code. The first line names the steps, so a
 * run says what it ran (`stepsOf`).
 */
export function stepsCommand(steps: readonly CheckStep[]): string {
  const listed = steps.map(({ name, command, parallel }) => (parallel ? { name, command, parallel: true as const } : { name, command }))
  return [
    `${HEADER}${JSON.stringify(listed)}`,
    `d=$${STEPS_FOLDER_VARIABLE}; unset ${STEPS_FOLDER_VARIABLE}`,
    `mako_step() { rm -f "$d/$1.exit"; printf '%s' "$2" > "$d/$1.cmd"; : > "$d/$1.start"; printf '[%s] %s\\n' "$1" "$2"; { (eval "$2") </dev/null 2>&1; printf '%s\\n' "$?" > "$d/$1.code"; } | tee "$d/$1.log"; mv -f "$d/$1.code" "$d/$1.exit"; printf '[%s] exit %s\\n\\n' "$1" "$(cat "$d/$1.exit")"; }`,
    `mako_passed() { for step; do [ "$(cat "$d/$step.exit" 2>/dev/null)" = 0 ] || return 1; done; }`,
    `rm -f ${steps.map((step) => `"$d/${step.name}".*`).join(" ")}`,
    ...stepGroups(steps).map((group) => {
      const run = group.length === 1
        ? `mako_step ${group[0]!.name} ${quote(group[0]!.command)}`
        : `${group.map((step) => `mako_step ${step.name} ${quote(step.command)} &`).join(" ")} wait`
      return `${run}; mako_passed ${group.map((step) => step.name).join(" ")} || exit 1`
    }),
  ].join("\n")
}

/** The steps a run of `stepsCommand` was given; undefined for a check of one command. */
export function stepsOf(command: string): CheckStep[] | undefined {
  if (!command.startsWith(HEADER)) return undefined
  const end = command.indexOf("\n")
  try {
    const parsed = StepsSchema.safeParse(JSON.parse(command.slice(HEADER.length, end === -1 ? undefined : end)))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** What a step left behind, from whichever run last ran it. */
export interface StepRecord {
  name: string
  /** The command it ran, to tell a result of the recipe's step from one of an earlier version of it. */
  command?: string
  startedAt: number
  exit?: { code: number; at: number }
}

export type StepState =
  /** In the run, not begun yet. */
  | { kind: "waiting" }
  | { kind: "running"; startedAt: number }
  | { kind: "passed" | "failed"; code: number; startedAt: number; at: number }
  /** Begun, and ended without an exit code: its run was stopped. */
  | { kind: "stopped"; startedAt: number }
  /** In a run that ended before it began, because a step before it failed or the run was stopped. */
  | { kind: "skipped" }
  /** Not run yet with the command the recipe names now. */
  | { kind: "never" }

/** A record by itself, as the step's last result. */
export function recordState(record: StepRecord | undefined, command: string): StepState {
  if (!record || (record.command !== undefined && record.command !== command)) return { kind: "never" }
  if (record.exit) return { kind: record.exit.code === 0 ? "passed" : "failed", code: record.exit.code, startedAt: record.startedAt, at: record.exit.at }
  return { kind: "stopped", startedAt: record.startedAt }
}

/** File times can be coarser than the clock that stamped the run, so a step of this run may look a moment older than it. */
const CLOCK_SLACK_MS = 1_000

/**
 * Each step of a run as that run left it: a record from before the run
 * started is an earlier run's, so in this run that step hasn't begun.
 */
export function runStepStates(steps: readonly CheckStep[], records: ReadonlyMap<string, StepRecord>, run: { startedAt?: number; up: boolean }): StepState[] {
  return steps.map((step) => {
    const record = records.get(step.name)
    const mine = record && (run.startedAt === undefined || record.startedAt >= run.startedAt - CLOCK_SLACK_MS) ? record : undefined
    if (!mine) return run.up ? { kind: "waiting" } : { kind: "skipped" }
    if (mine.exit) return { kind: mine.exit.code === 0 ? "passed" : "failed", code: mine.exit.code, startedAt: mine.startedAt, at: mine.exit.at }
    return run.up ? { kind: "running", startedAt: mine.startedAt } : { kind: "stopped", startedAt: mine.startedAt }
  })
}
