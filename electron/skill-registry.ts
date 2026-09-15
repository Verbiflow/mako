import { createHash } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { access, lstat, readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import {
  delimiter,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { parse } from "yaml"
import { z } from "zod"
import { selectedAccount } from "./accounts.js"
import { providerHost } from "./providers/index.js"
import {
  SKILL_HANDOVER_LIMIT,
  skillDelivery,
  skillDeliveryOrigin,
} from "./contracts/skill-reach.js"
import type {
  SkillOrigin,
  SkillProvider,
  SkillProviderStatus,
  SkillRecord,
  SkillReference,
  SkillRegistrySnapshot,
  SkillScope,
  SkillSyncTarget,
} from "./shared.js"

const MAX_SKILL_FILES = 1024
const MAX_SKILL_BYTES = 64 * 1024 * 1024
const MAX_SKILL_FILE_BYTES = 16 * 1024 * 1024
const MAX_SCAN_DEPTH = 5
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const frontmatterSchema = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(1024),
    license: z.string().min(1).max(256).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    "allowed-tools": z
      .union([z.string(), z.array(z.string())])
      .optional(),
    "disable-model-invocation": z.boolean().optional(),
  })
  .passthrough()

export interface SkillRoot {
  provider: SkillProvider
  account: string
  scope: SkillScope
  root: string
}

interface SkillFiles {
  files: Array<{ path: string; contents: Buffer }>
  bytes: number
  blockReason?: string
}

interface DiscoveredSkill {
  record: SkillRecord
}

function posixPath(value: string): string {
  return value.split(sep).join("/")
}

function parseFrontmatter(contents: string) {
  const match = FRONTMATTER.exec(contents)
  if (!match?.[1]) return null
  const parsed = frontmatterSchema.safeParse(parse(match[1]))
  return parsed.success ? parsed.data : null
}

/** The instructions a SKILL.md carries: everything after its frontmatter. */
export function skillBody(contents: string): string {
  return contents.replace(FRONTMATTER, "").trim()
}

function allowedTools(value: string | string[] | undefined): string[] | undefined {
  if (Array.isArray(value)) return value.filter(Boolean)
  const parsed = value?.split(/\s+/).filter(Boolean)
  return parsed?.length ? parsed : undefined
}

async function readSkillFiles(directory: string): Promise<SkillFiles> {
  const files: Array<{ path: string; contents: Buffer }> = []
  let bytes = 0
  let blockReason: string | undefined

  async function walk(current: string): Promise<void> {
    if (blockReason) return
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      if (blockReason) return
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        blockReason = "contains symbolic links"
        return
      }
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const stats = await lstat(path)
      if (stats.size > MAX_SKILL_FILE_BYTES) {
        blockReason = `contains a file larger than ${MAX_SKILL_FILE_BYTES} bytes`
        return
      }
      const contents = await readFile(path)
      bytes += contents.byteLength
      files.push({ path: posixPath(relative(directory, path)), contents })
      if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
        blockReason = "exceeds Mako's bounded skill package limits"
        return
      }
    }
  }

  await walk(directory)
  return { files, bytes, blockReason }
}

function hashFiles(files: SkillFiles["files"]): string {
  const digest = createHash("sha256")
  for (const file of files) {
    digest.update(file.path).update("\0").update(file.contents).update("\0")
  }
  return digest.digest("hex")
}

