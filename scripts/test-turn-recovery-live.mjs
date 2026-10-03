import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

// Real harnesses through the real host: the provider process Mako spawned is
// killed while the agent runs a shell command, and the conversation must come
// back on its own, finish the turn, and send nothing more. Uses each
// provider's installed CLI and sign-in, so it spends a few model calls:
//   npm run test:turn-recovery-live -- codex claude cursor grok devin
if (!process.versions.electron) {
  const root = await mkdtemp(join(tmpdir(), "mako-turn-recovery-live-"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-turn-recovery-live", main: fileURLToPath(import.meta.url) }))
  const providers = process.argv.slice(2).filter((argument) => !argument.startsWith("-"))
  const env = {
    ...process.env,
    MAKO_RECOVERY_ROOT: root,
    MAKO_REPO: resolve("."),
    MAKO_RECOVERY_PROVIDERS: (providers.length ? providers : ["codex", "claude", "cursor", "grok", "devin"]).join(","),
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  const deadline = setTimeout(() => child.kill("SIGTERM"), 20 * 60_000)
  const [code] = await once(child, "exit")
  clearTimeout(deadline)
  await rm(root, { recursive: true, force: true })
  process.exitCode = code ?? 1
} else {
  const { app } = await import("electron")
  void main().then(() => app.exit(0), (error) => {
    console.error(error)
    app.exit(1)
  })
}

/** Every process as pid → { ppid, command }. */
function processes() {
  const table = new Map()
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] })
  }
  return table
}

/** The child of this process that a command naming `marker` runs under, while it runs. */
function runningUnderUs(marker) {
  const table = processes()
  for (const [pid, entry] of table) {
    if (!entry.command.includes(marker)) continue
    for (let at = pid, guard = 0; at > 1 && guard < 32; at = table.get(at)?.ppid ?? 0, guard += 1)
      if (table.get(at)?.ppid === process.pid) return { provider: at, command: pid, name: table.get(at)?.command.slice(0, 120) }
  }
  return undefined
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
  const root = process.env.MAKO_RECOVERY_ROOT
  const repo = process.env.MAKO_REPO
  app.setPath("userData", join(root, "profile"))
  await app.whenReady()
  const { providerHost } = await import(join(repo, "dist-electron/providers/index.js"))
  const { LiveConversations } = await import(join(repo, "dist-electron/live-conversations.js"))
  const { assessProviderResume } = await import(join(repo, "dist-electron/provider-recovery.js"))
  const { bindCodexApp } = await import(join(repo, "dist-electron/codex-app.js"))
  const { nativePathForSession } = await import(join(repo, "dist-electron/threads.js"))
  const { installHostLog } = await import(join(repo, "dist-electron/host-log.js"))
  const log = join(root, "profile", "logs", "host.log")
  installHostLog(log)
  const owner = new LiveConversations({
    appPath: app.getAppPath(),
    root: join(root, "conversations"),
    driver: (provider) => providerHost.liveDrivers.get(provider),
    history: async () => null,
    emit: () => {},
    mcpSnapshot: async (cwd) => ({ cwd, generatedAt: Date.now(), servers: [], providers: [] }),
    nativePath: nativePathForSession,
    resumeVerdict: binding => assessProviderResume(binding, providerHost.liveDrivers.get(binding.provider)),
  })
  bindCodexApp((event) => owner.observe(event))
  const failures = []
  try {
    for (const provider of process.env.MAKO_RECOVERY_PROVIDERS.split(",")) {
      try {
        await recover(owner, providerHost.liveDrivers.get(provider), provider, root, app.getAppPath())
        console.log(`PASS ${provider}: killed mid-command, reopened on its native session, finished the turn with one continuation`)
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
  if (failures.length) throw new Error(`turn recovery failed for ${failures.join(", ")}`)
}

async function recover(owner, driver, provider, root, appPath) {
  assert.ok(driver, `${provider} is not a registered live driver`)
  assert.ok(driver.available(appPath), `${provider} is not installed`)
  const cwd = join(root, `work-${provider}`)
  await mkdir(cwd, { recursive: true })
  const nonce = randomUUID().slice(0, 8)
  // A timer rather than `sleep`, which Claude Code refuses to run in the foreground.
  const command = `node -e "setTimeout(() => console.log('recovered-' + 6 * 7 + '-${nonce}'), 45000)"`
  const token = `recovered-${6 * 7}-${nonce}`
  const id = randomUUID()
  const options = { conversationId: id }
  const full = driver.modes?.find((mode) => mode.access === "full")
  if (full) options.modeId = full.id
  await owner.start(provider, cwd, options)
  const snapshot = () => owner.snapshot(id)
  const requests = () => snapshot()?.requests ?? []
  const describe = () => JSON.stringify({
    session: { status: snapshot()?.session.status, connection: snapshot()?.session.connection, error: snapshot()?.session.error },
    requests: requests().map((request) => ({ status: request.status, interruption: request.interruption?.reason, scheduled: request.interruption?.autoContinue, continues: request.continues, evidence: request.nativeDelivery?.evidence.kind, error: request.error })),
    bindings: snapshot()?.control?.bindings.map((binding) => ({ provider: binding.provider, nativeId: binding.nativeId })),
    transfers: snapshot()?.control?.transfers.map((transfer) => transfer.state),
    permissions: snapshot()?.permissions.length,
    transcript: JSON.stringify(snapshot()?.blocks ?? []).slice(-1500),
  })
  const first = randomUUID()
  owner.submit(id, first,
    `Run this exact shell command in the foreground and wait for it to finish; it takes 45 seconds: \`${command}\`. ` +
    "Do not background it and do not run anything else. When it finishes, reply with only the line it printed.")

  // The command is running under the provider Mako spawned: kill that process.
  let target
  await until(`${provider} to run the command`, () => {
    if (requests()[0]?.status !== "dispatching" && requests()[0]?.status !== "queued") throw new Error(`the turn ended before the command ran: ${describe()}`)
    return (target = runningUnderUs(nonce)) !== undefined
  }, 180_000, describe)
  assert.equal(requests()[0]?.nativeDelivery?.evidence.kind, "accepted", `${provider} reported the prompt accepted before its turn ended`)
  process.kill(target.provider, "SIGKILL")
  console.log(`  ${provider}: killed pid ${target.provider} (${target.name}) while the command ran`)

  await until("the turn to settle as interrupted", () => requests()[0]?.status !== "dispatching", 30_000, describe)
  assert.equal(requests()[0]?.status, "interrupted", `the killed turn is continuable: ${describe()}`)
  assert.equal(requests()[0]?.interruption?.reason, "provider-exited", describe())
  await until("Mako to send the continuation", () => requests().length >= 2, 30_000, describe)
  const continuation = requests()[1]
  assert.deepEqual(continuation?.continues, { requestId: first, reason: "provider-exited", auto: true }, describe())
  await until("the continuation to finish", () => {
    const status = requests()[1]?.status
    return status === "completed" || status === "failed" || status === "interrupted" || status === "uncertain"
  }, 360_000, describe)
  assert.equal(requests()[1]?.status, "completed", `the continuation finished the turn: ${describe()}`)
  assert.ok(JSON.stringify(snapshot()?.blocks ?? []).includes(token), `the finished turn printed ${token}`)

  // Nothing more is sent once the turn is done.
  await delay(8_000)
  assert.equal(requests().length, 2, `no further continuation: ${describe()}`)
  assert.equal(snapshot()?.session.status, "ready", describe())
  for (const [pid, entry] of processes()) if (entry.command.includes(nonce)) process.kill(pid, "SIGKILL")
  await owner.close(id)
}
