import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { codexLaunch, resolveCodexExecutable } from "@mako/host/harnesses/codex/executable"

const root = await mkdtemp(join(tmpdir(), "mako-codex-executable-"))
try {
  const binary = join(root, "codex")
  const helper = join(root, "node")
  await writeFile(binary, "#!/usr/bin/env node\n")
  await writeFile(helper, "#!/bin/sh\nexit 0\n")
  await Promise.all([chmod(binary, 0o755), chmod(helper, 0o755)])
  // The CLI's own directory contains Node; desktop PATH does not.
  const env = { HOME: process.env.HOME, PATH: root }
  assert.equal(await resolveCodexExecutable(env), binary)
  assert.equal(
    await resolveCodexExecutable({ ...env, CODEX_EXECUTABLE: binary }),
    binary
  )
  // npm's script starts the native build its platform's package carries: a session starts that build itself.
  const platform = "darwin-arm64"
  for (const nested of [false, true]) {
    const prefix = join(root, nested ? "nested" : "beside")
    const pkg = join(prefix, "lib/node_modules/@openai/codex")
    const scope = nested ? join(pkg, "node_modules/@openai") : join(prefix, "lib/node_modules/@openai")
    const native = join(scope, "codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
    await mkdir(join(pkg, "bin"), { recursive: true })
    await mkdir(dirname(native), { recursive: true })
    await mkdir(join(prefix, "bin"), { recursive: true })
    await writeFile(join(pkg, "bin/codex.js"), "#!/usr/bin/env node\n")
    await writeFile(native, "")
    await chmod(native, 0o755)
    await symlink(join(pkg, "bin/codex.js"), join(prefix, "bin/codex"))
    const launch = await codexLaunch(join(prefix, "bin/codex"), platform)
    assert.equal(launch.executable, await realpath(native), nested ? "the build in the package's own modules" : "the build beside the package")
    assert.equal(launch.env.CODEX_MANAGED_PACKAGE_ROOT, await realpath(pkg))
    assert.equal(launch.env.CODEX_MANAGED_BY_NPM, "1")
    assert.ok("CODEX_MANAGED_BY_BUN" in launch.env && launch.env.CODEX_MANAGED_BY_BUN === undefined, "what the script clears stays cleared")
    assert.deepEqual(await codexLaunch(join(prefix, "bin/codex"), "linux-riscv64"), { executable: join(prefix, "bin/codex"), env: {} }, "a platform npm has no build for starts the script")
  }
  assert.deepEqual(await codexLaunch(helper, platform), { executable: helper, env: {} }, "a native install starts as it is")
  const missing = join(root, "missing/lib/node_modules/@openai/codex/bin/codex.js")
  await mkdir(dirname(missing), { recursive: true })
  await writeFile(missing, "")
  assert.deepEqual(await codexLaunch(missing, platform), { executable: missing, env: {} }, "a script whose build isn't there starts as it is")
  if (process.argv.includes("--live")) {
    const selected = await resolveCodexExecutable({
      HOME: process.env.HOME,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    })
    assert.ok(selected)
    assert.ok(
      !selected.includes(".app/Contents/"),
      "the installed standalone CLI passes compatibility with desktop PATH"
    )
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log(
  "Codex executable: standalone compatibility and explicit selection hold with desktop PATH; npm's script starts as its native build, with the script's variables"
)
