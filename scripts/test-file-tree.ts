import assert from "node:assert/strict"
import { buildFileTree } from "../src/lib/file-tree.ts"
import type { GitFile } from "../src/lib/types.ts"

const file = (path: string, staged = false): GitFile => ({ path, status: "modified", staged, binary: false, insertions: 1, deletions: 0 })
const files = [file("README.md"), file("src/components/rail/a.tsx", true), file("src/components/rail/b.tsx"), file("src/main.ts"), file("src/components/c.tsx")]
const outline = (rows: ReturnType<typeof buildFileTree>) => rows.map((row) => `${"  ".repeat(row.depth)}${row.kind === "dir" ? `${row.label}/ ${row.staged}/${row.files}` : row.label}`)

assert.deepEqual(outline(buildFileTree(files, [])), [
  "src/ 1/4",
  "  components/ 1/3",
  "    rail/ 1/2",
  "      a.tsx",
  "      b.tsx",
  "    c.tsx",
  "  main.ts",
  "README.md",
], "the tree nests folders and folds single-child chains")

assert.deepEqual(outline(buildFileTree(files, [], "folders")), [
  "README.md",
  "src/ 0/1",
  "  main.ts",
  "src/components/ 0/1",
  "  c.tsx",
  "src/components/rail/ 1/2",
  "  a.tsx",
  "  b.tsx",
], "by folder lists each folder once with only its own files, top-level files first")

const folded = buildFileTree(files, ["src/components/rail"], "folders")
assert.deepEqual(outline(folded).slice(-1), ["src/components/rail/ 1/2"], "a folded folder hides its files")
const rail = folded.at(-1)
assert.ok(rail?.kind === "dir")
assert.deepEqual(rail.paths, ["src/components/rail/a.tsx", "src/components/rail/b.tsx"], "a folder row stages only the files it shows")

console.log("file tree: nested and folded, or by folder with each folder's own files")
