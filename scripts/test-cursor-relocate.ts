import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, Cursor } from "@cursor/sdk"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"
import { relocateCursorAgent } from "../electron/providers/cursor/sdk/import.ts"

/**
 * A Cursor agent goes on in the folder it resumes in, against the real SDK
 * store: saved under one folder, the SDK refuses to resume it from another
 * until Mako files it there, and then resumes it under the same id with its
 * checkpoint, from the new folder only.
 */

const root = mkdtempSync(join(tmpdir(), "mako-fixture-cursor-relocate-"))
const stateRoot = join(root, "state")
const main = join(root, "main")
const worktree = join(root, "worktree")
mkdirSync(main)
mkdirSync(worktree)
const agentId = "agent-relocate-0000-4000-8000-000000000001"
const checkpoint = { schemaVersion: 1 as const, rootBlobId: "root-blob" }

async function resume(cwd: string) {
  const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot })
  Cursor.configure({ local: { store } })
  try {
    const handle = await Agent.resume(agentId, { apiKey: "test-key", local: { cwd, store } })
    await handle[Symbol.asyncDispose]?.()
    return store
  } catch (error) {
    await store.dispose()
    throw error
  }
}

try {
  const saved = await SqliteLocalAgentStore.open({ workspaceRef: main, stateRoot })
  const now = Date.now()
  await saved.agents.create({ agent: { agentId, cwd: main, status: "idle", name: "Before the move", createdAt: now, updatedAt: now, latestCheckpoint: checkpoint } })
  await saved.dispose()

  await assert.rejects(resume(worktree), /not found/, "the SDK resumes an agent only from the folder it was saved under")

  const store = await SqliteLocalAgentStore.open({ workspaceRef: worktree, stateRoot })
  assert.equal(await relocateCursorAgent(store.agents, agentId, worktree), true)
  assert.equal(await relocateCursorAgent(store.agents, agentId, worktree), false, "moving it again is a no-op")
  const moved = await store.agents.get({ agentId })
  assert.equal(moved?.cwd, worktree)
  assert.deepEqual(moved?.latestCheckpoint, checkpoint, "the move keeps the agent's history")
  assert.equal(moved?.name, "Before the move")
  await store.dispose()

  await (await resume(worktree)).dispose()
  await assert.rejects(resume(main), /not found/, "it now lives in the new folder only")
  assert.equal(await relocateCursorAgent({ get: async () => null, update: async () => assert.fail("nothing to move") }, agentId, main), false)
  console.log("cursor relocate: resumed in the new folder under the same id, with its checkpoint")

  const apiKey = process.env.CURSOR_API_KEY
  if (!apiKey) console.log("cursor relocate: no CURSOR_API_KEY, so no real turn")
  else await realTurns(apiKey)
} finally {
  rmSync(root, { recursive: true, force: true })
}

/** The same move with real turns: an agent told a word in one folder, moved, remembers it and works in the new one. */
async function realTurns(apiKey: string) {
  const liveRoot = join(root, "live")
  const from = join(liveRoot, "main")
  const to = join(liveRoot, "worktree")
  mkdirSync(from, { recursive: true })
  mkdirSync(to, { recursive: true })
  const models = await Cursor.models.list({ apiKey })
  const model = { id: (models.find((candidate) => /composer|auto/i.test(candidate.id)) ?? models[0])!.id }
  const word = `heron${Date.now() % 10_000}`
  const turn = async (cwd: string, create: boolean, id: string | undefined, text: string) => {
    // Mako runs each Cursor SDK child in its conversation's folder, and a woken one starts a new child.
    process.chdir(cwd)
    const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd, stateRoot: join(liveRoot, "state") })
    Cursor.configure({ local: { store } })
    try {
      if (!create) await relocateCursorAgent(store.agents, id!, cwd)
      const options = { apiKey, model, mode: "agent" as const, local: { cwd, store } }
      const handle = create ? await Agent.create(options) : await Agent.resume(id!, options)
      const run = await handle.send(text)
      let said = ""
      for await (const message of run.stream())
        if (message.type === "assistant") said += message.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("")
      await run.wait()
      await handle[Symbol.asyncDispose]?.()
      return { agentId: handle.agentId, said }
    } finally {
      await store.dispose()
    }
  }
  const first = await turn(from, true, undefined, `Remember this word: ${word}. Run pwd in the shell, then reply with exactly what it printed.`)
  assert.ok(first.said.includes(from.replace(/^\/private/, "")), `the first turn's shell runs in the first folder: ${first.said.replaceAll(root, "<root>")}`)
  const second = await turn(to, false, first.agentId, "Run pwd in the shell again. Then on one line: the word I asked you to remember, then what pwd printed. Nothing else.")
  assert.equal(second.agentId, first.agentId, "the same agent goes on")
  assert.match(second.said, new RegExp(word), `its next turn remembers the first folder's turn: ${second.said}`)
  assert.ok(second.said.includes(to.replace(/^\/private/, "")), `it works in the new folder: ${second.said.replaceAll(root, "<root>")}`)
  console.log(`cursor relocate: with ${model.id}, the moved agent remembered its turn and named the new folder`)
}
