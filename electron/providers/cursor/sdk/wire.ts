import { z } from "zod"

/**
 * The line protocol between the host and the Cursor SDK child.
 *
 * The SDK runs an agent in-process, and Mako runs every coding agent in a
 * provider-owned process, so the SDK lives in a Node child spawned from the
 * host's own executable. Host and child exchange one JSON document per line:
 * the host sends requests, the child answers each by id and pushes events
 * (streamed messages, deltas, turn results, the sign-in URL) on its own.
 *
 * Everything the child forwards from the SDK is parsed through these schemas
 * first, so the host never types against the SDK's own declarations — its
 * delta union alone is fifty thousand lines — and a change in the SDK's shape
 * fails here, at the boundary, rather than somewhere in a transcript.
 */
export const CURSOR_SDK_WIRE_VERSION = 1

/** The largest line either side accepts: a tool result the SDK truncated is still under this. */
export const CURSOR_SDK_MAX_LINE_BYTES = 16 * 1024 * 1024

export const JsonValueSchema = z.json()
export type JsonValue = z.infer<typeof JsonValueSchema>

export const SdkModelParamSchema = z.object({ id: z.string(), value: z.string() })
export const SdkModelSelectionSchema = z.object({
  id: z.string(),
  params: z.array(SdkModelParamSchema).optional(),
})
export type SdkModelSelection = z.infer<typeof SdkModelSelectionSchema>

export const SdkModelListItemSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  parameters: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string().optional(),
        values: z.array(z.object({ value: z.string(), displayName: z.string().optional() })),
      })
    )
    .optional(),
  variants: z
    .array(
      z.object({
        params: z.array(SdkModelParamSchema),
        displayName: z.string(),
        description: z.string().optional(),
        isDefault: z.boolean().optional(),
      })
    )
    .optional(),
})
export type SdkModelListItem = z.infer<typeof SdkModelListItemSchema>

export const SdkImageSchema = z.object({ data: z.string(), mimeType: z.string() })
export type SdkImage = z.infer<typeof SdkImageSchema>

export const SdkMcpServerSchema = z.union([
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.enum(["http", "sse"]),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
])
export type SdkMcpServer = z.infer<typeof SdkMcpServerSchema>

export const SdkTokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
})

const messageBase = { agent_id: z.string(), run_id: z.string() }

/** The SDK's `SDKMessage`, as the child forwards it from `run.stream()`. */
export const SdkMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...messageBase,
    type: z.literal("system"),
    subtype: z.literal("init").optional(),
    model: SdkModelSelectionSchema.optional(),
    tools: z.array(z.string()).optional(),
  }),
  z.object({
    ...messageBase,
    type: z.literal("assistant"),
    message: z.object({
      role: z.literal("assistant"),
      content: z.array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({
            type: z.literal("tool_use"),
            id: z.string(),
            name: z.string(),
            input: JsonValueSchema.optional(),
          }),
        ])
      ),
    }),
  }),
  z.object({
    ...messageBase,
    type: z.literal("user"),
    message: z.object({
      role: z.literal("user"),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    }),
  }),
  z.object({
    ...messageBase,
    type: z.literal("tool_call"),
    call_id: z.string(),
    name: z.string(),
    status: z.enum(["running", "completed", "error"]),
    args: JsonValueSchema.optional(),
    result: JsonValueSchema.optional(),
    truncated: z.object({ args: z.boolean().optional(), result: z.boolean().optional() }).optional(),
  }),
  z.object({
    ...messageBase,
    type: z.literal("thinking"),
    text: z.string(),
    thinking_duration_ms: z.number().optional(),
  }),
  z.object({
    ...messageBase,
    type: z.literal("status"),
    status: z.enum(["CREATING", "RUNNING", "FINISHED", "ERROR", "CANCELLED", "EXPIRED"]),
    message: z.string().optional(),
  }),
  z.object({ ...messageBase, type: z.literal("request"), request_id: z.string() }),
  z.object({
    ...messageBase,
    type: z.literal("task"),
    status: z.string().optional(),
    text: z.string().optional(),
  }),
  z.object({ ...messageBase, type: z.literal("usage"), usage: SdkTokenUsageSchema }),
])
export type SdkMessage = z.infer<typeof SdkMessageSchema>