async function readSkill(
  directory: string,
  origin: Omit<SkillOrigin, "hash">
): Promise<DiscoveredSkill | null> {
  const manifest = join(directory, "SKILL.md")
  try {
    const raw = await readFile(manifest, "utf8")
    const metadata = parseFrontmatter(raw)
    if (!metadata) return null
    const packageFiles = await readSkillFiles(directory)
    const reasons: string[] = []
    if (!skillName.test(metadata.name))
      reasons.push("name is not lowercase kebab-case")
    if (packageFiles.blockReason) reasons.push(packageFiles.blockReason)
    const hash = hashFiles(packageFiles.files)
    const record: SkillRecord = {
      id: createHash("sha256")
        .update(metadata.name)
        .update("\0")
        .update(hash)
        .digest("hex")
        .slice(0, 16),
      name: metadata.name,
      description: metadata.description,
      hash,
      bytes: packageFiles.bytes,
      files: packageFiles.files.length,
      portable: reasons.length === 0,
      origins: [{ ...origin, hash }],
    }
    if (metadata.license) record.license = metadata.license
    if (metadata.compatibility) record.compatibility = metadata.compatibility
    if (metadata["disable-model-invocation"]) record.manual = true
    const tools = allowedTools(metadata["allowed-tools"])
    if (tools) record.allowedTools = tools
    if (reasons.length) record.blockReason = reasons.join("; ")
    return { record }
  } catch {
    return null
  }
}

async function findSkillDirectories(
  root: string,
  depth = 0
): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const directories: string[] = []
  if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
    directories.push(root)
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    directories.push(
      ...(await findSkillDirectories(join(root, entry.name), depth + 1))
    )
  }
  return directories
}

function workspaceBases(cwd: string): string[] {
  const bases: string[] = []
  let current = resolve(cwd)
  while (true) {
    bases.push(current)
    if (existsSync(join(current, ".git"))) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return bases
}

export async function skillRoots(cwd: string): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [
    {
      provider: "agents",
      account: "local",
      scope: "user",
      root: join(homedir(), ".agents", "skills"),
    },
  ]
  const sources = providerHost.skillSources.list()
  for (const source of sources) {
    const account = await selectedAccount(source.provider)
    for (const root of source.userRoots(account)) {
      roots.push({
        provider: source.provider,
        account: account.name,
        scope: "user",
        root,
      })
    }
  }
  for (const base of workspaceBases(cwd)) {
    roots.push({
      provider: "agents",
      account: "local",
      scope: "workspace",
      root: join(base, ".agents", "skills"),
    })
    for (const source of sources) {
      roots.push({
        provider: source.provider,
        account: "default",
        scope: "workspace",
        root: join(base, source.workspaceFolder, "skills"),
      })
    }
  }
  const unique = new Map(roots.map((root) => [root.root, root]))
  return [...unique.values()]
}

export async function skillTargetRoot(
  cwd: string,
  target: SkillSyncTarget
): Promise<string> {
  const source = providerHost.skillSources.get(target.provider)
  if (!source) throw new Error(`Provider ${target.provider} has no skill source`)
  if (target.scope === "workspace") {
    return join(cwd, source.workspaceFolder, "skills")
  }
  const account = await selectedAccount(target.provider)
  if (account.name !== target.account) {
    throw new Error("The target account is no longer selected")
  }
  return source.targetUserRoot(account)
}

function mergeSkills(skills: DiscoveredSkill[]): SkillRecord[] {
  const records = new Map<string, SkillRecord>()
  const hashesByName = new Map<string, Set<string>>()
  for (const skill of skills) {
    const existing = records.get(skill.record.name)
    if (existing) {
      for (const origin of skill.record.origins) {
        if (
          !existing.origins.some(
            (candidate) => candidate.provenance === origin.provenance
          )
        ) {
          existing.origins.push(origin)
        }
      }
    } else {
      records.set(skill.record.name, {
        ...skill.record,
        origins: [...skill.record.origins],
      })
    }
    const hashes = hashesByName.get(skill.record.name) ?? new Set<string>()
    hashes.add(skill.record.hash)
    hashesByName.set(skill.record.name, hashes)
  }
  return [...records.values()]
    .map((record) =>
      (hashesByName.get(record.name)?.size ?? 0) > 1
        ? { ...record, conflict: "drift" as const }
        : record
    )
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function providerStatuses(): Promise<SkillProviderStatus[]> {
  return Promise.all(
    providerHost.skillSources.list().map(async (source) => {
      const account = await selectedAccount(source.provider)
      const command = source.command()
      let available = false
      const candidates = !command
        ? []
        : command.includes("/")
          ? [command]
          : (process.env.PATH ?? "")
              .split(delimiter)
              .filter(Boolean)
              .map((folder) => join(folder, command))
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.X_OK)
          available = true
          break
        } catch {
          continue
        }
      }
      return {
        id: source.provider,
        label: providerHost.profiles.get(source.provider)?.label ?? source.provider,
        account: account.name,
        available,
        readsUniversalRoot: source.readsUniversalRoot,
      }
    })
  )
}

