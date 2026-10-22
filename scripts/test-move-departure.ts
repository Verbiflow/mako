import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Git } from "@mako/git"
import type { SentRecords } from "@mako/sessions/record-sync"
import { departMove, stayMove, type MoveDepartureDeps } from "@mako/host/conversations/move-departure"
import { MoveNotQuietError } from "@mako/host/conversations/live-moves"
import { ThreadStore, type JournalFacts } from "@mako/host/threads/store"

/**
 * A Thread leaving its cloud machine for its device (`departMove`), against the real Thread store and a real checkout,
 * with the gateway's checkpoint route as a stand-in. The machine releases the Thread in its own store before it packs
 * anything, so a prompt that reaches it later is held, never run; the same departure asked again answers the same; one
 * that fails after its release takes the Thread back before it answers; one refused for work in progress changes
 * nothing; and `stayMove` takes a released Thread back, once.
 */
const root = mkdtempSync(join(tmpdir(), "mako-move-departure-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
let clock = 1_000

/** The gateway's checkpoint route: kept by hash; `failPuts` refuses the next uploads. */
const kept = new Map<string, number>()
let failPuts = 0
const server = createServer((request, response) => {
  const sha = request.url?.split("/").at(-1) ?? ""
  if (request.method === "HEAD") return void response.writeHead(kept.has(sha) ? 200 : 404).end()
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    if (failPuts > 0) {
      failPuts -= 1
      return void response.writeHead(503).end()
    }
    kept.set(sha, Buffer.concat(chunks).length)
    response.writeHead(201).end()
  })
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const { port } = z.object({ port: z.number() }).parse(server.address())

function setup(name: string) {
  const folder = join(root, name)
  const remote = join(folder, "remote.git")
  const checkout = join(folder, "Users", "ada", "worktrees", "fix")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(root, "clone", "--quiet", remote, checkout)
  writeFileSync(join(checkout, "a.txt"), "one\n")
  sh(checkout, "add", ".")
  sh(checkout, "commit", "--quiet", "-m", "base")
  sh(checkout, "push", "--quiet", "origin", "main")
  writeFileSync(join(checkout, "a.txt"), "one, changed in the cloud\n")
  const threads = new ThreadStore(join(folder, "threads.sqlite"), { now: () => clock++, realPath: (path) => path })
  const conversation = randomUUID()
  const facts: JournalFacts = { conversationId: conversation, createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }] }
  const placed = threads.registerJournal(facts, threads.person())
  const busy: string[] = []
  const sent: string[][] = []
  const order: string[] = []
  const deps: MoveDepartureDeps = {
    git,
    records: () => ({ id: "t-1", base: `http://127.0.0.1:${port}/v1/threads/t-1/records`, authorization: "Bearer test" }),
    workspace: () => checkout,
    workspaceProblem: () => undefined,
    blockers: () => [...busy],
    threads: () => threads,
    moves: {
      begin: (input) => threads.beginMove(input),
      release: async (input) => {
        if (busy.length) throw new MoveNotQuietError(busy)
        order.push("release")
        return threads.release(input)
      },
      cancel: (input) => threads.cancelMove(input),
      reclaim: (input) => threads.reclaim(input),
    },
    native: () => ({ harness: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }),
    send: async (_link, paths): Promise<SentRecords[]> => {
      order.push("send")
      sent.push(paths)
      return [{ harness: "codex", nativeId: "n-1", holdings: { "codex:n-1.jsonl": 3 }, versions: 1, held: 0, chunks: 1, bytes: 10, requests: 1, ms: 1 }]
    },
    scratch: join(folder, "scratch"),
  }
  const state = () => threads.execution(placed.session)
  return { deps, threads, conversation, checkout, busy, sent, order, state }
}

const device = randomUUID()

try {
  // The way back: released toward the device first, then the checkout and the records; asked again, the same.
  {
    const s = setup("departs")
    const move = randomUUID()
    const input = { move, folder: s.checkout, conversations: [s.conversation], device }
    const departure = await departMove(s.deps, input)
    assert.deepEqual(s.order, ["release", "send"], "released before anything is sent")
    assert.equal(s.state()?.state, "in-transit", "nothing runs it here now: a later prompt is held")
    assert.equal(kept.get(departure.checkpoint.sha256), departure.checkpoint.bytes, "the checkout went up by its hash")
    assert.deepEqual(departure.sessions, [{ harness: "codex", nativeId: "n-1", holdings: { "codex:n-1.jsonl": 3 } }])
    const again = await departMove(s.deps, input)
    assert.deepEqual(again, departure, "asked again, the same departure: the same checkpoint, nothing more")
    assert.equal(s.state()?.generation, 2, "released once")
    // The device gave it back: the machine runs it again, one generation on; told twice, once.
    assert.deepEqual(stayMove(s.deps, { move, device, reason: "the checkout didn't apply on the Mac" }), { stayed: true })
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 3])
    assert.deepEqual(stayMove(s.deps, { move, device, reason: "again" }), { stayed: false })
  }

  // Working: refused before anything is released, and the Thread runs here as it was.
  {
    const s = setup("busy")
    s.busy.push("Codex is running a turn")
    await assert.rejects(departMove(s.deps, { move: randomUUID(), folder: s.checkout, conversations: [s.conversation], device }), /A Thread goes back between turns: Codex is running a turn/)
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 1])
    assert.deepEqual(s.order, [])
  }

  // Failing after its release (the checkout can't go up): taken back here before it answers.
  {
    const s = setup("fails")
    failPuts = 1
    const move = randomUUID()
    await assert.rejects(departMove(s.deps, { move, folder: s.checkout, conversations: [s.conversation], device }), /couldn't be sent back: the cloud answered 503/)
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 3], "released (2), taken back (3): it runs here again")
    assert.deepEqual(s.sent, [], "no records went")
  }

  // A device that cancels before the machine ever packed: nothing to take back.
  {
    const s = setup("never")
    assert.deepEqual(stayMove(s.deps, { move: randomUUID(), device, reason: "cancelled" }), { stayed: false })
    assert.deepEqual([s.state()?.state, s.state()?.generation], ["here", 1])
  }
  console.log("PASS: a Thread leaves its machine released first, then its checkout and records; asked again, the same; busy, nothing released; a failure after the release, and a give-back, take it back here once")
} finally {
  server.close()
  git.close()
  rmSync(root, { recursive: true, force: true })
}
