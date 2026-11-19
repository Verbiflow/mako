import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// `check-host-boundaries.mjs` on small trees of its own: what the composition root may import of a domain (its entry,
// and its parts as `load.ts` lists them), and that a domain's `load.ts` is no other domain's to import.
const root = mkdtempSync(join(tmpdir(), "mako-host-boundaries-"))
const check = join(import.meta.dirname, "check-host-boundaries.mjs")

function checked(name: string, files: Readonly<Record<string, string>>) {
  const source = join(root, name)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(source, path)), { recursive: true })
    writeFileSync(join(source, path), text)
  }
  const ran = spawnSync(process.execPath, [check, source], { encoding: "utf8", cwd: join(import.meta.dirname, "..") })
  return { ok: ran.status === 0, said: ran.stderr + ran.stdout }
}

const domain = {
  "harnesses/index.ts": `export { part } from "./part.js"\n`,
  "harnesses/part.ts": `export const part = 1\n`,
  "harnesses/load.ts": `export const harnessesLoad = [() => import("./part.js"), () => import("./index.js")] as const\n`,
}
try {
  const staged = checked("staged", {
    ...domain,
    "create-host.ts": `import { harnessesLoad } from "./harnesses/load.js"\nexport const steps = [...harnessesLoad, () => import("./harnesses/index.js")]\n`,
  })
  assert.ok(staged.ok, `the composition root imports a domain's entry and its load.ts: ${staged.said}`)

  const inside = checked("inside", {
    ...domain,
    "create-host.ts": `export const steps = [() => import("./harnesses/part.js")]\n`,
  })
  assert.ok(!inside.ok, "the composition root still reaches no other file of a domain")
  assert.match(inside.said, /create-host\.ts imports .*harnesses\/part\.ts.*harnesses\/load\.ts lists them/)

  const across = checked("across", {
    ...domain,
    "conversations/index.ts": `import { harnessesLoad } from "../harnesses/load.js"\nexport const borrowed = harnessesLoad\n`,
  })
  assert.ok(!across.ok, "a domain doesn't import another's load.ts")
  assert.match(across.said, /conversations\/index\.ts imports .*harnesses\/load\.ts\. A domain reaches another only through its entry/)

  const entry = checked("entry", {
    ...domain,
    "conversations/index.ts": `import { part } from "../harnesses/index.js"\nexport const borrowed = part\n`,
  })
  assert.ok(entry.ok, `a domain still reaches another through its entry: ${entry.said}`)
  console.log("host boundaries ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
