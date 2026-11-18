// Mako's primer on a harness without a slot of its own reaches the model in
// Mako's note, through LiveConversations with an injected driver and the
// host's own note (`makoNote`). After anything that may have kept the model
// from it (a send that failed, a compaction, a rewind, a new process for the
// binding, another binding), the next accepted prompt carries it again.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { readFile } from "node:fs/promises"
import type { SpawnOptions } from "node:child_process"
import { mock } from "node:test"
import { z } from "zod"
import { processRunner } from "@mako/git/process-runner"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { makoNote } from "@mako/host/conversations/mako-note"
import { standingLines } from "@mako/host/conversations/control-cadence"
import { MAKO_SERVER_INSTRUCTIONS, primerBlocks } from "@mako/host/contracts/primer"
import { withoutInstructions } from "@mako/host/contracts/mcp-reach"
import { claudeSdkOptions } from "@mako/host/harnesses/claude/sdk-options"
import { configureOpenCodePrimer } from "@mako/host/harnesses/opencode/primer-file"
import { createCodexEngine } from "@mako/host/harnesses/codex-app"
import { admitted } from "./fixtures/admitted-start.ts"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { CONTEXT_COMPACTED } from "@mako/host/contracts/native-activity"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const FIXTURE = "Injected driver fixture"
/** What Codex's thread/start and thread/resume carry of Mako's `mako` server. */
const OpenedSchema = z.object({ config: z.object({ mcp_servers: z.object({ mako: z.object({ url: z.string() }) }) }) })
const BLOCKS = primerBlocks({ role: "thread", noRecipe: false, computer: true }).map((block) => block.text)
const FILE_LINK = "Link files with ordinary Markdown links to their absolute path, optionally followed by :line, so the person can open them."
const carries = (text: string) => BLOCKS.every((block) => text.includes(block))
const carriesAny = (text: string) => BLOCKS.some((block) => text.includes(block))

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

