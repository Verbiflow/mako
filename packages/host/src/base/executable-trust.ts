import { realpathSync, statSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join, win32 } from "node:path"
import { windowsHelperLines, windowsHelperSync } from "./windows-helper.js"

/**
 * Whether a program Windows' launches found by searching is this user's choice (`mako-windows trusted`): the file and
 * the folder holding it owned by this user, SYSTEM, Administrators or TrustedInstaller and writable by no one else, the
 * files the folder hands down included, and every folder above it the same for deleting, renaming or re-owning, each
 * checked where it really is through links. A program another account could have put there, or written over, would
 * run as this user.
 *
 * Two places count without asking: the user's own profile, and Windows' `System32` and `SysWOW64`. Where the helper
 * is missing (a release always ships it beside the app), the Program Files folders count too, as Windows makes them.
 *
 * A host keeps each verdict (`ExecutableTrust`, on its `HostStopping`) while the file is unchanged, asks off its thread
 * for every program on its folders as it starts, and asks again only for one it hasn't seen.
 */
export interface TrustOptions {
  env: NodeJS.ProcessEnv
  home: string
}

/** What `mako-windows trusted` takes a while to say: kept this long, while the file's size and times are unchanged. */
const VERDICT_MS = 10 * 60_000
/** Programs asked about in one run of the helper. */
const BATCH = 200

export function trustedWithoutAsking(file: string, { env, home }: TrustOptions): boolean {
  const system = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows"
  return underAny(file, [home, win32.join(system, "System32"), win32.join(system, "SysWOW64")])
}

/** The verdict where the helper can't be asked: Program Files, as Windows makes it, and nothing else. */
export function trustedWithoutHelper(file: string, env: NodeJS.ProcessEnv): boolean {
  return underAny(file, [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432].filter((folder): folder is string => Boolean(folder)))
}

/** `file`'s size and times, which change when it's written, replaced or its permissions change. */
function stamp(file: string): string | undefined {
  try {
    const info = statSync(file)
    return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  } catch {
    return undefined
  }
}

/** A host's verdicts on the programs its launches found, kept while each is unchanged. */
export class ExecutableTrust {
  readonly #verdicts = new Map<string, { stamp: string; trusted: boolean; at: number }>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** The kept verdict on `file`, while it's unchanged and recent. */
  known(file: string): boolean | undefined {
    const kept = this.#verdicts.get(file.toLowerCase())
    if (!kept || this.#now() - kept.at > VERDICT_MS || kept.stamp !== stamp(file)) return undefined
    return kept.trusted
  }

  /** Asks the helper about `files`, off the thread, and keeps what it says. */
  async check(files: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
    for (let at = 0; at < files.length; at += BATCH) {
      const batch = files.slice(at, at + BATCH)
      const said = await windowsHelperLines(["trusted", ...batch])
      batch.forEach((file, index) => this.keep(file, said ? said[index] === "trusted" : trustedWithoutHelper(file, env)))
    }
  }

  /** Asks it now, waiting: once for a program the host hasn't seen. */
  checkNow(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const said = windowsHelperSync(["trusted", file])?.[0]
    const trusted = said === undefined ? trustedWithoutHelper(file, env) : said === "trusted"
    this.keep(file, trusted)
    return trusted
  }

  keep(file: string, trusted: boolean): void {
    const now = stamp(file)
    if (now !== undefined) this.#verdicts.set(file.toLowerCase(), { stamp: now, trusted, at: this.#now() })
  }

  /**
   * Every program in `folders` (by PATHEXT's extensions) not trusted without asking, asked about off the thread as the
   * host starts: a launch then finds its verdict kept.
   */
  async warm(folders: readonly string[], extensions: readonly string[], options: TrustOptions): Promise<number> {
    const files: string[] = []
    for (const folder of folders) {
      if (trustedWithoutAsking(folder, options)) continue
      const names = await readdir(folder).catch((): string[] => [])
      for (const name of names) {
        if (!extensions.includes(win32.extname(name).toLowerCase())) continue
        const file = join(folder, name)
        if (await stat(file).then((info) => info.isFile(), () => false)) files.push(file)
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
  const real = (folder: string) => {
    try {
      return realpathSync.native(folder)
    } catch {
      return folder
    }
  }
  const lower = real(path).toLowerCase().replace(/[\\/]+$/, "")
  return folders.some((folder) => {
    const base = real(folder).toLowerCase().replace(/[\\/]+$/, "")
    return lower === base || lower.startsWith(`${base}\\`) || lower.startsWith(`${base}/`)
  })
}
