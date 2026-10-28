import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Git } from "@mako/git"
import { ThreadFileHistorySchema, type ThreadFileHistory } from "@mako/protocol"
import type { ReceivedRecords, SentRecords } from "@mako/sessions/record-sync"
import { ARRIVED_CARRY, arriveMove, readyForMove, type MoveArrivalDeps } from "@mako/host/conversations/move-arrival"
import { departMove, stayMove, type MoveDepartureDeps } from "@mako/host/conversations/move-departure"
import { captureMoveCheckpoint } from "@mako/host/workspaces/move-checkpoint"
import { captureCarry, cloneRepository, openCarry, readOutside } from "@mako/host/workspaces/move-carry"
import { ThreadStore, type JournalFacts } from "@mako/host/threads/store"

/**
 * A move's carry on the machine's side, end to end on real repositories, with the cloud's checkpoint route as a
 * stand-in. A project of two repositories, at the same paths on the Mac and the machine as a move keeps them: getting
 * ready clones the second beside the first (the agent's), and one it can't clone says which; the arrival applies both
 * checkouts, places the files outside the project at their own paths and takes the file history before any session
 * opens, and keeps the carry's manifest; asked again, it does none of it twice. Then in the cloud the Thread changes
 * the second repository and an outside file and removes another it carried; its departure, asked for a carry, packs
 * both checkouts, only the outside file it changed, the one it removed, and its history. A departure not asked for one
 * packs none, as for a device from before carries.
 */
const root = mkdtempSync(join(tmpdir(), "mako-move-carry-trip-"))
const outsideRoot = mkdtempSync("/tmp/mako-move-carry-trip-")
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
let clock = 1_000

/** The cloud's checkpoints and carries, by hash. */
const bundles = new Map<string, Buffer>()
const server = createServer((request, response) => {
  if (request.url?.endsWith("/records/sessions")) return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessions: [] }))
  const sha = request.url?.split("/").at(-1) ?? ""
  if (request.method === "HEAD") return void response.writeHead(bundles.has(sha) ? 200 : 404).end()
  if (request.method === "GET") {
    const body = bundles.get(sha)
    return void (body ? response.writeHead(200).end(body) : response.writeHead(404).end())
  }
  const chunks: Buffer[] = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    bundles.set(sha, Buffer.concat(chunks))
    response.writeHead(201).end()
  })
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const { port } = z.object({ port: z.number() }).parse(server.address())
const link = { id: "t-1", base: `http://127.0.0.1:${port}/v1/threads/t-1/records`, authorization: "Bearer test" }
const keep = (sha256: string, file: string) => bundles.set(sha256, readFileSync(file))
const opened = async (sha256: string) => {
  const scratch = await mkdtemp(join(root, "open-"))
  const file = join(scratch, "carry.bundle")
  writeFileSync(file, bundles.get(sha256) ?? Buffer.alloc(0))
  return openCarry(git, file, { sha256, bytes: bundles.get(sha256)?.length ?? 1 }, scratch)
}

