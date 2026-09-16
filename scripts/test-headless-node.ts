import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { headlessNodeExecutable } from "../electron/headless-node.js"

const root = await mkdtemp(join(tmpdir(), "mako-headless-node-"))
try {
  const executable = join(root, "Mako.app", "Contents", "MacOS", "Mako")
  const helper = join(
    root,
    "Mako.app",
    "Contents",
    "Frameworks",
    "Mako Helper.app",
    "Contents",
    "MacOS",
    "Mako Helper"
  )
  await mkdir(dirname(helper), { recursive: true })
  await writeFile(helper, "")

  assert.equal(headlessNodeExecutable(executable, "darwin"), helper)
  assert.equal(headlessNodeExecutable(helper, "darwin"), helper)
  assert.equal(headlessNodeExecutable(executable, "linux"), executable)
  assert.equal(
    headlessNodeExecutable(join(root, "node"), "darwin"),
    join(root, "node")
  )
  console.log(
    "Headless Node children use Electron's LSUIElement helper on macOS"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
