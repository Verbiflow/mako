import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { SessionCatalog } from "../dist/catalog.js"
import { CodexProvider } from "../dist/providers/codex.js"

const home = await mkdtemp(join(tmpdir(), "mako-native-rename-"))
try {
  // Codex's rename (`thread/name/set`, or naming a new thread) writes the
  // name to state_5.sqlite and appends it to session_index.jsonl. The rollout
  // is untouched, so its stat alone never says the row's title changed.
  const id = "01a0e752-670b-7900-8d93-804fefadacbd"
  const dated = join(home, ".codex", "sessions", "2026", "09", "28")
  const rollout = join(dated, `rollout-2026-09-28T02-22-12-${id}.jsonl`)
  const nameLog = join(home, ".codex", "session_index.jsonl")
  await mkdir(dated, { recursive: true })
  const line = (type, payload) => `${JSON.stringify({ timestamp: "2026-09-28T09:22:12Z", type, payload })}\n`
  await writeFile(rollout, line("session_meta", { id, cwd: home }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with just the word ok." }] }))
  const state = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, rollout_path TEXT)")
  state.prepare("INSERT INTO threads VALUES (?, NULL, 'Reply with just the word ok.', ?, ?, 'user', ?)").run(id, home, Date.now(), rollout)

  const catalog = new SessionCatalog([new CodexProvider(home)])
  const events = []
  catalog.onEvent((event) => events.push(event))
  const [before] = await catalog.scan()
  assert.equal(before.title, "Reply with just the word ok.")
  catalog.startWatching()
  await delay(200)

  // The first name makes session_index.jsonl; later ones append to it.
  const titled = async (title) => {
    const at = Date.now()
    while (!events.some((event) => event.type === "updated" && event.ref.title === title) && Date.now() - at < 6000) await delay(25)
    return Date.now() - at
  }
  const rename = async (title) => {
    state.prepare("UPDATE threads SET name = ? WHERE id = ?").run(title, id)
    await appendFile(nameLog, `${JSON.stringify({ id, thread_name: title, updated_at: new Date().toISOString() })}\n`)
    return titled(title)
  }
  const named = await rename("Renamed in Codex")
  assert.ok(named < 6000, `the first name reaches the row (${named} ms)`)
  const renamed = await rename("Renamed again")
  assert.ok(renamed < 6000, `a later rename reaches the row (${renamed} ms)`)
  const sweep = await new SessionCatalog([new CodexProvider(home)]).scan()
  assert.equal(sweep[0].title, "Renamed again")
  await catalog.stop()
  state.close()
  console.log(`Native rename: a Codex rename that leaves the rollout alone reaches the row (${named} ms first, ${renamed} ms after)`)
} finally {
  await rm(home, { recursive: true, force: true })
}