try {
  // A project folder's worktree of two repositories, each with its remote: the Mac's.
  const remotes = { app: join(root, "app.git"), api: join(root, "api.git") }
  const project = join(root, "Users", "ada", ".mako", "worktrees", "proj", "fix")
  const first = join(project, "app")
  const second = join(project, "api")
  for (const [name, remote] of Object.entries(remotes)) {
    sh(root, "init", "--bare", "--quiet", remote)
    sh(remote, "config", "uploadpack.allowFilter", "true")
    sh(root, "clone", "--quiet", remote, join(project, name))
    writeFileSync(join(project, name, "README.md"), `${name}\n`)
    sh(join(project, name), "add", ".")
    sh(join(project, name), "commit", "--quiet", "-m", "base")
    sh(join(project, name), "push", "--quiet", "origin", "main")
    sh(join(project, name), "checkout", "--quiet", "-b", "mako/fix")
    writeFileSync(join(project, name, "work.txt"), `${name}, the Thread's work on the Mac\n`)
  }
  const notes = join(outsideRoot, "notes.md")
  const script = join(outsideRoot, "scratch.sh")
  writeFileSync(notes, "notes from the Mac\n")
  writeFileSync(script, "#!/bin/sh\n", { mode: 0o755 })

  // The Mac's half: each checkout, then the carry naming both, its outside files and its history.
  const thread = randomUUID()
  const history = ThreadFileHistorySchema.parse({ format: 1, thread, from: randomUUID(), parts: [], choices: [] })
  const scratch = await mkdtemp(join(root, "mac-scratch-"))
  const app = await captureMoveCheckpoint(git, first, await mkdtemp(join(scratch, "c-")))
  const api = await captureMoveCheckpoint(git, second, await mkdtemp(join(scratch, "c-")))
  keep(app.checkpoint.sha256, app.file)
  keep(api.checkpoint.sha256, api.file)
  const outside = await readOutside([{ path: notes, access: "write" }, { path: script, access: "write" }], project)
  const sent = await captureCarry(git, {
    folder: project,
    repositories: [{ path: first, checkpoint: app.checkpoint }, { path: second, url: `file://${remotes.api}`, checkpoint: api.checkpoint }],
    outside: outside.read, left: outside.left, history,
  }, scratch)
  keep(sent.ref.sha256, sent.file)

  // The machine, at the same paths: its agent cloned the first repository; nothing else is there.
  renameSync(project, `${project}.mac`)
  rmSync(notes)
  rmSync(script)
  sh(root, "clone", "--quiet", "--filter=blob:none", `file://${remotes.app}`, first)

  const carried: ThreadFileHistory[] = []
  const threads = new ThreadStore(join(root, "threads.sqlite"), { now: () => clock++, realPath: (path) => path })
  const conversation = randomUUID()
  const facts: JournalFacts = { conversationId: conversation, createdAt: clock++, harness: "codex", bindings: [{ provider: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }] }
  threads.registerJournal(facts, threads.person())
  const opens: string[] = []
  const arrival: MoveArrivalDeps = {
    git,
    records: () => link,
    workspace: () => first,
    workspaceProblem: () => undefined,
    workspaceSettled: async () => ({ path: first }),
    warm: async () => {},
    receive: async (_link, sessions) => sessions.map((session): ReceivedRecords => ({
      harness: session.harness, nativeId: session.nativeId,
      pulled: { versions: 1, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1 },
      restored: { kind: "restored", path: `/home/node/${session.nativeId}`, files: 1, rows: 0, ms: 1 },
    })),
    stage: async () => [],
    installed: () => null,
    open: async (session) => void opens.push(session.folder),
    take: () => {},
    signedIn: () => true,
    label: (harness) => harness,
    scratch: join(root, "machine-scratch"),
    carryHistory: async (taken) => (carried.push(taken), true),
    clone: (repository) => cloneRepository(git, repository),
  }

  // Getting ready: a repository the machine can't clone keeps the Thread on the Mac, saying which; then the real one.
  await assert.rejects(readyForMove(arrival, { folder: first, repositories: [{ path: join(project, "gone"), url: `file://${join(root, "gone.git")}` }] }), /couldn't clone .*gone\.git at .*\/gone:/)
  assert.ok(!existsSync(join(project, "gone")), "a clone that failed leaves nothing behind")
  assert.deepEqual(await readyForMove(arrival, { folder: first, repositories: [{ path: second, url: `file://${remotes.api}` }] }), { folder: first, carry: true })
  assert.ok(existsSync(join(second, ".git")), "cloned beside the first")

  // The arrival: both checkouts, the outside files, the history, before any session opens in its own folder.
  const move = randomUUID()
  const input = { move, folder: first, checkpoint: app.checkpoint, sessions: [{ harness: "codex", nativeId: "n-1", open: { conversationId: conversation, cwd: project } }], carry: sent.ref }
  const arrived = await arriveMove(arrival, input)
  assert.equal(arrived.checkout, "applied")
  assert.deepEqual(arrived.carried, { repositories: 2, outside: 2, failed: [], history: true })
  assert.equal(readFileSync(join(first, "work.txt"), "utf8"), "app, the Thread's work on the Mac\n")
  assert.equal(readFileSync(join(second, "work.txt"), "utf8"), "api, the Thread's work on the Mac\n", "the second repository's checkout came too")
  assert.equal(sh(second, "rev-parse", "--abbrev-ref", "HEAD"), "mako/fix")
  assert.equal(readFileSync(notes, "utf8"), "notes from the Mac\n", "the outside file is at its own path")
  assert.equal(readFileSync(script, "utf8"), "#!/bin/sh\n")
  assert.deepEqual(carried, [history], "the file history was taken")
  assert.deepEqual(opens, [project], "the session opened in its own folder, the project's")
  assert.ok(existsSync(join(first, ".git", ARRIVED_CARRY)), "the carry's manifest is kept for the departure")
  // Asked again, nothing is done twice: the agent's work since stands.
  writeFileSync(notes, "the agent's work since\n")
  await arriveMove(arrival, input)
  assert.equal(readFileSync(notes, "utf8"), "the agent's work since\n")
  assert.equal(carried.length, 1)

  // In the cloud: the second repository changes, the outside file changes, the script it carried is removed.
  writeFileSync(join(second, "work.txt"), "api, changed in the cloud\n")
  writeFileSync(notes, "notes, changed in the cloud\n")
  rmSync(script)
  const departure: MoveDepartureDeps = {
    git,
    records: () => link,
    workspace: () => first,
    workspaceProblem: () => undefined,
    blockers: async () => [],
    threads: () => threads,
    moves: {
      begin: (moving) => threads.beginMove(moving),
      release: async (moving) => threads.release(moving),
      cancel: (moving) => threads.cancelMove(moving),
      reclaim: (moving) => threads.reclaim(moving),
    },
    native: () => ({ harness: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }),
    send: async (): Promise<SentRecords[]> => [{ harness: "codex", nativeId: "n-1", holdings: { "codex:n-1.jsonl": 3 }, versions: 1, held: 0, chunks: 1, bytes: 10, requests: 1, ms: 1 }],
    scratch: join(root, "machine-scratch"),
    outside: () => [],
    history: () => history,
  }
  const device = randomUUID()
  const leaving = randomUUID()
  const packed = await departMove(departure, { move: leaving, folder: first, conversations: [conversation], device, carry: true })
  assert.ok(packed.carry, "asked for a carry, it packs one")
  const back = await opened(packed.carry.sha256)
  assert.equal(back.carry.folder, project)
  assert.deepEqual(back.carry.repositories.map((repository) => repository.path), [first, second])
  assert.deepEqual(back.carry.repositories[0]?.checkpoint, packed.checkpoint, "the first is the departure's own checkout")
  assert.ok(bundles.has(back.carry.repositories[1]?.checkpoint.sha256 ?? ""), "the second's checkout went up")
  assert.notEqual(back.carry.repositories[1]?.checkpoint.sha256, api.checkpoint.sha256, "as it is now, changed in the cloud")
  assert.deepEqual(back.carry.outside.map((entry) => entry.path), [notes], "only the outside file it changed")
  assert.equal((await back.bytes(notes)).toString(), "notes, changed in the cloud\n")
  assert.deepEqual(back.carry.gone, [script], "and the one it removed")
  assert.deepEqual(back.history, history)

  // Taken back, then packed for a device that asked for no carry: none.
  stayMove(departure, { move: leaving, device, reason: "the test goes on" })
  const plain = await departMove(departure, { move: randomUUID(), folder: first, conversations: [conversation], device })
  assert.equal(plain.carry, undefined, "a device that didn't ask for a carry gets none")
  threads.close()
  console.log("move carry, on the machine: a project's other repository cloned as it gets ready (one it can't, said), both checkouts, outside files and history arrived once before any session opened in its folder; packed back, both checkouts, only what changed outside it, what it removed, its history; none for a device that didn't ask: ok")
} finally {
  server.close()
  git.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(outsideRoot, { recursive: true, force: true })
}