/**
 * Validates an SDK message as the wire will carry it: after a JSON round
 * trip. The SDK's own objects hold `undefined` fields (a `grep` hit reports
 * `line: undefined`; verified with SDK 1.0.31), which `z.json()` refuses and
 * serialization drops, so checking the live object refused the completed
 * message and left the tool row running for good.
 */
export interface SdkStreamedMessage {
  /** The SDK's own object from `run.stream()`, known here only by its tag; `SdkMessageSchema` is its contract. */
  readonly type: string
}

export function sdkMessageForWire(
  message: SdkStreamedMessage
): { message: SdkMessage } | { refused: string } {
  const parsed = SdkMessageSchema.safeParse(JSON.parse(JSON.stringify(message)))
  if (parsed.success) return { message: parsed.data }
  const issue = parsed.error.issues[0]
  return { refused: issue ? `${issue.path.join(".") || "message"}: ${issue.message}` : "invalid" }
}

/** The streamed deltas the transcript renders as they arrive; the rest of the SDK's update union is summarised by `SdkMessage`. */
export const SdkDeltaSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-delta"), text: z.string() }),
  z.object({ type: z.literal("thinking-delta"), text: z.string() }),
  z.object({ type: z.literal("thinking-completed") }),
  z.object({ type: z.literal("turn-ended") }),
])
export type SdkDelta = z.infer<typeof SdkDeltaSchema>

export const SdkRunResultSchema = z.object({
  runId: z.string(),
  status: z.enum(["finished", "error", "cancelled"]),
  error: z.object({ message: z.string(), code: z.string().optional() }).optional(),
  model: SdkModelSelectionSchema.optional(),
  durationMs: z.number().optional(),
  usage: SdkTokenUsageSchema.optional(),
})
export type SdkRunResult = z.infer<typeof SdkRunResultSchema>

export const SdkAuthStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("logged-out") }),
  z.object({
    status: z.literal("logged-in"),
    email: z.string().optional(),
    apiKeyExpiresAtMs: z.number().optional(),
  }),
])
export type SdkAuthStatus = z.infer<typeof SdkAuthStatusSchema>

/** How the SDK classified a failure; the host turns this into user guidance. */
export const SdkErrorKindSchema = z.enum([
  "authentication",
  "rate-limit",
  "configuration",
  "busy",
  "network",
  "not-found",
  "unknown",
])
export type SdkErrorKind = z.infer<typeof SdkErrorKindSchema>

export const SdkWireErrorSchema = z.object({
  message: z.string(),
  kind: SdkErrorKindSchema,
  code: z.string().optional(),
  retryable: z.boolean().optional(),
})
export type SdkWireError = z.infer<typeof SdkWireErrorSchema>

// ---------------------------------------------------------------------------
// Requests: host → child. One agent handle per child.

export const SdkImportSourceSchema = z.object({
  /** The legacy `store.db`. */
  path: z.string(),
  /** The legacy row's catalog identity, recorded on the agent so the two collapse. */
  identity: z.string(),
  /** The workspace and title the legacy row carried; the store itself records neither. */
  cwd: z.string().optional(),
  name: z.string().optional(),
})
export type SdkImportSource = z.infer<typeof SdkImportSourceSchema>

export const SdkOpenParamsSchema = z.object({
  cwd: z.string(),
  /** Mako's own state root; the SDK's default would scatter stores under `~/.cursor/projects`. */
  stateRoot: z.string(),
  agentId: z.string(),
  /** `true` creates the agent under `agentId`; `false` resumes the one that exists. */
  create: z.boolean(),
  name: z.string().optional(),
  model: SdkModelSelectionSchema.optional(),
  mcpServers: z.record(z.string(), SdkMcpServerSchema).optional(),
  /** Force HTTP/1.1 with SSE for the agent stream instead of HTTP/2. */
  http1: z.boolean().optional(),
  /**
   * With `create: false`: the `cursor-agent` store this agent continues. The
   * child copies it into the state root under `agentId` (or, when that id
   * already names another import, under a fresh id) the first time, and
   * resumes the agent it finds every time after.
   */
  importFrom: SdkImportSourceSchema.optional(),
})

