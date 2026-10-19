// What each harness recalls of a conversation carried to it, on its real CLI
// through this host: `npm run test:session-flows -- --carry <dir> [harness...]`.
//
// `<dir>` is what the audit's `carry-prepare.mts` writes: one real
// conversation with six facts planted at known points (`thread.json`), the
// same with its last message saying what to do next (`thread-continue.json`),
// the questions, and today's pointer to a bundle of each (`pointer.md`,
// `pointer-continue.md`, as the build before MH-35 step 5 sent them).
//
// new                the conversation, served as a saved session of another
//                    harness, captured and switched here with the questions:
//                    the transcript note, the file and `thread_history`.
// pointer            a new session whose first message is today's pointer
//                    and the questions.
// continue-new       as `new`, asked only to continue; the next step, named
//                    only in the history, needs two facts from it.
// continue-pointer   as `pointer`, asked only to continue.
//
// `source.json`, when there, names the harness the conversation came from
// (`{ "label": "Grok" }`); Codex otherwise.
//
// Each reports the facts recalled, the first request (exact from the session's
// own record where it keeps one per call: Claude Code and Codex; else the
// session's first context reading, Cursor's after its first call), the turn's input
// tokens, cost where the harness reports one, the harness's version, its
// session, and how the history was read.
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { zstdDecompressSync } from "node:zlib"
import { join } from "node:path"
import { historyReads, readBy } from "./session-flows-continuations.mjs"

const ACTIVE = new Set(["queued", "held", "dispatching"])
const EXPECT = [
  ["Q1", /orca-delta-5512/i], ["Q2", /kestrel-0938/i], ["Q3", /ledger_backfill_v4/i],
  ["Q4", /priya/i], ["Q5", /test_refund_rounding/i], ["Q6", /readme/i], ["Q7", /\b7\b/],
]
const NEXT = [/orca-delta-5512/i, /ledger_backfill_v4/i]

function score(answer) {
  const lines = Object.fromEntries([...answer.matchAll(/^\W*Q(\d)\W*[:.][ \t]*(.*)$/gm)].map((match) => [`Q${match[1]}`, match[2]]))
  return Object.fromEntries(EXPECT.map(([question, expected]) => [question, expected.test(lines[question] ?? "")]))
}

export async function carryFlows(dir) {
  if (!dir) throw new Error("--carry needs the folder carry-prepare.mts wrote")
  const read = (name) => readFile(join(dir, name), "utf8")
  const input = {
    thread: JSON.parse(await read("thread.json")),
    continueThread: JSON.parse(await read("thread-continue.json")),
    questions: await read("questions.txt"),
    proceed: (await read("continue.txt")).trim(),
    pointer: await read("pointer.md"),
    pointerContinue: await read("pointer-continue.md"),
    label: JSON.parse(await read("source.json").catch(() => "{}")).label ?? "Codex",
  }
  const cell = (name, run) => ({ name, declared: () => true, run: (h) => run(h, input) })
  return [
    cell("new", (h) => carried(h, input.thread, input.label, input.questions, questionsScore)),
    cell("pointer", (h) => pointed(h, input.pointer, questionsScore)),
    cell("continue-new", (h) => carried(h, input.continueThread, input.label, input.proceed, nextScore)),
    cell("continue-pointer", (h) => pointed(h, input.pointerContinue, nextScore)),
  ]
}

/** A folder holding seven files, for Q7's `ls -1 | wc -l`. */
async function workdir(h, label) {
  const cwd = join(h.root, "work", h.provider, `${label}-${randomUUID().slice(0, 8)}`)
  await mkdir(cwd, { recursive: true })
  for (let n = 1; n <= 7; n++) await writeFile(join(cwd, `a${n}.txt`), "")
  return cwd
}

/** The turn's words, each text block on its own lines: `reply` joins them as one string, and an answer's `Q1:` then follows the text before it on one line. */
function answerOf(h, id, requestId) {
  const blocks = h.snapshot(id).blocks
  const start = blocks.findIndex((block) => block.type === "user" && block.requestId === requestId)
  const end = blocks.findIndex((block, index) => index > start && block.type === "user" && !block.steeringFor)
  return blocks.slice(start + 1, end < 0 ? undefined : end).filter((block) => block.type === "text").map((block) => block.text).join("\n")
}

const questionsScore = async (h, id, requestId) => {
  const answer = answerOf(h, id, requestId)
  const recalled = score(answer)
  return { facts: Object.entries(recalled).filter(([question, ok]) => ok && question !== "Q7").length, shell: recalled.Q7, recalled, answer: answer.slice(-1200) }
}
const nextScore = async (h, id, requestId, cwd) => {
  const written = await readFile(join(cwd, "NEXT.md"), "utf8").catch(() => null)
  return { facts: written === null ? 0 : NEXT.filter((expected) => expected.test(written)).length, of: NEXT.length, wrote: written === null ? "no NEXT.md" : written.slice(0, 160) }
}

