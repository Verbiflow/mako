import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { SessionUpdate as AcpUpdate } from "@agentclientprotocol/sdk"
import { z } from "zod"
import type { ThreadEntry } from "../packages/sessions/src/format.ts"
import { DevinLocalProvider } from "../packages/sessions/src/providers/devin-local.ts"
import type { SessionProvider, SessionUpdate } from "../packages/sessions/src/providers/types.ts"
import { PAIRS_FOLDER, storeReader } from "./decode-compare.ts"
import { FIXTURE_ROOT } from "./native-decoding.ts"

/**
 * Every JSONL store a follower reads, written again one line at a time:
 * after each line, what the follower has delivered must equal a full read of
 * the same bytes. A follower sends only what changed since its last
 * delivery, so a translator that edits an entry without telling its sink
 * shows here as an entry the follower left stale.
 *
 * The recorded pairs only ever change the entry still being written. The
 * built sessions below are recorded ones put in orders real sessions also
 * take, where a record changes an entry pushed before the last.
 */

interface Session {
  name: string
  provider: SessionProvider
  path: string
  lines: string[]
}

const RECORDED = ["claude", "codex", "grok"]

const apply = (entries: ThreadEntry[], update: SessionUpdate | null): ThreadEntry[] =>
  !update ? entries : update.replace
    ? [...entries.slice(0, update.replaceFrom ?? 0), ...update.entries]
    : [...entries, ...update.entries]

/** The parts of a recorded line the built sessions rewrite; the rest is kept as recorded. */
const ClaudeLine = z.looseObject({ uuid: z.string(), message: z.looseObject({ content: z.array(z.looseObject({})).min(1) }) })
const CodexEvent = z.looseObject({ payload: z.looseObject({}) })

type CodexItem =
  | { type: "Plan"; id: string; text: string }
  | { type: "CommandExecution"; id: string; command: string[]; status: string; aggregated_output: string; exit_code: number }
type Written = z.infer<typeof ClaudeLine> | z.infer<typeof CodexEvent> | { notification: AcpUpdate & { _meta: { "cognition.ai/clientMessageId": string } } }

const json = (value: Written): string => `${JSON.stringify(value)}\n`

async function recorded(harness: string, name: string, sandbox: string): Promise<Session[]> {
  await cp(join(FIXTURE_ROOT, harness, PAIRS_FOLDER, name, "home"), sandbox, { recursive: true })
  const provider = storeReader(harness, sandbox)
  const sessions: Session[] = []
  for (const file of await provider.discover()) {
    if (!file.path.endsWith(".jsonl")) continue
    sessions.push({ name: `${harness}/${name}`, provider, path: file.path, lines: (await readFile(file.path, "utf8")).split(/(?<=\n)/) })
  }
  return sessions
}

/** Claude writes parallel calls as one entry each, so the first call's result changes an entry before the last. */
async function claudeParallelCalls(sandbox: string): Promise<Session[]> {
  const [session] = await recorded("claude", "read-and-answer", sandbox)
  const lines = session!.lines
  const call = lines.findIndex((line) => line.includes('"type":"tool_use"'))
  const result = lines.findIndex((line) => line.includes('"type":"tool_result"'))
  const recordedCall = ClaudeLine.parse(JSON.parse(lines[call]!))
  const second = { ...recordedCall, uuid: `${recordedCall.uuid}-second`, message: { ...recordedCall.message, content: [{ ...recordedCall.message.content[0]!, id: "call_second" }] } }
  const recordedResult = ClaudeLine.parse(JSON.parse(lines[result]!))
  const secondResult = { ...recordedResult, uuid: `${recordedResult.uuid}-second`, message: { ...recordedResult.message, content: [{ ...recordedResult.message.content[0]!, tool_use_id: "call_second" }] } }
  return [{
    ...session!,
    name: "built claude: parallel calls",
    lines: [...lines.slice(0, call + 1), json(second), ...lines.slice(call + 1, result + 1), json(secondResult), ...lines.slice(result + 1)],
  }]
}

