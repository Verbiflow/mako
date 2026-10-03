import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { claudeHooks, claudeCommands } from "../electron/providers/claude/authoring.ts"
import { openCodeCommands } from "../electron/providers/opencode/authoring.ts"
import { nativeAuthoringCatalog, writeNativeAuthoring } from "../electron/native-authoring.ts"
import { hostCallReplay } from "../electron/contracts/host-call-policy.ts"

const root = await mkdtemp(join(tmpdir(), "mako-authoring-"))
try {
  const catalog = nativeAuthoringCatalog(root)
  assert.equal(catalog.capabilities.length, 12)
  assert.equal(catalog.capabilities.filter((entry) => entry.supported).length, 3)
  for (const provider of ["cursor", "codex", "grok", "devin"]) {
    await assert.rejects(async () => writeNativeAuthoring(root, { provider, family: "commands", cwd: root, id: "review", contents: "Review it", revision: null }))
  }
  await assert.rejects(async () => writeNativeAuthoring(root, { provider: "claude", family: "commands", cwd: join(root, "elsewhere"), id: "review", contents: "Review it", revision: null }), /project changed/)
  for (const commands of [claudeCommands, openCodeCommands]) {
    const absent = await commands.read(root, "review")
    assert.equal(absent.revision, null)
    const content = "---\ndescription: Review changes\n---\nReview $ARGUMENTS with care.\n"
    const created = await commands.write(root, "review", content, null)
    assert.equal(await readFile(created.path, "utf8"), content)
    assert.deepEqual(await commands.list(root), [{ id: "review", name: "/review" }])
    await assert.rejects(commands.write(root, "review", "stale overwrite", null), /changed after opening/)
    await writeFile(created.path, `${content}External edit.\n`)
    await assert.rejects(commands.write(root, "review", content, created.revision), /changed after opening/)
    await assert.rejects(commands.remove(root, "review", created.revision!), /changed after opening/)
    const current = await commands.read(root, "review")
    const competing = await Promise.allSettled([commands.write(root, "review", "First edit", current.revision), commands.write(root, "review", "Second edit", current.revision)])
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1)
    assert.equal(competing.filter((result) => result.status === "rejected").length, 1)
    await assert.rejects(commands.read(root, "../escape"))
    await assert.rejects(commands.write(root, "large", "x".repeat(262145), null), /below 256 KB/)
    await commands.remove(root, "review", (await commands.read(root, "review")).revision!)
    assert.deepEqual(await commands.list(root), [])
  }
  const settings = join(root, ".claude/settings.json")
  const original = { permissions: { allow: ["Read"] }, env: { FIXTURE: "retained" }, arbitraryNativeSetting: [1, 2] }
  await writeFile(settings, JSON.stringify(original))
  const hooks = { SessionStart: [{ hooks: [{ type: "command", command: "printf ready", timeout: 5 }] }] }
  const saved = await claudeHooks.write(root, "configuration", JSON.stringify(hooks), (await claudeHooks.read(root, "configuration")).revision)
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { ...original, hooks })
  await assert.rejects(claudeHooks.write(root, "configuration", '{"SessionStart":[{"hooks":[{"type":"command"}]}]}', saved.revision))
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { ...original, hooks })
  await claudeHooks.remove(root, "configuration", saved.revision!)
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), original)
  await writeFile(settings, "broken JSON")
  await assert.rejects(claudeHooks.read(root, "configuration"))
  assert.equal(await readFile(settings, "utf8"), "broken JSON")
  const outside = join(root, "outside.md")
  await writeFile(outside, "keep")
  await mkdir(join(root, ".claude/commands"), { recursive: true })
  await symlink(outside, join(root, ".claude/commands/link.md"))
  await assert.rejects(claudeCommands.write(root, "link", "changed", (await claudeCommands.read(root, "link")).revision), /symbolic link/)
  assert.equal(await readFile(outside, "utf8"), "keep")
  const escapeRoot = join(root, "escape")
  await mkdir(escapeRoot)
  await symlink(join(root, ".claude"), join(escapeRoot, ".claude"))
  await assert.rejects(claudeCommands.write(escapeRoot, "escape", "changed", null), /outside the project/)
  for (const operation of ["write", "remove"]) assert.equal(hostCallReplay(`mako:native-authoring-${operation}`), "never")
  for (const operation of ["catalog", "list", "read"]) assert.equal(hostCallReplay(`mako:native-authoring-${operation}`), "read")
  console.log("Native authoring: all six declarations, native syntax, bounded writes, conflict fencing, settings preservation, symlinks and unknown-outcome retry policy passed")
} finally { await rm(root, { recursive: true, force: true }) }