/** Waits for request `requestId` to end, keeping each context reading the session reports on the way. */
async function measured(h, id, requestId, start) {
  const readings = []
  start()
  await h.wait(id, "the carried turn to end", (snapshot) => {
    const transfer = snapshot?.control?.transfers.find((entry) => entry.input.id === requestId)
    if (["failed", "uncertain"].includes(transfer?.state.kind)) throw new Error(`The switch ${transfer.state.kind}: ${transfer.state.error}`)
    const request = snapshot?.requests.find((entry) => entry.id === requestId)
    const used = snapshot?.session.usage?.used
    if (request && used !== undefined && used !== readings.at(-1)) readings.push(used)
    return Boolean(request && !ACTIVE.has(request.status))
  })
  const request = h.request(id, requestId)
  if (request.status !== "completed") throw new Error(`The turn ended ${request.status}${request.error ? `: ${request.error}` : ""}`)
  const tokens = request.spend?.tokens
  const { session } = h.snapshot(id)
  const path = session.nativePath ?? h.snapshot(id).threadPath
  const runtime = session.executionContext?.runtime
  // Read before the run deletes the session: Claude Code and Codex keep each call's usage in their record.
  const exact = await recordedFirstRequest(h.provider, path)
  // Cursor's first reading is its first checkpoint's `token_details`: the first call's input and output.
  const first = exact ?? readings[0] ?? null
  return {
    nativeId: session.nativeId, path,
    version: runtime?.kind === "reported" ? runtime.version : null,
    model: request.spend?.model ?? null,
    firstRequest: first,
    firstFrom: first === null ? null : exact !== null ? "record" : readings.length > 1 ? "first reading" : "only reading",
    readings: readings.length,
    input: tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : null,
    output: tokens?.output ?? null,
    cost: request.spend?.cost ?? null,
    estimate: request.spend?.estimate?.amount ?? null,
  }
}

/** The first model call's prompt tokens, from the session's own record where it keeps one per call (Claude Code, Codex). */
async function recordedFirstRequest(harness, path) {
  if (!path || (harness !== "claude" && harness !== "codex")) return null
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return null
  const text = (path.endsWith(".zst") ? zstdDecompressSync(bytes) : bytes).toString("utf8")
  const lines = text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
  if (harness === "claude") {
    const usage = lines.find((line) => line.type === "assistant" && line.message?.usage)?.message.usage
    return usage ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : null
  }
  const usage = lines.find((line) => line.type === "event_msg" && line.payload?.type === "token_count" && line.payload.info?.last_token_usage)?.payload.info.last_token_usage
  return usage ? usage.input_tokens : null
}

/** The conversation served as another harness's saved session, captured, and switched here with `text`. */
async function carried(h, planted, label, text, scored) {
  const cwd = await workdir(h, "carry-new")
  const path = join(h.root, "served", `carry-${randomUUID()}.json`)
  h.tools.served.set(path, { thread: { ref: { ...planted.ref, harness: "saved", nativeId: randomUUID(), path, cwd, title: "Carry experiment" }, entries: planted.entries }, label })
  const id = randomUUID()
  await h.owner.capture(id, path)
  h.open.add(id)
  h.current = id
  const requestId = randomUUID()
  const modeId = h.modeOf(h.provider)
  const began = Date.now()
  const tokens = await measured(h, id, requestId, () => h.owner.transfer(id, { id: requestId, provider: h.provider, text, attachments: [], ...modeId && { modeId } }))
  const manifest = h.request(id, requestId).context?.[0]
  const reads = historyReads(h, id, requestId, manifest)
  return { ...await scored(h, id, requestId, cwd), ...tokens, historyChars: reads.historyChars, seconds: Math.round((Date.now() - began) / 1000), read: readBy(reads), reads, turns: manifest?.turns }
}

/** A new session whose first message is today's pointer to a bundle. */
async function pointed(h, text, scored) {
  const cwd = await workdir(h, "carry-pointer")
  const id = randomUUID()
  await h.owner.start(h.provider, cwd, { conversationId: id, title: "Session flows: carry pointer", modeId: h.fullMode })
  h.open.add(id)
  h.current = id
  const requestId = randomUUID()
  const began = Date.now()
  const tokens = await measured(h, id, requestId, () => h.owner.submit(id, requestId, text, []))
  const bundle = /Read the conversation context at (\S+)/.exec(text)?.[1]
  const reads = historyReads(h, id, requestId, bundle && { file: bundle })
  return { ...await scored(h, id, requestId, cwd), ...tokens, historyChars: reads.historyChars, seconds: Math.round((Date.now() - began) / 1000), read: readBy(reads), reads }
}
