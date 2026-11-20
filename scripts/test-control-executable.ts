import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, join } from "node:path"
import { resolveExecutable } from "../packages/control-runtime/src/executable.js"
import { onWindows } from "../packages/control-runtime/src/platform.js"

/**
 * How the control runtime finds `mako-video`, `ffmpeg` and the like on PATH. Windows' rules (`PATHEXT`, no execute
 * bit, `Path` in any case) are asked for by name, so every system checks them; the execute bit only where there is one.
 */
const root = await mkdtemp(join(tmpdir(), "mako-control-executable-"))
try {
  const first = join(root, "first")
  const second = join(root, "second")
  await mkdir(first)
  await mkdir(second)
  const file = async (path: string, mode = 0o755) => {
    await writeFile(path, "")
    await chmod(path, mode)
  }

  // npm writes a shell script beside each `.cmd`; Windows can't start it, so the `.cmd` is the tool.
  await file(join(first, "tool"))
  await file(join(first, "tool.cmd"))
  await file(join(second, "tool.exe"))
  const windows = (env: NodeJS.ProcessEnv, command = "tool") => resolveExecutable(command, env, "win32")
  assert.equal(windows({ PATH: [first, second].join(delimiter) }), join(first, "tool.cmd"), "an earlier folder wins over a later extension")
  assert.equal(windows({ PATH: [second, first].join(delimiter) }), join(second, "tool.exe"))
  assert.equal(windows({ Path: [second, first].join(delimiter) }), join(second, "tool.exe"), "Windows' usual `Path`")
  assert.equal(windows({ PATH: first, PATHEXT: ".EXE" }), undefined, "only PATHEXT's extensions run")
  assert.equal(windows({ PATH: first, PathExt: ".Exe;.CMD" }), join(first, "tool.cmd"))
  await file(join(first, "tool.exe"))
  assert.equal(windows({ PATH: first, PATHEXT: ".EXE;.CMD" }), join(first, "tool.exe"), "PATHEXT's order within a folder")
  assert.equal(windows({ PATH: first }), join(first, "tool.exe"), "the default PATHEXT puts .EXE before .CMD")
  assert.equal(windows({ PATH: [second, first].join(delimiter) }, "tool.cmd"), join(first, "tool.cmd"), "a command with its extension is looked for as it is")
  assert.equal(windows({}, join(first, "tool")), join(first, "tool.exe"), "an absolute command takes an extension too")
  assert.equal(windows({}, join(first, "tool.cmd")), join(first, "tool.cmd"))
  await mkdir(join(root, "folder.exe"))
  assert.equal(windows({ PATH: root }, "folder"), undefined, "a folder is not a program")
  assert.equal(windows({ PATH: first }, "absent"), undefined)

  if (onWindows()) {
    // The runner's own Node, as Windows names it, through the real environment.
    const node = resolveExecutable("node")
    assert.ok(node, "node is on PATH")
    assert.equal(basename(node).toLowerCase(), "node.exe")
  } else {
    await file(join(second, "plain"), 0o644)
    await file(join(first, "plain"))
    await mkdir(join(second, "folder"))
    await chmod(join(second, "folder"), 0o755)
    const posix = (command: string) => resolveExecutable(command, { PATH: [second, first].join(delimiter) }, "linux")
    assert.equal(posix("plain"), join(first, "plain"), "a file without its execute bit is passed over")
    assert.equal(posix("folder"), undefined, "a searchable folder is not a program")
    assert.equal(posix("tool"), join(first, "tool"), "no extension is added off Windows")
    assert.equal(resolveExecutable(join(first, "tool"), {}, "darwin"), join(first, "tool"))
    assert.ok(resolveExecutable("node"), "node is on PATH")
  }
  console.log("control executables: PATHEXT, Path, execute bits and folders")
} finally {
  await rm(root, { recursive: true, force: true })
}
