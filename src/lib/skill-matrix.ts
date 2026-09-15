import { UNIVERSAL_SKILL_PROVIDER } from "../../electron/contracts/skill-reach"
import type {
  SkillOrigin,
  SkillProviderStatus,
  SkillRecord,
  SkillRegistrySnapshot,
} from "./types"

/**
 * Settings > Skills as a grid: one row per skill, one column per place a
 * copy can live. A cell says whether that place has the skill and whether
 * its copy matches the one Mako lists (`origins[0]`, the copy a sync reads
 * from). This is the whole story a `$skill` needs told: a filled cell is a
 * provider that loads the skill itself, an empty one is a provider that is
 * handed it.
 */

export type SkillCellState = "installed" | "drifted" | "absent"

export interface SkillCell {
  state: SkillCellState
  /** Every copy this column holds; a provider can have one per scope. */
  copies: SkillOrigin[]
}

export interface SkillColumn {
  id: string
  label: string
  /** The universal `.agents/skills` root: read by Mako, written by nobody here. */
  universal: boolean
  /** The provider's CLI was found; a column for one that was not still shows its copies. */
  available: boolean
  account?: string
}

export interface SkillMatrixRow {
  skill: SkillRecord
  cells: Map<string, SkillCell>
  /** How many columns hold a copy. */
  installed: number
}

export function skillColumns(
  providers: readonly SkillProviderStatus[]
): SkillColumn[] {
  return [
    {
      id: UNIVERSAL_SKILL_PROVIDER,
      label: "Universal",
      universal: true,
      available: true,
    },
    ...providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      universal: false,
      available: provider.available,
      account: provider.account,
    })),
  ]
}

export function skillCell(skill: SkillRecord, column: string): SkillCell {
  const copies = skill.origins.filter((origin) => origin.provider === column)
  if (copies.length === 0) return { state: "absent", copies }
  return {
    state: copies.every((origin) => origin.hash === skill.hash)
      ? "installed"
      : "drifted",
    copies,
  }
}

export function skillMatrixRows(
  snapshot: SkillRegistrySnapshot,
  columns: readonly SkillColumn[],
  filter = ""
): SkillMatrixRow[] {
  const term = filter.trim().toLowerCase()
  const rows: SkillMatrixRow[] = []
  for (const skill of snapshot.skills) {
    if (
      term &&
      !skill.name.toLowerCase().includes(term) &&
      !skill.description.toLowerCase().includes(term) &&
      !skill.origins.some((origin) => origin.provider.includes(term))
    )
      continue
    const cells = new Map<string, SkillCell>()
    let installed = 0
    for (const column of columns) {
      const cell = skillCell(skill, column.id)
      cells.set(column.id, cell)
      if (cell.state !== "absent") installed += 1
    }
    rows.push({ skill, cells, installed })
  }
  return rows
}

/** The copy a sync writes from: the first the registry found. */
export function listedCopy(skill: SkillRecord): SkillOrigin | undefined {
  return skill.origins.find((origin) => origin.hash === skill.hash)
}

const HOME = /^\/(?:Users|home)\/[^/]+(?=\/)/

/** `~`-relative for the line a person reads; the host keeps the absolute path. */
export function homeRelative(path: string): string {
  return path.replace(HOME, "~")
}

export function skillDirectory(provenance: string): string {
  const at = provenance.lastIndexOf("/")
  return at === -1 ? provenance : provenance.slice(0, at)
}
