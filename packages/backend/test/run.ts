import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { parseSlackWebhookBody } from "@chat-adapter/slack/webhook"
import { z } from "zod"
import { readOptionalServerEnv } from "../src/config/env"
import { integrationCatalog } from "../src/integrations/catalog"
import {
  appendSlackStream,
  downloadSlackFile,
  setSlackAgentStatus,
  slackIdentity,
  startSlackStream,
  stopSlackStream,
  uploadSlackFile,
} from "../src/integrations/slack/client"
import {
  formatHarnessReplies,
  relayEventSlackChunks,
} from "../src/relay/delivery"
import {
  registerRelayDeliveryAdapter,
  relayDeliveryAdapter,
} from "../src/relay/delivery-adapters"
import { applyRelayThreadMapping } from "../src/relay/relay-routing"
import { parseSlackRelayCommand } from "../src/relay/commands"
import {
  relayDeviceKey,
  signRelayTokenRequest,
} from "@mako/relay"
import {
  issueRelayToken,
  relayAuth,
  relayDeviceAuthorized,
} from "../src/relay/auth"
import { parseRelayJobPayload } from "../src/relay/types"
import {
  describeWorker,
  prepareSlackRelayWebhook,
  slackActionCommand,
} from "../src/relay/slack-ingress"
import {
  postSlackControls,
  slackControlBlocks,
} from "../src/relay/slack-ui"
import { listSkills, readSkill } from "../src/skills/catalog"
import { backendStatus } from "../src/status"

const token = "mako-test-token-".padEnd(64, "x")
process.env.MAKO_MCP_TOKEN = token
process.env.VERCEL_ENV = "development"
delete process.env.SLACK_BOT_TOKEN
delete process.env.SLACK_SIGNING_SECRET

const { makoMcpHandler } = await import("../src/mcp/server")

function mcpRequest(
  method: string,
  params: z.input<typeof JsonRpcParamsSchema>,
  bearerToken = token
): Request {
  const validatedParams = JsonRpcParamsSchema.parse(params)
  return new Request("http://localhost:3000/api/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: validatedParams,
    }),
  })
}

const JsonRpcParamsSchema = z.record(z.string(), z.json())
const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.json().optional(),
  error: z.json().optional(),
})

async function jsonRpc(response: Response) {
  const text = await response.text()
  const payload = text.startsWith("event:")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text
  assert.ok(payload)
  const body = JsonRpcResponseSchema.parse(JSON.parse(payload))
  assert.equal(response.status, 200)
  assert.equal(body.error, undefined)
  return body.result
}

