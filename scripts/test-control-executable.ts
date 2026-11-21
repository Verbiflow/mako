import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { resolveExecutable } from "../packages/control-runtime/src/executable.js"
import { onWindows } from "../packages/control-runtime/src/platform.js"

/**
 * How the control runtime finds `mako-video`, `ffmpeg` and the like. Windows' rules are asked for by name, so every
 * system checks them: no PATH search at all, PATHEXT for an absolute command, no folder taken for a program. The
 * execute bit and PATH search only where they apply.
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

  // On Windows nothing is searched for: a PATH folder there may be one another account can write, and the control
  // runtime can't ask who may. Its tools come by whole path from the host; an absolute command still takes PATHEXT.
  await file(join(first, "tool"))
  await file(join(first, "tool.cmd"))
  await file(join(second, "tool.exe"))
  const windows = (env: NodeJS.ProcessEnv, command = "tool") => resolveExecutable(command, env, "win32")
  assert.equal(windows({ PATH: [first, second].join(delimiter) }), undefined, "a bare name is never searched for")
  assert.equal(windows({ Path: [second, first].join(delimiter), PATHEXT: ".EXE" }), undefined, "nor with Windows' usual `Path`")
  assert.equal(windows({ PATH: first }, "tool.cmd"), undefined, "nor with its extension")
  assert.equal(windows({}, join(first, "tool")), join(first, "tool.cmd"), "an absolute command takes PATHEXT's extensions")
  assert.equal(windows({ PathExt: ".Exe;.CMD" }, join(second, "tool")), join(second, "tool.exe"), "in any case")
  await file(join(first, "tool.exe"))
  assert.equal(windows({ PATHEXT: ".EXE;.CMD" }, join(first, "tool")), join(first, "tool.exe"), "PATHEXT's order")
  assert.equal(windows({}, join(first, "tool")), join(first, "tool.exe"), "the default PATHEXT puts .EXE before .CMD")
  assert.equal(windows({}, join(first, "tool.cmd")), join(first, "tool.cmd"), "a command with its extension is taken as named")
  assert.equal(windows({ PATHEXT: ".EXE" }, join(first, "tool.cmd")), undefined, "only PATHEXT's extensions run")
  await mkdir(join(root, "folder.exe"))
  assert.equal(windows({}, join(root, "folder")), undefined, "a folder is not a program")
  assert.equal(windows({}, join(first, "absent")), undefined)

  if (onWindows()) {
    // The runner's own Node is on PATH, and still isn't searched for.
    assert.equal(resolveExecutable("node"), undefined, "Windows searches no PATH")
    assert.ok(resolveExecutable(process.execPath), "an absolute program is taken")
    assert.equal(resolveExecutable(process.execPath.slice(2)), undefined, "a path with no drive is no program")
    assert.equal(resolveExecutable(process.execPath.slice(2).replaceAll("\\", "/")), undefined)
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
  console.log("control executables: no Windows PATH search, PATHEXT, execute bits and folders")
} finally {
  await rm(root, { recursive: true, force: true })
}