export async function discoverSkillRecords(
  roots: SkillRoot[]
): Promise<SkillRecord[]> {
  const discovered: DiscoveredSkill[] = []
  for (const root of roots) {
    for (const directory of await findSkillDirectories(root.root)) {
      const skill = await readSkill(directory, {
        provider: root.provider,
        account: root.account,
        scope: root.scope,
        provenance: join(directory, "SKILL.md"),
      })
      if (skill) discovered.push(skill)
    }
  }
  return mergeSkills(discovered)
}

export async function discoverSkillRegistry(
  cwd: string
): Promise<SkillRegistrySnapshot> {
  return {
    cwd,
    generatedAt: Date.now(),
    skills: await discoverSkillRecords(await skillRoots(cwd)),
    providers: await providerStatuses(),
  }
}

export function skillSourceDirectory(
  snapshot: SkillRegistrySnapshot,
  skillId: string
): string {
  const skill = snapshot.skills.find((entry) => entry.id === skillId)
  if (!skill) throw new Error("That skill is no longer in the registry")
  const source = skill.origins[0]?.provenance
  if (!source) throw new Error("That skill has no readable source")
  return dirname(source)
}

export async function hashSkillDirectory(directory: string): Promise<string> {
  return hashFiles((await readSkillFiles(directory)).files)
}

/**
 * Frontmatter the schema admits is small, so a SKILL.md this much larger
 * than the handover cap cannot hold a body that fits and is not read at all.
 */
const HANDOVER_READ_LIMIT = SKILL_HANDOVER_LIMIT * 2

/**
 * Resolve the `$skill` names a message carries for the provider that will
 * answer it. A handover reads the SKILL.md the chosen origin points at and
 * carries its body when it fits `SKILL_HANDOVER_LIMIT`; a larger one, or one
 * that cannot be read, is handed over by path alone. The hash is the chosen
 * copy's own, so a later mention points back at the text that was sent even
 * when the copies have drifted. Names are resolved once each, in the order
 * given.
 */
export async function resolveSkillReferences(
  snapshot: SkillRegistrySnapshot,
  names: readonly string[],
  harness: string
): Promise<SkillReference[]> {
  const unique = [...new Set(names)]
  return Promise.all(
    unique.map(async (name): Promise<SkillReference> => {
      const skill = snapshot.skills.find((entry) => entry.name === name)
      if (!skill) return { name, delivery: { kind: "missing" } }
      const delivery = skillDelivery(skill, harness, snapshot.providers)
      const reference: SkillReference = { name, delivery }
      reference.description = skill.description
      reference.hash =
        skillDeliveryOrigin(skill, harness, snapshot.providers)?.origin.hash ??
        skill.hash
      if (delivery.kind !== "handover") return reference
      try {
        const stats = await lstat(delivery.path)
        if (stats.size > HANDOVER_READ_LIMIT) {
          reference.oversize = true
          return reference
        }
        const body = skillBody(await readFile(delivery.path, "utf8"))
        if (Buffer.byteLength(body, "utf8") > SKILL_HANDOVER_LIMIT) {
          reference.oversize = true
        } else {
          reference.body = body
        }
      } catch {
        reference.oversize = true
      }
      return reference
    })
  )
}
