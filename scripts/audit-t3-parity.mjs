import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const [mainPath, v2Path] = process.argv.slice(2)
if (!mainPath || !v2Path) {
  throw new Error(
    "Usage: node scripts/audit-t3-parity.mjs /path/to/t3-main /path/to/t3-v2"
  )
}
const directory = resolve(workspace, "docs/public-audits/2026-09-08/t3-parity")
const matrix = JSON.parse(
  readFileSync(resolve(directory, "matrix.json"), "utf8")
)
const roots = { mako: workspace, main: resolve(mainPath), v2: resolve(v2Path) }
for (const repo of ["main", "v2"]) {
  const revision = execFileSync(
    "git",
    ["-C", roots[repo], "rev-parse", "HEAD"],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4096,
    }
  ).trim()
  if (revision !== matrix.revisions[repo]) {
    throw new Error(
      `${repo} moved to ${revision}; review the source changes and update matrix.json first`
    )
  }
}

const files = new Map()
const evidence = []
for (const row of matrix.rows) {
  for (const ref of row.evidence) {
    const root = roots[ref.repo]
    if (!root) throw new Error(`Unknown source repository: ${ref.repo}`)
    const path = resolve(root, ref.path)
    const within = relative(root, path)
    if (within.startsWith("..") || isAbsolute(within))
      throw new Error(`Evidence escapes repository: ${ref.path}`)
    let source = files.get(path)
    if (!source) {
      if (statSync(path).size > 4 * 1024 * 1024)
        throw new Error(`Evidence file exceeds 4 MB: ${ref.path}`)
      source = readFileSync(path, "utf8")
      files.set(path, source)
    }
    const offset = source.indexOf(ref.anchor)
    if (offset < 0)
      throw new Error(
        `Missing evidence anchor for ${row.id}: ${ref.repo}/${ref.path}: ${ref.anchor}`
      )
    const line = source.slice(0, offset).split("\n").length
    evidence.push({
      row: row.id,
      ...ref,
      line,
      sha256: createHash("sha256").update(source).digest("hex"),
    })
  }
}

// Registry construction does not start provider sessions or scan native stores.
const registry = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--max-old-space-size=256",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { providerHost } from "./electron/providers/index.ts"; console.log(JSON.stringify(providerHost.liveDrivers.list().map(d => ({ provider: d.provider, nativeResume: d.canResume, nativeForkAtRun: !!d.forkPoint, steer: typeof d.steer === "function", compact: typeof d.compact === "function" }))))',
    ],
    { cwd: workspace, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 }
  )
)

function sourceLink(ref) {
  const target =
    ref.repo === "mako"
      ? `${resolve(workspace, ref.path)}:${ref.line}`
      : `https://github.com/pingdotgg/t3code/blob/${matrix.revisions[ref.repo]}/${ref.path}#L${ref.line}`
  return `[${ref.repo}: ${ref.path.split("/").at(-1)}](${target})`
}
const lines = [
  "# T3 parity matrix",
  "",
  `References: main \`${matrix.revisions.main}\`; V2 \`${matrix.revisions.v2}\` (${matrix.v2State}).`,
  "",
  "Generated from matrix.json. Statuses are reviewed assessments, not results inferred from filenames or test counts. This command validates source references and reads Mako’s actual capability registry. It does not run T3, certify parity, or establish a success rate.",
  "",
  "| Area | Status | T3 evidence | Mako evidence | Required to close |",
  "| --- | --- | --- | --- | --- |",
  ...matrix.rows.map(
    (row) =>
      `| ${row.area} | ${row.status} | ${row.t3} | ${row.mako} | ${row.required} |`
  ),
  "",
  "## Source references",
  "",
  ...matrix.rows.map(
    (row) =>
      `- **${row.area}**: ${evidence
        .filter((ref) => ref.row === row.id)
        .map(sourceLink)
        .join("; ")}`
  ),
  "",
  "## Actual Mako registration",
  "",
  "Optional methods are read from the installed provider modules. A true value means advertised capability, not a new live test. False native resume does not rule out portable continuation.",
  "",
  "| Provider | Native resume | Native fork at run | Steer | Manual compact |",
  "| --- | --- | --- | --- | --- |",
  ...registry.map(
    (row) =>
      `| ${row.provider} | ${row.nativeResume} | ${row.nativeForkAtRun} | ${row.steer} | ${row.compact} |`
  ),
  "",
]
writeFileSync(resolve(directory, "MATRIX.md"), lines.join("\n"))
writeFileSync(
  resolve(directory, "source-evidence.json"),
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      revisions: matrix.revisions,
      registry,
      evidence,
    },
    null,
    2
  ) + "\n"
)
console.log(
  `Validated ${evidence.length} references in ${files.size} files across ${matrix.rows.length} audit areas. Read ${registry.length} registered providers. Behavioral parity is NOT certified.`
)
