import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionCatalog } from "../dist/catalog.js"
import { ClaudeProvider } from "../dist/providers/claude.js"
import { GrokProvider } from "../dist/providers/grok.js"

// A thread is as fresh as its last message. Provider files change for other
// reasons — a CLI flushing bookkeeping as it exits, a TUI rewriting a sidecar
// — and none of those may move a row in the rail.

// The Claude provider also reads CLAUDE_CONFIG_DIR; a shell inside Claude
// Code sets it, and the user's real sessions would then sort among the
// fixtures. This check is about the fixtures only.
delete process.env.CLAUDE_CONFIG_DIR

const line = (value) => `${JSON.stringify(value)}\n`
const now = Date.now()
const iso = (offsetMs) => new Date(now + offsetMs).toISOString()
const touch = async (path, at) => {
  const date = new Date(at)
  await utimes(path, date, date)
}
const home = await mkdtemp(join(tmpdir(), "mako-activity-stamps-"))
try {
  // ---------------------------------------------------------------- Claude
  const projects = join(home, ".claude", "projects", "-Users-kashyab-pi-ui")
  await mkdir(projects, { recursive: true })
  const message = (sessionId, type, text, at) =>
    line({
      type,
      uuid: `${sessionId}-${type}-${at}`,
      sessionId,
      cwd: "/Users/kashyab/pi-ui",
      timestamp: at,
      message: {
        role: type,
        ...(type === "assistant" ? { model: "claude-opus-5" } : {}),
        content: [{ type: "text", text }],
      },
    })
  const idle = join(projects, "idle-session.jsonl")
  const fresh = join(projects, "fresh-session.jsonl")
  const idleAnsweredAt = iso(-90_000)
  const freshAnsweredAt = iso(-60_000)
  await writeFile(
    idle,
    message("idle-session", "user", "Fix the rail order", iso(-120_000)) +
      message("idle-session", "assistant", "Looking.", idleAnsweredAt)
  )
  await writeFile(
    fresh,
    message("fresh-session", "user", "Check the relay", iso(-70_000)) +
      message("fresh-session", "assistant", "Checking.", freshAnsweredAt)
  )
  // The idle file was written after the fresh one; mtime alone would put it first.
  await touch(fresh, now - 60_000)
  await touch(idle, now - 10_000)

  const claude = new ClaudeProvider(home)
  assert.equal(claude.activityFromContent, true)
  const catalog = new SessionCatalog([claude], { cachePath: join(home, "claude-cache.json") })
  const events = []
  catalog.onEvent((event) => events.push(event))
  const scanned = await catalog.scan()
  assert.deepEqual(
    scanned.map((ref) => [ref.nativeId, ref.updatedAt]),
    [
      ["fresh-session", freshAnsweredAt],
      ["idle-session", idleAnsweredAt],
    ],
    "a session is as fresh as its last message, whatever the file's mtime"
  )
  assert.equal(scanned[1].title, "Fix the rail order")
  assert.equal(scanned[1].model, "claude-opus-5")

  // The resident CLI exits — a host restart, an install — and flushes its
  // bookkeeping into the idle session. The file grew; the conversation did not.
  await appendFile(
    idle,
    line({ type: "last-prompt", lastPrompt: "Fix the rail order", leafUuid: "leaf-1", sessionId: "idle-session" }) +
      line({ type: "cost-state", sessionId: "idle-session", totalCostUSD: 1.5 })
  )
  await touch(idle, now + 3_600_000)
  // The watcher's path: a grown file reuses its ref and refines it.
  await catalog.reconcileActive(now)
  const grownIdle = catalog.list().find((ref) => ref.nativeId === "idle-session")
  assert.equal(grownIdle.bytes, (await stat(idle)).size, "the grown file was refreshed")
  assert.equal(grownIdle.updatedAt, idleAnsweredAt, "exit-time records do not move the row")
  assert.deepEqual(
    catalog.list().map((ref) => ref.nativeId),
    ["fresh-session", "idle-session"],
    "the idle thread stays below the one used more recently"
  )
  assert.equal(events.at(-1)?.type, "updated")
  assert.equal(events.at(-1)?.ref.updatedAt, idleAnsweredAt, "the event carries the held stamp too")

  // A cold peek of the same file, with no cache to lean on, says the same.
  const cold = new SessionCatalog([claude])
  const repeeked = (await cold.scan()).find((ref) => ref.nativeId === "idle-session")
  assert.equal(repeeked.updatedAt, idleAnsweredAt, "a cold peek reads the last message too")
  await cold.stop()

  // A real reply moves the row, to the reply's own time.
  const repliedAt = iso(-30_000)
  await appendFile(idle, message("idle-session", "assistant", "Done.", repliedAt))
  await touch(idle, now + 7_200_000)
  await catalog.reconcileActive(now)
  assert.deepEqual(
    catalog.list().map((ref) => [ref.nativeId, ref.updatedAt]),
    [
      ["idle-session", repliedAt],
      ["fresh-session", freshAnsweredAt],
    ],
    "a new message is the new stamp and the row climbs"
  )

  // A subagent's chatter is not the user's conversation.
  await appendFile(
    idle,
    line({
      type: "assistant",
      uuid: "side-1",
      sessionId: "idle-session",
      isSidechain: true,
      timestamp: iso(-5_000),
      message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "sidechain" }] },
    })
  )
  await touch(idle, now + 10_800_000)
  await catalog.reconcileActive(now)
  assert.equal(
    catalog.list().find((ref) => ref.nativeId === "idle-session").updatedAt,
    repliedAt,
    "sidechain lines do not count as activity"
  )

  // A file with no message in it at all still has a time: the file's own.
  const placeholder = join(projects, "placeholder.jsonl")
  await writeFile(
    placeholder,
    line({ type: "summary", summary: "Untitled", sessionId: "placeholder", leafUuid: "leaf-0" }) +
      line({ type: "last-prompt", sessionId: "placeholder", leafUuid: "leaf-0" })
  )
  const placeholderInfo = await stat(placeholder)
  const peekedPlaceholder = await claude.peek({
    path: placeholder,
    bytes: placeholderInfo.size,
    mtimeMs: placeholderInfo.mtimeMs,
  })
  assert.equal(
    peekedPlaceholder?.updatedAt,
    new Date(placeholderInfo.mtimeMs).toISOString(),
    "no message means the file's time, never an empty stamp"
  )
  await catalog.stop()

  // ------------------------------------------------------------------ Grok
  const sessionId = "01a08dbe-aedc-7423-99a5-f768af93cb5e"
  const sessionDir = join(home, ".grok", "sessions", encodeURIComponent("/Users/kashyab/flage"), sessionId)
  await mkdir(sessionDir, { recursive: true })
  const transcript = join(sessionDir, "updates.jsonl")
  const transcriptAt = now - 24 * 3_600_000
  await writeFile(transcript, "")
  await touch(transcript, transcriptAt)
  const summary = (title, updatedAt) =>
    JSON.stringify({
      info: { id: sessionId, cwd: "/Users/kashyab/flage" },
      generated_title: title,
      created_at: iso(-48 * 3_600_000),
      updated_at: updatedAt,
      last_active_at: iso(-23 * 3_600_000),
      current_model_id: "grok-4.6",
    })
  await writeFile(join(sessionDir, "summary.json"), summary("Rebooted hung shorts box", iso(0)))

  const grok = new GrokProvider(home)
  const grokCatalog = new SessionCatalog([grok], { cachePath: join(home, "grok-cache.json") })
  const [held] = await grokCatalog.scan()
  assert.equal(held.updatedAt, new Date(transcriptAt).toISOString(), "the transcript's time, not the sidecar's")
  assert.equal(held.title, "Rebooted hung shorts box")

  // An open TUI rewrites summary.json every minute or so; the transcript has not moved.
  await writeFile(
    join(sessionDir, "summary.json"),
    summary("Rebooted hung shorts box, wrote clip post", iso(60_000))
  )
  const [rewritten] = await grokCatalog.scan({ emitChanges: true })
  assert.equal(rewritten.updatedAt, new Date(transcriptAt).toISOString(), "a sidecar rewrite does not move the row")
  assert.equal(rewritten.title, "Rebooted hung shorts box, wrote clip post", "the sidecar still names the row")
  const refinedRef = await grok.refine(rewritten, rewritten.bytes)
  assert.equal(refinedRef.updatedAt, rewritten.updatedAt, "refine keeps the transcript's time")
  await grokCatalog.stop()

  console.log("activity stamps: ok")
} finally {
  await rm(home, { recursive: true, force: true })
}
