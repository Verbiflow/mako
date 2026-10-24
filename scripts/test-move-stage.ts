import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Git } from "@mako/git"
import type { MoveCheckpoint } from "@mako/protocol/moves"
import type { ReceivedRecords, StagedRecords } from "@mako/sessions/record-sync"
import { arriveMove, readyForMove, stageMove, type MoveArrivalDeps } from "@mako/host/conversations/move-arrival"
import { captureMoveCheckpoint } from "@mako/host/workspaces/index"

/**
 * A move staged on its machine while the Thread still runs on the device (`stageMove`), then arriving: real
 * repositories, a real checkpoint read over HTTP. Staged and unchanged since, the arrival proves the clone still reads
 * as the checkpoint and reads nothing more; changed since, the newest is laid over what was staged; never staged, it's
 * applied whole as before. Records are staged into the machine's store, never its harness's, and the arrival pulls the
 * rest.
 */
const root = mkdtempSync(join(tmpdir(), "mako-move-stage-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()

/** The cloud's checkpoints, by hash, and how many times each was read. */
const bundles = new Map<string, string>()
const reads: string[] = []
const server = createServer((request, response) => {
  // The Thread's sessions, as the cloud lists them for a machine getting ready.
  if (request.url?.endsWith("/records/sessions"))
    return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessions: [{ harness: "codex", nativeId: "n-1", units: 3, versions: 29, through: 29 }] }))
  const sha = request.url?.split("/").at(-1) ?? ""
  const file = bundles.get(sha)
  if (!file) return void response.writeHead(404).end()
  reads.push(sha)
  response.writeHead(200).end(readFileSync(file))
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const { port } = z.object({ port: z.number() }).parse(server.address())

function setup(name: string) {
  const folder = join(root, name)
  const remote = join(folder, "remote.git")
  const device = join(folder, "device")
  const machine = join(folder, "Users", "ada", "worktrees", "fix")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(root, "clone", "--quiet", remote, device)
  writeFileSync(join(device, "a.txt"), "one\n")
  sh(device, "add", ".")
  sh(device, "commit", "--quiet", "-m", "base")
  sh(device, "push", "--quiet", "origin", "main")
  sh(root, "clone", "--quiet", remote, machine)
  const capture = async (contents: string): Promise<MoveCheckpoint> => {
    writeFileSync(join(device, "a.txt"), contents)
    const scratch = mkdtempSync(join(folder, "capture-"))
    const { checkpoint, file } = await captureMoveCheckpoint(git, device, scratch)
    bundles.set(checkpoint.sha256, file)
    return checkpoint
  }
  const staged: string[] = []
  const deps: MoveArrivalDeps = {
    git,
    records: () => ({ id: "t-1", base: `http://127.0.0.1:${port}/v1/threads/t-1/records`, authorization: "Bearer test" }),
    workspace: () => machine,
    workspaceProblem: () => undefined,
    workspaceSettled: async () => ({ path: machine }),
    warm: async () => {},
    receive: async (_link, sessions): Promise<ReceivedRecords[]> => sessions.map((session) => ({
      harness: session.harness, nativeId: session.nativeId,
      pulled: { versions: staged.length ? 1 : 30, held: 0, chunks: 1, bytes: 1, requests: 1, ms: 1 },
      restored: { kind: "restored", path: `/home/node/${session.nativeId}`, files: 1, rows: 0, ms: 1 },
    })),
    stage: async (_link, sessions): Promise<StagedRecords[]> => sessions.map((session) => {
      staged.push(session.nativeId)
      return { harness: session.harness, nativeId: session.nativeId, versions: 29, held: 0, chunks: 29, bytes: 4_096, requests: 1, ms: 5 }
    }),
    installed: () => null,
    open: async () => {},
    take: () => {},
    signedIn: () => undefined,
    label: (harness) => harness,
    scratch: join(folder, "scratch"),
  }
  const files = () => [readFileSync(join(machine, "a.txt"), "utf8"), sh(machine, "status", "--short")]
  return { deps, capture, staged, files, machine }
}

const sessions = [{ harness: "codex", nativeId: "n-1" }]

try {
  // Staged, unchanged since: the arrival reads nothing and proves the clone is the checkpoint.
  {
    const s = setup("unchanged")
    const checkpoint = await s.capture("one, changed on the device\n")
    const move = randomUUID()
    const stage = await stageMove(s.deps, { move, folder: s.machine, checkpoint, sessions })
    assert.deepEqual(s.staged, ["n-1"], "records staged into the store")
    assert.deepEqual(stage.staged, [{ harness: "codex", nativeId: "n-1", versions: 29, bytes: 4_096 }])
    assert.equal(s.files()[0], "one, changed on the device\n", "the checkout is there already")
    const before = reads.length
    const arrival = await arriveMove(s.deps, { move, folder: s.machine, checkpoint, sessions })
    assert.equal(arrival.checkout, "staged", "proven unchanged, not applied again")
    assert.equal(reads.length, before, "nothing read at the hand-over")
    assert.ok(arrival.parts?.checkpointVerified !== undefined && arrival.parts.records !== undefined, JSON.stringify(arrival.parts))
    assert.deepEqual(await arriveMove(s.deps, { move, folder: s.machine, checkpoint, sessions }).then((again) => again.checkout), "arrived", "asked again, it arrived before")
    await assert.rejects(stageMove(s.deps, { move, folder: s.machine, checkpoint, sessions }), /already arrived/, "never staged over a move that arrived")
  }

  // Changed after staging (the last seconds of a turn): the newest checkout is laid over what was staged, exactly.
  {
    const s = setup("changed")
    const ahead = await s.capture("one, sent ahead\n")
    const move = randomUUID()
    await stageMove(s.deps, { move, folder: s.machine, checkpoint: ahead, sessions })
    const last = await s.capture("one, as it was released\n")
    const arrival = await arriveMove(s.deps, { move, folder: s.machine, checkpoint: last, sessions })
    assert.equal(arrival.checkout, "applied")
    assert.deepEqual(s.files(), ["one, as it was released\n", "M a.txt"])
  }

  // Never staged (a device from before staging, or a stage that failed): applied whole, as ever.
  {
    const s = setup("unstaged")
    const checkpoint = await s.capture("one, never staged\n")
    const arrival = await arriveMove(s.deps, { move: randomUUID(), folder: s.machine, checkpoint, sessions })
    assert.equal(arrival.checkout, "applied")
    assert.equal(s.files()[0], "one, never staged\n")
  }

  // Staged, then something wrote the clone before the arrival: not proven, so the checkout is laid down again.
  {
    const s = setup("touched")
    const checkpoint = await s.capture("one, staged\n")
    const move = randomUUID()
    await stageMove(s.deps, { move, folder: s.machine, checkpoint, sessions })
    writeFileSync(join(s.machine, "a.txt"), "written meanwhile\n")
    const arrival = await arriveMove(s.deps, { move, folder: s.machine, checkpoint, sessions })
    assert.equal(arrival.checkout, "applied", "a clone that doesn't read as the checkpoint is never taken as it")
    assert.equal(s.files()[0], "one, staged\n")
  }
  // Getting ready, the machine pulls what the Thread's records hold so far, and the stage after waits for that pull
  // rather than reading beside it: the cold first read of the cloud's copy is paid while the machine gets ready.
  {
    const s = setup("ahead")
    let land = () => {}
    const landed = new Promise<void>((resolve) => { land = resolve })
    const calls: string[] = []
    const stage = s.deps.stage
    const deps: MoveArrivalDeps = { ...s.deps, ahead: new Map(), stage: async (link, asked) => {
      calls.push(calls.length ? "stage" : "ahead")
      if (calls.length === 1) await landed
      return stage(link, asked)
    } }
    assert.deepEqual(await readyForMove(deps, { folder: s.machine }), { folder: s.machine }, "ready at once, not after the pull")
    const checkpoint = await s.capture("one, sent ahead\n")
    const staging = stageMove(deps, { move: randomUUID(), folder: s.machine, checkpoint, sessions })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(calls, ["ahead"], "the stage waits for what's being pulled ahead")
    land()
    await staging
    assert.deepEqual(calls, ["ahead", "stage"], "then pulls only what came since")
    assert.deepEqual(s.staged, ["n-1", "n-1"])
    assert.equal(deps.ahead?.size, 0, "a later move pulls ahead again")
  }
  console.log("PASS: a move staged ahead arrives by proving its checkout unchanged and reading nothing more, lays the newest over what was staged, applies whole when never staged, and never trusts a clone that changed; a machine getting ready pulls the Thread's records, and the stage waits for that pull")
} finally {
  server.close()
  git.close()
  rmSync(root, { recursive: true, force: true })
}
