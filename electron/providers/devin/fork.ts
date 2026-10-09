import type { Client } from "@agentclientprotocol/sdk"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { openNativeStore } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { acpReadable, acpWritable } from "../../acp-stream.js"
import { errorMessage } from "../../live-runtime.js"
import type { AcpForkInput } from "../acp-source.js"
import { spawnProviderProcess } from "../provider-process.js"
import { devinCliDirectory } from "@mako/sessions"
import { heavy } from "../../heavy-packages.js"

/** A cold start and one request; about 200 ms together on 3000.10.23. */
const FORK_MS = 30_000

const Forked = z.object({ forkedSessionId: z.string().min(1) })
const SavedHead = z.object({ main_chain_id: z.number().int() })
const NODE = /^\d+$/

/** A fork asks nothing of the client; anything asked is refused. */
const client: Client = {
  requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  sessionUpdate: async () => undefined,
}

/**
 * The node a session's history ends at, as Devin saved it. Read as a turn
 * ends, it is the node Devin's own step list names as that turn's fork
 * target, steers and all (3000.10.23).
 */
export function devinCheckpoint(session: { nativeId: string; env: NodeJS.ProcessEnv }): string | undefined {
  let db: DatabaseSync | undefined
  try {
    db = openNativeStore(join(devinCliDirectory(session.env), "sessions.db"))
    const row = SavedHead.safeParse(db.prepare("SELECT main_chain_id FROM sessions WHERE id = ? AND hidden = 0").get(session.nativeId))
    return row.success ? String(row.data.main_chain_id) : undefined
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

/**
 * Devin's own fork at a checkpoint, through the revert extension its desktop
 * app drives, which answers only a client that advertised
 * `cognition.ai/revert` (ACP `session/fork` is not implemented, 3000.10.23):
 * `forkFromStep` copies the session's history through that node into a new
 * session without opening the source, so it works while the conversation's
 * own process holds it. The process exits before the copy is returned, so
 * the driver's `session/load` finds it unlocked.
 */
export async function devinFork(input: AcpForkInput): Promise<string> {
  if (!NODE.test(input.checkpoint)) throw new Error(`Devin could not fork the session: ${JSON.stringify(input.checkpoint)} is not one of its nodes`)
  const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await heavy.acpSdk.load("devin fork")
  const child = spawnProviderProcess(input.executable, input.args, { cwd: input.cwd, env: input.env }, { kind: "acp:devin-fork", owner: input.owner })
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
    const capabilities = input.clientCapabilities
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { ...capabilities, _meta: { ...capabilities._meta, "cognition.ai/revert": true } } })
    const reply = await connection.extMethod("_cognition.ai/revert/forkFromStep", { sessionId: input.nativeId, targetNodeId: Number(input.checkpoint) })
    return Forked.parse(reply).forkedSessionId
  } catch (error) {
    const reason = input.signal.aborted ? "the conversation closed" : child.exitCode !== null || child.signalCode !== null
      ? `its process exited${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`
      : errorMessage({ error })
    throw new Error(`Devin could not fork the session: ${reason}`, { cause: error })
  } finally {
    child.stdin.end()
    await exited
    clearTimeout(deadline)
    input.signal.removeEventListener("abort", kill)
  }
}
