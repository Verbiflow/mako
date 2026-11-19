// What Mako's standing note and Codex's primer cost a session: 30 prompts
// across 3 process bindings (a new process every 10, resuming the same native
// session), replayed through the host's own code with an injected driver (the
// note) and the production Codex engine over a fixture app-server that keeps
// its rollout as Codex does (the primer: a developer message only when the
// turn's application context differs from the turn before's). No model is
// called. Writes each prompt's note and each primer the model got as JSON to
// the path given, for a tokenizer to count:
//   tsx --tsconfig tsconfig.app.json scripts/measure-note-cadence.ts <out.json>
// The note's text is a fixture of the real one's size and shape
// (`fixtures/standing-note.txt`), with its machine's values replaced.
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SpawnOptions } from "node:child_process"
import { mock } from "node:test"
import { z } from "zod"
import { processRunner } from "@mako/git/process-runner"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { createCodexEngine } from "@mako/host/harnesses/codex-app"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { admitted } from "./fixtures/admitted-start.ts"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const PROMPTS = 30
const PROCESSES = 3
const FIXTURE = "Measurement fixture"
const NOTE = readFileSync(resolve("scripts/fixtures/standing-note.txt"), "utf8").trim()
const [control, environment] = NOTE.split("\n\n")

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((done) => setTimeout(done, 5))
  }
}

/** Each prompt's `<mako-local-control>` block as the harness got it, or "" when it carried none. */
async function notes(): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "mako-measure-note-"))
  const id = randomUUID()
  const sent: string[] = []
  let starts = 0
  let owner: LiveConversations
  const state = (status: LiveSessionState["status"]): LiveSessionState => ({
    id, nativeId: id, nativePath: join(root, "native-session"), harness: "test-provider", cwd: root, status, connection: "connected", modes: [], currentMode: null, configOptions: [],
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
    provider: "test-provider",
    available: () => true,
    start: async () => {
      starts += 1
      return state("ready")
    },
    prompt: async (_id, text, _attachments, _settings, dispatch) => {
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
    controlInstructions: async () => ({ standing: { control, environment }, notices: [] }),
    providerIdleMs: 15,
    resumeVerdict: async () => ({ kind: "resumable" as const, record: "same" as const }),
  })
  const settled = () => (owner.snapshot(id)?.requests ?? []).every((request) => request.status === "completed" || request.status === "failed")
  try {
    await owner.start("test-provider", root, { conversationId: id })
    for (let prompt = 0; prompt < PROMPTS; prompt += 1) {
      if (prompt > 0 && prompt % (PROMPTS / PROCESSES) === 0) {
        // The process goes idle and hibernates; the next message resumes the same native session in a new one.
        await waitFor(() => owner.snapshot(id)?.session.connection === "hibernated", "the process never hibernated")
      }
      const before = sent.length
      owner.submit(id, randomUUID(), `Prompt ${prompt + 1}`)
      await waitFor(() => sent.length === before + 1 && settled(), `prompt ${prompt + 1} never went`)
    }
    if (starts !== PROCESSES) throw new Error(`expected ${PROCESSES} processes, saw ${starts}`)
    return sent.map((text) => text.match(/<mako-local-control>[\s\S]*?<\/mako-local-control>/)?.[0] ?? "")
  } finally {
    await owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Each developer message Codex handed the model under Mako's key, read from the fixture's rollout. */
async function primers(): Promise<{ primers: string[]; turns: number }> {
  const root = mkdtempSync(join(tmpdir(), "mako-measure-primer-"))
  const id = randomUUID()
  const rollout = join(root, "rollout.jsonl")
  const codex = createCodexEngine({ dataRoot: root })
  const originalSpawn = processRunner.spawn
  const spawn = mock.method(processRunner, "spawn", (_command: string, _args: readonly string[], settings: SpawnOptions) =>
    originalSpawn(process.execPath, [resolve("scripts/fixtures/primer-app-server.mjs")], settings))
  const states: LiveSessionState[] = []
  const tools = { token: "fixture", makoUrl: "http://127.0.0.1:1/mako", computerUrl: "http://127.0.0.1:1/computer" }
  let turns = 0
  try {
    for (let process_ = 0; process_ < PROCESSES; process_ += 1) {
      await codex.start(root, admitted("codex", {
        conversationId: id, resume: process_ === 0 ? undefined : "fixture-thread", conversationTools: tools,
        emit: (event) => { if (event.type === "live-session") states.push(event.session) },
      }, { env: { CODEX_EXECUTABLE: process.execPath, PATH: process.env.PATH, PRIMER_CALLS: join(root, "calls.jsonl"), PRIMER_ROLLOUT: rollout } }))
      for (let prompt = 0; prompt < PROMPTS / PROCESSES; prompt += 1) {
        await codex.prompt(id, `Prompt ${turns + 1}`, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
        await waitFor(() => states.at(-1)?.status === "ready", "the fixture turn never ended")
        turns += 1
      }
      await codex.close(id)
    }
    const Developer = z.object({ payload: z.object({ role: z.literal("developer"), content: z.array(z.object({ text: z.string() })) }) })
    const found = readFileSync(rollout, "utf8").trim().split("\n")
      .flatMap((line) => Developer.safeParse(JSON.parse(line)).data?.payload.content.map((part) => part.text) ?? [])
      .filter((text) => text.startsWith("<mako>"))
    return { primers: found, turns }
  } finally {
    spawn.mock.restore()
    rmSync(root, { recursive: true, force: true })
  }
}

const out = process.argv[2]
if (!out) throw new Error("usage: measure-note-cadence.ts <out.json>")
const result = { prompts: PROMPTS, processes: PROCESSES, notes: await notes(), codex: await primers() }
writeFileSync(out, JSON.stringify(result, null, 2))
console.log(`notes sent on ${result.notes.filter(Boolean).length} of ${PROMPTS} prompts; Codex primer on ${result.codex.primers.length} of ${result.codex.turns} turns; written to ${out}`)
