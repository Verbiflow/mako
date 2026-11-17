import "./lib/scratch-git.mjs"
// A turn's first write held on the real Grok CLI, in sealed homes, against the scripted model (no account; nothing
// leaves this machine).
//
// First, what Grok itself says loads in a folder (`grok inspect --json`), which decides whether a launch holds writes:
// nothing in a trusted folder; the person's hooks, which an untrusted folder doesn't report. Its answer is kept per
// folder while what Grok reads stands, so a second launch doesn't ask again, and a hook added since does.
//
// Then Mako's own live driver, one turn each: Grok asks over ACP (`_x.ai/hooks/run`) before a tool runs, and while
// the binding's write hold stands the call doesn't run and the model hears no result; once the hold lets go, it runs.
// A shell command that writes a file; an MCP tool of an HTTP server's (Mako's own, as `mako__touch`); and a subagent,
// whose spawn waits, and whose own shell call asks the same hook.
//
//   npx tsx scripts/test-first-write-hold-grok-live.ts [--evidence <dir>]
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { JsonObject } from "@mako/host/contracts/json"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { CALL_GATE_HOLD_MS } from "@mako/host/harnesses/call-gate"
import { GROK_CALL_HOOKS } from "@mako/host/harnesses/grok/call-hooks"
import { installGrok } from "@mako/host/harnesses/grok/index"
import { grokInspect, grokPersonCode, grokPersonCodeRuns, type GrokAnswers } from "@mako/host/harnesses/grok/person-code"
import { WriteHolds } from "@mako/host/harnesses/write-holds"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

const args = process.argv.slice(2)
const evidenceAt = args.indexOf("--evidence")
const evidence = evidenceAt === -1 ? undefined : args[evidenceAt + 1]

/** How long a held call must stay unrun: past Grok's own turnaround, under the gate's deadline. */
const HELD_FOR_MS = 4_000
assert.ok(HELD_FOR_MS < CALL_GATE_HOLD_MS)
/** The subagent's task, by which the stand-in model tells its requests from its parent's. */
const CHILD_TASK = "SUBAGENT-TASK: write sub.txt"

