import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { SDK_SCHEMAS, SDK_SCHEMAS_MARK, installedPackage, patchedModule, pristineName } from "./patch-sdk-schemas.mjs"

/**
 * The ACP and MCP packages' schemas are built on first use (`patch-sdk-schemas.mjs`). Each must still be the schema
 * its package shipped: here every exported one, once built, is held against the pristine module's, part by part down
 * to each literal, check and transform, and messages a session sends and receives parse to the same values, and are
 * refused with the same issues, through both. Importing a patched module builds none of the lazy ones.
 */
const ZodSchema = z.custom<z.ZodType>((value) => value instanceof z.ZodType)
/** Anything a schema's definition holds: another schema, a function, a pattern, a list, a record of parts, a value. */
type Part = NonNullable<object | string | number | boolean | bigint | symbol> | null | undefined
const isSchema = (value: Part): value is z.ZodType => ZodSchema.safeParse(value).success
const Version = z.object({ version: z.string() })
const Parts = z.record(z.string(), z.custom<Part>(() => true))

/** A lazy schema's own, however many times wrapped. */
function built(schema: z.ZodType): z.ZodType {
  let current = schema
  while (current instanceof z.ZodLazy) current = ZodSchema.parse(current.unwrap())
  return current
}

/** The two are one schema: every part of each definition, the schemas inside them built first. */
function same(left: Part, right: Part, path: string, held: Map<object, object>): void {
  if (isSchema(left) || isSchema(right)) {
    assert.ok(isSchema(left) && isSchema(right), `${path}: a schema on one side only`)
    const [mine, shipped] = [built(left), built(right)]
    if (held.get(mine) === shipped) return
    held.set(mine, shipped)
    return same(mine.def, shipped.def, path, held)
  }
  if (left instanceof Function || right instanceof Function || left instanceof RegExp || right instanceof RegExp)
    return assert.equal(String(left), String(right), `${path}: a function or a pattern differs`)
  if (left instanceof Set && right instanceof Set) return same([...left], [...right], path, held)
  if (Array.isArray(left) || Array.isArray(right)) {
    assert.ok(Array.isArray(left) && Array.isArray(right) && left.length === right.length, `${path}: lists of different lengths`)
    for (const [index, each] of left.entries()) same(each, right[index], `${path}[${index}]`, held)
    return
  }
  const [mine, shipped] = [Parts.safeParse(left), Parts.safeParse(right)]
  if (mine.success && shipped.success) {
    assert.deepEqual(Object.keys(mine.data), Object.keys(shipped.data), `${path}: its parts differ`)
    for (const key of Object.keys(mine.data)) same(mine.data[key], shipped.data[key], `${path}.${key}`, held)
    return
  }
  assert.deepEqual(left, right, `${path} differs`)
}

const MESSAGES = new Map<string, Array<[string, Part]>>(Object.entries({
  "@agentclientprotocol/sdk": [
    ["zInitializeRequest", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: true }, clientInfo: { name: "mako", version: "1" } }],
    ["zInitializeResponse", { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [{ id: "login", name: "Log in" }] }],
    ["zNewSessionRequest", { cwd: "/work", mcpServers: [{ name: "mako", command: "mako", args: ["mcp"], env: [{ name: "A", value: "b" }] }] }],
    ["zPromptRequest", { sessionId: "s1", prompt: [{ type: "text", text: "hello" }, { type: "resource_link", name: "a.ts", uri: "file:///work/a.ts" }] }],
    ["zSessionNotification", { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } }],
    ["zSessionNotification", { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", kind: "read", status: "pending", locations: [{ path: "/work/a.ts", line: 3 }] } }],
    ["zSessionNotification", { sessionId: "s1", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "done" } }] } }],
    ["zSessionNotification", { sessionId: "s1", update: { sessionUpdate: "plan", entries: [{ content: "one", priority: "high", status: "pending" }] } }],
    ["zRequestPermissionRequest", { sessionId: "s1", toolCall: { toolCallId: "t1" }, options: [{ optionId: "a", name: "Allow", kind: "allow_once" }] }],
    ["zRequestPermissionResponse", { outcome: { outcome: "selected", optionId: "a" } }],
    ["zPromptResponse", { stopReason: "end_turn" }],
    ["zCancelNotification", { sessionId: "s1" }],
    // Refused: a missing field, a wrong type, an unknown variant, not an object.
    ["zPromptRequest", { prompt: [{ type: "text" }] }],
    ["zSessionNotification", { sessionId: 4, update: { sessionUpdate: "no-such-update" } }],
    ["zInitializeRequest", "initialize"],
    ["zRequestPermissionResponse", { outcome: { outcome: "selected" } }],
  ],
  "@modelcontextprotocol/sdk": [
    ["JSONRPCMessageSchema", { jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "c" } }],
    ["JSONRPCMessageSchema", { jsonrpc: "2.0", id: "a", result: { tools: [] } }],
    ["JSONRPCMessageSchema", { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found", data: { method: "x" } } }],
    ["JSONRPCMessageSchema", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "stopped" } }],
    ["InitializeResultSchema", { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mako", version: "1.0.0" }, instructions: "Use them." }],
    ["ListToolsResultSchema", { tools: [{ name: "js", description: "Run a program", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] }, annotations: { readOnlyHint: false } }] }],
    ["CallToolResultSchema", { content: [{ type: "text", text: "done" }, { type: "image", data: "aGk=", mimeType: "image/png" }], isError: false, structuredContent: { ok: true } }],
    ["CallToolResultSchema", { content: [{ type: "resource_link", uri: "file:///a", name: "a" }] }],
    ["ToolSchema", { name: "show", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: {} }, _meta: { a: 1 } }],
    ["ElicitResultSchema", { action: "accept", content: { name: "x", count: 2, yes: true } }],
    // Refused: no version, content of no known type, a tool without its schema, not an object.
    ["JSONRPCMessageSchema", { id: 1, method: "tools/list" }],
    ["CallToolResultSchema", { content: [{ type: "video", data: "x" }] }],
    ["ListToolsResultSchema", { tools: [{ name: "js" }] }],
    ["InitializeResultSchema", null],
  ],
}))

