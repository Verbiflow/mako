import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

// A handoff of a conversation whose turn ended but left a command running in the background, against the real
// harness and its sign-in: the handoff stops the command and names it, the provider process goes as it does when a
// Thread leaves, and Mako's continuation must run as a turn of its own in the reopened session, the agent answering
// it, whatever the harness does about the command it finds stopped. Spends a few model calls:
//   npm run test:handoff-background-live -- claude
if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-handoff-background-live-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-handoff-background-live", main: fileURLToPath(import.meta.url) }))
  const providers = process.argv.slice(2).filter((argument) => !argument.startsWith("-"))
  // A person of its own (`scratchHostHome`): the harnesses keep their sessions in `<root>/home`, never in the person's stores.
  const { env: scratch, dispose } = (await import("./scratch-harness-home.ts")).scratchHostHome(root)
  const env = { ...scratch, MAKO_HANDOFF_ROOT: root, MAKO_REPO: resolve("."), MAKO_HANDOFF_PROVIDERS: (providers.length ? providers : ["claude"]).join(",") }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  const deadline = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000)
  const [code] = await once(child, "exit")
  clearTimeout(deadline)
  // The sessions it made are in its scratch home, which goes with it, whether it passed or not.
  dispose()
  await rm(root, { recursive: true, force: true })
  process.exitCode = code ?? 1
} else {
  const { app } = await import("electron")
  void main().then(() => app.exit(0), (error) => {
    console.error(error)
    app.exit(1)
  })
}

async function until(label, predicate, ms, detail = () => "") {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${label}; ${detail()}`)
    await delay(100)
  }
}

async function main() {
  const { app } = await import("electron")
  const root = process.env.MAKO_HANDOFF_ROOT
  const repo = process.env.MAKO_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { createHarnessHost, detachedHarnessContext } = await import(join(repo, "packages/host/dist/harnesses/harness-host.js"))
  const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))
  const { LiveConversations } = await import(join(repo, "packages/host/dist/conversations/live-conversations.js"))
  const { assessProviderResume } = await import(join(repo, "packages/host/dist/harnesses/provider-recovery.js"))
  const { nativeSessionPath } = await import("@mako/host/threads/native-source")
  const { installHostLog } = await import(join(repo, "packages/host/dist/base/host-log.js"))
  const log = join(root, "profile", "logs", "host.log")
  installHostLog(log)
  const owner = new LiveConversations({
    appPath: app.getAppPath(),
    root: join(root, "conversations"),
    driver: (provider) => providerHost.liveDrivers.get(provider),
    history: async () => null,
    emit: () => {},
    mcpSnapshot: async (cwd) => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
    nativePath: (session) => nativeSessionPath(session, []),
    resumeVerdict: (binding) => assessProviderResume(binding, providerHost.liveDrivers.get(binding.provider)),
  })
  const failures = []
  try {
    for (const provider of process.env.MAKO_HANDOFF_PROVIDERS.split(",")) {
      try {
        await handOff(owner, providerHost.liveDrivers.get(provider), provider, root, app.getAppPath())
        console.log(`PASS ${provider}: background work stopped and named, the provider reopened, and Mako's continuation answered as a turn of its own`)
      } catch (error) {
        failures.push(provider)
        console.error(`FAIL ${provider}:`, error)
        const lines = (await readFile(log, "utf8").catch(() => "")).split("\n")
        console.error(`host log (last 40 lines):\n${lines.slice(-40).join("\n")}`)
      }
    }
  } finally {
    owner.stop()
  }
  if (failures.length) throw new Error(`a handoff of background work failed for ${failures.join(", ")}`)
}

async function handOff(owner, driver, provider, root, appPath) {
  assert.ok(driver, `${provider} is not a registered live driver`)
  assert.ok(driver.available(appPath), `${provider} is not installed`)
  const cwd = join(root, `work-${provider}`)
  await mkdir(cwd, { recursive: true })
  const nonce = randomUUID().slice(0, 8)
  const command = `node -e "setTimeout(() => console.log('background-${nonce}'), 600000)"`
  const id = randomUUID()
  const options = { conversationId: id }
  const full = driver.modes?.find((mode) => mode.access === "full")
  if (full) options.modeId = full.id
  await owner.start(provider, cwd, options)
  const snapshot = () => owner.snapshot(id)
  const requests = () => snapshot()?.requests ?? []
  const describe = () => JSON.stringify({
    session: { status: snapshot()?.session.status, connection: snapshot()?.session.connection, background: snapshot()?.session.backgroundTasks, error: snapshot()?.session.error },
    roster: (snapshot()?.nativeAgents?.agents ?? []).map((agent) => ({ state: agent.state.kind, background: agent.background, detail: agent.detail })),
    requests: requests().map((request) => ({ id: request.id.slice(0, 8), status: request.status, continues: request.continues, error: request.error })),
    transcript: JSON.stringify(snapshot()?.blocks ?? []).slice(-1500),
  })

  // A turn that leaves its command running in the background, and ends.
  const first = randomUUID()
  owner.submit(id, first, `Start this shell command in the background (do not wait for it): \`${command}\`. Then reply with only the word STARTED.`)
  await until("the turn to end with its command in the background", () => requests()[0]?.status === "completed" && (snapshot()?.session.backgroundTasks ?? 0) > 0, 240_000, describe)

  // The handoff: the command stopped and named, the turn that left it to continue from.
  const paused = await owner.handOff(id)
  assert.equal(paused?.requestId, first, describe())
  assert.ok(paused.stopped.some((each) => each.includes(nonce)), `the stopped command is named: ${JSON.stringify(paused.stopped)}`)

  // The Thread leaves: its provider process goes (stopping the work may have ended it already), and the session
  // reopens where it lands.
  const gone = () => ["hibernated", "disconnected"].includes(snapshot()?.session.connection ?? "")
  if (!gone()) assert.ok(owner.hibernateIfIdle(id, "move"), `the conversation hibernates once its work stopped: ${describe()}`)
  await until("the provider to close", gone, 30_000, describe)

  const continuation = randomUUID()
  const before = (snapshot()?.blocks ?? []).length
  owner.continueTurn(id, { requestId: continuation, reason: "handed-off", continues: first, stopped: paused.stopped, actor: { kind: "service", name: "handoff" } })
  await until("the continuation to settle", () => {
    const status = requests().find((request) => request.id === continuation)?.status
    return status !== undefined && !["queued", "dispatching", "held"].includes(status)
  }, 300_000, describe)
  const settled = requests().find((request) => request.id === continuation)
  assert.equal(settled?.status, "completed", describe())
  // The agent answered Mako's continuation itself: prose after it, not only the harness's notice about the command.
  const after = (snapshot()?.blocks ?? []).slice(before)
  const answered = after.some((block) => block.type === "text" && String(block.text ?? "").trim().length > 0)
  assert.ok(answered, `the agent answered the continuation: ${describe()}`)
  await owner.close(id)
}
