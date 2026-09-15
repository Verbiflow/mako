import assert from "node:assert/strict"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverSkillRecords,
  hashSkillDirectory,
  type SkillRoot,
} from "../electron/skill-registry.ts"
import {
  applySkillSync,
  previewSkillRemove,
  previewSkillSync,
} from "../electron/skill-sync.ts"
import type { SkillRegistrySnapshot } from "../electron/shared.ts"

const directory = await mkdtemp(join(tmpdir(), "mako-skills-"))

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body: string
) {
  const path = join(root, name)
  await mkdir(join(path, "scripts"), { recursive: true })
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n\n${body}\n`
  )
  await writeFile(join(path, "scripts", "check.sh"), "echo checked\n")
  return path
}

try {
  const agentsRoot = join(directory, ".agents", "skills")
  const claudeRoot = join(directory, ".claude-source", "skills")
  const cursorRoot = join(directory, ".cursor-source", "skills")
  const review = await writeSkill(
    agentsRoot,
    "code-review",
    "Review changes safely.",
    "# Review\nCheck behavior and tests."
  )
  await writeSkill(
    claudeRoot,
    "code-review",
    "Review changes safely.",
    "# Review\nCheck behavior and tests."
  )
  await writeSkill(
    cursorRoot,
    "code-review",
    "Review changes differently.",
    "# Review\nOnly inspect formatting."
  )
  const unsafe = await writeSkill(
    agentsRoot,
    "unsafe-link",
    "Contains a symlink.",
    "# Unsafe"
  )
  await symlink("/tmp", join(unsafe, "references"))

  const roots: SkillRoot[] = [
    {
      provider: "agents",
      account: "local",
      scope: "workspace",
      root: agentsRoot,
    },
    {
      provider: "claude",
      account: "default",
      scope: "user",
      root: claudeRoot,
    },
    {
      provider: "cursor",
      account: "default",
      scope: "user",
      root: cursorRoot,
    },
  ]
  const records = await discoverSkillRecords(roots)
  const reviews = records.filter((skill) => skill.name === "code-review")
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0]?.conflict, "drift")
  assert.equal(reviews[0]?.origins.length, 3)
  assert.equal(
    records.find((skill) => skill.name === "unsafe-link")?.portable,
    false
  )

  const selected = reviews.find((skill) =>
    skill.origins.some((origin) => origin.provider === "agents")
  )
  assert.ok(selected)
  const snapshot: SkillRegistrySnapshot = {
    cwd: directory,
    generatedAt: 1,
    skills: records,
    providers: [
      {
        id: "grok",
        label: "Grok",
        account: "default",
        available: true,
        readsUniversalRoot: false,
      },
    ],
  }
  const target = {
    provider: "grok" as const,
    account: "default",
    scope: "workspace" as const,
  }
  const preview = await previewSkillSync(snapshot, selected.id, target)
  assert.equal(preview.action, "add")
  await applySkillSync(snapshot, selected.id, target)
  const installed = join(directory, ".grok", "skills", "code-review")
  assert.equal(await hashSkillDirectory(installed), selected.hash)
  assert.equal(
    await readFile(join(installed, "scripts", "check.sh"), "utf8"),
    "echo checked\n"
  )
  await assert.rejects(
    applySkillSync(snapshot, selected.id, target),
    /Preview this skill change/
  )

  const [alternative] = await discoverSkillRecords([roots[2]!])
  assert.ok(alternative)
  snapshot.skills.push(alternative)
  const replace = await previewSkillSync(snapshot, alternative.id, target)
  assert.equal(replace.action, "replace")
  await writeFile(join(installed, "SKILL.md"), "changed after preview")
  await assert.rejects(
    applySkillSync(snapshot, alternative.id, target),
    /changed after preview/
  )

  const removePreview = await previewSkillRemove(snapshot, selected.id, target)
  assert.equal(removePreview.action, "remove")
  await applySkillSync(snapshot, selected.id, target)
  await assert.rejects(readFile(join(installed, "SKILL.md")), /ENOENT/)
  const backups = await readdir(join(directory, ".grok", ".mako-skill-backups"))
  assert.equal(backups.length > 0, true)
  assert.equal(await hashSkillDirectory(review), selected.hash)
} finally {
  await rm(directory, { recursive: true, force: true })
}

console.log("skill registry and transactional sync checks passed")
