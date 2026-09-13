import assert from "node:assert/strict"
import { mkdtemp, writeFile, appendFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexProvider } from "../dist/providers/codex.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
const home = await mkdtemp(join(tmpdir(), "mako-settings-native-"))
const line = (value) => JSON.stringify(value) + "\n"
async function peek(provider, path) {
  const file = await stat(path)
  return provider.peek({ path, bytes: file.size, mtimeMs: file.mtimeMs })
}
try {
  const codex = new CodexProvider(home)
  const path = join(home, "codex.jsonl")
  await writeFile(path, line({ type: "session_meta", payload: { id: "test", cwd: home } }) +
    line({ type: "turn_context", payload: { model: "old", effort: "low", service_tier: "default" } }) +
    line({ type: "event_msg", payload: { type: "user_message", message: "hello" } }))
  await appendFile(path, "\n".repeat(3 * 1024 * 1024))
  assert.deepEqual((await peek(codex, path)).settings, {}, "an old head cannot be presented as a current setting")
  await appendFile(path, line({ type: "turn_context", payload: { model: "new", effort: "high", service_tier: "fast" } }))
  assert.deepEqual((await peek(codex, path)).settings, { model: "new", options: { effort: "high", serviceTier: "priority" } })
  // Codex 0.147+ writes the tier only in `thread_settings_applied`, before a
  // `turn_context` that carries the effort; both describe one turn.
  await appendFile(path,
    line({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-sol", reasoning_effort: "high", service_tier: "default" } } }) +
    line({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "high" } }))
  assert.deepEqual((await peek(codex, path)).settings, { model: "gpt-5.6-sol", options: { effort: "high", serviceTier: "default" } })
  await appendFile(path,
    line({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model: "gpt-5.6-sol", reasoning_effort: "xhigh", service_tier: "fast" } } }) +
    line({ type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "xhigh" } }))
  assert.deepEqual((await peek(codex, path)).settings, { model: "gpt-5.6-sol", options: { effort: "xhigh", serviceTier: "priority" } }, "the latest applied settings win")
  await appendFile(path, line({ type: "turn_context", payload: { model: "other", effort: "low" } }))
  assert.deepEqual((await peek(codex, path)).settings, { model: "other", options: { effort: "low" } }, "a turn on another model does not inherit the previous tier")
  assert.equal(codex.peekVersion, 1, "cached rows peeked before the tier was read must be peeked again")
  const claude = new ClaudeProvider(home)
  const claudePath = join(home, "claude.jsonl")
  await writeFile(claudePath, line({ type: "user", sessionId: "claude", message: { content: "hello" } }) +
    line({ type: "assistant", message: { model: "old" } }) +
    line({ type: "assistant", effort: "high", message: { model: "new", usage: { speed: "standard" } } }) +
    line({ type: "assistant", isSidechain: true, message: { model: "subagent" } }))
  assert.deepEqual((await peek(claude, claudePath)).settings, { model: "new", options: { effort: "high", fast: false } })
  await writeFile(claudePath, line({type:"attachment", padding:"x".repeat(300_000)}) +
    line({type:"user", sessionId:"late-header", cwd:home, message:{content:"A prompt after large attachments"}}) +
    line({type:"assistant", effort:"high", message:{model:"fable",usage:{speed:"standard"}}}))
  const late = await peek(claude, claudePath)
  assert.equal(late.cwd, home)
  assert.equal(late.title, "A prompt after large attachments")
  assert.deepEqual(late.settings, {model:"fable", options:{effort:"high",fast:false}})

  console.log("Native settings: latest turn wins, subagents are excluded, stale heads stay unknown, and speed aliases normalize")
} finally { await rm(home, { recursive: true, force: true }) }
