import assert from "node:assert/strict"
import { finished } from "node:stream/promises"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPackage, uncacheAll } from "@electron/asar"
import { assertPackagedImports } from "./test-packaged-imports.mjs"

const root = await mkdtemp(join(tmpdir(), "mako-package-imports-"))
try {
  for (const [name, importer, exports, valid] of [
    [
      "valid",
      'import value, { present as alias } from "./values.js"; export { alias, value };',
      "export const present = 1; export default 2;",
      true,
    ],
    [
      "missing",
      'import { missing } from "./values.js"; export { missing };',
      "export const present = 1;",
      false,
    ],
    [
      "missing-default",
      'import value from "./values.js"; export { value };',
      "export const present = 1;",
      false,
    ],
    [
      "reexport",
      'export { missing as renamed } from "./values.js";',
      "export const present = 1;",
      false,
    ],
  ]) {
    const source = join(root, name, "source")
    const app = join(root, name, "Mako.app")
    await mkdir(join(source, "dist-electron"), { recursive: true })
    await mkdir(join(app, "Contents/Resources"), { recursive: true })
    await writeFile(join(source, "dist-electron/main.js"), importer)
    await writeFile(join(source, "dist-electron/values.js"), exports)
    await finished(await createPackage(source, join(app, "Contents/Resources/app.asar")))
    // This ASAR version resolves with the stream before its final writes finish.
    uncacheAll()
    if (valid) assert.ok(assertPackagedImports(app) > 0)
    else
      assert.throws(() => assertPackagedImports(app), /Packaged export missing/)
  }
  console.log(
    "Packaged imports reject missing named/default exports and broken re-exports before launch"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
