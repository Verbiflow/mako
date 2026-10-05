import type { GitFile } from "@/lib/types"

/**
 * A flattened directory tree for the changes list.
 *
 * Flat rather than nested for the same reason the rail is: one array renders,
 * virtualizes, and keyboard-navigates uniformly. Directories that contain
 * exactly one child are folded into their parent ("src/components/rail"
 * instead of three rows), which is what keeps a deep repo readable.
 *
 * `folders` lists one row per folder that has changed files directly in it,
 * with only those files beneath, and no nesting: the flat list editors offer.
 */

export interface TreeDir {
  kind: "dir"
  key: string
  /** The collapsed label, e.g. `src/components/rail`. */
  label: string
  depth: number
  files: number
  insertions: number | null
  deletions: number | null
  collapsed: boolean
  /** Every file beneath this directory, so it can be staged as a unit. */
  paths: string[]
  /** How many of `paths` are staged — drives the tri-state checkbox. */
  staged: number
}

export interface TreeFile {
  kind: "file"
  key: string
  /** Just the file name; the directory is implied by its parent row. */
  label: string
  depth: number
  file: GitFile
}

export type TreeRow = TreeDir | TreeFile

interface Node {
  name: string
  children: Map<string, Node>
  files: GitFile[]
}

export function buildFileTree(files: GitFile[], collapsed: string[], view: "tree" | "folders" = "tree"): TreeRow[] {
  if (view === "folders") return byFolder(files, collapsed)
  const root: Node = { name: "", children: new Map(), files: [] }

  for (const file of files) {
    const parts = file.path.split("/")
    parts.pop()
    let node = root
    for (const part of parts) {
      let next = node.children.get(part)
      if (!next) {
        next = { name: part, children: new Map(), files: [] }
        node.children.set(part, next)
      }
      node = next
    }
    node.files.push(file)
  }

  const rows: TreeRow[] = []
  const isCollapsed = (key: string) => collapsed.includes(key)

  const walk = (node: Node, prefix: string, depth: number) => {
    // Fold a chain of single-child directories into one row.
    let label = node.name
    let cursor = node
    while (cursor.files.length === 0 && cursor.children.size === 1) {
      const [only] = [...cursor.children.values()]
      label = label ? `${label}/${only.name}` : only.name
      cursor = only
    }

    const key = prefix ? `${prefix}/${label}` : label
    const stats = totals(cursor)

    if (label) {
      const down = isCollapsed(key)
      rows.push({
        kind: "dir",
        key,
        label,
        depth,
        files: stats.files,
        insertions: stats.insertions,
        deletions: stats.deletions,
        collapsed: down,
        paths: stats.paths,
        staged: stats.staged,
      })
      if (down) return
    }

    const childDepth = label ? depth + 1 : depth
    for (const child of [...cursor.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      walk(child, key, childDepth)
    }
    for (const file of cursor.files.sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({
        kind: "file",
        key: file.path,
        label: file.path.split("/").at(-1) ?? file.path,
        depth: childDepth,
        file,
      })
    }
  }

  walk(root, "", 0)
  return rows
}

function byFolder(files: GitFile[], collapsed: string[]): TreeRow[] {
  const folders = new Map<string, GitFile[]>()
  for (const file of files) {
    const slash = file.path.lastIndexOf("/")
    const folder = slash < 0 ? "" : file.path.slice(0, slash)
    const inside = folders.get(folder)
    if (inside) inside.push(file)
    else folders.set(folder, [file])
  }
  const rows: TreeRow[] = []
  // The repository's own top-level files come first, under no folder row.
  for (const folder of [...folders.keys()].sort((a, b) => a.localeCompare(b))) {
    const inside = folders.get(folder)!.sort((a, b) => a.path.localeCompare(b.path))
    if (folder) {
      const down = collapsed.includes(folder)
      rows.push({ kind: "dir", key: folder, label: folder, depth: 0, collapsed: down, ...totals({ name: folder, children: new Map(), files: inside }) })
      if (down) continue
    }
    for (const file of inside)
      rows.push({ kind: "file", key: file.path, label: file.path.slice(folder ? folder.length + 1 : 0), depth: folder ? 1 : 0, file })
  }
  return rows
}

interface Totals {
  files: number
  insertions: number | null
  deletions: number | null
  paths: string[]
  staged: number
}

function totals(node: Node): Totals {
  let files = node.files.length
  let insertions = node.files.reduce<number | null>((sum, file) => sum === null || file.insertions === null ? null : sum + file.insertions, 0)
  let deletions = node.files.reduce<number | null>((sum, file) => sum === null || file.deletions === null ? null : sum + file.deletions, 0)
  let staged = node.files.reduce((sum, file) => sum + (file.staged ? 1 : 0), 0)
  const paths = node.files.map((file) => file.path)

  for (const child of node.children.values()) {
    const nested = totals(child)
    files += nested.files
    insertions = insertions === null || nested.insertions === null ? null : insertions + nested.insertions
    deletions = deletions === null || nested.deletions === null ? null : deletions + nested.deletions
    staged += nested.staged
    paths.push(...nested.paths)
  }
  return { files, insertions, deletions, paths, staged }
}
