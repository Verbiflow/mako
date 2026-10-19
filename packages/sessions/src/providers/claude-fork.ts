import { z } from "zod"
import type { ForkIds, RecordFork } from "../harness-records.js"
import { replaceQuoted, rootAndBelow, uuidFrom } from "../record-fork.js"

/**
 * A Claude Code session written again as its own fork, as `/branch` and
 * `--fork-session` write one: a transcript of its own under the new id, each
 * line naming the new `sessionId` and each message `forkedFrom` the session
 * and message it was copied from (uuids kept), beside the original in the
 * same project folder. What Claude Code keeps under the session's id moves
 * with it: subagent transcripts and tool results in the folder beside the
 * transcript, file snapshots under `file-history/<id>`, todo lists named
 * `<id>-agent-<id>.json`.
 */
export const claudeFork: RecordFork = {
  id: (seed) => uuidFrom(seed, 4),
  file(path, ids) {
    const { root, below } = rootAndBelow(path)
    const parts = below.split("/")
    const at = (place: string) => `${root}:${place}`
    if (parts[0] === "projects" && parts.length >= 3) {
      const [, project, name = "", ...rest] = parts
      if (!rest.length && name === `${ids.from}.jsonl`) return { path: at(`projects/${project}/${ids.to}.jsonl`), line: (line) => forkedLine(line, ids) }
      if (rest.length && name === ids.from) {
        const moved = at(["projects", project, ids.to, ...rest].join("/"))
        return below.endsWith(".jsonl") ? { path: moved, line: (line) => sessionLine(line, ids) } : { path: moved }
      }
      return null
    }
    if (parts[0] === "file-history" && parts[1] === ids.from) return { path: at(["file-history", ids.to, ...parts.slice(2)].join("/")) }
    if (parts[0] === "todos" && parts.length === 2 && parts[1]?.startsWith(`${ids.from}-`)) return { path: at(`todos/${parts[1].replaceAll(ids.from, ids.to)}`) }
    return null
  },
  table: () => null,
}

const SESSION_KEY = Buffer.from(`"sessionId":`)
/** A transcript line's fields as Claude Code wrote them, in their order. */
const Fields = z.record(z.string(), z.unknown())
const Uuid = z.string()

/** A line of a subagent's transcript: it names its session, which is now the fork. */
function sessionLine(line: Buffer, ids: ForkIds): Buffer {
  return line.includes(SESSION_KEY) ? replaceQuoted(line, ids.from, ids.to) : line
}

/**
 * A line of the session's transcript, as Claude Code copies it into a fork:
 * the new `sessionId`, and a message (one with a `uuid`) says which session
 * and message it came from. Lines that don't name the session (a file
 * snapshot) are kept as they are; the rest are rewritten in place, so
 * every other byte is as Claude Code wrote it.
 */
function forkedLine(line: Buffer, ids: ForkIds): Buffer {
  if (!line.includes(SESSION_KEY)) return line
  let parsed: z.infer<typeof Fields> | undefined
  try {
    parsed = Fields.safeParse(JSON.parse(line.toString("utf8"))).data
  } catch {
    return line
  }
  if (!parsed) return line
  const renamed = replaceQuoted(line, ids.from, ids.to)
  const uuid = Uuid.safeParse(parsed["uuid"])
  if (!uuid.success) return renamed
  const forkedFrom = { sessionId: ids.from, messageUuid: uuid.data }
  // A line copied from an earlier fork names that one; Claude Code's own copy replaces it where it stands.
  if ("forkedFrom" in parsed) return Buffer.from(JSON.stringify({ ...parsed, sessionId: ids.to, forkedFrom }))
  const end = renamed.lastIndexOf(0x7d)
  if (end === -1) return renamed
  return Buffer.concat([renamed.subarray(0, end), Buffer.from(`,"forkedFrom":${JSON.stringify(forkedFrom)}`), renamed.subarray(end)])
}
