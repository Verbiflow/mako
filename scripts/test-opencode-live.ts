import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createOpenCodeDriver } from "../electron/providers/opencode/live-driver.ts"
import { accessModeId } from "../electron/contracts/access.ts"
import type { LiveDriverEvent, LivePermissionRequest, LiveSessionState, LiveUpdate } from "../electron/shared.ts"
import type { ApprovalSubmission } from "../electron/contracts/approval-response.ts"
import type { PromptDeliveryEvidence } from "../electron/contracts/prompt-delivery.ts"
import type { ApprovalDispatch } from "../electron/providers/live-driver.ts"
import type { PromptDispatch } from "../electron/providers/prompt-dispatch.ts"

// Real OpenCode v2 through Mako's native driver. Every store is disposable
// (isolated HOME and XDG roots); the free hosted model needs no credentials.
const root = await mkdtemp(join(tmpdir(), "mako-opencode-live-"))
const executable = process.env.OPENCODE_BIN_PATH ?? join(homedir(), ".opencode/bin/opencode2")
const model = process.env.MAKO_OPENCODE_MODEL ?? "opencode/space-bunny-free"
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_BIN_PATH: executable, OPENCODE_CONFIG_CONTENT: "{}" }
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"]) {
  env[name] = join(root, name)
  await mkdir(env[name]!, { recursive: true })
}
const work = join(root, "work")
await mkdir(work)
await writeFile(join(work, "notes.txt"), "The launch code is 7-alpha-3.\n")
const STEP_MS = Number(process.env.MAKO_OPENCODE_STEP_MS ?? 180_000)
const report: { model: string; cases: string[]; passed: boolean } = { model, cases: [], passed: false }
/** The native stream's recent text, for a timeout's diagnosis only. */
let nativeTail = ""
const driver = createOpenCodeDriver({
  env: async () => ({ ...env }), approvalRoot: async () => join(root, "approvals"),
  fetch: async (input, init) => {
    const response = await fetch(input, init)
    if (new URL(String(input)).pathname !== "/api/event" || !response.body) return response
    const [returned, observed] = response.body.tee()
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of observed) nativeTail = (nativeTail + decoder.decode(chunk)).slice(-6000)
    })().catch(() => {})
    return new Response(returned, { status: response.status, headers: response.headers })
  },
})

interface Conversation {
  id: string
  events: LiveDriverEvent[]
  state(): LiveSessionState
  updates(): LiveUpdate[]
}

function conversation(): Conversation & { emit(event: LiveDriverEvent): void } {
  const id = randomUUID()
  const events: LiveDriverEvent[] = []
  return {
    id, events,
    emit: event => { events.push(event) },
    state() {
      const last = events.findLast(event => event.type === "live-session")
      assert.ok(last && last.type === "live-session")
      return last.session
    },
    updates: () => events.flatMap(event => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : []),
  }
}

async function until<T>(label: string, probe: () => T | undefined | false, ms = STEP_MS): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function promptDispatch(): PromptDispatch & { reports: PromptDeliveryEvidence[] } {
  const reports: PromptDeliveryEvidence[] = []
  return { operationId: randomUUID(), attemptId: randomUUID(), reports, report: evidence => { reports.push(evidence) } }
}

function approvalDispatch(): ApprovalDispatch & { reports: ApprovalSubmission[] } {
  const reports: ApprovalSubmission[] = []
  return { reports, assertCurrent() {}, report: result => { reports.push(result) } }
}

