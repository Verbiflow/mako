import { providerHost } from "./providers/index.js"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  hashSkillDirectory,
  skillSourceDirectory,
  skillTargetRoot,
} from "./skill-registry.js"
import type {
  SkillRecord,
  SkillRegistrySnapshot,
  SkillSyncPreview,
  SkillSyncTarget,
} from "./shared.js"

interface CachedPreview {
  action: SkillSyncPreview["action"]
  sourceHash: string
  targetHash: string | null
}

const previews = new Map<string, CachedPreview>()
const writes = new Map<string, Promise<void>>()

function previewKey(skillId: string, target: SkillSyncTarget): string {
  return `${skillId}\0${target.provider}\0${target.account}\0${target.scope}`
}

function findSkill(
  snapshot: SkillRegistrySnapshot,
  skillId: string
): SkillRecord {
  const skill = snapshot.skills.find((entry) => entry.id === skillId)
  if (!skill) throw new Error("That skill is no longer in the registry")
  return skill
}

function blockedPreview(
  skillId: string,
  target: SkillSyncTarget,
  blockReason: string
): SkillSyncPreview {
  return {
    skillId,
    target,
    action: "blocked",
    summary: `Cannot sync to ${target.provider}`,
    blockReason,
  }
}

async function currentHash(directory: string): Promise<string | null> {
  if (!existsSync(join(directory, "SKILL.md"))) return null
  return hashSkillDirectory(directory)
}

export async function previewSkillSync(
  snapshot: SkillRegistrySnapshot,
  skillId: string,
  target: SkillSyncTarget
): Promise<SkillSyncPreview> {
  const skill = findSkill(snapshot, skillId)
  if (
    !providerHost.skillEditing
      .get(target.provider)
      ?.operations.includes("import")
  )
    return blockedPreview(
      skillId,
      target,
      "Skill import is not implemented for this harness"
    )
  const status = snapshot.providers.find(
    (entry) => entry.id === target.provider
  )
  if (!status || status.account !== target.account)
    return blockedPreview(
      skillId,
      target,
      "target account is not the selected account"
    )
  if (!skill.portable)
    return blockedPreview(
      skillId,
      target,
      skill.blockReason ?? "this skill is not portable"
    )
  const root = await skillTargetRoot(snapshot.cwd, target)
  const targetDirectory = join(root, skill.name)
  const targetHash = await currentHash(targetDirectory)
  const action =
    targetHash === skill.hash ? "unchanged" : targetHash ? "replace" : "add"
  previews.set(previewKey(skillId, target), {
    action,
    sourceHash: skill.hash,
    targetHash,
  })
  return {
    skillId,
    target,
    action,
    summary:
      action === "unchanged"
        ? `${skill.name} already matches in ${target.provider}`
        : `${action === "add" ? "Add" : "Replace"} ${skill.name} in ${target.provider}`,
  }
}

export async function previewSkillRemove(
  snapshot: SkillRegistrySnapshot,
  skillId: string,
  target: SkillSyncTarget
): Promise<SkillSyncPreview> {
  const skill = findSkill(snapshot, skillId)
  if (
    !providerHost.skillEditing
      .get(target.provider)
      ?.operations.includes("remove")
  )
    return blockedPreview(
      skillId,
      target,
      "Skill removal is not implemented for this harness"
    )
  const status = snapshot.providers.find(
    (entry) => entry.id === target.provider
  )
  if (!status || status.account !== target.account)
    return blockedPreview(
      skillId,
      target,
      "target account is not the selected account"
    )
  const root = await skillTargetRoot(snapshot.cwd, target)
  const targetHash = await currentHash(join(root, skill.name))
  const action = targetHash ? "remove" : "unchanged"
  previews.set(previewKey(skillId, target), {
    action,
    sourceHash: skill.hash,
    targetHash,
  })
  return {
    skillId,
    target,
    action,
    summary: targetHash
      ? `Remove ${skill.name} from ${target.provider}`
      : `${skill.name} is not installed in ${target.provider}`,
  }
}

async function serialized(path: string, operation: () => Promise<void>) {
  const previous = writes.get(path) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  writes.set(path, current)
  try {
    await current
  } finally {
    if (writes.get(path) === current) writes.delete(path)
  }
}

async function backupDirectory(root: string, name: string): Promise<string> {
  const directory = join(dirname(root), ".mako-skill-backups")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return join(directory, `${name}-${Date.now()}-${randomUUID()}`)
}

export async function applySkillSync(
  snapshot: SkillRegistrySnapshot,
  skillId: string,
  target: SkillSyncTarget
): Promise<void> {
  const skill = findSkill(snapshot, skillId)
  const key = previewKey(skillId, target)
  const cached = previews.get(key)
  if (!cached) throw new Error("Preview this skill change before applying it")
  if (cached.action === "blocked")
    throw new Error("This skill change is blocked")
  if (
    !providerHost.skillEditing
      .get(target.provider)
      ?.operations.includes(cached.action === "remove" ? "remove" : "import")
  )
    throw new Error("This skill operation is not implemented for this harness")
  if (cached.action === "unchanged") {
    previews.delete(key)
    return
  }
  const root = await skillTargetRoot(snapshot.cwd, target)
  const targetDirectory = join(root, skill.name)
  await serialized(targetDirectory, async () => {
    const targetHash = await currentHash(targetDirectory)
    if (targetHash !== cached.targetHash)
      throw new Error(
        "The target skill changed after preview; review it again before syncing"
      )
    if (cached.action === "remove") {
      if (!targetHash) return
      await rename(targetDirectory, await backupDirectory(root, skill.name))
      return
    }
    if (!skill.portable)
      throw new Error(skill.blockReason ?? "This skill is not portable")
    const source = skillSourceDirectory(snapshot, skillId)
    if ((await hashSkillDirectory(source)) !== cached.sourceHash)
      throw new Error(
        "The source skill changed after preview; review it again before syncing"
      )
    await mkdir(root, { recursive: true, mode: 0o700 })
    const temporary = join(root, `.${randomUUID()}.tmp`)
    let backup: string | undefined
    try {
      await cp(source, temporary, {
        recursive: true,
        force: false,
        errorOnExist: true,
      })
      if (targetHash) {
        backup = await backupDirectory(root, skill.name)
        await rename(targetDirectory, backup)
      }
      await rename(temporary, targetDirectory)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      if (backup && !existsSync(targetDirectory) && existsSync(backup)) {
        await rename(backup, targetDirectory).catch(() => undefined)
      }
      throw error
    }
  }).finally(() => previews.delete(key))
}
