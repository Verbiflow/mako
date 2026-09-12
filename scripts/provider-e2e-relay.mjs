import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { once } from "node:events"
import { imageFixture } from "./provider-e2e-fixtures.mjs"
import { createMemoryRelayStore, signRelayToken, verifyRelayToken, HeadlessRelayWorker, RelayLeaseSchema, RelayCompletionSchema, RelayEventBatchSchema } from "@mako/relay"

export async function runRelayFixture(owner, root) {
  const { RelayConversations } = await import("../dist-electron/relay-conversations.js")
  const { stageRelayAttachments, relayPrompt, uploadRelayArtifacts } = await import("../dist-electron/relay-artifacts.js")
  const deviceId = randomUUID(), tenantId = "fixture-tenant", secret = randomUUID()
  const issuedAt = Math.floor(Date.now() / 1000)
  const token = signRelayToken({ version: 1, tenantId, deviceId, scopes: ["relay:read", "relay:write"], issuedAt, expiresAt: issuedAt + 600 }, secret)
  const store = createMemoryRelayStore()
  const proof = randomUUID()
  const file = Buffer.from(`${"Remote attachment padding.\n".repeat(80_000)}FINAL_FIXTURE_VALUE=${proof}\n`)
  const image = imageFixture()
  const uploads = new Map()
  let completion
  let downloadedBytes = 0
  const server = createServer((request, response) => {
    void (async () => {
      const claims = verifyRelayToken(request.headers.authorization?.replace(/^Bearer /, "") ?? "", secret)
      if (!claims || claims.tenantId !== tenantId || claims.deviceId !== deviceId) { response.writeHead(401).end(); return }
      const chunks = []; let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 25 * 1024 * 1024) throw new Error("Fixture request too large")
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      if (request.url === "/api/relay/artifact") {
        const input = { deviceId: request.headers["x-mako-device-id"], jobId: request.headers["x-mako-job-id"], artifactKey: request.headers["x-mako-artifact-key"] }
        if (input.deviceId !== claims.deviceId) { response.writeHead(403).end(); return }
        const target = await store.artifactTarget(input)
        if (!target.uploaded) { uploads.set(input.artifactKey, bytes); await store.markArtifactUploaded(input) }
        response.writeHead(200, { "Content-Type": "application/json" }).end("{}")
        return
      }
      const input = JSON.parse(bytes.toString("utf8"))
      if (input.deviceId !== claims.deviceId) { response.writeHead(403).end(); return }
      let result = {}
      if (request.url === "/api/relay/lease") {
        const leased = await store.lease({ tenantId, deviceId, visibilityTimeoutSeconds: input.visibilityTimeoutSeconds })
        result = leased.kind === "work" ? leased.lease : null
      } else if (request.url === "/api/relay/attachment") {
        const attachment = await store.attachment(input)
        const body = attachment.id === "picture" ? image : file
        response.writeHead(200, { "Content-Type": attachment.mimeType, "X-Mako-Attachment-Name": encodeURIComponent(attachment.name) })
        for (let offset = 0; offset < body.length; offset += 7103) {
          const chunk = body.subarray(offset, offset + 7103)
          downloadedBytes += chunk.length
          if (!response.write(chunk)) await once(response, "drain")
        }
        response.end(); return
      } else if (request.url === "/api/relay/events") {
        const batch = RelayEventBatchSchema.parse(input)
        await store.artifactTarget({ jobId: batch.jobId, deviceId, artifactKey: "authorization" })
        assert.ok(batch.events.every((event) => event.jobId === batch.jobId && event.workerId === deviceId))
        await store.appendEvents(batch.events)
      } else if (request.url === "/api/relay/renew") {
        result = { popReceipt: await store.renew(input) }
      } else if (request.url === "/api/relay/control") {
        result = { control: await store.control(input) }
      } else if (request.url === "/api/relay/complete") {
        completion = RelayCompletionSchema.parse(input)
        await store.recordCompletion(completion)
      } else { response.writeHead(404).end(); return }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result))
    })().catch((error) => { if (!response.headersSent) response.writeHead(403); response.end(String(error)) })
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const url = `http://127.0.0.1:${server.address().port}`
  const previousUrl = process.env.MAKO_BACKEND_URL, previousToken = process.env.MAKO_BACKEND_TOKEN
  process.env.MAKO_BACKEND_URL = url; process.env.MAKO_BACKEND_TOKEN = token
  const { backendRelayPost } = await import("../dist-electron/backend-connection.js")
  async function post(path, body) {
    const response = await backendRelayPost(path, JSON.stringify(body))
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response.json()
  }
  const cwd = join(root, "remote-fixture"); await mkdir(cwd)
  const conversations = new RelayConversations(owner, join(root, "remote-assets"))
  const origin = { provider: "fixture", tenantId, conversationId: "fixture", threadId: "fixture", eventId: randomUUID(), userId: "fixture" }
  const queued = await store.enqueue({ kind: "new", forceNew: true, origin, selection: { harness: "codex" }, text: "Inspect the attached PNG with your image tool and count red and blue squares. Read the last line of the text attachment. Write remote-result.txt containing RED=n BLUE=n followed by the exact FINAL_FIXTURE_VALUE. Include remote-result.txt in the outbound manifest as instructed. Reply with those same values.", attachments: [{ id: "picture", kind: "image", name: "squares.png", mimeType: "image/png", size: image.length }, { id: "large", kind: "file", name: "large.txt", mimeType: "text/plain", size: file.length }] }, deviceId)
  const worker = new HeadlessRelayWorker({
    lease: async (request) => { const value = await post("/api/relay/lease", request); return value ? RelayLeaseSchema.parse(value) : null },
    renew: async (lease) => (await post("/api/relay/renew", { deviceId, ...lease, visibilityTimeoutSeconds: 60 })).popReceipt,
    sendEvents: (batch) => post("/api/relay/events", batch),
    control: async (lease) => (await post("/api/relay/control", { deviceId, jobId: lease.jobId })).control,
    complete: (completion) => post("/api/relay/complete", completion),
  }, {
    control: (lease, control) => conversations.control(lease.jobId, control),
    execute: async (lease, context) => {
      const staged = await stageRelayAttachments(lease.payload, lease.jobId, deviceId, cwd)
      try {
        const execution = await conversations.execute({ jobId: lease.jobId, cwd, provider: "codex", text: relayPrompt(lease.payload.text, staged.paths, staged.manifestPath), attachments: staged.paths.map((path, index) => ({ ...lease.payload.attachments[index], path })), tuning: {}, signal: context.signal, emit: context.emit })
        await uploadRelayArtifacts({ cwd, deviceId, jobId: lease.jobId, manifestPath: staged.manifestPath })
        await uploadRelayArtifacts({ cwd, deviceId, jobId: lease.jobId, manifestPath: staged.manifestPath })
        return execution
      } finally { await staged.cleanup() }
    },
  }, { heartbeat: () => ({ deviceId, deviceName: "disposable fixture", defaultHarness: "codex", version: "test" }), controlIntervalMs: 250, renewIntervalMs: 10_000, eventFlushMs: 50 })
  try {
    assert.equal((await fetch(`${url}/api/relay/lease`, { method: "POST", headers: { Authorization: "Bearer invalid" }, body: "{}" })).status, 401)
    assert.equal((await backendRelayPost("/api/relay/attachment", JSON.stringify({ jobId: queued.jobId, deviceId: randomUUID(), attachmentId: "large" }))).status, 403)
    await worker.runOnce(AbortSignal.timeout(180_000))
    assert.equal(completion?.status, "done", completion?.result)
    assert.ok(completion.result.includes(proof))
    assert.match(completion.result, /RED\s*=\s*4/i); assert.match(completion.result, /BLUE\s*=\s*2/i)
    assert.equal(downloadedBytes, file.length + image.length)
    assert.equal(uploads.size, 1)
    const uploaded = [...uploads.values()][0].toString("utf8")
    assert.equal(uploaded, await readFile(join(cwd, "remote-result.txt"), "utf8"))
    assert.ok(uploaded.includes(proof))
    const events = await store.eventsAfter({ jobId: queued.jobId, limit: 1000 })
    assert.ok(events.some((event) => event.event.kind === "tool"))
    assert.ok(events.some((event) => event.event.kind === "text"))
    await writeFile(join(root, "remote.json"), JSON.stringify({ completion, events, downloadedBytes, uploadBytes: Buffer.byteLength(uploaded) }, null, 2))
    return { flow: "remote-http-provider", status: "passed", proof, downloadedBytes, uploadedBytes: Buffer.byteLength(uploaded), duplicateUploads: 1, jobId: queued.jobId, events: events.length }
  } finally {
    await worker.stop()
    server.closeAllConnections(); server.close()
    if (previousUrl === undefined) delete process.env.MAKO_BACKEND_URL; else process.env.MAKO_BACKEND_URL = previousUrl
    if (previousToken === undefined) delete process.env.MAKO_BACKEND_TOKEN; else process.env.MAKO_BACKEND_TOKEN = previousToken
  }
}
