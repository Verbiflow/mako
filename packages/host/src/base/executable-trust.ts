import { realpathSync, statSync } from "node:fs"
import { readdir, realpath, stat } from "node:fs/promises"
import { join, win32 } from "node:path"
import { windowsHelperLines, windowsHelperSync } from "./windows-helper.js"

/**
 * Whether a program Windows' launches found by searching is this user's choice (`mako-windows trusted`), and where it
 * really is: what is started, never the path it was found by, which a link or junction on the way could repoint after
 * it was asked about.
 *
 * The helper reads the program where it really is (through every link and junction): the file, the DLLs beside it,
 * its folder (files it hands down included) and every folder above, owned by this user, SYSTEM, Administrators or
 * TrustedInstaller and writable by no one else; and as it was named, every folder and link on the way, beyond anyone
 * else's repointing, deleting or renaming. A program another account could have put there, or written over, would run
 * as this user.
 *
 * Two places count without asking, where a program really is: the user's own profile, and Windows' `System32` and
 * `SysWOW64` themselves (not their subfolders, some of which every user may write). Where the helper is missing (a
 * release always ships it beside the app), Program Files counts too, as Windows makes it.
 *
 * A host keeps each verdict (`ExecutableTrust`, on its `HostStopping`) by the program's real path and its file's
 * identity (volume serial and file index, which no other file can take), while its size and times are unchanged; it
 * asks off its thread for every program on its folders as it starts, and asks again only for one it hasn't seen.
 */
export interface TrustOptions {
  env: NodeJS.ProcessEnv
  home: string
}

/** A verdict on a program: where it really is, to start, when it's trusted. */
export type ProgramVerdict = { trusted: true; real: string; identity: string } | { trusted: false; why: string }

/** Kept this long, while the program's file is the same one and unchanged. */
const VERDICT_MS = 10 * 60_000
/** Characters of paths asked about in one run of the helper (each on its own line of stdin). */
const BATCH_CHARACTERS = 256 * 1024

/** Where `file` really is, through links and junctions; itself when it can't be resolved. */
function realPath(file: string): string {
  try {
    return realpathSync.native(file)
  } catch {
    return file
  }
}

const sameFolder = (left: string, right: string) => withoutTrailingSeparators(left.toLowerCase()) === withoutTrailingSeparators(right.toLowerCase())

/** Where `file` really is, when that is in the profile or directly in `System32` or `SysWOW64`. */
export function trustedWithoutAsking(file: string, { env, home }: TrustOptions): string | undefined {
  const real = realPath(file)
  const system = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows"
  const folder = win32.dirname(real)
  if ([win32.join(system, "System32"), win32.join(system, "SysWOW64")].some((trusted) => sameFolder(folder, realPath(trusted)))) return real
  return underAny(real, [home]) ? real : undefined
}

