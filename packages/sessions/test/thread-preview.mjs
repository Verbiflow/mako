import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionCatalog } from "../dist/catalog.js"
import { CodexProvider } from "../dist/providers/codex.js"

const home = await mkdtemp(join(tmpdir(), "mako-thread-preview-"))
try {
  const sessions = join(home, ".codex", "sessions", "2026", "09", "22")
  await mkdir(sessions, { recursive: true })
  const id = "01a0b000-0000-7000-8000-000000000001"
  const rollout = join(sessions, `rollout-2026-09-22T00-00-00-${id}.jsonl`)
  const line = (type, payload) => `${JSON.stringify({ timestamp: "2026-09-22T00:00:00Z", type, payload })}\n`
  const exchange = (turn, outputBytes) =>
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `Prompt ${turn}` }] }) +
    line("response_item", { type: "function_call", call_id: `call-${turn}`, name: "exec_command", arguments: JSON.stringify({ cmd: `step ${turn}` }) }) +
    line("response_item", { type: "function_call_output", call_id: `call-${turn}`, output: "x".repeat(outputBytes) }) +
    line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: `Answer ${turn}` }] })

  // Big exchanges first so the 2 MB tail window starts inside one: the
  // preview must drop the tool result it holds without the call that made it.
  let body = line("session_meta", { id, cwd: home }) + line("turn_context", { model: "gpt-5.6-sol" })
  for (let turn = 0; turn < 12; turn += 1) body += exchange(turn, 700 * 1024)
  for (let turn = 12; turn < 40; turn += 1) body += exchange(turn, 4 * 1024)
  await writeFile(rollout, body)

  const shape = { toolOutputChars: 1024, maxChars: 384 * 1024 }
  const catalog = new SessionCatalog([new CodexProvider(home)], { cachePath: join(home, "cache.json") })
  await catalog.scan()

  const preview = await catalog.page(rollout, undefined, 100, { ...shape, preview: true })
  assert.ok(preview, "a large cold record previews from its tail")
  assert.equal(preview.preview, true)
  assert.equal(preview.hasEarlier, true)
  assert.equal(preview.checkpoint, undefined, "a preview never names a follow offset")
  assert.equal(preview.ref.path, rollout)

  const full = await catalog.page(rollout, undefined, 100, shape)
  assert.ok(full && !full.preview)
  assert.ok(preview.entries.length > 0 && preview.entries.length <= full.entries.length)
  const newest = full.entries.slice(-preview.entries.length)
  assert.deepEqual(preview.entries, newest, "the preview is exactly the newest exchanges of the full page")
  if (preview.start === 0) assert.equal(preview.entries[0]?.kind, "user", "an unshaped preview opens on a prompt")

  const raw = await new CodexProvider(home).tail(rollout, Buffer.byteLength(body) - 2 * 1024 * 1024)
  assert.notEqual(raw.entries[0]?.kind, "user", "the fixture's window starts mid-exchange, so the cut is exercised")

  assert.equal(
    await catalog.page(rollout, undefined, 100, { ...shape, preview: true }),
    null,
    "a warm translation is served as the full page instead"
  )

  await appendFile(rollout, exchange(40, 1024))
  const grown = await catalog.page(rollout, undefined, 100, { ...shape, preview: true })
  assert.ok(grown?.entries.some((entry) => entry.kind === "user" && entry.text === "Prompt 40"), "growth makes the warm translation stale")

  const small = join(sessions, `rollout-2026-09-22T01-00-00-01a0b000-0000-7000-8000-000000000002.jsonl`)
  await writeFile(small, line("session_meta", { id: "small", cwd: home }) + exchange(0, 1024))
  await catalog.scan()
  assert.equal(await catalog.page(small, undefined, 100, { ...shape, preview: true }), null, "a small record reads whole")
} finally {
  await rm(home, { recursive: true, force: true })
}

console.log("Thread previews: large cold records paint their newest exchanges from a prompt-aligned tail")
