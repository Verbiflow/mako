/**
 * How the host finds and starts programs and ends their trees, on every platform it runs on, with Windows' own cases
 * where the runner is Windows: PATHEXT and any-case `Path` (`base/executable.ts`), npm `.cmd` shims run as Node on
 * their script and other batch files through ComSpec with each word intact (`base/windows-launch.ts`), and a process
 * tree ended whole (`base/process-tree.ts`).
 *
 *   npx tsx scripts/test-windows-launch.ts
 */
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { conptyCommand } from "@mako/host/base/conpty-command"
import { commandNames, environmentVariable, resolveExecutable } from "@mako/host/base/executable"
import { hostSpawn } from "@mako/host/base/host-command"
import { processTreeAlive, signalProcessTree } from "@mako/host/base/process-tree"
import { BatchLaunchError, cmdArgument, npmShimScript, windowsLaunch } from "@mako/host/base/windows-launch"

const windows = process.platform === "win32"
const scratch = await mkdtemp(join(tmpdir(), "mako-windows-launch-"))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

try {
  // The names a command is looked for by.
  assert.deepEqual(commandNames("grok", { PATHEXT: ".COM;.EXE;.CMD" }, true), ["grok.com", "grok.exe", "grok.cmd"])
  assert.deepEqual(commandNames("grok.CMD", { PATHEXT: ".COM;.EXE;.CMD" }, true), ["grok.CMD"], "a command with its extension is looked for as it is")
  assert.deepEqual(commandNames("grok", {}, true), ["grok.com", "grok.exe", "grok.bat", "grok.cmd"], "PATHEXT's default")
  assert.deepEqual(commandNames("grok", { PATHEXT: ".EXE" }, false), ["grok"], "elsewhere a command is its own name")
  assert.equal(environmentVariable({ Path: "C:\\bin" }, "PATH", true), "C:\\bin", "Windows' Path in any case")
  assert.equal(environmentVariable({ Path: "C:\\bin" }, "PATH", false), undefined, "elsewhere PATH is PATH")

  // npm's shims, both shapes, and a batch file that is no shim.
  const modern = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@xai-official\\grok\\bin\\grok.js" %*\r\n`
  const older = `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\tool\\cli.mjs" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\tool\\cli.mjs" %*\r\n)\r\n`
  const shim = "C:\\Users\\one\\AppData\\Roaming\\npm\\grok.cmd"
  assert.equal(npmShimScript(shim, modern), "C:\\Users\\one\\AppData\\Roaming\\npm\\node_modules\\@xai-official\\grok\\bin\\grok.js")
  assert.equal(npmShimScript(shim, older), "C:\\Users\\one\\AppData\\Roaming\\tool\\cli.mjs")
  assert.equal(npmShimScript(shim, "@echo off\r\necho hello %*\r\n"), undefined)

  // Words for cmd.exe: quoted, metacharacters escaped once for the line and once more for the batch file's %*.
  assert.equal(cmdArgument("plain", false), '^"plain^"')
  assert.equal(cmdArgument("a b&c", false), '^"a^ b^&c^"')
  assert.equal(cmdArgument('say "hi"\\', false), '^"say^ \\^"hi\\^"\\\\^"')
  assert.equal(cmdArgument("%PATH%"), '^^^"^^^%PATH^^^%^^^"')
  const plain = windowsLaunch("C:\\tools\\grok.exe", ["a b"], {}, "node")
  assert.deepEqual(plain, { file: "C:\\tools\\grok.exe", args: ["a b"], verbatim: false }, "a program is started as it is")
  // A batch file only by its whole path, never with a word cmd.exe would end its line at, and delayed expansion off.
  assert.throws(() => windowsLaunch("grok.cmd", [], {}, "node"), BatchLaunchError, "a bare batch file is refused")
  for (const word of ["two\nlines", "carriage\rreturn", "nul\0byte"])
    assert.throws(() => windowsLaunch("C:\\tools\\grok.cmd", ["fine", word], { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "node"), BatchLaunchError, `${JSON.stringify(word)} is refused`)
  const batch = windowsLaunch("C:\\tools\\grok.cmd", ["a"], { ComSpec: "cmd.exe" }, "node")
  assert.deepEqual(batch.args.slice(0, 4), ["/d", "/v:off", "/s", "/c"])
  assert.match(batch.file, /^[A-Za-z]:\\.*cmd\.exe$/i, "a relative ComSpec is never run: the system's cmd.exe by its whole path")
  console.log("ok   command names, npm shims and cmd.exe quoting")

  if (windows) {
    const bin = join(scratch, "bin")
    await mkdir(join(bin, "node_modules", "echo"), { recursive: true })
    // A script that prints the words it was given, as JSON: what each launch below must hand it unchanged.
    const echo = join(bin, "node_modules", "echo", "echo.mjs")
    await writeFile(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n")
    // An npm shim (the modern shape above, pointing at the echo script), and a batch file of another shape.
    await writeFile(join(bin, "echo-shim.cmd"), modern.replace("node_modules\\@xai-official\\grok\\bin\\grok.js", "node_modules\\echo\\echo.mjs"))
    await writeFile(join(bin, "echo-batch.cmd"), `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`)
    await writeFile(join(bin, "echo-batch"), "#!/bin/sh\necho the extensionless script npm writes beside a shim\n")
    const env: NodeJS.ProcessEnv = { ...process.env, Path: [bin, process.env.Path ?? process.env.PATH].join(delimiter), PATHEXT: ".COM;.EXE;.BAT;.CMD" }
    delete env.PATH
    assert.equal(resolveExecutable("echo-batch", env), join(bin, "echo-batch.cmd"), "PATHEXT finds the .cmd, never the extensionless script")
    assert.equal(resolveExecutable("echo-shim", env), join(bin, "echo-shim.cmd"))

    const words = ["plain", "two words", 'a "quoted" word', "trailing\\", "a&b|c<d>e^f", "%PATH%", "!bang!", "(paren)", ""]
    const heard = (file: string) => new Promise<{ spawnfile: string; argv: string[] }>((done, fail) => {
      const child = hostSpawn(file, words, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      let out = ""
      let err = ""
      child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()))
      child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()))
      child.once("error", fail)
      child.once("close", (code) => (code === 0 ? done({ spawnfile: child.spawnfile, argv: JSON.parse(out) }) : fail(new Error(`${file} exited ${code}: ${err}`))))
    })
    const viaShim = await heard(join(bin, "echo-shim.cmd"))
    assert.deepEqual(viaShim.argv, words, "an npm shim's script hears every word as given")
    assert.doesNotMatch(viaShim.spawnfile, /cmd\.exe$/i, "an npm shim runs as Node, no shell between")
    const viaBatch = await heard(join(bin, "echo-batch.cmd"))
    assert.deepEqual(viaBatch.argv, words, "a batch file through ComSpec hears every word as given")
    assert.match(viaBatch.spawnfile, /cmd\.exe$/i, "another batch file runs through ComSpec")
    console.log("ok   .cmd launches: an npm shim as Node, another through ComSpec, every word intact")

    // A sign-in's terminal: the program under a ConPTY, read and written through the bridge's pipes.
    const terminal = conptyCommand(join(bin, "echo-batch.cmd"), ["under a pty"], env)
    const screen = await new Promise<string>((done, fail) => {
      const child = spawn(terminal.executable, terminal.args, { env: terminal.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      let out = ""
      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString()
        out += text
        // A terminal answers where its cursor is, as the sign-in does (TERMINAL_ANSWERS).
        if (text.includes("\u001b[6n")) child.stdin.write("\u001b[1;1R")
      })
      child.once("error", fail)
      const timer = setTimeout(() => { child.kill(); fail(new Error(`the ConPTY bridge said: ${JSON.stringify(out)}`)) }, 30_000)
      child.once("close", (code) => { clearTimeout(timer); return code === 0 ? done(out) : fail(new Error(`the bridge exited ${code}: ${JSON.stringify(out)}`)) })
    })
    assert.match(screen, /under a pty/, "the program's screen comes through the bridge")
    console.log("ok   a program under a ConPTY, through the sign-in's bridge")
  }

  // A tree ended whole: a parent, its child and the child's child, from the parent's pid.
  const pids = join(scratch, "tree.json")
  const grandchild = `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); setInterval(() => {}, 1000)`
  const child = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, c.pid])); setInterval(() => {}, 1000)`
  const parent = spawn(process.execPath, ["-e", child], { stdio: "ignore", detached: !windows, windowsHide: true })
  let tree: number[] = []
  for (const deadline = Date.now() + 10_000; !tree.length && Date.now() < deadline; await delay(100))
    // SAFETY: the child above writes this file once, as a JSON array of its own pid and its child's.
    tree = await readFile(pids, "utf8").then((text) => JSON.parse(text) as number[], () => [])
  await delay(500)
  // The grandchild's own child, found by its parent.
  const descendants = windows
    ? (await new Promise<string>((done) => execFile("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${tree[1]}").ProcessId`], (_, out) => done(out)))).split(/\s+/).filter(Boolean).map(Number)
    : []
  const all = [...tree, ...descendants]
  assert.ok(all.every(alive), "the whole tree runs")
  assert.ok(processTreeAlive(parent.pid!), "the tree is alive")
  if (windows) {
    // A pid only heard of, not held: ended only when its start, read again, is the one recorded.
    signalProcessTree(parent.pid!, "SIGKILL", { held: false })
    signalProcessTree(parent.pid!, "SIGKILL", { held: false, startedAt: 1_000 })
    await delay(4_000)
    assert.ok(all.every(alive), "a pid neither held nor proved by its start is left alone")
  }
  signalProcessTree(parent.pid!, "SIGKILL")
  for (const deadline = Date.now() + 10_000; all.some(alive) && Date.now() < deadline; ) await delay(100)
  assert.deepEqual(all.filter(alive), [], "every process of the tree ended")
  assert.equal(processTreeAlive(parent.pid!), false)
  console.log(`ok   a tree of ${all.length} processes ended from its root's pid${windows ? " (taskkill /T /F)" : " (its process group)"}`)
  console.log("PASS: executable lookup, batch-file launches and process-tree ends")
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
