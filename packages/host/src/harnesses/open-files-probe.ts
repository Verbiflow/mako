import { z } from "zod"
import { hostProbe } from "../base/host-command.js"
import type { ProviderActivityResult } from "../threads/index.js"
import { onMac, onWindows } from "../base/platform.js"
import { hostStopping, type RunningCommand } from "../base/host-stopping.js"

export type OpenFilesResult =
  | {
      kind: "available"
      paths: string[]
      processFound: boolean
      pids: number[]
      /** Each pid's process group, where lsof named it: a provider Mako spawns leads its group, so a native binary under its wrapper shares the wrapper's. */
      groups: Map<number, number>
    }
  | Extract<ProviderActivityResult, { kind: "unavailable" }>

export async function probeOpenFiles({
  processNames,
  signal,
  accept,
  sourcePath,
  runningIf,
}: {
  processNames: string[]
  /**
   * Whether a process could be one lsof is asked about, where its name alone can't say: Cursor's CLI runs as `node`,
   * which the host itself is. Without it, a process named in `processNames` is.
   */
  runningIf?: (command: RunningCommand) => boolean
  signal: AbortSignal
  accept: (path: string) => boolean
  /** Query a source inode across processes; executable names are not reliable ownership evidence. */
  sourcePath?: string
}): Promise<OpenFilesResult> {
  if (onWindows())
    return { kind: "unavailable", reason: "unsupported" }
  // No process by any of these names, no lsof: what it would find is none (its exit 1). The idle host asked lsof for
  // each harness every 30 s; one read of the process names now answers them all.
  if (!sourcePath && !(await anyRunning(processNames, runningIf)))
    return { kind: "available", paths: [], processFound: false, pids: [], groups: new Map() }
  const command = onMac() ? "/usr/sbin/lsof" : "lsof"
  const args = sourcePath ? ["-Fpgn", "--", sourcePath] : ["-Fpgn", ...processNames.flatMap((name) => ["-c", name])]
  // In the host's probe child (`hostProbe`): lsof's spawn held the host's loop 0.5 s in a 600 s run (2026-11-12).
  const answer = await lsofAnswer(command, args, signal)
  const paths = new Set<string>()
  const pids = new Set<number>()
  const groups = new Map<number, number>()
  let pid: number | undefined
  let incomplete = false
  for (const line of answer.stdout.split("\n")) {
    if (line.length > LINE_BYTES) {
      incomplete = true
      continue
    }
    if (/^p\d+$/.test(line)) {
      pid = Number(line.slice(1))
      pids.add(pid)
    } else if (/^g\d+$/.test(line) && pid !== undefined) groups.set(pid, Number(line.slice(1)))
    else if (line.startsWith("n") && accept(line.slice(1))) paths.add(line.slice(1))
  }
  // lsof exits 1 when it finds nothing; anything it says on stderr, or output past the limit, leaves the answer unknown.
  if (!incomplete && !signal.aborted && !answer.stderr.trim() && (answer.code === 1 || (answer.code === 0 && pids.size > 0)))
    return { kind: "available", paths: [...paths], processFound: answer.code === 0, pids: [...pids], groups }
  return { kind: "unavailable", reason: signal.aborted ? "timeout" : "failed" }
}

/** lsof's exit code and output; no code when it couldn't run or printed past the limit, which leaves the answer unknown. */
const LsofAnswerSchema = z.object({ code: z.number().int().optional(), stdout: z.string(), stderr: z.string() })
type LsofAnswer = z.infer<typeof LsofAnswerSchema>

async function lsofAnswer(command: string, args: string[], signal: AbortSignal): Promise<LsofAnswer> {
  try {
    return { code: 0, ...await hostProbe(command, args, { signal, maxBuffer: OUTPUT_BYTES }) }
  } catch (error) {
    const exited = LsofAnswerSchema.safeParse(error)
    return exited.success ? exited.data : { stdout: "", stderr: "" }
  }
}

/** At most this much of lsof's output; more is an answer cut short. */
const OUTPUT_BYTES = 16 * 1024 * 1024
/** A line this long isn't one lsof's fields make. */
const LINE_BYTES = 64 * 1024

/**
 * Whether a process runs under one of `names`, matched as `lsof -c` matches them: a name begins the command's, and
 * `/…/` is a regular expression. True when that can't be told, so lsof answers as before: the host's probes read the
 * names only on Linux (`HostProbes.commands`), and elsewhere lsof itself is asked.
 */
async function anyRunning(names: string[], runningIf?: (command: RunningCommand) => boolean): Promise<boolean> {
  if (!names.length) return true
  const running = await hostStopping()?.probes?.commands?.().catch(() => undefined)
  if (!running) return true
  if (runningIf) return running.some(runningIf)
  const matches = names.map((name) => {
    const pattern = /^\/(.*)\/([bix]*)$/.exec(name)
    if (!pattern) return (command: string) => command.startsWith(name)
    const regex = new RegExp(pattern[1]!, pattern[2]!.includes("i") ? "i" : "")
    return (command: string) => regex.test(command)
  })
  return running.some(({ comm }) => matches.some((match) => match(comm)))
}
