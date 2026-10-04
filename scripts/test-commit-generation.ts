import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { collectCommitPatch } from "../electron/commit-patch.ts"
import { KiriCommitEngine } from "../electron/kiri-commit.ts"
import { languageUtilityModel } from "../electron/utility-work.ts"
import { MockLanguageModelV4 } from "ai/test"

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-commit-generation-"))
const signal = AbortSignal.timeout(120_000)
const git = (...args: string[]) => run("git", args, { cwd: root })
const engine = new KiriCommitEngine()
try {
  await git("init", "-q")
  await assert.rejects(collectCommitPatch(root, signal), /no changes/i)
  await writeFile(join(root, "first.txt"), "First commit content\n")
  await writeFile(join(root, ".env"), "PRIVATE_TEST_VALUE=do-not-send\n")
  let patch = await collectCommitPatch(root, signal)
  assert.equal(patch.scope, "working-tree")
  assert.match(patch.text, /First commit content/)
  assert.doesNotMatch(patch.text, /do-not-send/)
  assert.ok(patch.warnings.length)
  await git("add", "first.txt")
  await writeFile(join(root, "first.txt"), "Unstaged content must not be sent\n")
  patch = await collectCommitPatch(root, signal)
  assert.equal(patch.scope, "staged")
  assert.match(patch.text, /First commit content/)
  assert.doesNotMatch(patch.text, /Unstaged content|PRIVATE_TEST_VALUE/)
  await git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Initial")
  await writeFile(join(root, "second.txt"), "New untracked feature\n")
  await writeFile(join(root, "large.txt"), "Large diff line\n".repeat(160_000) + "LATE_LARGE_FILE_CHANGE\n")
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: "dependency\n".repeat(20_000), finalChange: "LATE_LOCKFILE_CHANGE" }))
  await writeFile(join(root, "z-last.txt"), "Do not crowd out this change\n")
  await symlink(join(root, ".env"), join(root, "link.txt"))
  patch = await collectCommitPatch(root, signal)
  assert.ok(patch.text.includes("LATE_LARGE_FILE_CHANGE"))
  assert.ok(patch.text.includes("LATE_LOCKFILE_CHANGE"))
  assert.ok(patch.text.length > 2_100_000)
  assert.match(patch.text, /Do not crowd out this change/)
  assert.doesNotMatch(patch.text, /do-not-send/)
  const rawParts: string[] = []
  const model = new MockLanguageModelV4({ doGenerate: async (options) => {
    const text = options.prompt.flatMap((message) => message.role === "user" ? message.content.flatMap((part) => part.type === "text" ? [part.text] : []) : []).join("\n")
    const summary = options.prompt.some((message) => message.role === "system" && message.content.includes("Keep the summary under"))
    if (summary && text.startsWith("\nSOURCE")) rawParts.push(text)
    if (!summary) {
      assert.ok(text.includes("LATE_LARGE_FILE_CHANGE"))
      assert.ok(text.includes("LATE_LOCKFILE_CHANGE"))
    }
    return { content: [{ type: "text", text: JSON.stringify(summary ? { summary: text.match(/LATE_[A-Z_]+CHANGE/g)?.join("\n") || "Other changes in this part." } : { action: "finish", result: { message: "Include every change area" }, requests: [], notes: "" }) }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] }
  } })
  const drafted = await engine.generate({ client: "test", cwd: root, model: languageUtilityModel(model, { connection: { provider: "openai-compatible", model: "fixture", contextTokens: 32_000 }, via: "Fixture" }), signal })
  assert.ok(rawParts.length > 1)
  assert.ok(drafted.requests >= rawParts.length + 1)
  assert.equal((patch.text.match(/Large diff line/g) ?? []).length, 160_000)
  assert.ok((rawParts.join("\n").match(/Large diff line/g) ?? []).length > 0)
  assert.equal(await readFile(join(root, "first.txt"), "utf8"), "Unstaged content must not be sent\n")
  assert.equal((await git("diff", "--cached")).stdout, "")
  await git("add", "--", "large.txt", "package-lock.json")
  patch = await collectCommitPatch(root, signal)
  assert.equal(patch.scope, "staged")
  assert.ok(patch.text.includes("LATE_LARGE_FILE_CHANGE"))
  await git("reset", "-q", "HEAD", "--", "large.txt", "package-lock.json")
  await mkdir(join(root, "many"))
  for (let offset = 0; offset < 1_005; offset += 16) await Promise.all(Array.from({ length: Math.min(16, 1_005 - offset) }, (_, index) => writeFile(join(root, "many", `${offset + index}.txt`), `Change ${offset + index}\n`)))
  const many = await collectCommitPatch(root, signal)
  assert.ok(many.files >= 1_005)
  assert.ok(many.text.includes("Change 1004"))
  await mkdir(join(root, "nested"))
  await writeFile(join(root, "nested", "feature.txt"), "Nested content\n")
  patch = await collectCommitPatch(join(root, "nested"), signal)
  assert.match(patch.text, /New untracked feature/)
  assert.match(patch.text, /Nested content/)
  await git("mv", "first.txt", "renamed.txt")
  patch = await collectCommitPatch(root, signal)
  assert.equal(patch.scope, "staged")
  assert.match(patch.text, /renamed.txt/)
  assert.match(patch.text, /deleted file mode/)
  assert.doesNotMatch(patch.text, /New untracked feature/)
  await assert.rejects(collectCommitPatch(root, AbortSignal.abort()), /cancel|abort/i)
} finally {
  await engine.dispose()
  await rm(root, { recursive: true, force: true })
}
