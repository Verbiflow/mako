// A queued message and the goal turn Codex starts by itself: the real
// `codex app-server` in a sealed CODEX_HOME with a stand-in model, driven by
// Mako's Codex engine. A message sent while Codex's own goal turn runs joins
// that turn and reaches the model in it, and Codex's next goal turn still
// shows as its own. A message sent the moment a goal turn ends, as Mako's
// queue sends it, is taken every time, whichever of the two starts first.
// A token budget goes with the goal, and Codex stops starting turns at it.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createCodexEngine } from "@mako/host/harnesses/codex-app"
import type { JsonObject } from "@mako/host/contracts/json"
import type { PromptDeliveryEvidence } from "@mako/host/contracts/prompt-delivery"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { admitted } from "./fixtures/admitted-start.ts"

try {
  execFileSync("codex", ["--version"], { stdio: "ignore" })
} catch {
  console.log("Codex goal and queued message: skipped, codex is not installed")
  process.exit(0)
}

const OBJECTIVE = "Tidy the parser module"
const GOAL_TURN = "Continue working toward the active thread goal."

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-codex-goal-queue-")))
const home = join(root, "codex")
const project = join(root, "project")
for (const folder of [home, project]) mkdirSync(folder, { recursive: true })

/** What the stand-in model was asked, in order: the words that mark each request. */
const asked: string[] = []
/** The turn running when the model was asked to note each word. */
const readIn = new Map<string, string | undefined>()
let holding = false
const held: Array<() => void> = []
const answer = (res: ServerResponse, text: string) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  const send = (type: string, data: JsonObject) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  const id = `resp_${randomUUID()}`
  send("response.created", { response: { id } })
  send("response.output_item.done", { item: { type: "message", role: "assistant", id: `msg_${randomUUID()}`, content: [{ type: "output_text", text }] } })
  send("response.completed", { response: { id, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 } } })
  res.end()
}
const server = createServer(async (request, res) => {
  let body = ""
  for await (const chunk of request) body += chunk
  if (request.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }))
    return
  }
  const queued = [...body.matchAll(/Queued: remember (\w+)\./g)].at(-1)
  const goal = body.lastIndexOf(GOAL_TURN) > (queued?.index ?? -1)
  const word = goal ? undefined : queued?.[1]
  asked.push(word ? `noted ${word}` : goal ? "goal" : "other")
  if (word) {
    readIn.set(word, session()?.nativeRunId)
    return answer(res, `Noted ${word}.`)
  }
  if (!goal) return answer(res, "Title")
  if (holding) held.push(() => answer(res, "Working on the parser."))
  else answer(res, "Working on the parser.")
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
// SAFETY: a server listening on a TCP port reports an AddressInfo.
const { port } = server.address() as AddressInfo
writeFileSync(join(home, "config.toml"), `model = "stand-in"\nmodel_provider = "standin"\napproval_policy = "never"\nsandbox_mode = "read-only"\n\n[model_providers.standin]\nname = "standin"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`)
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home }

