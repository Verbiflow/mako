/**
 * The OpenCode requests Mako sends that `harness:decode-pairs` doesn't, run
 * through Mako's own client against one OpenCode executable in a sealed home:
 * adding an MCP server, a slash command, forking whole and before a message,
 * and a form's state around its cancel. No model answers; the provider points
 * at a closed port. Use it on an older release to check what `legacy-api.ts`
 * says of it:
 *
 *   npm run probe:opencode-api -- /path/to/opencode
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOpenCodeApi } from "@mako/host/harnesses/opencode/native-api"
import { OpenCodeServers } from "@mako/host/harnesses/opencode/servers"
import { ProviderLaunchTrace } from "@mako/host/harnesses/provider-launch"

const command = process.argv[2]
if (!command) throw new Error("Usage: npm run probe:opencode-api -- <opencode executable>")
const home = await mkdtemp(join(tmpdir(), "mako-opencode-api-"))
const project = join(home, "project")
await mkdir(project)
execFileSync("git", ["init", "-q", project])
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { anthropic: { options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "unused" } } } }),
}
const api = await startOpenCodeApi({
  servers: new OpenCodeServers(), command, cwd: project, env, conversationId: "probe-opencode-api",
  trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "probe-opencode-api" }, { report() {} }),
})
const location = { directory: project }
try {
  console.log(`OpenCode ${api.info.version}`)
  await api.client.mcp.add({ server: "probe", location, config: { type: "local", command: ["/usr/bin/true"] } })
  console.log("  mcp.add: added")
  const session = await api.client.session.create({ location })
  // An unknown name proves the server read the name; a misnamed field would be refused as a payload.
  await assert.rejects(api.client.session.command({ sessionID: session.id, name: "no-such-command", text: "" }), { name: "CommandNotFoundError" })
  console.log("  session.command: the server looked the name up")
  await api.client.session.prompt({ sessionID: session.id, text: "hello" })
  const messages = await api.client.message.list({ sessionID: session.id, order: "asc", limit: 50 })
  const user = messages.data.find(message => message.type === "user")
  assert.ok(user, "the prompt left a user message")
  const whole = await api.client.session.fork({ sessionID: session.id })
  const before = await api.client.session.fork({ sessionID: session.id, before: user.id })
  assert.notEqual(whole.id, before.id)
  console.log("  session.fork: whole and before a message")
  const form = await api.client.session.form.create({ sessionID: session.id, title: "Pick", fields: [{ key: "pick", type: "string", title: "Pick" }] })
  assert.equal((await api.client.session.form.get({ sessionID: session.id, formID: form.id })).state.status, "pending")
  await api.client.session.form.cancel({ sessionID: session.id, formID: form.id })
  assert.equal((await api.client.session.form.get({ sessionID: session.id, formID: form.id })).state.status, "cancelled")
  console.log("  session.form: pending, cancelled")
} finally {
  await api.close()
  await rm(home, { recursive: true, force: true })
}
