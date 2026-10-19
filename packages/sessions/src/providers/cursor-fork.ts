import type { ForkIds, ForkRow, RecordFork, RecordRow } from "../harness-records.js"
import { mapText, replaceQuoted, rootAndBelow, uuidFrom } from "../record-fork.js"
import { cursorSdkDirectoryName } from "./cursor-sdk-index.js"

/**
 * A Cursor agent written again as a new agent holding the same
 * conversation. Cursor has no fork record of its own: an agent is its
 * `store.db` of content-addressed blobs and a `meta` row naming the agent
 * and its latest root blob, so a new agent whose store holds the same blobs
 * and whose meta names it is the conversation, resumed as that agent. A
 * `cursor-agent` chat moves to its new id's folder under the same workspace
 * hash; an SDK agent to its new id's `agent-<sha256>` folder, with its
 * `index.db` row and runs under the new agent and new run ids, their events
 * with them. Cursor desktop's chats live in the editor's own database and
 * aren't forked.
 */
export const cursorFork: RecordFork = {
  id: (seed) => uuidFrom(seed, 4),
  file(path, ids) {
    const moved = agentFolder(path, ids)
    return moved === null ? null : moved === path ? "shared" : { path: moved }
  },
  database(name, ids) {
    return agentFolder(name, ids) ?? name
  },
  table(name, table, ids) {
    const { root, below } = rootAndBelow(name)
    if (root.startsWith("cursor-sdk") && below === "index.db") {
      if (table === "agents") return owned("agent_id", ids, { active_run_id: true })
      if (table === "runs") return owned("agent_id", ids, { run_id: true })
      // The session's events are its runs' only, each under the run's new id.
      if (table === "run_events") return (row) => ({ ...row, run_id: runId(row["run_id"], ids) })
      return null
    }
    const moved = agentFolder(name, ids)
    if (moved === null || !below.endsWith("/store.db")) return null
    // A child agent's store comes with the session and stays its own.
    if (moved === name) return "shared"
    if (table === "meta") return (row) => ({ ...row, value: renamedMeta(row["value"], ids) })
    // Blobs are content-addressed: the fork's store holds them as they are.
    if (table === "blobs") return "shared"
    return null
  },
}

/**
 * Where a file or database of an agent's folder goes in the fork: the same
 * place under the fork's folder; the path itself when it's another agent's
 * (a child's), and null outside the agent folders Cursor keeps.
 */
function agentFolder(path: string, ids: ForkIds): string | null {
  const { root, below } = rootAndBelow(path)
  const parts = below.split("/")
  if (root.startsWith("cursor-sdk") && parts[0] === "agents" && parts.length >= 3) {
    return parts[1] === cursorSdkDirectoryName(ids.from) ? `${root}:${["agents", cursorSdkDirectoryName(ids.to), ...parts.slice(2)].join("/")}` : path
  }
  if (root.startsWith("cursor") && parts[0] === "chats" && parts.length >= 4)
    return parts[2] === ids.from ? `${root}:${["chats", parts[1], ids.to, ...parts.slice(3)].join("/")}` : path
  if (root.startsWith("cursor") && parts[0] === "acp-sessions" && parts.length >= 3)
    return parts[1] === ids.from ? `${root}:${["acp-sessions", ids.to, ...parts.slice(2)].join("/")}` : path
  // Its subagents' plain transcripts, under the agent's id in the workspace's project folder.
  if (root.startsWith("cursor") && parts[0] === "projects" && parts[2] === "agent-transcripts" && parts.length >= 5)
    return parts[3] === ids.from ? `${root}:${[...parts.slice(0, 3), ids.to, ...parts.slice(4)].join("/")}` : path
  return null
}

/** An `index.db` row of the agent's, under the fork's agent id, its run ids the fork's. */
function owned(owner: string, ids: ForkIds, runs: Readonly<Record<string, true>>): ForkRow {
  return (row) => {
    if (row[owner] !== ids.from) return "shared"
    const forked: RecordRow = { ...row, [owner]: ids.to }
    for (const column of Object.keys(runs)) if (column in row) forked[column] = runId(row[column], ids)
    return forked
  }
}

function runId(value: RecordRow[string], ids: ForkIds): RecordRow[string] {
  return mapText(value, (run) => uuidFrom(ids.derive(run), 4))
}

/** The `meta` row's JSON naming the fork's agent, in the encoding it came in: hex text, plain text or bytes. */
function renamedMeta(value: RecordRow[string], ids: ForkIds): RecordRow[string] {
  if (value instanceof Uint8Array) return new Uint8Array(replaceQuoted(Buffer.from(value), ids.from, ids.to))
  return mapText(value, (text) => (/^[0-9a-f]+$/i.test(text)
    ? replaceQuoted(Buffer.from(text, "hex"), ids.from, ids.to).toString("hex")
    : replaceQuoted(Buffer.from(text), ids.from, ids.to).toString("utf8")))
}
