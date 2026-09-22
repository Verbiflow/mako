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
import {
  UtilityModelStore,
  type UtilityKeyEncryption,
} from "../electron/utility-model-store.ts"
import { CommitGeneration } from "../electron/commit-generation.ts"

const secret = randomBytes(32)
const encryption: UtilityKeyEncryption = {
  available: () => true,
  encrypt: (value) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", secret, iv)
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
  },
  decrypt: (value) => {
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
  const store = new UtilityModelStore(join(root, "connections"), encryption)
  assert.deepEqual((await store.settings()).connections, [])
  const saved = await store.connect(input)
  assert.equal(requests.length, 1)
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(apiKey))
  const asynchronous = new UtilityModelStore(join(root, "connections"), {
    available: async () => encryption.available(),
    encrypt: async (value) => encryption.encrypt(value),
    decrypt: async (value) => encryption.decrypt(value),
  })
  assert.equal((await asynchronous.load(input.provider))?.apiKey, apiKey)
  assert.equal((await asynchronous.settings()).secureStorage, true)
  const snapshot = await store.settings()
  assert.equal(snapshot.connections.length, 1)
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(apiKey))
  const path = join(root, "connections", "openai-compatible.enc")
  assert.equal((await readFile(path)).includes(Buffer.from(apiKey)), false)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const reopened = new UtilityModelStore(join(root, "connections"), encryption)
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
  const run = promisify(execFile)
  await run("git", ["init", "-q"], { cwd: root })
  await writeFile(join(root, ".gitignore"), "connections/\n")
  await writeFile(join(root, "feature.ts"), "New feature for the commit\n")
  const service = new CommitGeneration(store)
  const generation = {
    requestId: randomUUID(),
    cwd: root,
    model: "openai-compatible/local-test",
  }
  const generated = await service.generate("first-window", generation)
  assert.equal(generated.message, "fix: keep drafts intact")
  assert.ok(requests.at(-1)?.includes("New feature for the commit"))
  assert.ok(!requests.at(-1)?.includes(apiKey))
  delay = 150
  const pending = service.generate("first-window", {
    ...generation,
    requestId: randomUUID(),
  })
  await assert.rejects(
    service.generate("first-window", generation),
    /already being generated/
  )
  await pending
  const cancelled = service.generate("first-window", generation)
  service.cancel("second-window", generation.requestId)
  service.cancel("first-window", generation.requestId)
  delay = 0
  await Promise.all([
    assert.rejects(cancelled, /cancelled/),
    service.generate("first-window", {
      ...generation,
      requestId: randomUUID(),
    }),
  ])
  const locked = new UtilityModelStore(join(root, "connections"), {
    ...encryption,
    available: () => false,
  })
  assert.equal((await locked.settings()).issues.length, 1)
  await assert.rejects(locked.connect(input), /Secure key storage/)
  await writeFile(path, "corrupt")
  assert.equal((await store.settings()).issues.length, 1)
  await store.connect(input)
  assert.equal((await store.settings()).issues.length, 0)
  await store.disconnect("openai-compatible")
  assert.equal((await store.settings()).connections.length, 0)
  console.log(
    "Commit connections: real SDK HTTP, encrypted persistence, key redaction, rollback, endpoint isolation, generate/cancel, per-window isolation, locked and corrupt storage passed"
  )
} finally {
  server.closeAllConnections()
  server.close()
  await rm(root, { recursive: true, force: true })
}