export const SdkSendParamsSchema = z.object({
  /** Mako's id for the turn; every message, delta and result of the run carries it back. */
  turn: z.string(),
  text: z.string(),
  images: z.array(SdkImageSchema).optional(),
  model: SdkModelSelectionSchema.optional(),
})

export const SdkRequestSchema = z.discriminatedUnion("method", [
  z.object({ id: z.number(), method: z.literal("hello") }),
  z.object({ id: z.number(), method: z.literal("open"), params: SdkOpenParamsSchema }),
  z.object({ id: z.number(), method: z.literal("send"), params: SdkSendParamsSchema }),
  z.object({ id: z.number(), method: z.literal("steer"), params: z.object({ text: z.string() }) }),
  z.object({ id: z.number(), method: z.literal("cancel") }),
  z.object({ id: z.number(), method: z.literal("close") }),
  z.object({ id: z.number(), method: z.literal("models") }),
  z.object({ id: z.number(), method: z.literal("authStatus") }),
  z.object({ id: z.number(), method: z.literal("login") }),
  z.object({ id: z.number(), method: z.literal("logout") }),
  z.object({ id: z.number(), method: z.literal("me") }),
])
export type SdkRequest = z.infer<typeof SdkRequestSchema>
export type SdkMethod = SdkRequest["method"]

// ---------------------------------------------------------------------------
// Results: child → host, one per request.

export const SdkResultSchemas = {
  hello: z.object({ wire: z.number(), sdkVersion: z.string(), node: z.string() }),
  open: z.object({
    agentId: z.string(),
    model: SdkModelSelectionSchema.optional(),
    /** Set when this open copied a `cursor-agent` store into a new agent. */
    imported: z.boolean().optional(),
  }),
  send: z.object({ runId: z.string() }),
  steer: z.object({ outcome: z.enum(["complete_delivered", "revert_to_followup"]) }),
  cancel: z.object({}),
  close: z.object({}),
  models: z.object({ models: z.array(SdkModelListItemSchema) }),
  authStatus: SdkAuthStatusSchema,
  /**
   * The browser sign-in's minted key, handed to the host and nowhere else:
   * the child persists nothing (`store: null`), the host encrypts the key
   * with the OS keychain and passes it back to children in their environment.
   */
  login: z.object({
    apiKey: z.string(),
    email: z.string().optional(),
    apiKeyExpiresAtMs: z.number(),
  }),
  logout: z.object({}),
  me: z.object({
    email: z.string().optional(),
    name: z.string().optional(),
    apiKeyName: z.string(),
    createdAt: z.string(),
  }),
} satisfies Record<SdkMethod, z.ZodType>
export type SdkResult<Method extends SdkMethod> = z.infer<(typeof SdkResultSchemas)[Method]>

export const SdkResponseSchema = z.union([
  z.object({ id: z.number(), ok: z.literal(true), result: JsonValueSchema.optional() }),
  z.object({ id: z.number(), ok: z.literal(false), error: SdkWireErrorSchema }),
])
export type SdkResponse = z.infer<typeof SdkResponseSchema>

// ---------------------------------------------------------------------------
// Events: child → host, unsolicited.

export const SdkEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("message"), turn: z.string(), message: SdkMessageSchema }),
  z.object({ event: z.literal("delta"), turn: z.string(), delta: SdkDeltaSchema }),
  z.object({ event: z.literal("result"), turn: z.string(), result: SdkRunResultSchema }),
  z.object({ event: z.literal("login-url"), url: z.string() }),
  z.object({ event: z.literal("log"), level: z.enum(["info", "warn"]), message: z.string() }),
])
export type SdkEvent = z.infer<typeof SdkEventSchema>

/** Everything the child writes: a response or an event. */
export const SdkChildLineSchema = z.union([SdkResponseSchema, SdkEventSchema])
export type SdkChildLine = z.infer<typeof SdkChildLineSchema>