/**
 * A stopped Codex turn: its plan revised and the stopped command's typed
 * item both arrive after the `Interrupted` marker.
 */
async function codexAfterInterrupt(sandbox: string): Promise<Session[]> {
  const [session] = await recorded("codex", "stopped-shell", sandbox)
  const lines = session!.lines
  const call = lines.findIndex((line) => line.includes('"type":"function_call"'))
  const aborted = lines.findIndex((line) => line.includes('"type":"turn_aborted"'))
  const template = CodexEvent.parse(JSON.parse(lines.find((line) => line.includes('"type":"item_completed"'))!))
  const completed = (item: CodexItem) => json({ ...template, payload: { ...template.payload, item } })
  const plan = (text: string) => completed({ type: "Plan", id: "plan_1", text })
  return [{
    ...session!,
    name: "built codex: plan and command item after the interrupt",
    lines: [
      ...lines.slice(0, call),
      plan("# Plan\n\nFirst"),
      lines[call]!,
      lines[aborted]!,
      plan("# Plan\n\nRevised"),
      completed({ type: "CommandExecution", id: "call_1", command: ["sleep", "30"], status: "failed", aggregated_output: "stopped", exit_code: 130 }),
    ],
  }]
}

/** A legacy Devin journal: a call whose result lands after the context usage event that closed its reply. */
async function devinResultAfterUsage(sandbox: string): Promise<Session[]> {
  const user = join(sandbox, "User")
  await mkdir(join(user, "acp-events"), { recursive: true })
  const path = join(user, "acp-events", "journal.ndjson")
  const note = (update: AcpUpdate) => json({ notification: { ...update, _meta: { "cognition.ai/clientMessageId": "prompt-1" } } })
  return [{
    name: "built devin-local: result after usage",
    provider: new DevinLocalProvider(user),
    path,
    lines: [
      note({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Run the " } }),
      note({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "tests" } }),
      note({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "Run tests", kind: "execute", rawInput: { command: "npm test" } }),
      note({ sessionUpdate: "usage_update", used: 1200, size: 200000 }),
      note({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", content: [{ type: "content", content: { type: "text", text: "12 passing" } }] }),
      note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All pass." } }),
    ],
  }]
}

const sources: ((sandbox: string) => Promise<Session[]>)[] = [claudeParallelCalls, codexAfterInterrupt, devinResultAfterUsage]
for (const harness of RECORDED)
  for (const name of await readdir(join(FIXTURE_ROOT, harness, PAIRS_FOLDER)).catch(() => []))
    sources.push((sandbox) => recorded(harness, name, sandbox))

const failures: string[] = []
let sessions = 0
let lines = 0
for (const source of sources) {
  const sandbox = await mkdtemp(join(tmpdir(), "follow-convergence-"))
  try {
    for (const session of await source(sandbox)) {
      await writeFile(session.path, "")
      const follower = session.provider.createFollower?.(session.path, 0)
      if (!follower) continue
      sessions++
      let followed: ThreadEntry[] = []
      for (const [index, line] of session.lines.entries()) {
        await appendFile(session.path, line)
        followed = apply(followed, await follower.next())
        lines++
        const full = (await session.provider.read(session.path))?.entries ?? []
        if (isDeepStrictEqual(followed, full)) continue
        const at = followed.findIndex((entry, position) => !isDeepStrictEqual(entry, full[position]))
        failures.push(`✗ ${session.name} line ${index + 1}: entry ${at < 0 ? followed.length : at} differs (${followed.length} followed, ${full.length} read)`)
        break
      }
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true })
  }
}

if (failures.length) {
  console.error(failures.join("\n"))
  process.exit(1)
}
console.log(`PASS: ${sessions} sessions followed line by line converge with full reads at every one of ${lines} lines`)
