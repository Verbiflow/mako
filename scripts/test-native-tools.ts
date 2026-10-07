import assert from "node:assert/strict"
import { VOCABULARIES } from "@mako/sessions/harnesses"
import { definedTools, diffDefinitions, NO_SOURCE, storedDefinitions, toolsAcross, type NativeDefinitions } from "./native-tools.ts"

/**
 * Holds each harness's tool vocabulary (packages/sessions/src/harnesses) to
 * the tools its newest recorded definitions carry. Record a new version with
 * `npm run harness:native-tools -- <harness>`.
 */

const version = (text: string) => /\d+(?:\.\d+)+/.exec(text)?.[0]

for (const vocabulary of VOCABULARIES) {
  const { harness } = vocabulary
  const newest = storedDefinitions(harness).at(-1)
  if (!newest) {
    assert.ok(NO_SOURCE.has(harness), `${harness} has no recorded definitions; run npm run harness:native-tools -- ${harness}, or say in NO_SOURCE why it can't`)
    continue
  }
  assert.ok(!NO_SOURCE.has(harness), `${harness} has recorded definitions, so NO_SOURCE shouldn't explain their absence`)
  assert.equal(version(vocabulary.checked.version), newest.version, `${harness}'s vocabulary was checked on ${vocabulary.checked.version}, its newest definitions are ${newest.version}`)

  const declaredAs = new Map<string, string>()
  for (const [name, tool] of Object.entries(vocabulary.tools)) for (const native of [name, ...tool.aliases ?? []]) declaredAs.set(native, name)
  const defined = new Map([...toolsAcross(newest)].filter(([, { tool }]) => !tool.placeholder).map(([key, entry]) => [key.split(".").at(-1)!, entry]))

  const undeclared = [...defined.keys()].filter((name) => !declaredAs.has(name))
  assert.deepEqual(undeclared, [], `${harness} ${newest.version} defines tools its vocabulary doesn't declare`)

  for (const [name, tool] of Object.entries(vocabulary.tools)) {
    const native = [name, ...tool.aliases ?? []].map((candidate) => defined.get(candidate)).find(Boolean)
    if (!native) {
      assert.ok(tool.unlisted, `${harness} declares ${name}, which ${newest.version} doesn't define; say why with unlisted`)
      continue
    }
    assert.ok(!tool.unlisted, `${harness} says ${name} is unlisted, but ${newest.version} defines it (in ${native.in.join(", ")})`)
    const parameters = native.tool.parameters
    if (!parameters) continue
    for (const [field, keys] of Object.entries(tool.keys ?? {}))
      assert.ok(keys.some((key) => key in parameters), `${harness} ${name}: no ${field} key (${keys.join(", ")}) is among its parameters (${Object.keys(parameters).join(", ")})`)
    const wraps = tool.wraps
    const wrapKeys = !wraps ? [] : wraps.form === "arguments" ? [wraps.tool, wraps.args, ...wraps.server ? [wraps.server] : []] : wraps.key ? [wraps.key] : []
    for (const key of wrapKeys) assert.ok(key in parameters, `${harness} ${name} wraps through ${key}, which isn't among its parameters (${Object.keys(parameters).join(", ")})`)
  }
}

// The diff between two versions names each kind of change.
const tool = (sha: string, parameters: Record<string, { type: string; required: boolean }>) =>
  ({ form: "function" as const, description: { chars: sha.length, sha }, parameters })
const before: NativeDefinitions = {
  harness: "example", version: "1.0.0", on: "2026-10-06", source: "test",
  configurations: [{ name: "default", tools: { read: tool("a", { path: { type: "string", required: true } }), gone: tool("b", {}) } }],
}
const after: NativeDefinitions = {
  ...before, version: "1.1.0",
  configurations: [{ name: "default", tools: { read: { ...tool("c", { path: { type: "string", required: false }, limit: { type: "number", required: false } }), deferred: true }, added: tool("d", {}) } }],
}
assert.deepEqual(diffDefinitions(before, after), [
  "default:",
  "  ~ read: now deferred",
  "  ~ read: description reworded (1 → 1 characters)",
  "  ~ read.path: now optional",
  "  + read.limit: number",
  "  - gone",
  "  + added",
])

// A code-mode script tool's description declares the tools its script calls.
const exec = {
  type: "custom", name: "exec",
  description: [
    "Run JavaScript.", "", "### `apply_patch`", "Edits files.", "", "exec tool declaration:", "```ts",
    "declare const tools: { apply_patch(input: string): Promise<unknown>; };", "```", "", "### `exec_command`", "Runs a command.", "",
    "exec tool declaration:", "```ts", "declare const tools: { exec_command(args: {", "  // Shell command.", "  cmd: string;",
    "  options?: Array<{", "  // Nested, not a parameter.", "  inner: string;", "}>;", "}): Promise<{ output: string }>; };", "```",
  ].join("\n"),
}
const nested = definedTools("responses", [{ type: "namespace", name: "functions", tools: [exec] }], (text) => text)
assert.deepEqual(Object.keys(nested), ["exec", "apply_patch", "exec_command"])
assert.equal(nested.apply_patch?.within, "exec")
assert.deepEqual(nested.exec_command?.parameters, { cmd: { type: "string", required: true }, options: { type: "array", required: false } })
assert.throws(() => definedTools("responses", [{ ...exec, description: `${exec.description}\ndeclare const tools: { odd(` }], (text) => text), /declares 3 nested tools/)

console.log("native tools: every vocabulary matches its newest recorded definitions")
