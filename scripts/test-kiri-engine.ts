import assert from "node:assert/strict"
import { z } from "zod"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { KiriCommitEngine } from "../electron/kiri-commit.ts"
import { utilityLanguageModel } from "../electron/utility-models.ts"
import type { UtilityConnection } from "../electron/shared.ts"

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-kiri-"))
process.env.MAKO_KIRI_BINARY =
  process.env.MAKO_KIRI_BINARY ?? resolve("../kiri/target/debug/kiri-engine")
const engine = new KiriCommitEngine()
const requests: string[] = []
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const body = Buffer.concat(chunks).toString("utf8")
  requests.push(body)
  const result = body.includes("COMMIT UNITS")
    ? {
        action: "finish",
        result: {
          commits: [
            {
              message: "feat: add the first planned change",
              reason: "The first file is independently useful.",
            },
            {
              message: "feat: add the second planned change",
              reason: "The second file is independently useful.",
            },
          ],
          assignments: { u0: 0, u1: 1 },
        },
        requests: [],
        notes: "",
      }
    : {
        action: "finish",
        result: { message: "feat: describe the complete selected change" },
        requests: [],
        notes: "",
      }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(
    JSON.stringify({
      id: "fixture",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify(result) },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    })
  )
})
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"
process.env.GIT_AUTHOR_NAME = "Integration Test"
process.env.GIT_AUTHOR_EMAIL = "test@example.invalid"
process.env.GIT_COMMITTER_NAME = "Integration Test"
process.env.GIT_COMMITTER_EMAIL = "test@example.invalid"
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = z
    .object({ port: z.number().int().positive() })
    .parse(server.address())
  await run("git", ["init", "-q"], { cwd: root })
  await writeFile(join(root, "file.txt"), "COMPLETE_SELECTED_EVIDENCE\n")
  await run("git", ["add", "file.txt"], { cwd: root })
  await writeFile(join(root, "unrelated.txt"), "UNRELATED_WORKING_CONTENT\n")
  const connection: UtilityConnection = {
    provider: "openai-compatible",
    model: "fixture",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    contextTokens: 32_000,
  }
  const result = await engine.generate({
    client: "window",
    cwd: root,
    connection,
    model: utilityLanguageModel(connection, "fixture-key"),
    signal: AbortSignal.timeout(20_000),
  })
  assert.equal(result?.message, "feat: describe the complete selected change")
  assert.equal(result?.scope, "staged")
  assert.equal(requests.length, 1)
  assert.ok(requests[0]?.includes("COMPLETE_SELECTED_EVIDENCE"))
  assert.ok(!requests[0]?.includes("UNRELATED_WORKING_CONTENT"))
  await engine.commit(
    "window",
    root,
    "feat: describe the complete selected change"
  )
  const committed = await run(
    "git",
    ["show", "--format=", "--name-only", "HEAD"],
    { cwd: root }
  )
  assert.equal(committed.stdout.trim(), "file.txt")
  await mkdir(join(root, "selected"))
  await writeFile(join(root, "selected", "first.txt"), "FIRST_PLANNED_CHANGE\n")
  await writeFile(
    join(root, "selected", "second.txt"),
    "SECOND_PLANNED_CHANGE\n"
  )
  await run("git", ["add", "selected", "unrelated.txt"], { cwd: root })
  const plan = await engine.plan({
    client: "window",
    cwd: root,
    connection,
    model: utilityLanguageModel(connection, "fixture-key"),
    paths: [[...Buffer.from("selected")]],
    scope: "staged",
    signal: AbortSignal.timeout(20_000),
  })
  assert.deepEqual(
    plan.files.map((file) => Buffer.from(file.path).toString()),
    ["selected/first.txt", "selected/second.txt"]
  )
  const commits = await engine.applyPlan(root, plan)
  assert.equal(commits.length, 2)
  const first = await run(
    "git",
    ["show", "--format=", "--name-only", commits[0]!],
    { cwd: root }
  )
  const second = await run(
    "git",
    ["show", "--format=", "--name-only", commits[1]!],
    { cwd: root }
  )
  assert.equal(first.stdout.trim(), "selected/first.txt")
  assert.equal(second.stdout.trim(), "selected/second.txt")
  const staged = await run("git", ["diff", "--cached", "--name-only"], {
    cwd: root,
  })
  assert.equal(staged.stdout.trim(), "unrelated.txt")
  await mkdir(join(root, "working"))
  await writeFile(join(root, "working", "first.txt"), "FIRST_WORKING_CHANGE\n")
  await writeFile(
    join(root, "working", "second.txt"),
    "SECOND_WORKING_CHANGE\n"
  )
  await writeFile(join(root, "outside.txt"), "OUTSIDE_WORKING_CHANGE\n")
  const workingPlan = await engine.plan({
    client: "window",
    cwd: root,
    connection,
    model: utilityLanguageModel(connection, "fixture-key"),
    paths: [[...Buffer.from("working")]],
    scope: "worktree",
    signal: AbortSignal.timeout(20_000),
  })
  assert.deepEqual(
    workingPlan.files.map((file) => Buffer.from(file.path).toString()),
    ["working/first.txt", "working/second.txt"]
  )
  const workingCommits = await engine.applyPlan(root, workingPlan)
  assert.equal(workingCommits.length, 2)
  const firstWorking = await run(
    "git",
    ["show", "--format=", "--name-only", workingCommits[0]!],
    { cwd: root }
  )
  const secondWorking = await run(
    "git",
    ["show", "--format=", "--name-only", workingCommits[1]!],
    { cwd: root }
  )
  assert.equal(firstWorking.stdout.trim(), "working/first.txt")
  assert.equal(secondWorking.stdout.trim(), "working/second.txt")
  const finalStatus = await run("git", ["status", "--porcelain"], {
    cwd: root,
  })
  assert.deepEqual(finalStatus.stdout.trim().split("\n"), [
    "A  unrelated.txt",
    "?? outside.txt",
  ])
} finally {
  await engine.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
}
