import assert from "node:assert/strict"
import { join } from "node:path"
import { normalizeCursorSdkModels } from "@mako/sessions"
import { cursorSdkNativeRunner } from "../electron/providers/cursor/sdk/native-runner.ts"
import { CURSOR_SDK_HEADLESS, SdkHeadlessSpecSchema } from "../electron/providers/cursor/sdk/wire.ts"
import type { NativeCommand } from "../electron/providers/native-runner.ts"

/**
 * Cursor's headless runs start Mako's SDK child in its one-shot mode with the
 * selection the live driver would send. Checked live on 2026-10-01: a fresh
 * run answered and exited 0, and a resume of the agent it created recalled
 * what the first was told.
 */

const catalog = normalizeCursorSdkModels([
  { id: "composer-2", displayName: "Composer 2", parameters: [{ id: "thinking", values: [{ value: "low" }, { value: "high" }] }] },
  { id: "gpt-6", displayName: "GPT 6" },
])
const fallback = catalog.defaultModel ?? catalog.models[0]!.id
const home = "/home/user"
const runner = cursorSdkNativeRunner({
  childLaunch: async () => ({ env: { PATH: "/usr/bin", HOME: home, SECRET_ELSEWHERE: "x", CURSOR_API_KEY: "key" }, credential: { kind: "unavailable", reason: "Fixture credential" } }),
  stateRoot: () => "/state",
  models: async () => catalog,
  home,
})
const spec = (command: NativeCommand) => SdkHeadlessSpecSchema.parse(JSON.parse(command.args[2]!))

assert.equal(runner.available(), true, "the SDK ships inside Mako")
const fresh = await runner.fresh("hello", {})
assert.equal(fresh.args[1], CURSOR_SDK_HEADLESS)
assert.match(fresh.args[0]!, /child\.(js|ts)$/)
assert.deepEqual(fresh.env, { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", CURSOR_API_KEY: "key" }, "only what the child needs rides the command")
assert.deepEqual({ ...spec(fresh), agentId: "new" }, { agentId: "new", create: true, prompt: "hello", stateRoot: "/state", model: { id: fallback } },
  "local agents need a model, so none selected is the account's default")

const plain = spec(await runner.resume("agent-1", "again", { nativePath: "/state/agents/agent-1/store.db" }))
assert.equal(plain.create, false)
assert.equal(plain.importFrom, undefined, "an SDK store resumes in place")
const legacyPath = join(home, ".cursor", "chats", "hash", "legacy-1", "store.db")
const legacy = spec(await runner.resume("legacy-1", "again", { nativePath: legacyPath }))
assert.equal(legacy.importFrom?.path, legacyPath, "a cursor-agent store is imported the first time it runs here")
assert.ok(legacy.importFrom?.identity, "the import records the thread it came from")

let checked = 0
for (const model of catalog.models) {
  const selections = [{ model: model.id }, ...model.options.flatMap((option) =>
    option.kind === "select" ? option.values.map((choice) => ({ model: model.id, options: { [option.id]: choice.value } })) : [])]
  for (const selection of selections) {
    const prepared = await runner.prepare!(selection, {})
    assert.deepEqual(prepared.dropped, [], `${JSON.stringify(selection)} drops nothing the model offers`)
    const back = runner.describe(await runner.resume("agent-1", "hi", prepared.options), catalog.models)
    assert.equal(back.model, model.id, `${JSON.stringify(selection)}: the command names the model`)
    for (const [id, value] of Object.entries(selection.options ?? {}))
      assert.equal(back.options?.[id], value, `${JSON.stringify(selection)}: the command states ${id}`)
    checked++
  }
}
assert.ok(checked >= 4)

assert.deepEqual((await runner.prepare!({ model: "gpt-6", options: { thinking: "high" } }, {})).dropped, ["thinking"], "an option the model lacks is named")
await assert.rejects(runner.prepare!({ model: "retired" }, {}), /Cursor does not offer the model "retired"/)
const admittedEnv = { CURSOR_API_KEY: "admitted-fixture-account" }
let fallbackReads = 0
const admitted = cursorSdkNativeRunner({
  childLaunch: async () => { fallbackReads++; return { env: { CURSOR_API_KEY: "later-selection" }, credential: { kind: "unavailable", reason: "Fixture credential" } } },
  stateRoot: () => "/state",
  models: async env => { assert.equal(env.CURSOR_API_KEY, admittedEnv.CURSOR_API_KEY); return catalog },
})
const preparedAccount = await admitted.prepare!({}, admittedEnv)
const accountCommand = await admitted.resume("agent-1", "one admitted reply", preparedAccount.options, admittedEnv)
assert.equal(accountCommand.env?.CURSOR_API_KEY, admittedEnv.CURSOR_API_KEY)
assert.equal(fallbackReads, 0, "preparation and command building must not reread a later selected account")
assert.deepEqual(runner.describe({ command: "x", args: ["child.js", CURSOR_SDK_HEADLESS, "not json"] }, catalog.models), {})

console.log(`PASS: Cursor's headless runner starts the SDK child with the live selection (${checked} selections read back), resumes and imports, and names what it drops`)