for (const target of SDK_SCHEMAS) {
  const root = installedPackage(target.package)
  assert.ok(root, `${target.package} is installed in this checkout`)
  const { version } = Version.parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")))
  assert.equal(version, target.version, `${target.package} is ${version}: read its schemas again, then move patch-sdk-schemas.mjs to it`)
  const folder = join(root, target.build)
  const installed = readFileSync(join(folder, target.module), "utf8")
  assert.ok(installed.startsWith(SDK_SCHEMAS_MARK), `${target.package} is patched (node scripts/patch-sdk-schemas.mjs)`)
  // What's installed is the patch of what shipped: nothing else in the module moved.
  assert.equal(installed, patchedModule(root, target, readFileSync(join(folder, pristineName(target.module)), "utf8")))

  const patched = Parts.parse({ ...(await import(pathToFileURL(join(folder, target.module)).href)) })
  const pristine = Parts.parse({ ...(await import(pathToFileURL(join(folder, pristineName(target.module))).href)) })
  assert.deepEqual(Object.keys(patched).sort(), Object.keys(pristine).sort(), `${target.package}'s module exports what it did`)
  const names = Object.keys(pristine).filter((name) => isSchema(pristine[name]))
  const lazy = names.filter((name) => patched[name] instanceof z.ZodLazy && !(pristine[name] instanceof z.ZodLazy))
  assert.equal(lazy.length, target.lazy, `${target.package}: ${target.lazy} schemas are built on first use`)
  const held = new Map<object, object>()
  for (const name of names) same(patched[name], pristine[name], name, held)
  // A schema left whole is the schema itself, with the shape a handler's registration reads.
  for (const name of names.filter((each) => !lazy.includes(each))) assert.equal(Object.getPrototypeOf(patched[name]), Object.getPrototypeOf(pristine[name]), `${name} stays whole`)

  // And through the door a session uses: the same values out, the same refusals.
  const messages = MESSAGES.get(target.package) ?? []
  let accepted = 0
  for (const [name, message] of messages) {
    const [mine, shipped] = [patched[name], pristine[name]]
    assert.ok(isSchema(mine) && isSchema(shipped), `${name} is a schema of ${target.package}`)
    const [got, wanted] = [mine.safeParse(message), shipped.safeParse(message)]
    assert.equal(got.success, wanted.success, `${name} takes or refuses ${JSON.stringify(message)} as it did`)
    assert.deepEqual(got.data, wanted.data, `${name} parses to what it did`)
    assert.deepEqual(got.error?.issues, wanted.error?.issues, `${name} refuses for what it did`)
    if (got.success) accepted += 1
  }
  assert.ok(accepted >= 8 && messages.length - accepted >= 3, `${target.package}'s messages are taken and refused both (${accepted} of ${messages.length} taken)`)
  console.log(`sdk schemas: ${target.package} ${version}, ${lazy.length} of ${names.length} built on first use, each the package's own; ${messages.length} messages parse and are refused as they were`)
}
