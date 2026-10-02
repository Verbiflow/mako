import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-provider-turn-test-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-provider-turn-test", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_PROVIDER_TURN_ROOT: root, MAKO_REPO: resolve(".") }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  const deadline = setTimeout(() => child.kill("SIGTERM"), 30_000)
  const [code] = await once(child, "exit")
  clearTimeout(deadline)
  process.exitCode = code ?? 1
} else {
  const { app } = await import("electron")
  void check().then(() => app.exit(0), (error) => {
    console.error(error)
    app.exit(1)
  })
}

async function check() {
  const { app } = await import("electron")
  const root = process.env.MAKO_PROVIDER_TURN_ROOT
  const repo = process.env.MAKO_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { providerHost } = await import(join(repo, "dist-electron/providers/index.js"))
  const { grokAcpSource } = await import(join(repo, "dist-electron/providers/grok/acp.js"))
  const { devinAcpSource } = await import(join(repo, "dist-electron/providers/devin/acp.js"))
  const { liveStart, livePrompt, liveCancel, liveClose, liveCompact } = await import(join(repo, "dist-electron/acp.js"))
  const { advancePromptDelivery } = await import(join(repo, "dist-electron/contracts/prompt-delivery.js"))
  const { installHostLog } = await import(join(repo, "dist-electron/host-log.js"))
  const hostLogFile = join(root, "host.log")
  installHostLog(hostLogFile)
  // Sessions the agent has written to; a new session is not on disk until its first turn.
  const written = new Set()
  const fixture = (provider, source) => providerHost.acpSources.register({
    provider,
    canResume: false,
    locateSession: ({ nativeId }) => (written.has(nativeId) ? join(root, "located", nativeId) : undefined),
    available: () => true,
    providerTurns: source.providerTurns,
    decodeNotification: source.decodeNotification,
    mcpStartup: source.mcpStartup,
    observeAgents: source.observeAgents,
    compaction: source.compaction,
    clientCapabilities: source.clientCapabilities,
    launch: async () => ({
      command: process.execPath,
      args: [join(repo, "scripts/fixtures/acp-provider-turn-agent.mjs")],
      configureEnvironment(env) {
        env.ELECTRON_RUN_AS_NODE = "1"
        env.FIXTURE_PROVIDER = provider
      },
    }),
  })
  fixture("provider-turn-grok", grokAcpSource)
  fixture("provider-turn-devin", devinAcpSource)

  async function conversation(provider) {
    const id = randomUUID()
    const events = []
    await liveStart(provider, root, {
      conversationId: id,
      emit: (event) => events.push(event),
      mcpSnapshot: async () => ({ cwd: root, generatedAt: Date.now(), servers: [], providers: [] }),
    })
    const session = () => events.findLast((event) => event.type === "live-session")?.session
    const updates = () => events.flatMap((event) =>
      event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
    const until = async (label, predicate) => {
      for (let waited = 0; !predicate(); waited += 10) {
        if (waited > 5000) throw new Error(`Timed out waiting for ${label}; last status ${session()?.status}`)
        await delay(10)
      }
    }
    return {
      events, session, updates, until,
      markers: (label) => updates().filter((update) => update.kind === "event" && update.label === label).map((update) => update.detail),
      opened: () => updates().filter((update) => update.kind === "provider-turn"),
      statusesSince: (seen) => events.slice(seen).flatMap((event) => event.type === "live-session" ? [event.session.status] : []),
      async prompt(text) {
        await livePrompt(id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
        await until(`${text} to end`, () => session()?.status === "ready")
      },
      cancel: () => liveCancel(id),
      close: () => liveClose(id),
      compact: (actionId) => liveCompact(id, actionId),
    }
  }

  const grok = await conversation("provider-turn-grok")
  assert.deepEqual(grok.markers("MCP server failed"), ["crashes · could not connect"],
    "a server Grok reports failing before the session's id arrives is shown once the session opens")
  console.log("PASS: Grok's MCP startup failures said while the session opens reach it")
  await grok.prompt("self-started")
  const seen = grok.events.length
  await grok.until("the self-started turn", () => grok.opened().length === 1)
  await grok.until("the self-started turn to end", () => grok.session()?.status === "ready")
  assert.deepEqual(grok.opened(), [{ kind: "provider-turn", reason: 'Background command "Sleep briefly then print BG-DONE" completed (exit code 0)' }])
  assert.ok(grok.statusesSince(seen).includes("running"), "the turn Grok started itself shows as running")
  assert.equal(grok.session()?.lastStop, "completed")
  const turn = grok.updates().findIndex((update) => update.kind === "provider-turn")
  assert.ok(grok.updates().slice(turn).some((update) => update.kind === "text" && update.text.includes("BG-DONE")),
    "the reply belongs to the turn it opened")
  console.log("PASS: A turn Grok starts after a background command opens with its cause, runs, and ends on turn_completed")

  await grok.prompt("cancelled")
  await grok.until("the cancellable turn", () => grok.opened().length === 2 && grok.session()?.status === "running")
  await grok.cancel()
  await grok.until("the cancelled turn to end", () => grok.session()?.status === "ready")
  await delay(150)
  assert.equal(grok.opened().length, 2, "the thought chunk trailing a cancel opens no turn")
  assert.equal(grok.session()?.status, "ready")
  assert.equal(grok.session()?.lastStop, "interrupted")
  console.log("PASS: Stop ends a turn Grok started itself, and the chunk trailing the cancel stays with it")

  await grok.prompt("unannounced")
  await delay(150)
  assert.equal(grok.opened().length, 2, "output without an announced turn opens nothing")
  assert.equal(grok.session()?.status, "ready")
  console.log("PASS: Output Grok did not announce as a new turn opens nothing")

  const beforeCompact = grok.events.length
  const actionId = randomUUID()
  await grok.compact(actionId)
  const settled = () => grok.events.slice(beforeCompact).find((event) => event.type === "live-action-result" && event.actionId === actionId)
  await grok.until("the compaction to settle", () => settled() && grok.session()?.status === "ready")
  assert.deepEqual(settled().result, { kind: "completed" }, "Grok's own compaction notice confirms the /compact Mako sent")
  assert.deepEqual(grok.events.slice(beforeCompact).flatMap((event) => event.type === "live-update" && event.update.kind === "event" ? [event.update.detail] : []),
    ["Manual · 23k → 9k tokens"], "a compaction Mako asked for is labelled manual")
  assert.equal(grok.session()?.lastStop, "completed")
  console.log("PASS: Compact on Grok sends /compact and settles on Grok's own completion notice, marked manual")

  const beforeNative = grok.events.length
  await grok.prompt("native-grok")
  const since = (from) => grok.events.slice(from)
  assert.deepEqual(since(beforeNative).flatMap((event) => event.type === "live-activity" ? [event.activity] : []), [{ kind: "compacting" }, null],
    "Grok's auto-compaction shows while it runs and ends with its marker; another session's does not")
  assert.deepEqual(since(beforeNative).flatMap((event) => event.type === "live-update" && event.update.kind === "event" ? [event.update] : []),
    [{ kind: "event", label: "Context compacted", detail: "Automatic · 404k → 21k tokens · took 1m 34s" }])
  const titles = since(beforeNative).flatMap((event) => event.type === "live-session" && event.session.title ? [event.session.title] : [])
  // The SDK dispatches vendor notifications through more handlers than session
  // updates, so the two channels are not ordered against each other.
  assert.ok(titles.includes("Compacted fixture"), "Grok's generated title names the thread")
  assert.ok(titles.includes("Renamed by the agent"), "ACP's session_info_update names the thread")
  console.log("PASS: Grok's vendor notifications reach the conversation as activity, a marker and a title")

  const beforeRefused = grok.events.length
  await grok.prompt("refused-updates")
  await grok.until("the text after the refused updates", () => grok.updates().some((update) => update.kind === "text" && update.text === "Still streaming."))
  const refusedActivity = since(beforeRefused).flatMap((event) => event.type === "live-activity" ? [event.activity] : [])
  // The replayed completion ends compacting again; the host publishes a repeated report once.
  assert.deepEqual(refusedActivity, [{ kind: "compacting" }, null, null],
    "Grok's kinds on ACP's own method reach its decoder instead of being dropped by the SDK")
  assert.deepEqual(since(beforeRefused).flatMap((event) => event.type === "live-update" && event.update.kind === "event" ? [event.update] : []),
    [{ kind: "event", id: "fixture-2", label: "Context compacted", detail: "Automatic · 1k → 200 tokens · took 4s" }],
    "the replayed completion, named by Grok's event id, is drawn once")
  const logged = await readFile(hostLogFile, "utf8")
  assert.match(logged, /native event not handled.*kind=session\/update\/mystery_update/, "an undeclared kind is on record")
  assert.match(logged, /native event not handled.*kind=session\/update\/tool_call\/invalid/, "a malformed known kind is on record under its own name")
  assert.doesNotMatch(logged, /Error handling notification/, "the SDK never sees, or prints, an update it would refuse")
  console.log("PASS: session/update the ACP SDK would refuse reaches the provider's decoder or the unknown-event log, and a replayed marker is drawn once")
  await grok.close()

  const devin = await conversation("provider-turn-devin")
  assert.deepEqual(devin.markers("MCP server failed"), ["missing · could not be launched", "crashes · could not connect"],
    "lines with no session yet and Devin's second copy of each failure leave one marker per server")
  assert.deepEqual(devin.markers("Warning"), [], "no generic warnings beside them")
  console.log("PASS: Devin's MCP startup failures said while the session opens reach it once per server")
  await devin.prompt("devin-self-started")
  const devinSeen = devin.events.length
  await devin.until("the turn Devin starts on the finished subagent", () => devin.opened().length === 1)
  await devin.until("that turn to end", () => devin.session()?.status === "ready")
  assert.deepEqual(devin.opened(), [{ kind: "provider-turn", reason: 'Subagent "Run the checks" completed' }])
  assert.ok(devin.statusesSince(devinSeen).includes("running"), "the turn Devin started itself shows as running")
  assert.equal(devin.session()?.lastStop, "completed")
  const opener = devin.updates().findIndex((update) => update.kind === "provider-turn")
  const texts = (from, to) => devin.updates().slice(from, to).filter((update) => update.kind === "text").map((update) => update.text).join("")
  assert.ok(texts(opener).includes("The checks passed."), "the reply belongs to the turn it opened")
  assert.ok(!texts(0).includes("All checks passed."), "the subagent's own text stays out of the parent's turns")
  console.log("PASS: A turn Devin starts after a background subagent opens with its cause, runs, and ends on agent_stopped")

  await devin.prompt("devin-self-cancelled")
  await devin.until("the cancellable turn", () => devin.opened().length === 2 && devin.session()?.status === "running")
  await devin.cancel()
  await devin.until("the cancelled turn to end", () => devin.session()?.status === "ready")
  assert.equal(devin.session()?.lastStop, "interrupted")
  console.log("PASS: Stop ends a turn Devin started itself")

  await devin.prompt("devin-subagent-stopped")
  await devin.cancel()
  await delay(200)
  assert.equal(devin.opened().length, 2, "a subagent Stop ended opens no turn")
  assert.equal(devin.session()?.status, "ready")
  await devin.prompt("unannounced")
  await delay(150)
  assert.equal(devin.opened().length, 2, "the ended announcement does not open a later turn")
  console.log("PASS: Stopping Devin's background subagent opens no turn, and leaves no announcement behind")

  const beforeDevinNative = devin.events.length
  await devin.prompt("native-devin")
  const devinSince = devin.events.slice(beforeDevinNative)
  assert.deepEqual(devinSince.flatMap((event) => event.type === "live-activity" ? [event.activity] : []),
    [{ kind: "retrying", attempt: 1, maxAttempts: 5, reason: "Stream interrupted" }])
  assert.deepEqual(devinSince.flatMap((event) => event.type === "live-update" && event.update.kind === "event" ? [event.update] : []),
    [{ kind: "event", label: "Turn failed", detail: "Quota exhausted", body: "You have used all of your credits.", tone: "error" }])
  assert.equal(devin.opened().length, 2, "a failed prompted turn opens no provider turn")
  console.log("PASS: Devin's connection retry and quota stop reach the conversation as activity and a failure marker")
  await devin.close()

  // The agent's first output is the prompt's receipt, and a process that dies
  // before answering reports the turn failed and disconnected in one update,
  // so the host continues it rather than recording a provider failure.
  const exiting = await conversation("provider-turn-grok")
  assert.equal(exiting.session().nativePath, undefined, "a new session has no source yet")
  written.add(exiting.session().nativeId)
  const reports = []
  const before = exiting.events.length
  await livePrompt(exiting.session().id, "exits-mid-turn", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: (evidence) => reports.push(evidence) })
  await exiting.until("the process exit", () => exiting.session()?.connection === "disconnected")
  assert.deepEqual(reports.slice(0, 2).map((evidence) => evidence.kind), ["submitted", "accepted"], "the first output accepted the prompt")
  assert.equal(reports[1].source, "native-echo")
  assert.equal(reports.reduce(advancePromptDelivery, { kind: "prepared" }).kind, "accepted", "the dead connection's late error cannot undo the receipt")
  const ended = exiting.events.slice(before).flatMap((event) => event.type === "live-session" && event.session.status !== "running" ? [event.session] : [])
  assert.equal(ended[0]?.status, "failed")
  assert.equal(ended[0]?.connection, "disconnected", "the turn ends with the disconnect, not as a failure of a connected provider")
  assert.equal(ended[0]?.nativePath, join(root, "located", exiting.session().nativeId),
    "the same update names the session's source, so the host can resume it before the thread list has indexed it")
  console.log("PASS: An ACP agent's first output accepts the prompt, and its process dying mid-turn ends the turn disconnected in one update that locates the session")
}
