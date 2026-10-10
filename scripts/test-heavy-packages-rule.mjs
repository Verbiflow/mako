import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"

/**
 * The `mako/heavy-packages` lint rule against a small repository of its own:
 * every form the rule must refuse is refused, with the message for it, and
 * every form it allows passes.
 */
const root = resolve(import.meta.dirname, "..")
const scratch = await mkdtemp(join(tmpdir(), "mako-heavy-packages-"))
const files = {
  "scripts/heavy-packages.json": JSON.stringify({
    packages: ["yaml", "@ai-sdk/"],
    declarations: ["electron/heavy-packages.ts"],
    adapters: {
      "electron/yaml-adapter.ts": { uses: "yaml", loadedBy: ["electron/heavy-packages.ts", "electron/lazy-user.ts"] },
    },
  }),
  "electron/heavy-packages.ts": [
    'import { stringify } from "yaml"',
    'export const yaml = () => import("yaml")',
    'export const adapter = () => import("./yaml-adapter.js")',
    'import "./yaml-adapter.js"',
  ].join("\n"),
  "electron/yaml-adapter.ts": 'import { parse } from "yaml"\nexport const read = parse',
  "electron/lazy-user.ts": 'import { read } from "./yaml-adapter.js"\nexport { read }',
  "electron/user.ts": [
    'import type { Document } from "yaml"',
    'import { parse } from "yaml"',
    'import { createOpenAI } from "@ai-sdk/openai"',
    'import { type Scalar } from "yaml"',
    'export type { Pair } from "yaml"',
    'export { stringify } from "yaml/util"',
    'export const later = () => import("yaml")',
    'export const adapter = () => import("./yaml-adapter.js")',
    'export const other = () => import("./other.js")',
  ].join("\n"),
  "electron/test/fixture.ts": 'import { parse } from "yaml"\nexport { parse }',
  "scripts/tool.ts": 'import { parse } from "yaml"\nexport { parse }',
  ".oxlintrc.json": JSON.stringify({
    jsPlugins: [{ name: "mako", specifier: join(root, "tools/oxlint/mako/index.ts") }],
    rules: { "mako/heavy-packages": "error" },
  }),
}
try {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(scratch, path)), { recursive: true })
    await writeFile(join(scratch, path), contents)
  }
  const { stdout } = await promisify(execFile)(join(root, "node_modules/.bin/oxlint"), ["--config", ".oxlintrc.json", "--format", "json", "electron", "scripts"], { cwd: scratch }).catch((error) => error)
  const found = JSON.parse(stdout).diagnostics
    .filter((diagnostic) => diagnostic.code === "mako(heavy-packages)")
    .map((diagnostic) => `${diagnostic.filename}:${diagnostic.labels[0].span.line} ${diagnostic.message.split(/[:.]/, 1)[0]}`)
    .sort()
  assert.deepEqual(found, [
    "electron/heavy-packages.ts:1 A declaration loads `yaml` with `import()` inside `lazyPackage`, never at its top, or every importer of `heavy` would load it",
    "electron/heavy-packages.ts:4 A declaration loads `electron/yaml-adapter",
    "electron/user.ts:2 `yaml` is a heavy package",
    "electron/user.ts:3 `@ai-sdk/openai` is a heavy package",
    "electron/user.ts:4 `yaml` is a heavy package",
    "electron/user.ts:6 `yaml/util` is a heavy package",
    "electron/user.ts:7 Load `yaml` through its declaration in electron/heavy-packages",
    "electron/user.ts:8 electron/yaml-adapter",
  ])
  console.log(`PASS: mako/heavy-packages refuses ${found.length} violations and allows types, declarations, adapters and their listed loaders`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
