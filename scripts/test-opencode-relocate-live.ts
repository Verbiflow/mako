import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createOpenCodeDriver } from "../electron/providers/opencode/live-driver.ts"
import { accessModeId } from "../electron/contracts/access.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"

// An OpenCode session going on in another folder, as a Thread's move into its
// worktree needs: real OpenCode v2 through Mako's driver, in disposable
// stores, with the free hosted model. A session made in one folder resumes in
// another under the same ID, remembers its turns, and runs its tools there.
const executable = process.env.OPENCODE_BIN_PATH ?? join(homedir(), ".opencode/bin/opencode2")
if (!existsSync(executable)) {
  console.log(`opencode relocate: skipped, OpenCode v2 is not at ${executable}`)
  process.exit(0)
}
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-opencode-relocate-")))
const model = process.env.MAKO_OPENCODE_MODEL ?? "opencode/space-bunny-free"
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_BIN_PATH: executable, OPENCODE_CONFIG_CONTENT: "{}" }
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"]) {
  env[name] = join(root, name)
  await mkdir(env[name]!, { recursive: true })
}
const main = join(root, "main")
const worktree = join(root, "worktree")
await mkdir(main)
await mkdir(worktree)
const driver = createOpenCodeDriver({ env: async () => ({ ...env }), approvalRoot: async () => join(root, "approvals") })

function conversation() {
  const id = randomUUID()
  const events: LiveDriverEvent[] = []
  const state = (): LiveSessionState => {
    const last = events.findLast(event => event.type === "live-session")
    assert.ok(last && last.type === "live-session")
    return last.session
  }
  return { id, events, state, emit: (event: LiveDriverEvent) => { events.push(event) } }
}

async function turn(chat: ReturnType<typeof conversation>, text: string) {
  const from = chat.events.length
  await driver.prompt(chat.id, text, [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
  const deadline = Date.now() + 180_000
  while (!(chat.state().status !== "running" && chat.events.slice(from).some(event => event.type === "live-session" && event.session.status === "running"))) {
    if (Date.now() > deadline) throw new Error(`Timed out on ${JSON.stringify(text)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const updates = chat.events.slice(from).flatMap(event => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
  return {
    state: chat.state(),
    prose: updates.flatMap(update => update.kind === "text" ? [update.text] : []).join(""),
    output: JSON.stringify(updates.filter(update => update.kind === "tool-update")),
  }
}

const word = `heron${Date.now() % 10_000}`
const chats: string[] = []
try {
  const first = conversation()
  chats.push(first.id)
  const opened = await driver.start(main, { conversationId: first.id, emit: first.emit, tuning: { model }, title: "Relocate", modeId: accessModeId("full") })
  const told = await turn(first, `Remember this word: ${word}. Reply with exactly: noted`)
  assert.equal(told.state.lastStop, "end_turn", told.state.error)
  await driver.close(first.id)

  const moved = conversation()
  chats.push(moved.id)
  const again = await driver.start(worktree, {
    conversationId: moved.id, emit: moved.emit, tuning: { model }, title: "Relocate", modeId: accessModeId("full"),
    resume: opened.nativeId!, threadPath: opened.nativePath!,
  })
  assert.equal(again.nativeId, opened.nativeId, "the same native session goes on")
  const recall = await turn(moved, "Use the bash tool to run exactly: pwd\nThen reply with the word I asked you to remember, and nothing else.")
  assert.equal(recall.state.lastStop, "end_turn", recall.state.error)
  assert.match(recall.prose, new RegExp(word), "it remembers its turns from the first folder")
  assert.ok(recall.output.includes(worktree), `its tools run in the new folder: ${recall.output.slice(0, 600)}`)
  assert.ok(!recall.output.includes(`${main}\\n`) && !recall.output.includes(`"${main}"`), "not in the old one")
  console.log("opencode relocate: resumed in the new folder under the same id, with its turns, running its tools there")
} finally {
  for (const id of chats) await Promise.resolve(driver.close(id)).catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
