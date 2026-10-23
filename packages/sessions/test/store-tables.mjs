import assert from "node:assert/strict"
import { codexFork } from "../dist/providers/codex-fork.js"
import { devinFork } from "../dist/providers/devin-fork.js"
import { openCodeFork } from "../dist/providers/opencode-fork.js"

// Each harness names its store's own tables: rows that describe the database (its migration list, OpenCode's project),
// which no session owns. A store taking another's records keeps its own of them where the two differ (a cloud
// machine's harness made its database before this Mac's sessions arrived), and a fork leaves them as they are.
const ids = { from: "s-1", to: "s-2", derive: () => Buffer.alloc(32) }
const cases = [
  [openCodeFork, "opencode:opencode.db", ["project", "instruction_blob", "session_share", "migration", "__drizzle_migrations"], ["session", "message", "part", "event"]],
  [codexFork, "codex:state_5.sqlite", ["_sqlx_migrations"], ["threads", "thread_spawn_edges"]],
  [devinFork, "devin-cli:sessions.db", ["refinery_schema_history"], ["sessions", "messages"]],
]
for (const [fork, name, store, session] of cases) {
  for (const table of store) {
    assert.equal(fork.storeTable(name, table), true, `${name} ${table} is the store's`)
    assert.equal(fork.table(name, table, ids), "shared", `${name} ${table}: a fork leaves it as it is`)
  }
  for (const table of session) assert.equal(fork.storeTable(name, table), false, `${name} ${table} is a session's`)
  assert.equal(fork.storeTable("elsewhere:other.db", store[0]), false, "only in the harness's own database")
}
console.log("PASS: each harness names its store's own tables, which a fork leaves as they are and a store keeps as its own")
