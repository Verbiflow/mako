import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)
const worker = process.argv[2] === "--worker"
const path = process.argv[worker ? 3 : 2]
assert.ok(path, "Use test-packaged-control-cli.mjs <Mako.app>")
const app = await realpath(resolve(path))
const executable = join(app, "Contents/MacOS/Mako")

if (!worker) {
  const result = await run(
    executable,
    [fileURLToPath(import.meta.url), "--worker", app],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }
  )
  process.stdout.write(result.stdout)
} else {
  assert.equal(await realpath(process.execPath), await realpath(executable))
  const archive = join(app, "Contents/Resources/app.asar")
  const require = createRequire(join(archive, "package.json"))
  const { createControlMcpServer } = await import(pathToFileURL(require.resolve("@mako/control-runtime/mcp")).href)
  const manifest = JSON.parse(
    await readFile(
      join(archive, "node_modules/@mako/control-runtime/package.json"),
      "utf8"
    )
  )
  assert.deepEqual(Object.keys(manifest.bin), ["mako-control"])
  const runtime = await import(
    pathToFileURL(require.resolve("@mako/control-runtime/session")).href
  )
  const source = await mkdtemp(join(tmpdir(), "mako-packaged-cli-"))
  const owner = await runtime.startDesktopControlSession({
    taskId: "packaged-cli",
  })
  try {
    const adapter = createControlMcpServer(owner.request)
    await adapter.close()
    const initialized = await owner.request({method:"js",code:"let packaged=41; packaged",timeout_ms:5000}, AbortSignal.timeout(7000))
    assert.equal(initialized.isError, undefined, JSON.stringify(initialized))
    const continued = await owner.request({method:"js",code:"++packaged",timeout_ms:5000}, AbortSignal.timeout(7000))
    assert.match(JSON.stringify(continued), /42/)
    const help = JSON.parse(
      (await run(owner.launch.command, ["shot", "--help", "--json"])).stdout
    )
    assert.ok(JSON.stringify(help).includes("--output"))
    const status = JSON.parse(
      (await run(owner.launch.command, ["status"])).stdout
    )
    assert.equal(status.browser.configured, false)
    assert.equal(status.native.configured, false)
    const program = join(source, "retained state.js")
    const exact = "  日本語 🧪 é  "
    await writeFile(
      program,
      `state.exact=${JSON.stringify(exact)};return state.exact`
    )
    const execute = async () =>
      JSON.parse(
        (await run(owner.launch.command, ["exec", "--source-file", program]))
          .stdout
      ).at(-1).value
    assert.equal(await execute(), exact)
    await writeFile(program, "return state.exact")
    assert.equal(await execute(), exact)
    const descriptor = JSON.parse(
      await readFile(owner.launch.sessionFile, "utf8")
    )
    assert.equal(descriptor.build, await runtime.controlSessionBuild())
    assert.equal(
      JSON.parse((await run(owner.launch.command, ["session", "stop"])).stdout)
        .stopped,
      true
    )
    await owner.close()
    await assert.rejects(access(owner.launch.bin), { code: "ENOENT" })
    console.log(
      JSON.stringify({
        packagedControl: "passed",
        engineBuild: descriptor.build,
        checks: [
          "ASAR worker and CLI",
          "offline help",
          "exact state across shell processes",
          "matching code identity",
          "typed MCP adapter and persistent JS",
          "retired MCP executable absent",
          "shutdown cleanup",
        ],
      })
    )
  } finally {
    await owner.close()
    await rm(source, { recursive: true, force: true })
  }
}
