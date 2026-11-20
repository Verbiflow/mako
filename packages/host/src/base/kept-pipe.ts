import { randomBytes } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"

/**
 * A named pipe's name drawn at random and kept in a file of a folder only its user can read, with a proof its server
 * can say and its clients check (`transport/pipe.ts`). Windows' pipes share one namespace across the machine, and
 * another account can take a name it can guess while nothing listens on it; it can't guess one drawn here.
 */
export interface KeptPipe {
  pipe: string
  proof: string
}

const PIPE_PREFIX = "\\\\.\\pipe\\"
const KeptPipeSchema = z.object({ pipe: z.string().regex(/^\\\\\.\\pipe\\[a-z0-9-]+-[0-9a-f]{32}$/), proof: z.string().regex(/^[0-9a-f]{64}$/) }).strict()

/** A Windows named pipe's path, which Node's `net` and `http` take where they take a socket's. */
export const isPipePath = (path: string): boolean => path.startsWith(PIPE_PREFIX)

/** What `file` keeps, when it keeps a pipe named `<prefix>-<random>`. */
export function readKeptPipe(file: string, prefix: string): KeptPipe | undefined {
  try {
    const kept = KeptPipeSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    return kept.pipe.startsWith(`${PIPE_PREFIX}${prefix}-`) ? kept : undefined
  } catch {
    return undefined
  }
}

function draw(prefix: string): KeptPipe {
  return { pipe: `${PIPE_PREFIX}${prefix}-${randomBytes(16).toString("hex")}`, proof: randomBytes(32).toString("hex") }
}

function draft(file: string, value: KeptPipe): string {
  mkdirSync(dirname(file), { recursive: true })
  const path = join(dirname(file), `.pipe-${process.pid}-${randomBytes(4).toString("hex")}`)
  writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  return path
}

/** The pipe `file` keeps, or one drawn and kept now; two processes drawing at once both answer with the one linked first. */
export function keptPipe(file: string, prefix: string): KeptPipe {
  const kept = readKeptPipe(file, prefix)
  if (kept) return kept
  const path = draft(file, draw(prefix))
  try {
    linkSync(path, file)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
  } finally {
    rmSync(path, { force: true })
  }
  const settled = readKeptPipe(file, prefix)
  if (!settled) throw new Error(`Mako couldn't keep a pipe's name in ${file}`)
  return settled
}

/** A new name for the pipe `file` keeps, in place of one something else took. */
export function redrawPipe(file: string, prefix: string): KeptPipe {
  const next = draw(prefix)
  renameSync(draft(file, next), file)
  return next
}
