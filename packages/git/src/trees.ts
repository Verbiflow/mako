import { delimiter } from "node:path"
import { GitError } from "./errors.js"
import { parseNumstat, type LineCount } from "./lines.js"
import { ObjectReader } from "./objects.js"
import { readPreview, type Preview } from "./preview.js"
import { run } from "./run.js"
import type { Change } from "./status.js"

export interface TreeChange {
  path: string
  change: Change
  lines: LineCount
}

const OID = /^[0-9a-f]{40,64}$/
const CHANGES = new Map<string, Change>([["A", "added"], ["D", "deleted"], ["T", "typechange"]])

/**
 * Two trees of one repository, such as the checkpoints either side of an
 * agent's turn, whose objects may live in stores of their own outside it.
 * Lists what changed between them and previews each file, reading through
 * one object reader that sees those stores.
 */
export class TreeComparison {
  readonly root: string
  readonly from: string
  readonly to: string
  private readonly env: Readonly<Record<string, string | undefined>>
  private readonly objects: ObjectReader

  /** `stores` are object folders read besides the repository's own. */
  constructor(input: { root: string; from: string; to: string; stores?: readonly string[] }) {
    if (!OID.test(input.from) || !OID.test(input.to)) throw new GitError({ kind: "failed", message: "Choose two trees to compare." })
    this.root = input.root
    this.from = input.from
    this.to = input.to
    this.env = { GIT_ALTERNATE_OBJECT_DIRECTORIES: input.stores?.length ? input.stores.join(delimiter) : undefined }
    this.objects = new ObjectReader(input.root, this.env)
  }

  async files(): Promise<TreeChange[]> {
    const compared = ["-r", "-z", "--no-renames", this.from, this.to, "--"]
    const [names, counts] = await Promise.all([
      run({ cwd: this.root, args: ["diff-tree", "--name-status", ...compared], env: this.env, read: true }),
      run({ cwd: this.root, args: ["diff-tree", "--numstat", ...compared], env: this.env, read: true }),
    ])
    const lines = parseNumstat(counts.stdout)
    const fields = names.stdout.toString("utf8").split("\0")
    const files: TreeChange[] = []
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const code = fields[at]!.trim()
      if (!code) continue
      const path = fields[at + 1]!
      files.push({ path, change: CHANGES.get(code[0]!) ?? "modified", lines: lines.has(path) ? lines.get(path)! : { insertions: 0, deletions: 0 } })
    }
    return files
  }

  preview(path: string): Promise<Preview> {
    if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").includes(".."))
      throw new GitError({ kind: "failed", message: "Choose a file inside this repository." })
    return readPreview({ root: this.root, objects: this.objects, base: async () => this.from, env: this.env }, path, { kind: "trees", from: this.from, to: this.to })
  }

  close(): void {
    this.objects.close()
  }
}
