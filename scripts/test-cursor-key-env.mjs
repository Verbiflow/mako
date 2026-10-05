import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { build } from "esbuild"

// The production Cursor child, with an SDK stand-in that spawns tools the way
// SDK 1.0.31 does. The account's key must reach every SDK call by name and
// never the environment an agent's shell or MCP server inherits.
const KEY = "mako-fixture-cursor-key-must-not-reach-tools"
const root = await mkdtemp(join(tmpdir(), "mako-cursor-key-env-"))
const entry = join(process.cwd(), "node_modules/.tmp/cursor-key-env-child.mjs")
const children = []
try {
  await build({ entryPoints: ["electron/providers/cursor/sdk/child.ts"], outfile: entry, platform: "node", format: "esm", bundle: true, packages: "external", logLevel: "silent", plugins: [{ name: "env-sdk", setup(build) { build.onResolve({ filter: /^@cursor\/sdk$/ }, () => ({ path: join(process.cwd(), "scripts/fixtures/cursor-env-sdk.mjs") })) } }] })
  const env = { PATH: process.env.PATH, HOME: root, NODE_OPTIONS: "", CURSOR_API_KEY: KEY }
  const traced = async cwd => (await readFile(join(cwd, "trace"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  const assertClean = (events, mode) => {
    const tools = events.filter(event => event.event === "tool-env")
    assert.ok(tools.length > 0, `${mode}: the agent ran a tool`)
    for (const { value } of tools) {
      assert.equal(value.CURSOR_API_KEY, undefined, `${mode}: a tool inherited CURSOR_API_KEY`)
      assert.ok(!JSON.stringify(value).includes(KEY), `${mode}: the key reached a tool's environment under another name`)
    }
    for (const event of events.filter(event => event.event !== "tool-env"))
      assert.equal(event.value, KEY, `${mode}: ${event.event} must sign with the account's key`)
  }

  const live = join(root, "live")
  await mkdir(live)
  const child = spawn(process.execPath, [entry], { cwd: live, env, stdio: ["pipe", "pipe", "pipe"] })
  children.push(child)
  let stderr = ""
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk })
  const replies = new Map()
  let finished
  const turnEnded = new Promise(resolve => { finished = resolve })
  createInterface({ input: child.stdout }).on("line", line => {
    const value = JSON.parse(line)
    if (value.id !== undefined) replies.get(value.id)?.(value)
    if (value.event === "result") finished()
  })
  let next = 0
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 15_000)
    replies.set(id, value => { clearTimeout(timer); replies.delete(id); resolve(value) })
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n")
  })
  assert.equal((await request("hello")).ok, true, stderr)
  const status = await request("authStatus")
  assert.equal(status.result.status, "logged-in", "a key handed in still signs the account in")
  assert.equal((await request("me")).ok, true)
  assert.equal((await request("models")).ok, true)
  assert.equal((await request("open", { cwd: live, stateRoot: live, agentId: "key-env-live", create: true, model: { id: "composer-2" } })).ok, true, stderr)
  assert.equal((await request("send", { turn: "key-env-turn", text: "print the environment" })).ok, true, stderr)
  await Promise.race([turnEnded, new Promise(resolve => setTimeout(resolve, 2_000))])
  await request("close")
  child.stdin.end()
  const liveEvents = await traced(live)
  assert.deepEqual(liveEvents.map(event => event.event).filter(name => name !== "tool-env"), ["me", "me", "models", "open"])
  assertClean(liveEvents, "live")
  assert.ok(!stderr.includes(KEY), "the child never prints the key")

  const headless = join(root, "headless")
  await mkdir(headless)
  const spec = { stateRoot: headless, agentId: "key-env-headless", create: true, model: { id: "composer-2" }, prompt: "print the environment" }
  const oneShot = spawn(process.execPath, [entry, "--headless", JSON.stringify(spec)], { cwd: headless, env, stdio: ["ignore", "pipe", "pipe"] })
  children.push(oneShot)
  let output = ""
  oneShot.stdout.setEncoding("utf8").on("data", chunk => { output += chunk })
  oneShot.stderr.setEncoding("utf8").on("data", chunk => { output += chunk })
  const code = await new Promise(resolve => oneShot.once("close", resolve))
  assert.equal(code, 0, output)
  assertClean(await traced(headless), "headless")
  assert.ok(!output.includes(KEY), "the headless child never prints the key")

  console.log(JSON.stringify({ scope: "production Cursor child, SDK stand-in spawning tools from process.env", modes: ["live", "headless"], keyInToolEnv: false, sdkCallsSigned: true }))
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  await rm(root, { recursive: true, force: true })
}