/** `idleMs`: the process hibernates once idle that long, and the next message resumes its session in a new one. */
function primerHost(options: { idleMs?: number; harness?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mako-primer-delivery-"))
  const id = randomUUID()
  const sent: string[] = []
  let starts = 0
  let refuse = false
  let owner: LiveConversations
  const harness = options.harness ?? "test-provider"
  const state = (status: LiveSessionState["status"], connection: LiveSessionState["connection"] = "connected"): LiveSessionState => ({
    id, nativeId: id, nativePath: join(root, "native-session"), harness, cwd: root, status, connection, modes: [], currentMode: null, configOptions: [],
  })
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: FIXTURE },
    launchEnvironment: { kind: "unavailable", reason: FIXTURE },
    nativeIdentity: { kind: "unavailable", reason: FIXTURE },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: FIXTURE, feedback: { kind: "next-message", reason: FIXTURE } },
    backgroundStop: { kind: "ends-with-turn", evidence: FIXTURE },
    turnRecovery: { kind: "manual", reason: FIXTURE },
    resume: fixtureResume(),
    provider: harness,
    available: () => true,
    start: async () => {
      starts += 1
      return state("ready")
    },
    prompt: async (_id, text, _attachments, _settings, dispatch) => {
      if (refuse) {
        refuse = false
        throw new Error("The harness refused the message")
      }
      dispatch.report({ kind: "submitted", source: "transport-call" })
      sent.push(text)
      owner.observe({ type: "live-session", session: state("running") })
      owner.observe({ type: "live-update", id, update: { kind: "text", text: "Done." } })
      setTimeout(() => owner.observe({ type: "live-session", session: state("ready") }), 0)
    },
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    controlInstructions: makoNote({
      cloudMachine: false,
      launchedWith: () => undefined,
      controlLine: () => undefined,
      ownSlot: () => false,
      notices: () => [],
    }),
    ...options.idleMs !== undefined && {
      providerIdleMs: options.idleMs,
      resumeVerdict: async () => ({ kind: "resumable" as const, record: "same" as const }),
    },
  })
  const settled = () => (owner.snapshot(id)?.requests ?? []).every((request) => request.status === "completed" || request.status === "failed")
  return {
    id,
    owner,
    starts: () => starts,
    hibernated: () => owner.snapshot(id)?.session.connection === "hibernated",
    start: () => owner.start(harness, root, { conversationId: id }),
    send: async (text: string) => {
      const before = sent.length
      owner.submit(id, randomUUID(), text)
      await waitFor(() => sent.length === before + 1 && settled(), `"${text}" never went`)
      return sent.at(-1)!
    },
    refused: async (text: string) => {
      refuse = true
      owner.submit(id, randomUUID(), text)
      await waitFor(() => owner.snapshot(id)?.session.status === "failed", `"${text}" was never refused`)
    },
    observe: (event: Parameters<LiveConversations["observe"]>[0]) => owner.observe(event),
    cleanup: async () => {
      await owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type Host = ReturnType<typeof primerHost>

/** One way the model can miss the primer: after `lose`, the next accepted prompt carries it. */
async function primerAfter(lose: (host: Host) => Promise<void>, options: { idleMs?: number; harness?: string } = {}) {
  const host = primerHost(options)
  try {
    await host.start()
    assert.ok(carries(await host.send("First")), "the first prompt carries the primer")
    assert.ok(BLOCKS.some(block => block.includes(FILE_LINK)), "the common primer includes clickable absolute file guidance")
    assert.equal(carriesAny(await host.send("Second")), false, "a prompt after it doesn't repeat it")
    await lose(host)
    assert.ok(carries(await host.send("Next")), "the next accepted prompt carries the primer again")
  } finally {
    await host.cleanup()
  }
}

const running = (host: Host, status: "running" | "ready") =>
  host.observe({ type: "live-session", session: { ...host.owner.snapshot(host.id)!.session, status } })

const cases: Array<[string, () => Promise<void>]> = [
  ["a send that failed", () => primerAfter((host) => host.refused("Refused"))],
  ["a compaction", () => primerAfter(async (host) => host.observe({ type: "live-update", id: host.id, update: { kind: "event", label: CONTEXT_COMPACTED } }))],
  ["a compaction the harness starts", () => primerAfter(async (host) => {
    running(host, "running")
    host.observe({ type: "live-activity", id: host.id, activity: { kind: "compacting" } })
    running(host, "ready")
  })],
  ["a rewind", () => primerAfter(async (host) => host.observe({ type: "live-rewound", id: host.id, run: "run-1" }))],
  ["a new process for the binding", () => primerAfter(async (host) => {
    const starts = host.starts()
    await waitFor(host.hibernated, "the idle provider never hibernated")
    await waitFor(() => host.starts() === starts, "the provider started again before the next message")
  }, { idleMs: 15 })],
]

// The real common note/queue path, with each note-backed harness's identity.
// The injected transport observes exactly what LiveConversations hands it; no model is called.
for (const harness of ["cursor", "grok", "devin"]) {
  cases.push([`${harness} compaction`, () => primerAfter(async host => {
    host.observe({ type: "live-update", id: host.id, update: { kind: "event", label: CONTEXT_COMPACTED } })
  }, { harness })])
  cases.push([`${harness} resume`, () => primerAfter(async host => {
    await waitFor(host.hibernated, `${harness} never hibernated`)
  }, { harness, idleMs: 15 })])
}

cases.push(["native instruction slots", async () => {
  const root = mkdtempSync(join(tmpdir(), "mako-primer-slots-"))
  const tools = { token: "fixture", makoUrl: "http://127.0.0.1:1/mako", computerUrl: "http://127.0.0.1:1/computer" }
  const instructions = BLOCKS.join("\n\n")
  const id = randomUUID()
  const options = (resume?: string) => admitted("claude", {
    conversationId: id, resume, emit: () => {}, conversationTools: tools,
    mcpSnapshot: async () => ({ cwd: root, generatedAt: 0, servers: [], providers: [] }),
  }, { env: {} })
  let primerFolder: string | undefined
  const codex = createCodexEngine({ dataRoot: root })
  const originalSpawn = processRunner.spawn
  let fixtureStderr = ""
  // Only replace the native executable with a fixture. The production engine still
  // constructs turn/start and exchanges it over real child stdin/stdout.
  const spawn = mock.method(processRunner, "spawn", (_command: string, args: readonly string[], settings: SpawnOptions) => {
    assert.deepEqual(args, ["app-server"])
    const child = originalSpawn(process.execPath, [resolve("scripts/fixtures/primer-app-server.mjs")], settings)
    child.stderr?.on("data", chunk => { fixtureStderr += String(chunk) })
    return child
  })
  const states: LiveSessionState[] = []
  try {
    for (const phase of ["start", "resume", "after compaction"]) {
      const input = options(phase === "start" ? undefined : id)
      const configured = await claudeSdkOptions(root, input, input.trace)
      assert.deepEqual(configured.options.systemPrompt, { type: "preset", preset: "claude_code", append: instructions }, `Claude ${phase}: native preset append keeps the full primer`)
      assert.equal(configured.options.resume, input.resume)

      const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ instructions: ["person.md"], model: "fixture" }) }
      // The unique suffix gives this fixture sole ownership of the hashed temp file.
      await configureOpenCodePrimer(env, `${instructions}\nFixture ${root}`)
      const config = z.object({ instructions: z.array(z.string()), model: z.string() }).parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT))
      assert.equal(config.instructions[0], "person.md")
      assert.equal(config.model, "fixture")
      const file = config.instructions[1]!
      primerFolder = dirname(file)
      assert.ok((await readFile(file, "utf8")).includes(FILE_LINK), `OpenCode ${phase}: the configured instruction file carries file guidance`)
    }

    const log = join(root, "calls.jsonl")
    const open = async (resume?: string) => codex.start(root, admitted("codex", {
      conversationId: id, resume, conversationTools: tools,
      emit: event => { if (event.type === "live-session") states.push(event.session) },
    }, { env: { CODEX_EXECUTABLE: process.execPath, PATH: process.env.PATH, PRIMER_CALLS: log } }))
    const send = async (text: string) => {
      await codex.prompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
      await waitFor(() => states.at(-1)?.status === "ready", "the fixture turn never ended")
    }
    await open()
    await send("first")
    await codex.compact(id, randomUUID())
    await waitFor(() => states.at(-1)?.status === "ready", "the fixture compaction never ended")
    await send("after compaction")
    await codex.close(id)
    await open("fixture-thread")
    await send("after resume")
    const frames = (await readFile(log, "utf8")).trim().split("\n").map(line => z.object({ method: z.string(), params: z.unknown().optional() }).parse(JSON.parse(line)))
    const turns = frames.filter(frame => frame.method === "turn/start")
    assert.equal(turns.length, 3)
    for (const frame of turns) {
      const params = z.object({ additionalContext: z.object({ mako: z.object({ kind: z.literal("application"), value: z.string() }) }), input: z.array(z.object({ text: z.string() })) }).parse(frame.params)
      assert.equal(params.additionalContext.mako.value, `${instructions}\n\n${MAKO_SERVER_INSTRUCTIONS}`, "Codex uses the real turn's developer application context, with the server's instructions, also after compaction/resume")
      assert.equal(params.input.some(item => item.text.includes(FILE_LINK)), false, "the primer never replaces the person's words")
    }
    assert.ok(frames.some(frame => frame.method === "thread/resume"))
    const opened = frames.filter(frame => frame.method === "thread/start" || frame.method === "thread/resume")
    assert.ok(opened.length >= 2)
    for (const frame of opened) {
      const params = OpenedSchema.parse(frame.params)
      assert.equal(params.config.mcp_servers.mako.url, withoutInstructions(tools.makoUrl), `Codex's ${frame.method} reaches mako without its instructions`)
    }
    assert.ok(frames.some(frame => frame.method === "thread/compact/start"))
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nfixture spawns=${spawn.mock.callCount()}\n${fixtureStderr}`, { cause: error })
  } finally {
    try { await codex.close(id) } finally {
      spawn.mock.restore()
      if (primerFolder) rmSync(primerFolder, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }
}])

cases.push(["another binding", async () => {
  const note = makoNote({ cloudMachine: false, launchedWith: () => undefined, controlLine: () => undefined, ownSlot: () => false, notices: () => [] })
  const standing = (await note("binding-a", "conversation", { role: "thread" })).standing
  const heard = standingLines(undefined, { bindingId: "binding-a", generation: 1 }, standing)
  assert.ok(carries(heard.lines.join("\n")), "the first binding hears the primer")
  assert.equal(standingLines(heard.said, { bindingId: "binding-a", generation: 1 }, standing).lines.length, 0, "and not again")
  const replaced = (await note("binding-b", "conversation", { role: "thread" })).standing
  assert.ok(carries(standingLines(heard.said, { bindingId: "binding-b", generation: 1 }, replaced).lines.join("\n")), "the binding that replaces it hears it whole")
}])

const failed: string[] = []
for (const [name, run] of cases) {
  try {
    await run()
    console.log(`  ok: the primer after ${name}`)
  } catch (error) {
    failed.push(name)
    console.log(`  FAIL: the primer after ${name}: ${error instanceof Error ? error.stack : String(error)}`)
  }
}
assert.deepEqual(failed, [], `the primer was lost after ${failed.join(", ")}`)
console.log("primer delivery: the next accepted prompt carries the primer after a failed send, a compaction, a rewind, a new process or another binding")
