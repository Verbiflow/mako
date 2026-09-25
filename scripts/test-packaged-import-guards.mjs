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
  for (const dependency of ["zod", "./host-only.js", "node:fs/promises"]) {
    const source = join(root, "native", "source")
    const app = join(root, "native", "Mako.app")
    await mkdir(join(source, "dist-electron/providers/fixture"), { recursive: true })
    await mkdir(join(app, "Contents/Resources"), { recursive: true })
    await writeFile(join(source, "dist-electron/main.js"), 'import "./values.js"; export const plugin = new URL("./providers/fixture/native-approval-plugin.bundle.mjs", import.meta.url);')
    await writeFile(join(source, "dist-electron/values.js"), "export const value = 1;")
    await writeFile(join(source, "dist-electron/providers/fixture/native-approval-plugin.bundle.mjs"),
      `import * as dependency from ${JSON.stringify(dependency)}; export default dependency;`)
    await finished(await createPackage(source, join(app, "Contents/Resources/app.asar")))
    uncacheAll()
    if (dependency.startsWith("node:")) assert.doesNotThrow(() => assertPackagedImports(app))
    else assert.throws(() => assertPackagedImports(app), /Native plugin must be standalone/)
  }
  const nativeSource = join(root, "native", "source")
  const nativeApp = join(root, "native", "Mako.app")
  await rm(join(nativeSource, "dist-electron/providers/fixture/native-approval-plugin.bundle.mjs"))
  await finished(await createPackage(nativeSource, join(nativeApp, "Contents/Resources/app.asar")))
  uncacheAll()
  assert.throws(() => assertPackagedImports(nativeApp), /Packaged import missing/)
  console.log("Native plugin imports cannot depend on Mako's package or module tree")
} finally {
  await rm(root, { recursive: true, force: true })
}
