/** Opt-in real-provider check. Runs the normal web host with isolated app data and Git files. */
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "vite"
import { webHostProxy } from "../electron/web-dev-proxy.mjs"

const repository = resolve(import.meta.dirname, "..")
const root = await mkdtemp(join(tmpdir(), "mako-rewind-e2e-"))
const userData = join(root, "user-data")
const cwd = join(root, "workspace")
await Promise.all([mkdir(userData), mkdir(cwd)])
for (const name of [
  "node_modules",
  "dist-electron",
  "dist-browser-extension",
  "mako-icons",
])
  await symlink(join(repository, name), join(root, name), "dir")
await writeFile(
  join(root, "package.json"),
  JSON.stringify({
    name: "mako-rewind-verification",
    type: "module",
    main: "bootstrap.mjs",
  })
)
await writeFile(
  join(root, "bootstrap.mjs"),
  `import { app } from 'electron';
app.setPath('userData', ${JSON.stringify(userData)});
await import(${JSON.stringify(pathToFileURL(join(repository, "dist-electron/main.js")).href)});
`
)
const git = (...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
git("init", "-q")
git("config", "user.name", "Mako verification")
git("config", "user.email", "test@localhost")
await writeFile(join(cwd, "checkpoint.txt"), "initial\n")
git("add", ".")
git("commit", "-qm", "Disposable checkpoint fixture")
const socket = join(root, "host.sock")
const server = await createServer({
  root: repository,
  cacheDir: join(root, "vite-cache"),
  plugins: [webHostProxy(socket)],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.MAKO_REWIND_PORT ?? 5184),
    strictPort: true,
  },
})
await server.listen()
const url = server.resolvedUrls.local[0]
const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: url,
  MAKO_WEB_SOCKET: socket,
}
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(join(repository, "node_modules/.bin/electron"), [root], {
  cwd: repository,
  env,
  stdio: ["ignore", "pipe", "pipe"],
})
const chunks = []
child.stdout.on("data", (chunk) => {
  chunks.push(chunk)
  if (chunks.length > 300) chunks.shift()
})
child.stderr.on("data", (chunk) => {
  chunks.push(chunk)
  if (chunks.length > 300) chunks.shift()
})
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  child.kill("SIGTERM")
  await server.close()
  await writeFile(join(root, "host.log"), Buffer.concat(chunks))
}
process.once("SIGINT", () => void stop())
process.once("SIGTERM", () => void stop())
async function rpc(channel, ...args) {
  const response = await fetch(new URL("/__mako/rpc", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new URL(url).origin,
      "sec-fetch-site": "same-origin",
      "x-mako-client": "web",
    },
    body: JSON.stringify({
      channel,
      args: args.map((value) =>
        value === undefined ? { kind: "absent" } : { kind: "value", value }
      ),
    }),
  })
  if (!response.ok) throw new Error(`Host HTTP ${response.status}`)
  const result = await response.json()
  if (!result.ok) throw new Error(result.error)
  return result.value
}
async function until(read, predicate, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (await predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error("Timed out waiting for provider/checkpoint")
}
try {
  await until(
    () =>
      rpc("mako:live-snapshot", randomUUID()).then(
        () => true,
        () => false
      ),
    Boolean,
    60_000
  )
  const id = randomUUID()
  const provider = process.env.MAKO_REWIND_PROVIDER ?? "codex"
  await rpc("mako:live-start", provider, cwd, {
    conversationId: id,
    title: "Checkpoint end-to-end verification",
  })
  const requestIds = []
  const controls = process.argv.includes("--controls")
  const marker = `CONTROL_${randomUUID()}`
  let steeringResult
  let steeringTask
  for (const word of ["first", "second"]) {
    const requestId = randomUUID()
    requestIds.push(requestId)
    await rpc(
      "mako:live-prompt",
      id,
      requestId,
      `Write exactly "${word} checkpoint" followed by a newline to checkpoint.txt in the current directory. Use the Write file tool directly, not a shell command. Change no other file. Reply exactly ${word.toUpperCase()}_DONE.`,
      []
    )
    const completed = await until(
      () => rpc("mako:live-snapshot", id),
      async (snapshot) => {
        const request = snapshot.requests.find((item) => item.id === requestId)
        if (["failed", "uncertain", "interrupted"].includes(request?.status))
          throw new Error(request.error ?? request.status)
        if (
          controls &&
          word === "first" &&
          !steeringTask &&
          request?.nativeRun &&
          snapshot.session.status === "running"
        ) {
          steeringTask = rpc("mako:live-action", id, {
            kind: "steer",
            id: randomUUID(),
            requestId,
            text: `Keep the file-writing task unchanged. Replace the final reply instruction: reply FIRST_DONE followed by ${marker}. Remember this marker for later.`,
            attachments: [],
          }).then(
            (result) => ({ result }),
            (error) => ({ error: String(error) })
          )
        }
        for (const permission of snapshot.permissions) {
          const once = permission.options.find(
            (option) => option.kind === "allow_once"
          )
          const paths = [
            join(cwd, "checkpoint.txt"),
            await realpath(join(cwd, "checkpoint.txt")),
          ]
          const fileTool = snapshot.blocks.some(
            (block) =>
              block.type === "tool" &&
              ["read", "write", "edit"].includes(
                (block.name ?? block.toolKind)?.toLowerCase()
              ) &&
              ["pending", "running", "in_progress"].includes(block.status) &&
              paths.some((path) => block.input?.includes(path))
          )
          const allowedCommands = new Set(
            paths.flatMap((path) => [
              `printf '${word} checkpoint\\n' > ${path}`,
              `printf '${word} checkpoint\\\\n' > ${path}`,
            ])
          )
          const fixtureCommand = snapshot.blocks.some((block) => {
            if (
              block.type !== "tool" ||
              !["execute", "bash"].includes((block.name ?? block.toolKind)?.toLowerCase()) ||
              !["pending", "running", "in_progress"].includes(block.status) ||
              !block.input
            )
              return false
            try {
              return allowedCommands.has(JSON.parse(block.input).command)
            } catch {
              return false
            }
          })
          if (!once || (!fileTool && !fixtureCommand))
            throw new Error(
              `Unapproved test permission: ${permission.title}; ${JSON.stringify(snapshot.blocks.filter((block) => block.type === "tool").slice(-1))}`
            )
          await rpc("mako:live-permission", id, permission.id, {
            kind: "choice",
            optionId: once.optionId,
          })
        }
        return request?.snapshots?.after !== undefined
      }
    )
    const request = completed.requests.find((item) => item.id === requestId)
    assert.equal(
      request.snapshots.after.kind,
      "ready",
      JSON.stringify(request.snapshots.after)
    )
    assert.equal(
      await readFile(join(cwd, "checkpoint.txt"), "utf8"),
      `${word} checkpoint\n`
    )
    if (controls && word === "first") {
      assert.ok(steeringTask, "Steering must reach an active turn")
      steeringResult = await steeringTask
      assert.equal(
        steeringResult.result?.state.kind,
        "accepted",
        JSON.stringify(steeringResult)
      )
      assert.ok(
        completed.blocks.some(
          (block) => block.type === "text" && block.text.includes(marker)
        ),
        "Model must actually receive steering"
      )
      console.log(
        `${provider}: steering receipt and model acknowledgement verified`
      )
    }
    console.log(`${provider}: ${word} turn and workspace checkpoint verified`)
  }
  const preview = await rpc("mako:live-rewind-preview", id, requestIds[0])
  assert.deepEqual(preview.changedFiles, ["checkpoint.txt"])
  const result = await rpc("mako:live-rewind", id, {
    id: randomUUID(),
    requestId: requestIds[0],
    expectedId: preview.current.id,
  })
  assert.equal(
    await readFile(join(cwd, "checkpoint.txt"), "utf8"),
    "first checkpoint\n"
  )
  assert.equal(result.session.connection, "disconnected")
  const original = await rpc("mako:live-snapshot", id)
  assert.equal(original.requests.length, 2)
  if (controls) {
    if (process.argv.includes("--compact")) {
      const compactId = randomUUID()
      await rpc("mako:live-action", id, { kind: "compact", id: compactId })
      await until(
        () => rpc("mako:live-snapshot", id),
        (snapshot) => {
          const receipt = snapshot.control.actions.find(
            (action) => action.input.id === compactId
          )
          if (receipt?.state.kind === "uncertain")
            throw new Error(JSON.stringify(receipt.state))
          return (
            receipt?.state.kind === "completed" &&
            snapshot.session.status === "ready"
          )
        },
        180_000
      )
    }
    const { defaultCatalog } = await import("@mako/sessions")
    const catalog = defaultCatalog()
    const refs = await catalog.scan()
    const nativeRef = refs.find(
      (ref) =>
        ref.harness === provider && ref.nativeId === original.session.nativeId
    )
    assert.ok(nativeRef, "Native session must be discoverable")
    await rpc("mako:live-bind", id, nativeRef.path)
    const checkpointed = await until(
      () => rpc("mako:live-snapshot", id),
      (snapshot) =>
        snapshot.control.bindings.some(
          (binding) =>
            binding.nativeId === original.session.nativeId && binding.checkpoint
        )
    )
    assert.ok(checkpointed)
    await rpc("mako:live-close", id)
    const closed = await rpc("mako:live-snapshot", id)
    const binding = closed.control.bindings.find(
      (binding) => binding.nativeId === original.session.nativeId
    )
    const { assessProviderResume } =
      await import("../dist-electron/provider-recovery.js")
    const { resumable } = await import("../dist-electron/contracts/conversation-control.js")
    const { providerHost } = await import("../dist-electron/providers/index.js")
    await until(
      async () => resumable(await assessProviderResume(binding, providerHost.liveDrivers.get(provider)), "same"),
      Boolean,
      30_000
    )
    const resumedRequest = randomUUID()
    await rpc(
      "mako:live-prompt",
      id,
      resumedRequest,
      "What was the CONTROL_ marker I gave you earlier? Reply with that exact marker only. Use no tools and change no files.",
      []
    )
    const resumed = await until(
      () => rpc("mako:live-snapshot", id),
      (snapshot) => {
        const request = snapshot.requests.find(
          (item) => item.id === resumedRequest
        )
        if (["failed", "uncertain", "interrupted"].includes(request?.status))
          throw new Error(request.error ?? request.status)
        if (snapshot.permissions.length)
          throw new Error("Unexpected permission during recall")
        return request?.snapshots?.after !== undefined
      }
    )
    assert.equal(resumed.session.nativeId, original.session.nativeId)
    const recallIndex = resumed.blocks.findIndex(
      (block) => block.type === "user" && block.requestId === resumedRequest
    )
    assert.ok(recallIndex >= 0)
    assert.equal(
      resumed.blocks
        .slice(recallIndex + 1)
        .filter((block) => block.type === "text")
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n"),
      marker,
      "Native resume must recall the marker exactly once"
    )
    console.log(
      `${provider}: native resume with history recall verified (compaction: ${process.argv.includes("--compact")})`
    )
  }
  // Leave a second-change file for reviewing and exercising the real UI dialog.
  if (process.argv.includes("--serve"))
    await writeFile(join(cwd, "checkpoint.txt"), "second checkpoint\n")
  const report = {
    url,
    root,
    cwd,
    provider,
    sourceId: id,
    forkId: result.session.id,
    requestIds,
    controls,
    compaction: process.argv.includes("--compact"),
    steeringResult,
    preview,
    checkedAt: new Date().toISOString(),
  }
  await writeFile(
    join(root, "result.json"),
    JSON.stringify(report, null, 2) + "\n"
  )
  console.log(
    `PASS: real ${provider} run, checkpoint, preview, file restore and idle conversation fork`
  )
  console.log(JSON.stringify({ url, result: join(root, "result.json"), cwd }))
  if (!process.argv.includes("--serve")) await stop()
} catch (error) {
  console.error(error)
  await stop()
  console.error(`Host log: ${join(root, "host.log")}`)
  process.exitCode = 1
}
