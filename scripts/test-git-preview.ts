import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { WorkspaceGit } from "../electron/host-git.ts"
import { draftCommit, openRepository, type JsonSchema } from "@mako/git"

/** What drafting a commit would send a model, from a model that only records it. */
async function drafted(root: string, signal: AbortSignal) {
  const prompts: string[] = []
  const model = {
    identity: "test-recorder",
    contextTokens: 1_000_000,
    complete: async (request: { prompt: string; schema?: JsonSchema }) => {
      prompts.push(request.prompt)
      return JSON.stringify(JSON.stringify(request.schema).includes('"summary"') ? { summary: "Part of the change." } : { action: "finish", result: { message: "Test" }, requests: [], notes: "" })
    },
  }
  const draft = await draftCommit((await openRepository(root))!, { model, signal })
  return { scope: draft.snapshot.scope, files: draft.files, text: prompts.join("\n") }
}

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-large-git-"))
const command = (...args: string[]) =>
  run("git", ["--no-optional-locks", ...args], { cwd: root })
try {
  await command("init", "-q")
  await writeFile(join(root, "small.ts"), "export const version = 1\n")
  await command("add", "small.ts")
  await command(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "Initial fixture"
  )
  await writeFile(join(root, "small.ts"), "export const version = 2\n")
  const git = new WorkspaceGit(root)
  const small = await git.diff("small.ts")
  assert.equal(small.preview, undefined)
  assert.ok(small.oldFile?.contents.includes("version = 1"))
  assert.ok(small.newFile?.contents.includes("version = 2"))
  await writeFile(
    join(root, "large.ts"),
    "export const changed = true\n".repeat(50_000) + "COMPLETE_TAIL\n"
  )
  const preview = await git.diff("large.ts")
  assert.equal(preview.preview?.kind, "patch")
  assert.equal(preview.oldFile, null)
  assert.equal(preview.newFile, null)
  if (preview.preview?.kind === "patch") {
    assert.ok(preview.preview.limited)
    assert.ok(Buffer.byteLength(preview.preview.contents) <= 128 * 1024)
    assert.ok(preview.preview.contents.split("\n").length <= 1_001)
  }
  await git.stage(["large.ts"])
  assert.ok(
    (await drafted(root, AbortSignal.timeout(15_000))).text.includes(
      "COMPLETE_TAIL"
    ),
    "Display preview limits must not truncate generation or staging"
  )
  await command(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "Large fixture"
  )
  const head = (await command("rev-parse", "HEAD")).stdout.trim()
  assert.equal(
    (await git.commitFileDiff(head, "large.ts")).preview?.kind,
    "patch"
  )
  await writeFile(join(root, "huge.txt"), "x".repeat(33 * 1024 * 1024))
  assert.equal((await git.diff("huge.txt")).preview?.kind, "unavailable")
  await assert.rejects(git.diff("../outside.txt"), /inside this repository/)
  await mkdir(join(root, "many"))
  for (let offset = 0; offset < 600; offset += 20)
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFile(join(root, "many", `${offset + index}.txt`), "Change\n")
      )
    )
  const first = git.status()
  assert.equal(first, git.status(), "Concurrent status readers must share work")
  const status = await first
  assert.ok(status.files.length >= 600)
  assert.ok(
    status.files.every((file) => file.insertions === null),
    "Large status snapshots must not read every patch just to count lines"
  )
  const history = await git.log(80)
  assert.equal(history.length, 2)
  assert.ok(
    history.every((commit) => commit.insertions === null),
    "Reading commit titles must not diff historical trees"
  )
  const batch = await git.diffAll()
  assert.ok(batch.diffs.length <= 25)
  assert.ok(batch.truncated > 0)
  console.log(
    "Large Git: bounded previews, full staged/generation content, historical previews, source-size protection, shared status readers, deferred totals and metadata-only history passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
