import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { closeRepositories, draftCommit, openRepository, type Repository } from "@mako/git"
import { languageUtilityModel } from "../electron/utility-work.ts"
import { MockLanguageModelV4 } from "ai/test"

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-commit-generation-"))
const signal = AbortSignal.timeout(120_000)
const git = (...args: string[]) => run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })

/** Every request the model received, with whether it asked for a summary. */
let requests: Array<{ summary: boolean; text: string }> = []
const mock = new MockLanguageModelV4({
  doGenerate: async (options) => {
    const text = options.prompt.flatMap((message) => message.role === "user" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n")
    const summary = options.prompt.some((message) => message.role === "system" && message.content.includes("Keep the summary under"))
    requests.push({ summary, text })
    const reply = summary ? { summary: text.match(/[A-Z_]+_CHANGE/g)?.join("\n") || "Other changes in this part." } : { action: "finish", result: { message: "Describe every change" }, requests: [], notes: "" }
    return { content: [{ type: "text", text: JSON.stringify(reply) }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] }
  },
})
const model = languageUtilityModel(mock, { connection: { provider: "openai-compatible", model: "fixture", contextTokens: 32_000 }, via: "Fixture" })

async function draft(repository: Repository, abort = signal) {
  requests = []
  const result = await draftCommit(repository, { model, signal: abort })
  return { ...result, seen: requests.map((request) => request.text).join("\n") }
}

try {
  await git("init", "-q")
  const repository = (await openRepository(root))!
  await assert.rejects(draft(repository), /no changes/i)
  await writeFile(join(root, "first.txt"), "First commit content\n")
  await writeFile(join(root, ".env"), "PRIVATE_TEST_VALUE=do-not-send\n")
  let drafted = await draft(repository)
  assert.equal(drafted.snapshot.scope, "working-tree")
  assert.equal(drafted.message, "Describe every change")
  assert.match(drafted.seen, /First commit content/)
  assert.doesNotMatch(drafted.seen, /do-not-send/)
  assert.ok(drafted.warnings.length)

  await git("add", "first.txt")
  await writeFile(join(root, "first.txt"), "Unstaged content must not be sent\n")
  drafted = await draft(repository)
  assert.equal(drafted.snapshot.scope, "staged")
  assert.match(drafted.seen, /First commit content/)
  assert.doesNotMatch(drafted.seen, /Unstaged content|PRIVATE_TEST_VALUE/)
  await git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Initial")

  await writeFile(join(root, "second.txt"), "New untracked feature\n")
  await writeFile(join(root, "large.txt"), "Large diff line\n".repeat(160_000) + "LATE_LARGE_FILE_CHANGE\n")
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: "dependency\n".repeat(20_000), finalChange: "LATE_LOCKFILE_CHANGE" }))
  await writeFile(join(root, "z-last.txt"), "Do not crowd out this change\n")
  await symlink(join(root, ".env"), join(root, "link.txt"))
  drafted = await draft(repository)
  const summaries = requests.filter((request) => request.summary)
  const final = requests.filter((request) => !request.summary)
  assert.ok(summaries.length > 1, "a large change is summarized in parts")
  assert.equal(final.length, 1)
  assert.ok(summaries.some((request) => request.text.includes("LATE_LARGE_FILE_CHANGE")), "the end of a 2.5 MB file reaches the model")
  assert.ok(summaries.some((request) => request.text.includes("LATE_LOCKFILE_CHANGE")), "lockfiles are described, not dropped")
  assert.ok(final[0]!.text.includes("LATE_LARGE_FILE_CHANGE") && final[0]!.text.includes("LATE_LOCKFILE_CHANGE"), "the final request reads what every part said")
  assert.match(drafted.seen, /Do not crowd out this change/)
  assert.doesNotMatch(drafted.seen, /do-not-send/, "a symlink to a sensitive file sends its target's name, not its contents")
  assert.equal(drafted.calls, requests.length)
  assert.equal(await readFile(join(root, "first.txt"), "utf8"), "Unstaged content must not be sent\n")
  assert.equal((await git("diff", "--cached")).stdout, "", "drafting stages nothing")

  await git("add", "--", "large.txt", "package-lock.json")
  drafted = await draft(repository)
  assert.equal(drafted.snapshot.scope, "staged")
  assert.equal(drafted.files, 2)
  await git("reset", "-q", "HEAD", "--", "large.txt", "package-lock.json")

  await mkdir(join(root, "many"))
  for (let offset = 0; offset < 1_005; offset += 16) await Promise.all(Array.from({ length: Math.min(16, 1_005 - offset) }, (_, index) => writeFile(join(root, "many", `${offset + index}.txt`), `Change ${offset + index}\n`)))
  drafted = await draft(repository)
  assert.ok(drafted.files >= 1_005)
  assert.match(drafted.seen, /Change 1004/)

  await mkdir(join(root, "nested"))
  await writeFile(join(root, "nested", "feature.txt"), "Nested content\n")
  const nested = (await openRepository(join(root, "nested")))!
  assert.equal(nested, repository, "a folder inside a repository drafts for the whole repository")
  const before = drafted.files
  drafted = await draft(nested)
  assert.equal(drafted.files, before + 1)
  assert.match(drafted.seen, /Nested content/)

  await git("mv", "first.txt", "renamed.txt")
  drafted = await draft(repository)
  assert.equal(drafted.snapshot.scope, "staged")
  assert.match(drafted.seen, /renamed\.txt/)
  assert.match(drafted.seen, /deleted file mode/, "a rename is described as a deletion and an addition")
  assert.doesNotMatch(drafted.seen, /New untracked feature/)

  await assert.rejects(draft(repository, AbortSignal.abort()), /cancel|abort/i)
  console.log("Commit generation: scopes, sensitive files, complete large evidence, 1,005 files, nested folders, renames and cancellation passed")
} finally {
  closeRepositories()
  await rm(root, { recursive: true, force: true })
}
