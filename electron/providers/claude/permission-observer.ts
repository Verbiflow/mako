import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { Worker } from "node:worker_threads"
import { join } from "node:path"
import { z } from "zod"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { NativeApprovalDecision, NativeApprovalIdentity } from "../../contracts/approval-response.js"
import { approvalAnswerDigest } from "../approval-evidence.js"
import { RetainedApprovalDecisions, readRetainedApprovalDecisions } from "../retained-approval-decisions.js"
import { claudeTelemetryOptionsCompatible } from "./approval-telemetry-settings.js"

const Envelope = z.object({ resourceLogs: z.array(z.object({ scopeLogs: z.array(z.object({
  logRecords: z.array(z.object({ attributes: z.array(z.object({
    key: z.string(), value: z.object({ stringValue: z.string().optional(), intValue: z.union([z.string(), z.number()]).optional() }),
  })).max(128) })).max(1024),
})).max(32) })).max(32) })
const Decision = z.object({
  "event.name": z.literal("tool_decision"), "session.id": z.string().min(1).max(512),
  tool_use_id: z.string().min(1).max(512), decision: z.enum(["accept", "reject"]),
  source: z.enum(["user_temporary", "user_permanent", "user_reject"]),
  "event.sequence": z.coerce.number().int().nonnegative(),
})

export interface ClaudePermissionObserver {
  identify(toolUseId: string): NativeApprovalIdentity | undefined
  dispose(): Promise<void>
}

/** Native events are parsed here; durable evidence and the UI receipt contract
 * are shared with every provider. A callback return is never an event. */
export async function listenClaudePermissionDecisions(input: {
  root: string
  sessionId: string
  previous?: readonly NativeApprovalIdentity[]
  publish(decision: NativeApprovalDecision): void
}): Promise<ClaudePermissionObserver & { env: NodeJS.ProcessEnv }> {
  const retained = new RetainedApprovalDecisions(input.root)
  const identities = new Map<string, NativeApprovalIdentity | null>()
  const previous = new Map<string, NativeApprovalIdentity | null>()
  for (const identity of input.previous ?? []) if (identity.sessionId === input.sessionId)
    previous.set(identity.requestId, previous.has(identity.requestId) ? null : identity)
  const published = new Set<string>()
  const path = `/${randomBytes(32).toString("hex")}/v1/logs`
  let active = 0
  let disposing: Promise<void> | undefined
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== path || request.headers.origin ||
      !request.headers["content-type"]?.startsWith("application/json") ||
      (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")) {
      response.writeHead(404).end(); request.resume(); return
    }
    if (active >= 4) { response.writeHead(503).end(); request.resume(); return }
    active++
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 2 * 1024 * 1024) { response.writeHead(413).end(); request.destroy(); return }
        chunks.push(chunk)
      }
      const envelope = Envelope.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      if (!envelope.success) { response.writeHead(400).end(); return }
      for (const resource of envelope.data.resourceLogs) for (const scope of resource.scopeLogs) for (const record of scope.logRecords) {
        if (new Set(record.attributes.map(attribute => attribute.key)).size !== record.attributes.length) continue
        const attributes = Object.fromEntries(record.attributes.map(attribute => [attribute.key, attribute.value.stringValue ?? attribute.value.intValue]))
        if (attributes["agent.id"] || attributes.agent_id) continue
        const parsed = Decision.safeParse(attributes)
        if (!parsed.success || parsed.data["session.id"] !== input.sessionId) continue
        const native = parsed.data
        const identity = identities.get(native.tool_use_id)
        if (!identity) continue
        const optionId = native.decision === "accept"
          ? native.source === "user_temporary" ? "allow_once" : native.source === "user_permanent" ? "allow_session" : undefined
          : native.source === "user_reject" ? "reject_once" : undefined
        if (!optionId) continue
        const decision = await retained.record({ identity, answerDigest: approvalAnswerDigest({ kind: "choice", optionId }), observedAt: Date.now() })
        // A second callback may have made this tool ID ambiguous while storage ran.
        if (identities.get(native.tool_use_id) !== identity || published.has(native.tool_use_id)) continue
        input.publish(decision)
        published.add(native.tool_use_id)
      }
      // Acknowledge only after normalized evidence has reached durable storage.
      response.writeHead(200, { "content-type": "application/json" }).end("{}")
    } catch { response.writeHead(503).end() }
    finally { active-- }
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.timeout = 5000
  server.maxConnections = 8
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
  })
  server.unref()
  const address = z.object({ port: z.number().int().positive() }).parse(server.address())
  return {
    env: {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${address.port}${path}`,
      OTEL_LOGS_EXPORT_INTERVAL: "250", OTEL_METRICS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "none",
      OTEL_LOG_USER_PROMPTS: "0", OTEL_LOG_ASSISTANT_RESPONSES: "0", OTEL_LOG_TOOL_DETAILS: "0", OTEL_LOG_TOOL_CONTENT: "0", OTEL_LOG_RAW_API_BODIES: "0",
    },
    identify(toolUseId) {
      if (disposing || !toolUseId || toolUseId.length > 512 || identities.size >= 2000) return
      // Replayed callbacks keep their journaled occurrence, so a saved answer is
      // never offered again. This executor's events cannot confirm an older one.
      if (previous.has(toolUseId)) return previous.get(toolUseId) ?? undefined
      // A retried native tool ID is not proof of the same approval occurrence.
      if (identities.has(toolUseId)) { identities.set(toolUseId, null); return }
      const identity = { scope: retained.scope, sessionId: input.sessionId, requestId: toolUseId }
      identities.set(toolUseId, identity)
      return identity
    },
    dispose() {
      return disposing ??= (async () => {
        await new Promise<void>(resolve => server.close(() => resolve()))
        await retained.close()
      })()
    },
  }
}

async function compatibleNativeSettings(config: Options): Promise<boolean> {
  if (!claudeTelemetryOptionsCompatible(config)) return false
  return new Promise<boolean>(resolve => {
    const worker = new Worker(new URL("./approval-settings-worker.js", import.meta.url), {
      env: config.env ?? process.env,
      workerData: { cwd: config.cwd ?? process.cwd(), settingSources: config.settingSources },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    let settled = false
    const finish = (compatible: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(compatible)
    }
    const timer = setTimeout(() => finish(false), 2000)
    worker.once("message", value => finish(value === true))
    worker.once("error", () => finish(false))
    worker.once("exit", () => finish(false))
  })
}

export async function prepareClaudePermissionObserver(input: {
  root: string
  config: Options
  sessionId: string
  previous: readonly NativeApprovalIdentity[]
  publish(decision: NativeApprovalDecision): void
}): Promise<ClaudePermissionObserver | undefined> {
  const root = join(input.root, "claude")
  for (const decision of await readRetainedApprovalDecisions(root, input.previous.filter(identity => identity.sessionId === input.sessionId))) input.publish(decision)
  if (!await compatibleNativeSettings(input.config)) return
  const observer = await listenClaudePermissionDecisions({ ...input, root })
  input.config.env = { ...input.config.env ?? process.env, ...observer.env }
  return observer
}
