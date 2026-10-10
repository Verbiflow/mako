import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto"
import { createServer } from "node:http"
import { once } from "node:events"
import { z } from "zod"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { UtilityModelStore } from "../electron/utility-model-store.ts"
import { aesSealer, fileSecrets, wrappedKey } from "../electron/secrets.ts"
import type { SecretEncryption } from "../electron/secure-storage.ts"
import { GitDrafting } from "../electron/git-drafting.ts"
import { UtilityWork } from "../electron/utility-work.ts"

const secret = randomBytes(32)
const encryption: SecretEncryption = {
  available: async () => true,
  encrypt: async (value) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", secret, iv)
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  },
  decrypt: async (value) => {
    const cipher = createDecipheriv(
      "aes-256-gcm",
      secret,
      value.subarray(0, 12)
    )
    cipher.setAuthTag(value.subarray(12, 28))
    return Buffer.concat([
      cipher.update(value.subarray(28)),
      cipher.final(),
    ]).toString("utf8")
  },
}
const root = await mkdtemp(join(tmpdir(), "mako-commit-connections-"))
const apiKey = `synthetic-${randomUUID()}`
const requests: string[] = []
let reject = false
let delay = 0
const server = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`)
  assert.equal(request.url, "/v1/chat/completions")
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks).toString("utf8")
  requests.push(body)
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  response.setHeader("Content-Type", "application/json")
  response.statusCode = reject ? 401 : 200
  response.end(
    JSON.stringify(
      reject
        ? { error: { message: `Do not leak ${apiKey}` } }
        : {
            id: "test",
            object: "chat.completion",
            created: 1,
            model: "local-test",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({ action: "finish", result: { message: "fix: keep drafts intact" }, requests: [], notes: "" }),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }
    )
  )
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = z.object({ port: z.number() }).parse(server.address())
const input = {
  provider: "openai-compatible",
  model: "local-test",
  contextTokens: 32_000,
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  apiKey,
} satisfies Parameters<UtilityModelStore["connect"]>[0]
try {
  /** The host's store, under a stand-in keychain. */
  const secrets = (keychain = encryption) => fileSecrets(join(root, "secrets"), aesSealer(wrappedKey(join(root, "secrets", "data-key"), keychain)))
  const store = new UtilityModelStore(join(root, "connections"), secrets())
  assert.deepEqual((await store.settings()).connections, [])
  const saved = await store.connect(input)
  assert.equal(requests.length, 1)
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(apiKey))
  const anotherHost = new UtilityModelStore(join(root, "connections"), secrets())
  assert.equal((await anotherHost.load(input.provider))?.apiKey, apiKey)
  assert.equal((await anotherHost.settings()).secureStorage, true)
  const snapshot = await store.settings()
  assert.equal(snapshot.connections.length, 1)
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(apiKey))
  const path = join(root, "secrets", "saved-key", "utility", "openai-compatible.json")
  assert.equal((await readFile(path)).includes(Buffer.from(apiKey)), false)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const reopened = new UtilityModelStore(join(root, "connections"), secrets())
  assert.equal((await reopened.load("openai-compatible"))?.apiKey, apiKey)
  const { apiKey: _apiKey, ...withoutKey } = input
  await reopened.connect(withoutKey)
  await assert.rejects(
    reopened.connect({
      ...withoutKey,
      baseUrl: `http://localhost:${address.port}/v1`,
    }),
    /Re-enter the API key/
  )
  reject = true
  await assert.rejects(
    store.connect({ ...input, model: "denied" }),
    (error: Error) => {
      assert.doesNotMatch(error.message, new RegExp(apiKey))
      return /rejected this API key/.test(error.message)
    }
  )
  assert.equal((await reopened.load("openai-compatible"))?.model, "local-test")
  reject = false
  // A key saved before names were kept gets its name once, and keeps its key.
  const nameOf = async () => (await store.settings()).connections[0]?.name
  assert.equal(await nameOf(), undefined)
  assert.equal(await store.nameModel("openai-compatible", "other-model", "Other"), false, "A replaced key is not renamed")
  assert.equal(await store.nameModel("openai-compatible", "local-test", "Local Test"), true)
  assert.equal(await nameOf(), "Local Test")
  assert.equal((await store.load("openai-compatible"))?.apiKey, apiKey)
  assert.equal(await store.nameModel("openai-compatible", "local-test", "Renamed"), false, "A named key keeps its name")
  // Connecting saves the name with the key; one that only repeats the id is dropped.
  await store.connect({ ...input, name: "  Local model  " })
  assert.equal(await nameOf(), "Local model")
  const named = await new UtilityWork({ models: store }).settings()
  assert.equal(named.commit.options[0]?.label, "Local model")
  assert.equal(named.commit.resolved?.label, "Local model")
  await store.connect({ ...input, name: "local-test" })
  assert.equal(await nameOf(), undefined)
  const run = promisify(execFile)
  await run("git", ["init", "-q"], { cwd: root })
  await writeFile(join(root, ".gitignore"), "connections/\n")
  await writeFile(join(root, "feature.ts"), "New feature for the commit\n")
  const service = new GitDrafting(new UtilityWork({ models: store }))
  const generation = {
    requestId: randomUUID(),
    cwd: root,
    model: "openai-compatible/local-test",
  }
  const generated = await service.commitMessage("first-window", generation)
  assert.equal(generated.message, "fix: keep drafts intact")
  assert.ok(requests.at(-1)?.includes("New feature for the commit"))
  assert.ok(!requests.at(-1)?.includes(apiKey))
  delay = 150
  const pending = service.commitMessage("first-window", {
    ...generation,
    requestId: randomUUID(),
  })
  await assert.rejects(
    service.commitMessage("first-window", generation),
    /already being written/
  )
  await pending
  const cancelled = service.commitMessage("first-window", generation)
  service.cancel("second-window", generation.requestId)
  service.cancel("first-window", generation.requestId)
  delay = 0
  await Promise.all([
    assert.rejects(cancelled, /cancelled/),
    service.commitMessage("first-window", {
      ...generation,
      requestId: randomUUID(),
    }),
  ])
  const locked = new UtilityModelStore(join(root, "connections"), secrets({ ...encryption, available: async () => false }))
  assert.equal((await locked.settings()).issues.length, 1)
  await assert.rejects(locked.connect(input), /Secure key storage/)
  await writeFile(path, "corrupt")
  assert.equal((await store.settings()).issues.length, 1)
  await store.connect(input)
  assert.equal((await store.settings()).issues.length, 0)
  await store.disconnect("openai-compatible")
  assert.equal((await store.settings()).connections.length, 0)
  console.log(
    "Commit connections: real SDK HTTP, encrypted persistence, key redaction, rollback, endpoint isolation, generate/cancel, per-window isolation, locked and corrupt storage, saved and backfilled model names passed"
  )
} finally {
  server.closeAllConnections()
  server.close()
  await rm(root, { recursive: true, force: true })
}