// What Grok says loads, as a launch would ask it: its executable, the sealed home's environment and the folder.
const timings: Record<string, number> = {}
await sandboxed("mako-grok-inspect", "grok", async (sandbox) => {
  const ask = (env: NodeJS.ProcessEnv = sandbox.env) => grokPersonCodeRuns(grokInspect("grok", env, sandbox.project), { servers: [] })
  assert.equal(await ask(), false, "a trusted folder with nothing of the person's: writes can be held")
  // Kept: a second launch in the same folder, nothing Grok reads changed, takes Grok's last answer.
  const answers: GrokAnswers = new Map()
  const launch = { executable: "grok", env: sandbox.env, cwd: sandbox.project, servers: [] }
  let began = performance.now()
  assert.equal(await grokPersonCode(launch, answers), false, "asked of Grok")
  timings.askedMs = Math.round(performance.now() - began)
  began = performance.now()
  assert.equal(await grokPersonCode(launch, answers), false, "read from its last answer")
  timings.keptMs = Math.round(performance.now() - began)
  assert.equal(answers.size, 1, "one answer kept for the folder")
  await mkdir(join(sandbox.home, ".grok", "hooks"), { recursive: true })
  await writeFile(join(sandbox.home, ".grok", "hooks", "start.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] } }))
  await mkdir(join(sandbox.project, ".grok", "hooks"), { recursive: true })
  await writeFile(join(sandbox.project, ".grok", "hooks", "pre.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "true" }] }] } }))
  assert.equal(await grokPersonCode(launch, answers), true, "a hook added since is asked about again, not read from the kept answer")
  assert.equal(await ask(), true, "a folder Grok doesn't trust reports no hooks, so nothing is held")
  assert.equal(await ask({ ...sandbox.env, GROK_FOLDER_TRUST: "0" }), true, "trusted, Grok names the person's hooks, and nothing is held")
  // A hook file edited in place moves only its own time: the answer is asked again.
  const answersTrusted: GrokAnswers = new Map()
  const trusted = { ...launch, env: { ...sandbox.env, GROK_FOLDER_TRUST: "0" } }
  assert.equal(await grokPersonCode(trusted, answersTrusted), true)
  await delay(20)
  writeFileSync(join(sandbox.project, ".grok", "hooks", "pre.json"), JSON.stringify({ hooks: {} }))
  await grokPersonCode(trusted, answersTrusted)
  assert.equal(answersTrusted.size, 2, "a hook file edited in place is a new answer")
  console.log(`PASS: Grok's own account of a folder holds writes only where it trusts it and names nothing of the person's; asked ${timings.askedMs} ms, kept ${timings.keptMs} ms`)
})

// Which tools asked the pre-tool hook, from which session: a subagent's own calls name its session.
const asked: { tool: string; session: string | undefined }[] = []
const writes = GROK_CALL_HOOKS.writes
assert.ok(writes)
const holdsOf = writes.holds.bind(writes)
const Asked = z.object({ hookEventName: z.string(), toolName: z.string().optional(), sessionId: z.string().optional() }).loose()
writes.holds = (params: JsonObject, answer: JsonObject) => {
  const run = Asked.safeParse(params)
  if (run.success && run.data.hookEventName === "pre_tool_use") asked.push({ tool: run.data.toolName ?? "?", session: run.data.sessionId })
  return holdsOf(params, answer)
}

const holds = new WriteHolds()
const driver = sealedDrivers([installGrok], { writeHolds: holds }).get("grok")
assert.ok(driver, "Grok's live driver registered")
assert.ok(driver.firstWrite, "Grok declares that it holds its agent's writes when the host gives it write holds")
// Mako's conversation server over HTTP, with one tool that writes, standing for the likes of `worktree_update`.
let touched = ""
const tools = await startConversationMcp({ authorizeAgent: () => {} }, async () => null, [(server) => {
  server.registerTool("touch", { description: "Write mcp.txt in the project folder.", inputSchema: {} }, async () => {
    writeFileSync(touched, "written by an MCP tool\n")
    return { content: [{ type: "text", text: "Wrote mcp.txt." }] }
  })
}])

try {
  await sandboxed("mako-first-write", "grok", async (sandbox) => {
    touched = join(sandbox.project, "mcp.txt")
    const heard: { at: number; body: string }[] = []
    const parent: ScriptedReply[] = []
    let child: ScriptedReply[] = []
    const model = await scriptedModel({
      reply: (body) => {
        heard.push({ at: Date.now(), body })
        if (body.includes(CHILD_TASK) && !body.includes("spawn_subagent\"")) return child.shift() ?? { text: "Done." }
        return parent.shift() ?? { text: "Done." }
      },
      answers: SCRIPTED_GETS,
    })
    const env = { ...sandbox.env }
    await pointAt("grok", sandbox, model.url, env, "first-write-hold")
    const id = randomUUID()
    const grant = tools.mint(id, id)
    assert.ok(grant.makoUrl, "Mako's server is served over HTTP, so it isn't the person's process")
    const events: LiveDriverEvent[] = []
    const timeline: Record<string, Record<string, number>> = {}
    try {
      await driver.start(sandbox.project, admitted("grok", {
        conversationId: id, modeId: "access:full",
        emit: (event) => {
          events.push(event)
          // A call Grok asks about is answered as the person would: allowed.
          if (event.type === "live-permission") {
            const option = event.request.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? event.request.options?.[0]
            if (option) void Promise.resolve(driver.permission(id, event.request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
          }
        },
        mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
        nativeCalls: () => ({ folder: sandbox.project, recipe: { kind: "none" } }),
        conversationTools: grant,
      }, { env }))
      assert.ok(holds.attends(id), "a sealed launch in a folder Grok trusts, with none of the person's own code, holds its writes")

      /** One turn: the model's call is held, unrun and unanswered, until the hold lets go; then it writes `file`. */
      const heldTurn = async (name: string, call: ScriptedReply, file: string) => {
        parent.push(call)
        const gate = Promise.withResolvers<void>()
        let early = 0
        const unhold = holds.hold(id, { until: gate.promise, frozen: () => false, wrote: () => { early += 1 } })
        const target = join(sandbox.project, file)
        const from = heard.length
        const times: Record<string, number> = {}
        try {
          await driver.prompt(id, `Turn ${name}.`, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
          const deadline = Date.now() + 120_000
          while (heard.length <= from && Date.now() < deadline) await delay(50)
          assert.ok(heard.length > from, `${name}: Grok never asked the stand-in model`)
          times.asked = heard[from]!.at
          await delay(HELD_FOR_MS)
          assert.equal(existsSync(target), false, `${name}: the held call hasn't run ${HELD_FOR_MS} ms after the model asked for it (asked: ${asked.map((each) => each.tool).join(", ")})`)
          times.released = Date.now()
          gate.resolve()
          while (!existsSync(target) && Date.now() < deadline) await delay(20)
          times.written = Date.now()
          assert.ok(existsSync(target), `${name}: once the hold lets go, the call runs and writes ${file}`)
          assert.ok(early >= 1, `${name}: the call let go before a freeze is said`)
          const status = () => events.findLast((event) => event.type === "live-session")?.session.status
          while (Date.now() < deadline && (status() === "running" || status() === "starting")) await delay(100)
        } finally {
          gate.resolve()
          unhold()
        }
        timeline[name] = times
        console.log(`PASS: ${name}: held ${HELD_FOR_MS} ms unrun; released, it wrote ${times.written! - times.released!} ms later`)
      }

      await heldTurn("shell", { call: { id: "call_shell", name: "run_terminal_command", arguments: { command: "echo written by the agent > held.txt", description: "Write the held file" } } }, "held.txt")
      assert.equal(readFileSync(join(sandbox.project, "held.txt"), "utf8").trim(), "written by the agent")

      await heldTurn("mcp", { call: { id: "call_mcp", name: "mako__touch", arguments: {} } }, "mcp.txt")
      assert.ok(asked.some((each) => each.tool === "mako__touch"), `the MCP call asked the hook as ${asked.map((each) => each.tool).join(", ")}`)

      child = [{ call: { id: "call_child", name: "run_terminal_command", arguments: { command: "echo written by a subagent > sub.txt", description: "Write the subagent's file" } } }]
      await heldTurn("subagent", { call: { id: "call_spawn", name: "spawn_subagent", arguments: { description: "Write a file", prompt: CHILD_TASK } } }, "sub.txt")
      const spawned = asked.find((each) => each.tool === "spawn_subagent")
      assert.ok(spawned, "the spawn asked the hook, and waited")
      const childAsked = asked.filter((each) => each.tool === "run_terminal_command" && each.session !== spawned.session)
      assert.ok(childAsked.length > 0, `the subagent's own shell call asked the same hook from its own session (asked: ${JSON.stringify(asked)})`)
      console.log(`PASS: a subagent's own calls ask Mako's pre-tool hook too (its session ${childAsked[0]!.session})`)
    } finally {
      await Promise.resolve(driver.close(id)).catch(() => {})
      await model.close()
      if (evidence) {
        await mkdir(evidence, { recursive: true })
        await writeFile(join(evidence, "grok-first-write.json"), sandbox.scrub(JSON.stringify({ timings, timeline, asked, heard: heard.map(({ at }) => at), events }, null, 1)).replaceAll(homedir(), "~"))
      }
    }
  })
} finally {
  await tools.close?.()
  await driver.stop?.()
}
