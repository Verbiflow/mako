import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { Client } from "@agentclientprotocol/sdk"
import { grokHome, grokWorkspaceCwd } from "@mako/sessions"
import { z } from "zod"
import { acpReadable, acpWritable } from "../../acp-stream.js"
import { errorMessage } from "../../live-runtime.js"
import type { AcpForkInput } from "../acp-source.js"
import { spawnProviderProcess } from "../provider-process.js"
import { grokSessionSource } from "./session-source.js"
import { heavy } from "../../heavy-packages.js"

/** A cold start and one request that copies the session's files. */
const FORK_MS = 30_000
/** Sessions whose counts are kept between turns. */
const KEPT = 64
const TURN = /^\d+$/

const Forked = z.object({ newSessionId: z.string().min(1) })
const Update = z.looseObject({
  sessionUpdate: z.string(),
  _meta: z.looseObject({ promptIndex: z.number().int().nonnegative().optional(), hostTurn: z.boolean().optional() }).nullish().catch(undefined),
  target_prompt_index: z.number().int().nonnegative().optional().catch(undefined),
})
const Envelope = z.looseObject({ method: z.string().optional(), params: z.looseObject({ update: Update.optional() }).optional() })
const Bare = z.looseObject({ update: Update.optional() })

/** A fork asks nothing of the client; anything asked is refused. */
const client: Client = {
  requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  sessionUpdate: async () => undefined,
}

type Step = { kind: "rewind"; target: number } | { kind: "user"; promptIndex: number | undefined } | { kind: "other" }

/**
 * One line of `updates.jsonl` as Grok's fork classifies it
 * (`rewind_step_for_line`, xai-grok-shell `session/storage`): a rewind
 * marker, a person's prompt chunk, or anything else.
 */
function step(line: string): Step {
  if (!line.includes("user_message_chunk") && !line.includes("rewind_marker")) return { kind: "other" }
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return { kind: "other" }
  }
  const envelope = Envelope.safeParse(json).data
  const update = envelope?.params ? envelope.params.update : Bare.safeParse(json).data?.update
  if (!update) return { kind: "other" }
  const vendor = envelope?.method === "_x.ai/session/update"
  if (vendor && update.sessionUpdate === "rewind_marker" && update.target_prompt_index !== undefined)
    return { kind: "rewind", target: update.target_prompt_index }
  if (!vendor && update.sessionUpdate === "user_message_chunk" && update._meta?.hostTurn !== true)
    return { kind: "user", promptIndex: update._meta?.promptIndex }
  return { kind: "other" }
}

/**
 * Grok's count of the turns a fork keeps, read forward from where the last
 * turn left off: `updates.jsonl` only grows, rewinds included. A run of
 * prompt chunks is one turn and a new `promptIndex` starts the next; once a
 * chunk carries one, only chunks with one count; a rewind to turn n keeps n
 * turns (`UserRunTurnTracker`, `filter_rewind_by`).
 */
class TurnCount {
  offset = 0
  turns = 0
  private marked = false
  private inUser = false
  private current: number | undefined
  readonly file: number

  constructor(file: number) {
    this.file = file
  }

  read(line: string): void {
    const next = step(line)
    if (next.kind !== "user") {
      if (next.kind === "rewind") this.turns = Math.min(this.turns, next.target)
      this.inUser = false
      this.current = undefined
      return
    }
    if (next.promptIndex !== undefined) this.marked = true
    const opens = !this.inUser || ((this.marked || next.promptIndex !== undefined) && next.promptIndex !== this.current)
    this.inUser = true
    if (!opens) return
    this.current = next.promptIndex
    if (!this.marked || next.promptIndex !== undefined) this.turns++
  }
}

const counts = new Map<string, TurnCount>()

/** Read what was appended to `path` since the last turn, up to its last whole line. */
function countTurns(path: string): number | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const { size, ino } = fstatSync(fd)
    let count = counts.get(path)
    if (!count || count.file !== ino || size < count.offset) count = new TurnCount(ino)
    counts.delete(path)
    counts.set(path, count)
    if (counts.size > KEPT) counts.delete(counts.keys().next().value!)
    if (size > count.offset) {
      const bytes = Buffer.allocUnsafe(size - count.offset)
      const read = readSync(fd, bytes, 0, bytes.length, count.offset)
      const end = bytes.subarray(0, read).lastIndexOf(0x0a)
      if (end >= 0) {
        for (const raw of bytes.toString("utf8", 0, end).split("\n")) {
          const line = raw.trim()
          if (line) count.read(line)
        }
        count.offset += end + 1
      }
    }
    return count.turns
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function updatesFile(nativeId: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const found = grokSessionSource(nativeId, cwd, join(grokHome(env), "sessions"))
  return found && join(dirname(found), "updates.jsonl")
}

/**
 * The last turn of the session as Grok's fork names it: its
 * `targetPromptIndex`, which keeps every turn up to and including that one.
 */
export function grokCheckpoint(session: { nativeId: string; env: NodeJS.ProcessEnv; cwd: string }): string | undefined {
  const path = updatesFile(session.nativeId, session.cwd, session.env)
  const turns = path ? countTurns(path) : undefined
  return turns ? String(turns - 1) : undefined
}

/**
 * Grok's own fork (`x.ai/session/fork`, grok 1.0.46): it copies the saved
 * session through the target turn into a new session under the fork's
 * folder, without opening the source, so it works while the conversation's
 * own process holds it, and opens nothing the driver's `session/load` then
 * waits on.
 */
export async function grokFork(input: AcpForkInput): Promise<string> {
  if (!TURN.test(input.checkpoint)) throw new Error(`Grok could not fork the session: ${JSON.stringify(input.checkpoint)} is not one of its turns`)
  const source = grokSessionSource(input.nativeId, input.cwd, join(grokHome(input.env), "sessions"))
  const sourceCwd = source && basename(dirname(source)) === input.nativeId ? grokWorkspaceCwd(dirname(dirname(source))) : undefined
  if (!sourceCwd) throw new Error("Grok could not fork the session: its saved copy isn't in Grok's sessions folder")
  const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await heavy.acpSdk.load("grok fork")
  const child = spawnProviderProcess(input.executable, input.args, { cwd: input.cwd, env: input.env }, { kind: "acp:grok-fork", owner: input.owner })
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve())
    child.once("error", () => resolve())
  })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000)
  })
  const kill = () => child.kill()
  const deadline = setTimeout(kill, FORK_MS)
  input.signal.addEventListener("abort", kill, { once: true })
  if (input.signal.aborted) kill()
  const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout)))
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: input.clientCapabilities })
    const reply = await connection.extMethod("_x.ai/session/fork", {
      sourceSessionId: input.nativeId,
      sourceCwd,
      newCwd: input.cwd,
      targetPromptIndex: Number(input.checkpoint),
      sessionKind: "fork",
    })
    return Forked.parse(reply).newSessionId
  } catch (error) {
    const reason = input.signal.aborted ? "the conversation closed" : child.exitCode !== null || child.signalCode !== null
      ? `its process exited${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`
      : errorMessage({ error })
    throw new Error(`Grok could not fork the session: ${reason}`, { cause: error })
  } finally {
    // The copy is whole when Grok answers, and Grok takes about two seconds to exit once its input closes.
    child.kill()
    await exited
    clearTimeout(deadline)
    input.signal.removeEventListener("abort", kill)
  }
}