const codex = createCodexEngine({ dataRoot: root })
const events: LiveDriverEvent[] = []
const id = randomUUID()
const session = (): LiveSessionState | undefined => events.findLast((event) => event.type === "live-session")?.session
/** The turns Codex started toward its goal: each run that follows a goal-turn marker. */
const goalTurnIds = () => {
  const ids = new Set<string>()
  let marked = false
  for (const event of events) {
    const batch = event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : []
    if (batch.some((update) => update.kind === "provider-turn")) marked = true
    if (marked && event.type === "live-session" && event.session.nativeRunId) {
      ids.add(event.session.nativeRunId)
      marked = false
    }
  }
  return ids
}
const until = async (label: string, predicate: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; status ${session()?.status}, model last asked ${asked.slice(-8).join(", ")}`)
    await delay(10)
  }
}
/** Sends one message as Mako's queue does, and returns what the driver reported about it. */
const send = async (text: string) => {
  const reports: PromptDeliveryEvidence[] = []
  const outcome = await codex.prompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: (evidence) => reports.push(evidence) })
    .then(() => "sent" as const, (error: Error) => error.message)
  return { outcome, reports, accepted: reports.find((report) => report.kind === "accepted") }
}

try {
  await codex.start(project, admitted("codex", {
    conversationId: id,
    emit: (event) => events.push(event),
    mcpSnapshot: async () => ({ cwd: project, generatedAt: Date.now(), servers: [], providers: [] }),
  }, { env }))

  // A message while Codex's own goal turn runs joins that turn.
  holding = true
  await codex.goal(id, { kind: "set", objective: OBJECTIVE, replacing: false })
  await until("Codex's goal turn", () => goalTurnIds().size === 1 && session()?.status === "running" && held.length === 1)
  const goalTurn = session()?.nativeRunId
  assert.ok(goalTurn && goalTurnIds().has(goalTurn), "the running turn is Codex's goal turn")
  const joined = await send("Queued: remember PELICAN.")
  assert.equal(joined.outcome, "sent", `the message is taken while Codex's goal turn runs, not refused: ${joined.outcome}`)
  assert.equal(joined.accepted?.kind === "accepted" && joined.accepted.referenceId, goalTurn, "it joined the goal turn")
  held.splice(0).forEach((release) => release())
  await until("the model to read the message", () => asked.includes("noted PELICAN"))
  assert.equal(readIn.get("PELICAN"), goalTurn, "the model read it inside the goal turn")
  await until("Codex's next goal turn", () => held.length === 1 && session()?.nativeRunId !== goalTurn)
  assert.ok(goalTurnIds().has(session()?.nativeRunId ?? ""), "Codex's next goal turn still shows as its own")

  // A message sent the moment a goal turn ends is taken, whichever starts first.
  const outcomes: string[] = []
  for (const word of ["HERON", "IBIS", "KITE", "LARK", "MERLIN"]) {
    await until("a held goal turn", () => held.length === 1 && session()?.status === "running")
    const ending = session()?.nativeRunId
    held.splice(0).forEach((release) => release())
    await until("the goal turn to end", () => session()?.nativeRunId !== ending || session()?.status !== "running")
    const sent = await send(`Queued: remember ${word}.`)
    assert.equal(sent.outcome, "sent", `the message at a goal turn's end is taken: ${sent.outcome}`)
    await until(`the model to read ${word}`, () => {
      held.splice(0).forEach((release) => release())
      return asked.includes(`noted ${word}`)
    })
    const into = sent.accepted?.kind === "accepted" ? sent.accepted.referenceId : undefined
    outcomes.push(into && goalTurnIds().has(into) ? "joined a goal turn" : "its own turn")
  }
  for (const word of ["PELICAN", "HERON", "IBIS", "KITE", "LARK", "MERLIN"])
    assert.equal(asked.filter((entry) => entry === `noted ${word}`).length, 1, `the model read ${word} once`)

  holding = false
  held.splice(0).forEach((release) => release())
  await codex.goal(id, { kind: "clear" })
  if (session()?.status === "running") await codex.cancel(id)
  await until("the cleared goal's turn to end", () => session()?.status !== "running")

  // Each answer spends 12 tokens as Codex counts them: a budget of 30 runs out in the third turn.
  const reported = () => events.flatMap((event) => event.type === "live-goal" && event.goal ? [event.goal] : [])
  await codex.goal(id, { kind: "set", objective: "Shorten the parser", tokenBudget: 30, replacing: false })
  assert.deepEqual([reported().at(-1)?.objective, reported().at(-1)?.tokenBudget], ["Shorten the parser", 30], "Codex took the budget with the goal")
  await until("Codex to stop at the budget", () => reported().at(-1)?.status === "budget-limited" && session()?.status !== "running", 30_000)
  const limited = reported().at(-1)!
  assert.ok((limited.tokensUsed ?? 0) >= 30, `it spent the budget: ${limited.tokensUsed}`)
  const asks = asked.length
  await delay(1_500)
  assert.equal(asked.length, asks, "nothing continues a goal out of budget")
  console.log(`Codex goal and queued message: a message joins Codex's own goal turn and reaches the model in it, Codex's next goal turn still shows as its own, messages at a goal turn's end were each taken once (${outcomes.join(", ")}), and a 30-token budget stopped the goal at ${limited.tokensUsed} tokens`)
} finally {
  await codex.close(id).catch(() => undefined)
  server.close()
  rmSync(root, { recursive: true, force: true })
}
