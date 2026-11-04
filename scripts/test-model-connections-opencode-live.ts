import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { seedScratchHome } from "./scratch-harness-home.ts"
import { admitted } from "./fixtures/admitted-start.ts"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { memorySecrets } from "@mako/host/base/secrets"
import { ModelConnections, modelConnectionsPath, type ServedConnection } from "@mako/host/harnesses/model-connections"
import { openCodeAccountCapability } from "@mako/host/harnesses/opencode/accounts"
import { resolveOpenCodeInstallation, OpenCodeVersions } from "@mako/host/harnesses/opencode/installation"
import { createOpenCodeDriver } from "@mako/host/harnesses/opencode/live-driver"
import { discoverOpenCodeCatalog } from "@mako/host/harnesses/opencode/profile"
import { OpenCodeServers } from "@mako/host/harnesses/opencode/servers"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

/**
 * A connection added the way Add a connection adds one shows its models in
 * OpenCode's model list, and a turn on one of them reaches its endpoint with
 * its key. The installed OpenCode runs in a scratch home with no sign-in of
 * the person's; the endpoint is a stand-in on loopback that answers `/models`
 * and one streamed reply. With Ollama running on this Mac, a turn also runs on
 * its first model.
 */

const KEY = `fake-${randomUUID()}`
const ANSWER_MS = 60_000
const requests: Array<{ path: string; authorized: boolean }> = []

function chunk(delta: { role?: "assistant"; content?: string }, finish: "stop" | null = null) {
  return `data: ${JSON.stringify({ id: "stand-in", object: "chat.completion.chunk", created: 1, model: "stand-in-coder", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
}

const server = createServer((request: IncomingMessage, response) => {
  requests.push({ path: `${request.method} ${request.url}`, authorized: request.headers.authorization === `Bearer ${KEY}` })
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    request.resume()
    response.setHeader("content-type", "text/event-stream")
    response.write(chunk({ role: "assistant", content: "ok" }))
    response.write(chunk({}, "stop"))
    response.write(`data: ${JSON.stringify({ id: "stand-in", object: "chat.completion.chunk", created: 1, model: "stand-in-coder", choices: [], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`)
    response.end("data: [DONE]\n\n")
    return
  }
  if (request.url === "/v1/models") {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ object: "list", data: [{ id: "stand-in-coder", name: "Stand-in Coder", context_length: 32_768 }, { id: "stand-in-small" }] }))
    return
  }
  response.statusCode = 404
  response.end()
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const { port } = z.object({ port: z.number().int().positive() }).parse(server.address())
const root = await mkdtemp(join(tmpdir(), "mako-connections-opencode-"))
const scratch = seedScratchHome(root, {})

/** Runs one turn on `model` through Mako's OpenCode driver; how it stopped. */
async function turn(env: NodeJS.ProcessEnv, model: string): Promise<string | undefined> {
  const driver = createOpenCodeDriver({ stores: new NativeStores(false), servers: new OpenCodeServers(), approvalRoot: async () => join(root, "approvals") })
  const id = randomUUID()
  let state: LiveSessionState | undefined
  try {
    await driver.start(root, admitted("opencode", { conversationId: id, emit: (event) => { if (event.type === "live-session") state = event.session }, tuning: { model } }, { env: { ...env } }))
    await driver.prompt(id, "Reply with exactly the word ok.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => undefined })
    for (const deadline = Date.now() + ANSWER_MS; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 200)))
      if (state && state.status !== "running" && state.lastStop) return state.lastStop
    return undefined
  } finally {
    await Promise.resolve().then(() => driver.close(id)).catch(() => undefined)
  }
}

try {
  const store = new ModelConnections(modelConnectionsPath(join(root, "user")), memorySecrets())
  const baseUrl = `http://127.0.0.1:${port}/v1`
  // As the dialog does: Check access, then add what it listed. One keeps a key, the other has none.
  const keyed = await store.check({ provider: "local", baseUrl, apiKey: KEY })
  assert.deepEqual(keyed.models.map((model) => model.id), ["stand-in-coder", "stand-in-small"])
  const withKey = await store.add({ provider: "local", baseUrl, apiKey: KEY, models: keyed.models })
  const custom = await store.add({ provider: "openai-compatible", name: "Bench endpoint", baseUrl, models: [{ id: "stand-in-small" }] })
  const ollama = (await store.detectLocal()).find((entry) => entry.provider === "ollama")
  if (ollama?.running && ollama.models.length) await store.add({ provider: "ollama", models: ollama.models.slice(0, 1) })

  const capability = openCodeAccountCapability(new NativeStores(false), () => store.served())
  const env = await capability.accountEnv(null, { ...scratch.env })
  assert.ok(!env.OPENCODE_CONFIG_CONTENT?.includes(KEY), "the inline config holds no key")

  const installation = await resolveOpenCodeInstallation(env, new OpenCodeVersions())
  const catalog = await discoverOpenCodeCatalog(installation.command, env, root, new OpenCodeServers())
  const ids = catalog.models.map((model) => model.id)
  const served = (entry: ServedConnection["connection"]) => entry.models.map((model) => `mako-${entry.id}/${model.id}`)
  for (const id of [...served(withKey), ...served(custom)])
    assert.ok(ids.includes(id), `OpenCode's model list has ${id}`)
  const named = catalog.models.find((model) => model.id === `mako-${withKey.id}/stand-in-coder`)
  assert.equal(named?.label, "Stand-in Coder", "it lists the model by the name its endpoint gave")
  console.log(`OpenCode ${installation.command}: ${catalog.models.length} models, with ${[...served(withKey), ...served(custom)].join(", ")}`)

  const before = requests.length
  assert.equal(await turn(env, `mako-${withKey.id}/stand-in-coder`), "end_turn", "a turn on the connection's model ends")
  const sent = requests.slice(before).filter((request) => request.path === "POST /v1/chat/completions")
  assert.ok(sent.length > 0, "the turn reached the connection's endpoint")
  assert.ok(sent.every((request) => request.authorized), "with the connection's key")

  if (ollama?.running && ollama.models.length) {
    const model = `mako-ollama/${ollama.models[0]!.id}`
    assert.ok(ids.includes(model), `OpenCode's model list has ${model}`)
    assert.equal(await turn(env, model), "end_turn", `a turn on Ollama's ${ollama.models[0]!.id} ends`)
    console.log(`Ollama: a turn on ${ollama.models[0]!.id} ended`)
  } else {
    console.log("Ollama isn't running on this Mac: its turn was skipped")
  }
  console.log("model connections in OpenCode: listed and answered with their key")
} finally {
  server.close()
  scratch.dispose()
  await rm(root, { recursive: true, force: true })
}
