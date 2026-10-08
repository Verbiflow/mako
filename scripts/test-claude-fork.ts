import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readClaudeForkPoint } from "../electron/providers/claude/sdk-transcript.js"

const root = await mkdtemp(join(tmpdir(), "mako-claude-fork-"))
const sessionId = randomUUID()
const path = join(root, `${sessionId}.jsonl`)
const answer = randomUUID()
const carrier = randomUUID()
const output = randomUUID()
const entry = (
  uuid: string,
  parentUuid: string | null,
  type = "assistant"
) => ({
  type,
  uuid,
  parentUuid,
  sessionId,
  isSidechain: false,
})
const rows = [
  entry(answer, null),
  entry(carrier, answer, "user"),
  entry(output, carrier, "attachment"),
  { type: "last-prompt", sessionId, leafUuid: output },
]
const save = (values: unknown[], suffix = "") =>
  writeFile(
    path,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n${suffix}`
  )
try {
  await save(rows)
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), output)
  await save(rows.slice(0, -1))
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined)
  await save([
    ...rows,
    { type: "custom-title", sessionId, customTitle: "Test" },
  ])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), output)
  await save([...rows, { ...entry(randomUUID(), carrier), isSidechain: true }])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), output)
  await save([...rows, entry(randomUUID(), answer)])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined)
  await save(rows, '{"type":')
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined)
  await save([
    ...rows,
    { ...entry(randomUUID(), output), message: "x".repeat(1024 * 1024) },
  ])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined)
  await save([
    { type: "tool-output", text: "x".repeat(17 * 1024 * 1024) },
    ...rows,
  ])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), output)
  assert.equal(
    await readClaudeForkPoint(path, sessionId, randomUUID()),
    undefined
  )
  assert.equal(await readClaudeForkPoint(path, randomUUID(), answer), undefined)
  // A later turn as Claude Code 2.1.293 has it when its result arrives: the
  // closing summary is written, the leaf still names the previous turn's end.
  const previous = randomUUID()
  const prompt = randomUUID()
  const closing = randomUUID()
  const later = [
    entry(previous, null, "system"),
    { type: "last-prompt", sessionId, leafUuid: previous },
    entry(prompt, previous, "user"),
    entry(answer, prompt),
    entry(closing, answer, "system"),
  ]
  await save(later)
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), closing, "a leaf Claude hasn't moved up yet is on the chain")
  const branch = randomUUID()
  await save([entry(branch, null, "system"), ...later, { type: "last-prompt", sessionId, leafUuid: branch }])
  assert.equal(await readClaudeForkPoint(path, sessionId, answer), undefined, "a leaf on another branch means the chain moved")
  console.log(
    "PASS: Claude fork keeps tool carriers and output attachments, bounds native tails, accepts a leaf that lags its chain, and refuses torn or ambiguous chains"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