/** Send one prompt and wait for the turn it starts to stop. */
async function turn(chat: Conversation, text: string, onRequest?: (request: LivePermissionRequest) => Promise<void>) {
  const from = chat.events.length
  const dispatch = promptDispatch()
  await driver.prompt(chat.id, text, [], undefined, dispatch)
  const answered = new Set<string>()
  const state = await until(`the turn for ${JSON.stringify(text.slice(0, 40))} to stop`, () => {
    for (const event of chat.events.slice(from)) if (event.type === "live-permission" && !answered.has(event.request.id) && onRequest) {
      const request = event.request
      answered.add(request.id)
      void onRequest(request)
    }
    const session = chat.state()
    return session.status !== "running" && chat.events.slice(from).some(event => event.type === "live-session" && event.session.status === "running") && session
  }).catch(error => {
    const seen = chat.events.slice(from).map(event => event.type === "live-updates" ? `updates(${event.updates.map(update => update.kind === "tool-update" ? `${update.kind}:${update.status ?? ""}` : update.kind).join(",")})`
      : event.type === "live-permission" ? `permission(${event.request.title}; ${event.request.questions ? "form" : event.request.kind})` : event.type)
    const { status, lastStop, error: failure } = chat.state()
    throw new Error(`${error.message}; state ${JSON.stringify({ status, lastStop, failure })}; saw ${seen.join(" ").slice(-2500)}\nnative stream tail:\n${nativeTail.replace(/data: \{"type":"session\.(text|reasoning)\.delta"[^\n]*\n/g, "")}`)
  })
  const events = chat.events.slice(from)
  const updates = events.flatMap(event => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
  const prose = updates.flatMap(update => update.kind === "text" ? [update.text] : []).join("")
  return { state, dispatch, events, updates, prose }
}

async function start(chat: ReturnType<typeof conversation>, options: { modeId?: string; resume?: string; threadPath?: string } = {}) {
  return driver.start(work, { conversationId: chat.id, emit: chat.emit, tuning: { model }, title: "Mako native driver test", ...options })
}

const marker = `mako-native-${Date.now()}`
const chats: string[] = []
try {
  assert.equal(driver.available(process.cwd()), true, `OpenCode v2 is required at ${executable}`)

  const ask = conversation()
  chats.push(ask.id)
  const started = await start(ask, { modeId: accessModeId("ask") })
  assert.equal(started.status, "ready")
  assert.equal(started.connection, "connected")
  assert.match(started.nativeId ?? "", /^ses_/)
  assert.match(started.nativePath ?? "", /#v2:ses_/)
  assert.equal(started.currentMode, accessModeId("ask"))
  assert.deepEqual(started.modes.map(mode => mode.id), ["plan", accessModeId("ask"), accessModeId("edits"), accessModeId("full")])
  assert.equal(started.settings?.model, model)
  assert.ok(started.commands?.some(command => command.name === "compact"))
  report.cases.push("fresh session: native id and store path, launch-tier ladder, requested model and native commands")

  const pong = await turn(ask, "Reply with exactly the single word: pong")
  assert.equal(pong.state.lastStop, "end_turn", pong.state.error)
  assert.match(pong.prose, /pong/i)
  const submitted = pong.dispatch.reports.find(evidence => evidence.kind === "submitted")
  assert.ok(submitted && submitted.kind === "submitted" && submitted.correlationId?.startsWith("msg_"))
  const accepted = pong.dispatch.reports.filter(evidence => evidence.kind === "accepted")
  assert.ok(accepted.some(evidence => evidence.kind === "accepted" && evidence.referenceId === submitted.correlationId),
    "acceptance names the inbox item the client chose")
  assert.ok(pong.state.usage && pong.state.usage.used > 0 && pong.state.usage.size > 0, "context usage comes from the root step")
  report.cases.push("prompt: client-chosen inbox id is the correlation and acceptance reference; prose streams; usage reported")

  const shell = await turn(ask, `Use the bash tool to run exactly this command: echo ${marker}\nThen reply with the word done.`, async request => {
    const dispatch = approvalDispatch()
    await driver.permission(ask.id, request.id, { kind: "choice", optionId: "once" }, dispatch)
    assert.deepEqual(dispatch.reports, [{ kind: "submitted", source: "transport-write" }])
  })
  assert.equal(shell.state.lastStop, "end_turn", shell.state.error)
  const permission = shell.events.find(event => event.type === "live-permission")
  assert.ok(permission && permission.type === "live-permission", "ask mode asks before running a shell command")
  assert.equal(permission.request.kind, "execute")
  assert.ok(permission.request.options.some(option => option.optionId === "always"))
  assert.ok(shell.events.some(event => event.type === "live-permission-ended" && event.requestId === permission.request.id && event.source === "native-resolution"))
  assert.ok(shell.events.some(event => event.type === "live-approval-decision"), "the native decision is retained")
  const bash = shell.updates.find(update => update.kind === "tool" && update.toolKind === "execute")
  assert.ok(bash && bash.kind === "tool")
  assert.ok(shell.updates.some(update => update.kind === "tool-update" && update.id === bash.id && update.status === "completed"
    && JSON.stringify(update.output ?? "").includes(marker)), "the shell row completes with its output")
  report.cases.push("permission: ask tier asks natively, Allow once is written through the API, native resolution ends the request, output lands on the tool row")

  const question = await turn(ask, "Use the question tool to ask me whether I prefer red or blue (two options). After I answer, reply with only my choice.", async request => {
    assert.ok(request.questions?.length, `a native form is a structured question, got ${JSON.stringify({ title: request.title, kind: request.kind, native: request.native })}`)
    const answers = Object.fromEntries(request.questions.map(item => [item.id, [item.options?.[0]?.value ?? item.options?.[0]?.label ?? "red"]]))
    const dispatch = approvalDispatch()
    await driver.permission(ask.id, request.id, { kind: "answers", answers }, dispatch)
    assert.deepEqual(dispatch.reports, [{ kind: "submitted", source: "transport-write" }])
  })
  assert.equal(question.state.lastStop, "end_turn", question.state.error)
  const form = question.events.find(event => event.type === "live-permission" && event.request.questions?.length)
  assert.ok(form && form.type === "live-permission")
  assert.ok(question.events.some(event => event.type === "live-permission-ended" && event.requestId === form.request.id && event.source === "native-resolution"))
  assert.ok(!question.updates.some(update => update.kind === "tool" && update.toolKind === "question"), "the question tool is the form, not a row")
  report.cases.push("question: OpenCode's form becomes a structured question, the answer is written natively and resolves it")

  await driver.setMode(ask.id, "plan")
  assert.equal(ask.state().currentMode, "plan")
  await driver.setMode(ask.id, accessModeId("ask"))
  assert.equal(ask.state().currentMode, accessModeId("ask"))
  await assert.rejects(driver.setMode(ask.id, accessModeId("full")), /when its session starts/)
  report.cases.push("modes: Plan and back switch the native agent; a different tier is refused for a started session")

  const cancelFrom = ask.events.length
  const long = promptDispatch()
  await driver.prompt(ask.id, "Use the bash tool to run exactly: sleep 60 && echo late", [], undefined, long)
  const sleeping = await until("the sleep permission", () => ask.events.slice(cancelFrom).flatMap(event => event.type === "live-permission" ? [event.request] : [])[0])
  await driver.permission(ask.id, sleeping.id, { kind: "choice", optionId: "once" }, approvalDispatch())
  await until("the sleep to start running", () => ask.updates().some(update => update.kind === "tool-update" && update.status === "in_progress"
    && JSON.stringify(update).includes("sleep")) || ask.events.slice(cancelFrom).some(event => event.type === "live-permission-ended"))
  await new Promise(resolve => setTimeout(resolve, 1500))
  await driver.cancel(ask.id)
  const cancelled = await until("the cancelled turn", () => ask.state().status !== "running" && ask.state())
  assert.equal(cancelled.lastStop, "cancelled", cancelled.error)
  const cancelUpdates = ask.events.slice(cancelFrom).flatMap(event => event.type === "live-updates" ? event.updates : event.type === "live-update" ? [event.update] : [])
  const sleepRow = cancelUpdates.find(update => update.kind === "tool" && update.toolKind === "execute")
  assert.ok(sleepRow && sleepRow.kind === "tool")
  const sleepEnd = cancelUpdates.findLast(update => update.kind === "tool-update" && update.id === sleepRow.id && update.status)
  assert.ok(sleepEnd && sleepEnd.kind === "tool-update" && sleepEnd.status !== "completed", `the interrupted call must not complete: ${JSON.stringify(sleepEnd)}`)
  report.cases.push("cancel: interrupt stops a running shell call; the turn ends cancelled")

  const actionId = randomUUID()
  assert.equal(driver.compaction?.kind, "supported")
  if (driver.compaction?.kind === "supported") await driver.compaction.start(ask.id, actionId)
  const compacted = await until("compaction to settle", () => ask.events.find(event => event.type === "live-action-result" && event.actionId === actionId))
  assert.ok(compacted.type === "live-action-result")
  assert.deepEqual(compacted.result, { kind: "completed" })
  assert.equal(ask.state().lastStop, "completed")
  report.cases.push("compaction: native compact with a client id settles its action from the execution events")

  const nativeId = ask.state().nativeId!
  const nativePath = ask.state().nativePath!
  await driver.close(ask.id)
  const resumed = conversation()
  chats.push(resumed.id)
  const again = await start(resumed, { modeId: accessModeId("ask"), resume: nativeId, threadPath: nativePath })
  assert.equal(again.nativeId, nativeId)
  assert.equal(again.nativePath, nativePath)
  const recall = await turn(resumed, "What launch code did I not tell you yet? Just kidding: reply with exactly the word resumed.")
  assert.equal(recall.state.lastStop, "end_turn", recall.state.error)
  assert.match(recall.prose, /resumed/i)
  report.cases.push("resume: a closed session reopens by native id and store path and takes new turns")
  await driver.close(resumed.id)

  const full = conversation()
  chats.push(full.id)
  const fullStarted = await start(full, { modeId: accessModeId("full") })
  assert.equal(fullStarted.currentMode, accessModeId("full"))
  const read = await turn(full, "Use the read tool to read notes.txt in the current directory, then reply with only the launch code it contains.")
  assert.equal(read.state.lastStop, "end_turn", read.state.error)
  assert.ok(!read.events.some(event => event.type === "live-permission"), "full access never asks")
  assert.match(read.prose, /7-alpha-3/)
  const readRow = read.updates.find(update => update.kind === "tool" && update.toolKind === "read")
  assert.ok(readRow && readRow.kind === "tool")
  assert.ok(read.updates.some(update => (update.kind === "tool" || update.kind === "tool-update") && update.id === readRow.id
    && update.details?.some(detail => detail.type === "location" && detail.path === join(work, "notes.txt"))), "the read row carries its resolved location")
  report.cases.push("full access: read runs without asking; the row carries its resolved location")

  const switchTo = process.env.MAKO_OPENCODE_SECOND_MODEL ?? "opencode/mimo-v2.6-flash-free"
  const switchFrom = full.events.length
  const switched = promptDispatch()
  await driver.prompt(full.id, "Reply with exactly the word switched.", [], { model: switchTo }, switched)
  const afterSwitch = await until("the switched turn", () => full.state().status !== "running"
    && full.events.slice(switchFrom).some(event => event.type === "live-session" && event.session.status === "running") && full.state())
  assert.equal(afterSwitch.settings?.model, switchTo)
  assert.equal(afterSwitch.lastStop, "end_turn", afterSwitch.error)
  report.cases.push("model: a per-prompt model switches the native session before the send and reads back")

  const child = await turn(full, "Use the task tool to launch the general subagent with the prompt 'Reply with exactly: child ok'. Then reply with the subagent's answer.")
  assert.equal(child.state.lastStop, "end_turn", child.state.error)
  const agent = child.events.find(event => event.type === "live-agent")
  assert.ok(agent && agent.type === "live-agent", "the subagent is observed natively")
  report.cases.push("subagent: the task tool's child session is observed as a native agent")
  await driver.close(full.id)

  const edits = conversation()
  chats.push(edits.id)
  await start(edits, { modeId: accessModeId("edits") })
  const wrote = await turn(edits, "Use the write tool to create the file hello.txt in the current directory containing exactly: hi from edits. Then use the bash tool to run: cat hello.txt", async request => {
    assert.equal(request.kind, "execute", `the edits tier asks only for commands, got ${request.title}`)
    await driver.permission(edits.id, request.id, { kind: "choice", optionId: "reject" }, approvalDispatch())
  })
  assert.notEqual(wrote.state.status, "running")
  assert.equal(await readFile(join(work, "hello.txt"), "utf8").then(text => text.trim()), "hi from edits")
  assert.ok(wrote.events.some(event => event.type === "live-permission" && event.request.kind === "execute"), "commands still ask under edits")
  const writeRow = wrote.updates.find(update => update.kind === "tool" && update.toolKind === "write")
  assert.ok(writeRow && writeRow.kind === "tool")
  assert.ok(wrote.updates.some(update => (update.kind === "tool" || update.kind === "tool-update") && update.id === writeRow.id
    && update.details?.some(detail => detail.type === "diff" && detail.newText.includes("hi from edits"))), "the write row carries its diff")
  report.cases.push("edits tier: writes run without asking and show a diff; a shell command asks and Reject is honored")
  await driver.close(edits.id)

  // Transport faults at the SDK boundary, against the same real server.
  const faults = { losePrompt: false, prompts: 0, streams: 0, cut: undefined as (() => void) | undefined, hold: Promise.resolve(), sniffed: "" }
  const faulty = createOpenCodeDriver({
    env: async () => ({ ...env }), approvalRoot: async () => join(root, "approvals"),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === "/api/event") {
        await faults.hold
        faults.streams++
        const response = await fetch(input, { ...init, signal: undefined })
        const [body, observed] = response.body!.tee()
        void (async () => {
          const decoder = new TextDecoder()
          for await (const chunk of observed) nativeTail = (nativeTail + decoder.decode(chunk)).slice(-6000)
        })().catch(() => {})
        const upstream = body.getReader()
        const decoder = new TextDecoder()
        const cut = Promise.withResolvers<never>()
        faults.cut = () => cut.reject(new Error("injected event stream loss"))
        // After the cut the server keeps streaming to the sniffer only, as a gap the SDK cannot see.
        let severed = false
        init?.signal?.addEventListener("abort", () => { if (!severed) void upstream.cancel().catch(() => {}) }, { once: true })
        cut.promise.catch(() => { severed = true; void (async () => {
          for (;;) { const next = await upstream.read().catch(() => ({ done: true, value: undefined })); if (next.done) return; faults.sniffed += decoder.decode(next.value) }
        })() })
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (severed) { controller.error(new Error("injected event stream loss")); return }
            try {
              const next = await Promise.race([upstream.read(), cut.promise])
              if (next.done) controller.close(); else controller.enqueue(next.value)
            } catch (error) { controller.error(error) }
          },
          cancel: reason => { if (!severed) return upstream.cancel(reason) },
        }), { status: response.status, headers: response.headers })
      }
      if (/^\/api\/session\/[^/]+\/prompt$/.test(path) && init?.method === "POST") {
        faults.prompts++
        const response = await fetch(input, init)
        if (faults.losePrompt) {
          faults.losePrompt = false
          await response.arrayBuffer()
          throw new Error("injected prompt response loss after native consumption")
        }
        return response
      }
      return fetch(input, init)
    },
  })
  /** Cut the SDK's stream and refuse to reopen it until the server reports the root execution ended. */
  async function gap(chat: Conversation, during: () => Promise<void>) {
    const released = Promise.withResolvers<void>()
    faults.hold = released.promise
    faults.sniffed = ""
    const before = faults.streams
    faults.cut!()
    await during()
    const nativeId = chat.state().nativeId!
    await until("the native execution to end during the gap", () => faults.sniffed.split(/\n\n/).some(block =>
      block.includes(nativeId) && /session\.execution\.(succeeded|failed|interrupted)/.test(block))).catch(error => {
      throw new Error(`${error.message}; sniffed ${faults.sniffed.length} bytes: ${faults.sniffed.slice(-1500)}`)
    })
    released.resolve()
    await until("the driver to resubscribe", () => faults.streams > before)
  }

  const lossy = conversation()
  chats.push(lossy.id)
  const lossyDriverChat = lossy
  await faulty.start(work, { conversationId: lossy.id, emit: lossy.emit, tuning: { model }, modeId: accessModeId("ask") })
  {
    const from = lossy.events.length
    const dispatch = promptDispatch()
    faults.losePrompt = true
    const prompts = faults.prompts
    await assert.rejects(faulty.prompt(lossy.id, "Reply with exactly the word survived.", [], undefined, dispatch), (error: Error) => String(error.cause).includes("injected prompt response loss"))
    const state = await until("the turn whose response was lost", () => lossy.state().status !== "running" && lossy.state()).catch(error => {
      throw new Error(`${error.message}\nnative stream tail:\n${nativeTail.replace(/data: \{"type":"session\.(text|reasoning)\.delta"[^\n]*\n/g, "")}`)
    })
    assert.equal(state.lastStop, "end_turn", state.error)
    assert.equal(faults.prompts, prompts + 1, "the lost send is never repeated")
    const submitted = dispatch.reports.find(evidence => evidence.kind === "submitted")
    assert.ok(submitted?.kind === "submitted")
    assert.ok(dispatch.reports.some(evidence => evidence.kind === "accepted" && evidence.source === "native-echo" && evidence.referenceId === submitted.correlationId),
      "the enqueue echo proves acceptance without the response")
    const prose = lossy.events.slice(from).flatMap(event => event.type === "live-updates" ? event.updates : event.type === "live-update" ? [event.update] : [])
      .flatMap(update => update.kind === "text" ? [update.text] : []).join("")
    assert.match(prose, /survived/i)
    report.cases.push("lost prompt response: the native echo accepts the send, the turn completes, nothing is resent")
  }
  {
    const from = lossy.events.length
    await faulty.prompt(lossy.id, "Reply with exactly the word gap.", [], undefined, promptDispatch())
    await gap(lossyDriverChat, async () => {})
    const state = await until("the turn that ended during the gap", () => lossy.state().status !== "running" && lossy.state())
    assert.equal(state.lastStop, "end_turn", state.error)
    assert.ok(lossy.events.slice(from).some(event => event.type === "live-session" && event.session.status === "running"))
    report.cases.push("stream gap across a whole turn: reconnect reconciliation reads the native outcome and ends the turn")
  }
  {
    const from = lossy.events.length
    await faulty.prompt(lossy.id, `Use the bash tool to run exactly: echo gap-${marker}`, [], undefined, promptDispatch())
    const asked = await until("a permission before the gap", () => lossy.events.slice(from).flatMap(event => event.type === "live-permission" ? [event.request] : [])[0])
    await gap(lossyDriverChat, async () => {
      const dispatch = approvalDispatch()
      await faulty.permission(lossy.id, asked.id, { kind: "choice", optionId: "once" }, dispatch)
      assert.deepEqual(dispatch.reports, [{ kind: "submitted", source: "transport-write" }])
    })
    const state = await until("the turn after an answered gap", () => lossy.state().status !== "running" && lossy.state())
    assert.equal(state.lastStop, "end_turn", state.error)
    await until("the request to end", () => lossy.events.slice(from).some(event => event.type === "live-permission-ended" && event.requestId === asked.id && event.source === "native-resolution"))
    report.cases.push("stream gap with a pending permission: the answer lands, reconciliation ends the request natively and the turn")
  }
  await faulty.close(lossy.id)

  report.passed = true
} finally {
  for (const id of chats) await driver.close(id).catch(() => {})
  await rm(root, { recursive: true, force: true })
  if (process.env.MAKO_PROOF_OUTPUT) await writeFile(process.env.MAKO_PROOF_OUTPUT, JSON.stringify(report, null, 2) + "\n")
}
console.log(`OpenCode live driver (${model}): ${report.cases.length} real cases passed\n- ${report.cases.join("\n- ")}`)
