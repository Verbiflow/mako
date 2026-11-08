import type { Client } from "@agentclientprotocol/sdk"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import { z } from "zod"
import { acpReadable, acpWritable } from "../acp-stream.js"
import { errorMessage } from "../../base/error-message.js"
import type { AcpForkInput } from "../acp-source.js"
import { closeProviderProcess, endProviderProcess, providerProcessGone, spawnProviderProcess } from "../provider-process.js"
import { ProviderStartupWatch } from "../provider-startup.js"
import { devinCliDirectory } from "@mako/sessions"
import { heavy } from "../../base/heavy-packages.js"
import { childInput } from "@mako/sessions/child-input"

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
export function devinCheckpoint(stores: NativeStores, session: { nativeId: string; env: NodeJS.ProcessEnv }): string | undefined {
  let db: DatabaseSync | undefined
  try {
    db = stores.open(join(devinCliDirectory(session.env), "sessions.db"))
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
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000)
  })
  const kill = () => void endProviderProcess(child)
  const deadline = setTimeout(kill, FORK_MS)
  input.signal.addEventListener("abort", kill, { once: true })
  if (input.signal.aborted) kill()
  const watch = new ProviderStartupWatch(child, { harness: "Devin fork", stderr: () => stderr })
  const connection = new ClientSideConnection(() => client, ndJsonStream(acpWritable(childInput(child)), acpReadable(child.stdout)))
  let failed = false
  try {
    const capabilities = input.clientCapabilities
    await watch.step("initialize", connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { ...capabilities, _meta: { ...capabilities._meta, "cognition.ai/revert": true } } }))
    const reply = await watch.step("session fork", connection.extMethod("_cognition.ai/revert/forkFromStep", { sessionId: input.nativeId, targetNodeId: Number(input.checkpoint) }))
    return Forked.parse(reply).forkedSessionId
  } catch (error) {
    failed = true
    const reason = input.signal.aborted ? "the conversation closed" : providerProcessGone(child)
      ? `its process exited${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`
      : errorMessage({ error })
    const during = input.signal.aborted ? "" : ` during ${watch.steps.at(-1)?.name ?? "startup"}`
    throw new Error(`Devin could not fork the session${during}: ${reason}`, { cause: error })
  } finally {
    watch.dispose()
    clearTimeout(deadline)
    input.signal.removeEventListener("abort", kill)
    // Its input closed, Devin stops its shells and exits. A fork that worked waits for that, so the copy is unlocked;
    // a failure reaches the caller without waiting: the process is still ended, SIGKILL if it must be. A fork whose
    // process outlives that hasn't worked: the copy is still held.
    if (failed) void endProviderProcess(child, "input")
    else await closeProviderProcess(child, "input")
  }
}
