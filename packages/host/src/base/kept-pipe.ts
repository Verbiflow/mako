import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"

/**
 * A Windows named pipe's name and secret, drawn for one start of the server that listens on it and published in a
 * file of a folder only its user can read, once it listens. Windows' pipes share one namespace across the machine and
 * any account can list it, so a name is private only until its server listens: none is used for more than one start,
 * and both ends prove they know the secret before anything crosses a connection (`pipe-handshake.ts`).
 */
export interface KeptPipe {
  pipe: string
  proof: string
}

const PIPE_PREFIX = "\\\\.\\pipe\\"
const KeptPipeSchema = z.object({ pipe: z.string().regex(/^\\\\\.\\pipe\\[a-z0-9-]+-[0-9a-f]{32}$/), proof: z.string().regex(/^[0-9a-f]{64}$/) }).strict()

/** A Windows named pipe's path, which Node's `net` and `http` take where they take a socket's. */
export const isPipePath = (path: string): boolean => path.startsWith(PIPE_PREFIX)

/** Mako's folder in the user's local app data, which only they, SYSTEM and administrators can read. */
export function makoLocalFolder(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Mako")
}

/** What `file` publishes, when it publishes a pipe named `<prefix>-<random>`. */
export function readKeptPipe(file: string, prefix: string): KeptPipe | undefined {
  try {
    const kept = KeptPipeSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    return kept.pipe.startsWith(`${PIPE_PREFIX}${prefix}-`) ? kept : undefined
  } catch {
    return undefined
  }
}

/** A new name, `<prefix>-<128 random bits>`, and a 256-bit secret, for one start of a server. */
export function drawKeptPipe(prefix: string): KeptPipe {
  return { pipe: `${PIPE_PREFIX}${prefix}-${randomBytes(16).toString("hex")}`, proof: randomBytes(32).toString("hex") }
}

/** Publishes `pipe` in `file` in one rename, so a reader finds the whole of the old or the whole of the new. */
export function publishKeptPipe(file: string, pipe: KeptPipe): void {
  mkdirSync(dirname(file), { recursive: true })
  const draft = join(dirname(file), `.pipe-${process.pid}-${randomBytes(4).toString("hex")}`)
  writeFileSync(draft, JSON.stringify(pipe), { flag: "wx", mode: 0o600 })
  try {
    renameSync(draft, file)
  } catch (error) {
    rmSync(draft, { force: true })
    throw error
  }
}

/** Removes what `file` publishes, when it is still `pipe`: a later start's is left alone. */
export function retractKeptPipe(file: string, prefix: string, pipe: KeptPipe): void {
  if (readKeptPipe(file, prefix)?.pipe === pipe.pipe) rmSync(file, { force: true })
}