function signedSlackRequest(
  body: string,
  signingSecret: string,
  timestamp = Math.floor(Date.now() / 1_000)
): Request {
  const timestampHeader = timestamp.toString()
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestampHeader}:${body}`)
    .digest("hex")
  return new Request("http://localhost:3000/api/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestampHeader,
      "X-Slack-Signature": `v0=${signature}`,
    },
    body,
  })
}

const unauthorized = await makoMcpHandler(
  mcpRequest(
    "initialize",
    {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    },
    "wrong-token".padEnd(64, "x")
  )
)
assert.equal(unauthorized.status, 401)

await jsonRpc(
  await makoMcpHandler(
    mcpRequest("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    })
  )
)

const tools = await jsonRpc(
  await makoMcpHandler(mcpRequest("tools/list", {}))
)
const serializedTools = JSON.stringify(tools)
for (const name of [
  "mako_server_status",
  "mako_list_integrations",
  "mako_list_skills",
  "mako_read_skill",
  "mako_slack_status",
  "mako_slack_list_channels",
  "mako_slack_read_messages",
  "mako_slack_read_thread",
  "mako_slack_send_message",
]) {
  assert.match(serializedTools, new RegExp(name))
}

const resources = await jsonRpc(
  await makoMcpHandler(mcpRequest("resources/list", {}))
)
assert.match(JSON.stringify(resources), /mako:\/\/skills\/mako-operations/)

const skill = await readSkill("mako-operations")
assert.match(skill, /Mako operations/)
assert.equal(listSkills().length, 1)

const connected = integrationCatalog({ slackConnected: true })
assert.equal(connected[0]?.status.kind, "connected")
const disconnected = integrationCatalog({ slackConnected: false })
assert.equal(disconnected[0]?.status.kind, "available")

const origin = {
  provider: "slack",
  tenantId: "TTEST",
  conversationId: "CTEST",
  threadId: "123.456",
  eventId: "event-1",
  userId: "UTEST",
}
process.env.SLACK_TEAM_ID = origin.tenantId
process.env.RELAY_TOKEN_SECRET = "relay-token-secret".padEnd(64, "x")
process.env.RELAY_BOOTSTRAP_SECRET = "relay-bootstrap-secret".padEnd(64, "x")
process.env.RELAY_ALLOW_LEGACY_TOKEN = "true"
const relayDeviceSecret = "relay-device-secret".padEnd(64, "x")
const relayTokenInput = {
  tenantId: origin.tenantId,
  deviceId: crypto.randomUUID(),
  nonce: crypto.randomUUID(),
  timestamp: Date.now(),
}
const issued = issueRelayToken({
  deviceKey: relayDeviceKey(relayDeviceSecret),
  request: {
    ...relayTokenInput,
    signature: signRelayTokenRequest(relayTokenInput, relayDeviceSecret),
  },
})
assert.ok(issued)
const relayRequest = new Request("http://localhost/api/relay/lease", {
  headers: { Authorization: `Bearer ${issued.token}` },
})
const relayIdentity = relayAuth(relayRequest)
assert.equal(relayIdentity?.kind, "device")
if (relayIdentity)
  assert.equal(
    relayDeviceAuthorized(relayIdentity, relayTokenInput.deviceId),
    true
  )
if (relayIdentity)
  assert.equal(relayDeviceAuthorized(relayIdentity, crypto.randomUUID()), false)

const legacyPayload = parseRelayJobPayload({
  kind: "new",
  selection: { harness: "codex" },
  slack: {
    channel: "CTEST",
    eventId: "legacy-event",
    teamId: "TTEST",
    threadTs: "123.456",
    userId: "UTEST",
  },
  text: "legacy queued work",
})
assert.equal(legacyPayload.origin.provider, "slack")
assert.equal(legacyPayload.origin.conversationId, "CTEST")
if (legacyPayload.kind === "new")
  assert.equal(legacyPayload.forceNew, false)

const explicitNew = parseSlackRelayCommand({
  mapping: null,
  origin,
  text: "new codex investigate",
})
assert.equal(explicitNew.kind, "enqueue")
if (explicitNew.kind === "enqueue" && explicitNew.payload.kind === "new")
  assert.equal(explicitNew.payload.forceNew, true)
const continuation = parseSlackRelayCommand({
  mapping: {
    harness: "claude",
    model: "sonnet",
    threadPath: "/tmp/thread",
  },
  origin,
  text: "continue",
})
assert.equal(continuation.kind, "enqueue")
if (continuation.kind === "enqueue") {
  assert.equal(continuation.payload.kind, "resume")
}
for (const [text, field, value] of [
  ["reasoning high", "effort", "high"],
  ["fast on", "fast", true],
  ["model gpt-5.6", "model", "gpt-5.6"],
  ["harness codex", "harness", "codex"],
] satisfies Array<
  [string, "effort" | "fast" | "model" | "harness", string | boolean]
>) {
  const command = parseSlackRelayCommand({
    mapping: {
      harness: "claude",
      model: "sonnet",
      threadPath: "/tmp/thread",
    },
    origin,
    text,
  })
  assert.equal(command.kind, "enqueue")
  if (command.kind === "enqueue") {
    assert.equal(command.payload.kind, "configure")
    assert.equal(command.payload.selection[field], value)
  }
}
assert.equal(
  parseSlackRelayCommand({ mapping: null, origin, text: "threads auth" }).kind,
  "enqueue"
)
const attachmentCommand = parseSlackRelayCommand({
  attachments: [
    {
      id: "FTEST",
      kind: "image",
      name: "screenshot.png",
      mimeType: "image/png",
      size: 1_024,
    },
  ],
  mapping: null,
  origin,
  text: "",
})
assert.equal(attachmentCommand.kind, "enqueue")
if (attachmentCommand.kind === "enqueue") {
  assert.equal(attachmentCommand.payload.kind, "new")
  if (attachmentCommand.payload.kind === "new") {
    assert.equal(attachmentCommand.payload.forceNew, false)
    assert.equal(attachmentCommand.payload.attachments[0]?.id, "FTEST")
  }
}
const futureHarness = parseSlackRelayCommand({
  mapping: null,
  origin,
  text: "new future-agent investigate",
})
assert.equal(futureHarness.kind, "enqueue")
if (futureHarness.kind === "enqueue")
  assert.equal(futureHarness.payload.selection.harness, "future-agent")
if (attachmentCommand.kind === "enqueue") {
  const mapped = applyRelayThreadMapping(attachmentCommand.payload, {
    harness: "claude",
    model: "sonnet",
    threadPath: "/threads/existing",
  })
  assert.equal(mapped.kind, "resume")
  if (mapped.kind === "resume") {
    assert.equal(mapped.threadPath, "/threads/existing")
    assert.equal(mapped.attachments[0]?.id, "FTEST")
  }
}
if (explicitNew.kind === "enqueue") {
  assert.equal(
    applyRelayThreadMapping(explicitNew.payload, {
      harness: "claude",
      threadPath: "/threads/existing",
    }).kind,
    "new"
  )
}
// Projects: listing, choosing by name, and carrying the choice into new work.
const projectsCommand = parseSlackRelayCommand({
  mapping: null,
  origin,
  text: "projects ui",
})
assert.equal(projectsCommand.kind, "enqueue")
if (projectsCommand.kind === "enqueue") {
  assert.equal(projectsCommand.payload.kind, "inspect-projects")
  if (projectsCommand.payload.kind === "inspect-projects")
    assert.equal(projectsCommand.payload.query, "ui")
}
const projectCommand = parseSlackRelayCommand({
  mapping: {
    cwd: "/Users/me/old",
    harness: "claude",
    model: "sonnet",
    threadPath: "/tmp/thread",
  },
  origin,
  text: "project pi-ui",
})
assert.equal(projectCommand.kind, "enqueue")
if (projectCommand.kind === "enqueue") {
  assert.equal(projectCommand.payload.kind, "configure")
  if (projectCommand.payload.kind === "configure") {
    assert.equal(projectCommand.payload.selection.cwd, "pi-ui")
    assert.equal(projectCommand.payload.selection.model, "sonnet")
    assert.equal(
      projectCommand.payload.threadPath,
      undefined,
      "a new project starts fresh; the resumed session stayed in the old one"
    )
  }
}
assert.equal(
  parseSlackRelayCommand({ mapping: null, origin, text: "project" }).kind,
  "help"
)
const tuningWithoutSession = parseSlackRelayCommand({
  mapping: { cwd: "/Users/me/pi-ui", harness: "codex" },
  origin,
  text: "model gpt-5.6",
})
assert.equal(tuningWithoutSession.kind, "enqueue")
if (tuningWithoutSession.kind === "enqueue") {
  assert.equal(tuningWithoutSession.payload.kind, "configure")
  assert.equal(tuningWithoutSession.payload.selection.cwd, "/Users/me/pi-ui")
  if (tuningWithoutSession.payload.kind === "configure")
    assert.equal(tuningWithoutSession.payload.threadPath, undefined)
}
const projectOnlyPrompt = parseSlackRelayCommand({
  mapping: { cwd: "/Users/me/pi-ui", harness: "codex" },
  origin,
  text: "fix the flaky test",
})
if (projectOnlyPrompt.kind === "enqueue") {
  assert.equal(projectOnlyPrompt.payload.kind, "new")
  assert.equal(projectOnlyPrompt.payload.selection.cwd, "/Users/me/pi-ui")
}
if (explicitNew.kind === "enqueue") {
  const forced = applyRelayThreadMapping(explicitNew.payload, {
    cwd: "/Users/me/pi-ui",
    harness: "claude",
    threadPath: "/threads/existing",
  })
  assert.equal(forced.kind, "new")
  assert.equal(
    forced.selection.cwd,
    "/Users/me/pi-ui",
    "a forced new session still runs in the thread's project"
  )
}
assert.equal(
  parseSlackRelayCommand({ mapping: null, origin, text: "stop" }).kind,
  "stop"
)
assert.equal(
  parseSlackRelayCommand({ mapping: null, origin, text: "queue next" }).kind,
  "enqueue"
)
assert.equal(
  parseSlackRelayCommand({ mapping: null, origin, text: "steer now" }).kind,
  "interrupt"
)

const directBotToken = "xoxb-test-direct-bot-token"
const directSigningSecret = "0123456789abcdef0123456789abcdef"
assert.throws(
  () =>
    readOptionalServerEnv({
      MAKO_MCP_TOKEN: token,
      NODE_ENV: "test",
      SLACK_BOT_TOKEN: directBotToken,
    }),
  /must be configured together/
)
process.env.SLACK_BOT_TOKEN = directBotToken
process.env.SLACK_SIGNING_SECRET = directSigningSecret

const challengeBody = JSON.stringify({
  challenge: "self-hosted-challenge",
  token: "legacy-verification-token",
  type: "url_verification",
})
const directWebhook = await prepareSlackRelayWebhook(
  signedSlackRequest(challengeBody, directSigningSecret)
)
assert.equal(directWebhook.response.status, 200)
assert.deepEqual(await directWebhook.response.json(), {
  challenge: "self-hosted-challenge",
})
const invalidDirectWebhook = await prepareSlackRelayWebhook(
  signedSlackRequest(challengeBody, "fedcba9876543210fedcba9876543210")
)
assert.equal(invalidDirectWebhook.response.status, 401)
const staleDirectWebhook = await prepareSlackRelayWebhook(
  signedSlackRequest(
    challengeBody,
    directSigningSecret,
    Math.floor(Date.now() / 1_000) - 301
  )
)
assert.equal(staleDirectWebhook.response.status, 401)

const originalFetch = globalThis.fetch
let directSlackApiCalled = false
let directSlackControlsCalled = false
let streamCalls = 0
let uploadedFile = false
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url === "https://files.slack.com/upload-test") {
    uploadedFile = init?.body instanceof Blob
    return new Response("OK")
  }
  const headers = new Headers(init?.headers)
  assert.equal(headers.get("authorization"), `Bearer ${directBotToken}`)
  if (url === "https://slack-files.com/files-pri/test")
    return new Response("image-bytes", { headers: { "Content-Type": "image/png" } })
  directSlackApiCalled ||= url === "https://slack.com/api/auth.test"
  directSlackControlsCalled ||= url === "https://slack.com/api/chat.postMessage"
  if (url === "https://slack.com/api/chat.postMessage") {
    const body = z
      .object({ blocks: z.array(z.json()).min(1), channel: z.literal("CTEST") })
      .parse(JSON.parse(String(init?.body)))
    assert.ok(body.blocks.length > 0)
    return Response.json({
      ok: true,
      channel: "CTEST",
      ts: "123.456",
      message: { text: "Mako local harness controls" },
    })
  }
  if (
    url === "https://slack.com/api/chat.startStream" ||
    url === "https://slack.com/api/chat.appendStream" ||
    url === "https://slack.com/api/chat.stopStream"
  ) {
    streamCalls += 1
    return Response.json({ ok: true, channel: "CTEST", ts: "234.567" })
  }
  if (url === "https://slack.com/api/agents.sessions.setStatus")
    return Response.json({ ok: true })
  if (url === "https://slack.com/api/files.info")
    return Response.json({
      ok: true,
      file: {
        id: "FTEST",
        mimetype: "image/png",
        name: "screen.png",
        size: 11,
        url_private_download: "https://slack-files.com/files-pri/test",
      },
    })
  if (url === "https://slack.com/api/files.getUploadURLExternal")
    return Response.json({
      ok: true,
      file_id: "FUPLOADED",
      upload_url: "https://files.slack.com/upload-test",
    })
  if (url === "https://slack.com/api/files.completeUploadExternal")
    return Response.json({ ok: true })
  return Response.json({
    ok: true,
    team: "Test Team",
    team_id: "TTEST",
    user: "mako-test",
    user_id: "UTESTBOT",
    bot_id: "BTEST",
  })
}
try {
  const identity = await slackIdentity()
  assert.equal(identity.team_id, "TTEST")
  assert.equal(directSlackApiCalled, true)
  assert.equal(await postSlackControls({ channel: "CTEST" }), "123.456")
  assert.equal(directSlackControlsCalled, true)
  await setSlackAgentStatus({
    channel: "CTEST",
    initiatorUserId: "UTEST",
    status: "processing",
    threadTs: "123.456",
    title: "Investigate",
  })
  const stream = await startSlackStream({
    channel: "CTEST",
    chunks: [
      { type: "plan_update", title: "Investigate" },
      {
        type: "task_update",
        id: "task-1",
        title: "Run Codex",
        status: "in_progress",
      },
    ],
    recipientTeamId: "TTEST",
    recipientUserId: "UTEST",
    threadTs: "123.456",
  })
  await appendSlackStream({
    channel: "CTEST",
    chunks: [{ type: "markdown_text", text: "Working" }],
    ts: stream.ts,
  })
  await stopSlackStream({
    channel: "CTEST",
    chunks: [
      {
        type: "task_update",
        id: "task-1",
        title: "Run Codex",
        status: "complete",
      },
    ],
    ts: stream.ts,
  })
  assert.equal(streamCalls, 3)
  const downloaded = await downloadSlackFile("FTEST")
  assert.equal(await new Response(downloaded.stream).text(), "image-bytes")
  assert.equal(downloaded.size, 11)
  await uploadSlackFile({
    source: new Blob(["output"], { type: "text/plain" }),
    size: 6,
    mimeType: "text/plain",
    channel: "CTEST",
    filename: "output.txt",
    threadTs: "123.456",
  })
  assert.equal(uploadedFile, true)
} finally {
  globalThis.fetch = originalFetch
}

delete process.env.SLACK_BOT_TOKEN
delete process.env.SLACK_SIGNING_SECRET
process.env.SLACK_CONNECTOR = "slack/mako-test-fallback"
const previousOidcToken = process.env.VERCEL_OIDC_TOKEN
const oidcPayload = Buffer.from(
  JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })
).toString("base64url")
process.env.VERCEL_OIDC_TOKEN = `e30.${oidcPayload}.test-signature`
const connectorBotToken = "xoxb-test-connector-bot-token"
let connectorTokenRequested = false
let connectorSlackApiCalled = false
globalThis.fetch = async (input, init) => {
  const url = String(input)
  const headers = new Headers(init?.headers)
  if (
    url ===
    "https://api.vercel.com/v1/connect/token/slack%2Fmako-test-fallback"
  ) {
    connectorTokenRequested = true
    assert.equal(headers.get("authorization")?.startsWith("Bearer "), true)
    return Response.json({
      expiresAt: Date.now() + 60_000,
      token: connectorBotToken,
    })
  }
  connectorSlackApiCalled = url === "https://slack.com/api/auth.test"
  assert.equal(
    headers.get("authorization") === `Bearer ${connectorBotToken}`,
    true
  )
  return Response.json({
    ok: true,
    team: "Connector Team",
    team_id: "TCONNECT",
    user: "mako-connect-test",
    user_id: "UCONNECT",
    bot_id: "BCONNECT",
  })
}
try {
  const identity = await slackIdentity()
  assert.equal(identity.team_id, "TCONNECT")
  assert.equal(connectorTokenRequested, true)
  assert.equal(connectorSlackApiCalled, true)
} finally {
  globalThis.fetch = originalFetch
  if (previousOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN
  else process.env.VERCEL_OIDC_TOKEN = previousOidcToken
}

const unsignedSlack = await prepareSlackRelayWebhook(
  new Request("http://localhost:3000/api/slack/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
)
assert.equal(unsignedSlack.response.status, 401)

const fileMessage = parseSlackWebhookBody(
  JSON.stringify({
    type: "event_callback",
    team_id: "TTEST",
    event_id: "event-file",
    event: {
      type: "message",
      channel_type: "im",
      channel: "DTEST",
      user: "UTEST",
      text: "",
      ts: "123.456",
      files: [
        {
          id: "FTEST",
          mimetype: "image/png",
          name: "screen.png",
          size: 1_024,
          url_private_download: "https://slack-files.com/files-pri/test",
        },
      ],
    },
  }),
  { contentType: "application/json" }
)
assert.equal(fileMessage.kind, "direct_message")
if (fileMessage.kind === "direct_message") {
  assert.equal(fileMessage.files?.[0]?.id, "FTEST")
  assert.equal(fileMessage.files?.[0]?.type, "image")
}

const slash = parseSlackWebhookBody(
  new URLSearchParams({
    channel_id: "CTEST",
    command: "/mako",
    team_id: "TTEST",
    text: "status",
    trigger_id: "trigger-1",
    user_id: "UTEST",
  }).toString(),
  { contentType: "application/x-www-form-urlencoded" }
)
assert.equal(slash.kind, "slash_command")
if (slash.kind === "slash_command") assert.equal(slash.text, "status")
const action = parseSlackWebhookBody(
  new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: "UTEST" },
      team: { id: "TTEST" },
      channel: { id: "CTEST" },
      message: { ts: "123.456", thread_ts: "123.456" },
      actions: [
        {
          action_id: "mako-harness",
          type: "static_select",
          selected_option: { value: "codex" },
        },
      ],
    }),
  }).toString(),
  { contentType: "application/x-www-form-urlencoded" }
)
assert.equal(action.kind, "block_actions")
if (action.kind === "block_actions") {
  assert.equal(slackActionCommand(action), "harness codex")
  const current = action.actions[0]
  if (current)
    assert.equal(
      slackActionCommand({
        ...action,
        actions: [
          {
            ...current,
            actionId: "mako-thread",
            value: "/threads/selected",
          },
        ],
      }),
      "select /threads/selected"
    )
}
// `status` answers from the worker's own heartbeat, never from transcripts.
{
  const seen = new Date().toISOString()
  const base = {
    partitionKey: "workers:TTEST",
    rowKey: "8b452bc3-0000-4000-8000-000000000000",
    defaultHarness: "codex",
    deviceName: "Studio",
    lastSeenAt: seen,
    version: "1.0.0",
  }
  assert.equal(describeWorker(null), "Mako is offline.")
  assert.equal(describeWorker(base), "Mako is online on *Studio*.")
  assert.equal(
    describeWorker({ ...base, activity: "idle", workspace: "pi-ui" }),
    "Mako is online on *Studio*. New requests run in `pi-ui`."
  )
  assert.equal(
    describeWorker({ ...base, activity: "busy", workspace: "pi-ui" }),
    "Mako is online on *Studio*. It is working on a request now."
  )
  assert.match(describeWorker({ ...base, activity: "failing" }), /last attempts failed/)
  assert.match(describeWorker({ ...base, kind: "cloud" }), /in the cloud on \*Studio\*/)
}
const controls = JSON.stringify(slackControlBlocks())
for (const actionId of [
  "mako-harness",
  "mako-reasoning",
  "mako-fast-on",
  "mako-stop",
  "mako-status",
  "mako-threads",
  "mako-models",
]) {
  assert.match(controls, new RegExp(actionId))
}
assert.deepEqual(formatHarnessReplies("one\\n\\ntwo"), ["one\n\ntwo"])
assert.deepEqual(
  relayEventSlackChunks({
    kind: "tool",
    id: "tool-1",
    title: "Read file",
    status: "completed",
    detail: "README.md",
  }),
  [
    {
      type: "task_update",
      id: "tool-1",
      title: "Read file",
      status: "complete",
      details: "README.md",
      output: undefined,
    },
  ]
)
assert.equal(
  relayEventSlackChunks({
    kind: "plan",
    id: "plan-1",
    title: "Implementation",
    entries: [
      { id: "step-1", title: "Inspect", status: "in_progress" },
      { id: "step-2", title: "Verify", status: "pending" },
    ],
  }).length,
  3
)
assert.equal(formatHarnessReplies("x".repeat(24_000)).length, 3)
const testDeliveryAdapter = {
  async start() {},
  async events() {
    return 0
  },
  async complete() {},
}
const unregisterTestAdapter = registerRelayDeliveryAdapter(
  "test",
  testDeliveryAdapter
)
assert.equal(relayDeliveryAdapter("test"), testDeliveryAdapter)
unregisterTestAdapter()
assert.throws(() => relayDeliveryAdapter("test"), /No delivery adapter/)

assert.equal(
  backendStatus({ SLACK_BOT_TOKEN: directBotToken }).integrations[0]?.status.kind,
  "connected"
)
assert.deepEqual(backendStatus({}).relay, {
  attachments: "streaming",
  authentication: "legacy-token",
  events: "canonical-v1",
  execution: "headless-worker",
  offlineQueue: true,
  persistence: "azure-storage",
  replay: true,
})

assert.equal(JSON.stringify(tools).includes(token), false)
assert.equal(JSON.stringify(resources).includes(token), false)

console.log("Backend MCP auth, tools, resources, skills, and catalog checks passed")