/** The verdict where the helper can't be asked: a program really in Program Files, as Windows makes it. */
export function trustedWithoutHelper(file: string, env: NodeJS.ProcessEnv): ProgramVerdict {
  const real = realPath(file)
  const inside = underAny(real, [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter((folder): folder is string => Boolean(folder)))
  return inside ? { trusted: true, real, identity: identityOf(real) ?? "" } : { trusted: false, why: "mako-windows.exe isn't installed, and the program isn't in Program Files" }
}

/** The helper's line about one program. */
export function parseVerdict(line: string | undefined): ProgramVerdict | undefined {
  if (line === undefined) return undefined
  const trusted = /^trusted (.+) ([0-9a-f]{8}:[0-9a-f]{16})$/.exec(line)
  if (trusted) return { trusted: true, real: trusted[1]!, identity: trusted[2]! }
  return { trusted: false, why: line.replace(/^untrusted /, "") }
}

/**
 * A file's identity as the helper names it, `<volume serial>:<file index>`, read through Node: libuv's `dev` is the
 * volume's serial and `ino` the file's index on Windows.
 */
export function identityOf(file: string): string | undefined {
  try {
    const info = statSync(file, { bigint: true })
    return `${info.dev.toString(16).padStart(8, "0")}:${info.ino.toString(16).padStart(16, "0")}`
  } catch {
    return undefined
  }
}

/** The real file's identity, size and times: another file put in its place, or a change to it, reads differently. */
function stamp(real: string): string | undefined {
  try {
    const info = statSync(real, { bigint: true })
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch {
    return undefined
  }
}

/** A host's verdicts on the programs its launches found, by the path each was found at. */
export class ExecutableTrust {
  readonly #verdicts = new Map<string, { verdict: ProgramVerdict; stamp: string | undefined; at: number }>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** The kept verdict on `file`, while it is recent and the file it led to is the same and unchanged. */
  known(file: string): ProgramVerdict | undefined {
    const kept = this.#verdicts.get(file.toLowerCase())
    if (!kept || this.#now() - kept.at > VERDICT_MS) return undefined
    // Still where it led, and the same file: a link repointed since, or a file put in its place, is asked about again.
    if (kept.verdict.trusted && (!sameFolder(realPath(file), kept.verdict.real) || stamp(kept.verdict.real) !== kept.stamp || identityOf(kept.verdict.real) !== kept.verdict.identity))
      return undefined
    return kept.verdict
  }

  /** Asks the helper about `files`, off the thread, in batches no command line bounds, and keeps what it says. */
  async check(files: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
    let batch: string[] = []
    let characters = 0
    const ask = async () => {
      if (!batch.length) return
      const asked = batch
      batch = []
      characters = 0
      const said = await windowsHelperLines(["trusted", "-"], `${asked.join("\n")}\n`)
      asked.forEach((file, index) => this.keep(file, parseVerdict(said?.[index]) ?? trustedWithoutHelper(file, env)))
    }
    for (const file of files) {
      if (characters + file.length + 1 > BATCH_CHARACTERS) await ask()
      batch.push(file)
      characters += file.length + 1
    }
    await ask()
  }

  /** Asks it now, waiting: once for a program the host hasn't seen. */
  checkNow(file: string, env: NodeJS.ProcessEnv = process.env): ProgramVerdict {
    const verdict = parseVerdict(windowsHelperSync(["trusted", "-"], `${file}\n`)?.[0]) ?? trustedWithoutHelper(file, env)
    this.keep(file, verdict)
    return verdict
  }

  keep(file: string, verdict: ProgramVerdict): void {
    // A verdict whose real file reads as another than the helper's isn't kept: it's asked about again.
    if (verdict.trusted && verdict.identity && identityOf(verdict.real) !== verdict.identity) return
    this.#verdicts.set(file.toLowerCase(), { verdict, stamp: verdict.trusted ? stamp(verdict.real) : undefined, at: this.#now() })
  }

  /**
   * Every program in `folders` (by PATHEXT's extensions) not trusted without asking, asked about off the thread as the
   * host starts: a launch then finds its verdict kept.
   */
  async warm(folders: readonly string[], extensions: readonly string[], options: TrustOptions): Promise<number> {
    const files: string[] = []
    for (const folder of folders) {
      const names = await readdir(folder).catch((): string[] => [])
      for (const name of names) {
        if (!extensions.includes(win32.extname(name).toLowerCase())) continue
        const file = join(folder, name)
        if (!(await stat(file).then((info) => info.isFile(), () => false))) continue
        if (trustedWithoutAsking(await realpath(file).catch(() => file), options)) continue
        files.push(file)
      }
    }
    await this.check(files, options.env)
    return files.length
  }
}

/**
 * Whether `path` is one of `folders` or inside one, in any case as Windows names them, each by its long name through
 * any link (`C:\Users\RUNNER~1` is `C:\Users\runner-admin`).
 */
export function underAny(path: string, folders: readonly string[]): boolean {
  const lower = withoutTrailingSeparators(realPath(path).toLowerCase())
  return folders.some((folder) => {
    const base = withoutTrailingSeparators(realPath(folder).toLowerCase())
    return lower === base || lower.startsWith(`${base}\\`) || lower.startsWith(`${base}/`)
  })
}

/** A path without the separators it ends in, counted from its end so a long run of them costs its length once. */
function withoutTrailingSeparators(path: string): string {
  let end = path.length
  while (end > 0 && (path[end - 1] === "\\" || path[end - 1] === "/")) end -= 1
  return path.slice(0, end)
}
