import { configureOpenCodePermissions } from "@mako/host/harnesses/opencode/permissions"
import { openCodeLaunchAccess } from "@mako/host/harnesses/opencode/access"
import { accessModeId } from "@mako/host/contracts/access"
import assert from "node:assert/strict"
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { OpenCodeVersions, openCodeDatabasePaths, resolveOpenCodeInstallation } from "@mako/host/harnesses/opencode/installation"
import { cmdShimTarget, openCodeBinaryTarget, openCodeUnusedBuilds } from "@mako/host/harnesses/opencode/updates"

const root = await mkdtemp(join(tmpdir(), "mako-opencode-runtime-"))
try {
  const misleading = join(root, "opencode2")
  const renamed = join(root, "custom-agent")
  await writeFile(misleading, "#!/bin/sh\nprintf '1.4.11\\n'\n")
  await writeFile(renamed, "#!/bin/sh\nprintf 'opencode v2.0.27\\n'\n")
  await Promise.all([chmod(misleading, 0o700), chmod(renamed, 0o700)])
  const env = { ...process.env, OPENCODE_BIN_PATH: renamed }
  assert.equal((await resolveOpenCodeInstallation(env)).command, renamed)
  await assert.rejects(resolveOpenCodeInstallation({ ...env, OPENCODE_BIN_PATH: misleading }), /Mako runs OpenCode 2\.0\.0 or newer; this executable reports "1\.4\.11"/)
  for (const access of [undefined, "ask", "edits", "full"] as const) {
    const nativeEnv = { OPENCODE_CONFIG_CONTENT: '{"model":"keep/model","agents":{"plan":{"system":"keep plan"},"build":{"system":"keep build","permissions":[{"action":"bash","resource":"*","effect":"allow"}]}},}' }
    configureOpenCodePermissions(nativeEnv, openCodeLaunchAccess(access && accessModeId(access)))
    const config = JSON.parse(nativeEnv.OPENCODE_CONFIG_CONTENT)
    assert.equal(config.model, "keep/model")
    assert.equal(config.agents.plan.system, "keep plan")
    assert.equal(config.agents.build.system, "keep build")
    assert.equal(config.agents.build.permissions[1].effect, access === "full" ? "allow" : "ask")
    assert.equal(config.agents.build.permissions.at(-1).action, access === "edits" ? "edit" : access === "full" ? "*" : "todowrite")
  }
  assert.throws(() => configureOpenCodePermissions({ OPENCODE_CONFIG_CONTENT: '{"agents":' }, "ask"))
  assert.throws(() => configureOpenCodePermissions({ OPENCODE_CONFIG_CONTENT: '{"agents":{"build":null}}' }, "ask"))
  for (const version of ["2.0.0", "2.0.1", "2.0.27", "2.19.7", "2.1.0-beta.3", "0.0.0-dev-19656", "0.0.0-dev-20843"]) {
    await writeFile(renamed, `#!/bin/sh\nprintf '${version}\\n'\n`)
    assert.equal((await resolveOpenCodeInstallation(env)).generation, "v2", `${version} runs`)
  }
  for (const version of ["0.0.0-beta-19425", "0.0.0-dev-19654", "0.0.0-dev-2"]) {
    await writeFile(renamed, `#!/bin/sh\nprintf 'opencode v${version}\\n'\n`)
    await assert.rejects(resolveOpenCodeInstallation(env), { message: `OpenCode ${version} is older than Mako supports. Update OpenCode to 2.0.0 or newer.` })
  }
  for (const version of ["3.0.0", "0.0.0-next-12", "unknown-version"]) {
    await writeFile(renamed, `#!/bin/sh\nprintf '${version}\\n'\n`)
    await assert.rejects(resolveOpenCodeInstallation(env), /Mako runs OpenCode 2\.0\.0 or newer/)
  }
  const runs = join(root, "runs")
  const versions = new OpenCodeVersions()
  await writeFile(renamed, `#!/bin/sh\necho run >> '${runs}'\nprintf 'opencode v2.0.27\\n'\n`)
  await Promise.all([resolveOpenCodeInstallation(env, versions), resolveOpenCodeInstallation(env, versions)])
  await resolveOpenCodeInstallation(env, versions)
  assert.equal((await readFile(runs, "utf8")).split("\n").filter(Boolean).length, 1, "one version check serves every launch until the file changes")
  await writeFile(renamed, `#!/bin/sh\necho run >> '${runs}'\nprintf 'opencode v2.0.28\\n'\n`)
  await resolveOpenCodeInstallation(env, versions)
  assert.equal((await readFile(runs, "utf8")).split("\n").filter(Boolean).length, 2, "a changed executable is checked again")
  await writeFile(renamed, "#!/bin/sh\necho broken >&2\nexit 3\n")
  await assert.rejects(resolveOpenCodeInstallation(env, versions), new RegExp(`OpenCode at ${renamed} did not report its version`))
  assert.deepEqual(openCodeDatabasePaths({ XDG_DATA_HOME: root }), [join(root, "opencode", "opencode.db"), join(root, "opencode", "opencode-next.db")])
  assert.deepEqual(openCodeDatabasePaths({ XDG_DATA_HOME: root, OPENCODE_DB: "custom.db" }), [join(root, "opencode", "custom.db")])
  assert.deepEqual(openCodeDatabasePaths({ OPENCODE_DB: join(root, "exact.db") }), [join(root, "exact.db")])
  assert.deepEqual(openCodeDatabasePaths({ OPENCODE_DB: ":memory:" }), [])
  // npm's layout of `@opencode/cli`: every build for the OS and CPU under it, the picked one linked into its `bin/`.
  const cli = join(root, "prefix", "lib", "node_modules", "@opencode", "cli")
  await mkdir(join(cli, "bin"), { recursive: true })
  await writeFile(join(cli, "package.json"), JSON.stringify({ name: "@opencode/cli" }))
  for (const build of ["cli-linux-x64", "cli-linux-x64-baseline", "cli-linux-x64-musl"]) {
    await mkdir(join(cli, "node_modules", "@opencode", build, "bin"), { recursive: true })
    await writeFile(join(cli, "node_modules", "@opencode", build, "bin", "opencode"), "a build")
  }
  await link(join(cli, "node_modules", "@opencode", "cli-linux-x64", "bin", "opencode"), join(cli, "bin", "opencode.exe"))
  await mkdir(join(root, "prefix", "bin"), { recursive: true })
  await symlink(join(cli, "bin", "opencode.exe"), join(root, "prefix", "bin", "opencode"))
  assert.deepEqual(openCodeUnusedBuilds(join(root, "prefix", "bin", "opencode")).map((folder) => folder.split("/").pop()).sort(), ["cli-linux-x64", "cli-linux-x64-baseline", "cli-linux-x64-musl"], "every build under the package, the linked one too: its bin keeps the file")
  await writeFile(join(root, "brew-opencode"), "#!/bin/sh\n")
  assert.deepEqual(openCodeUnusedBuilds(join(root, "brew-opencode")), [], "a launcher outside npm's layout leaves everything")
  assert.deepEqual(openCodeUnusedBuilds(join(root, "missing")), [])
  // On Windows, npm's shim in its prefix (`opencode.cmd`, as cmd-shim writes it) runs the package's executable: that
  // executable is the binary, whose builds go as above.
  const windowsPrefix = join(root, "windows-prefix")
  const exe = join(windowsPrefix, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
  await mkdir(join(windowsPrefix, "node_modules", "@opencode", "cli", "node_modules", "@opencode", "cli-windows-x64-baseline"), { recursive: true })
  await mkdir(dirname(exe), { recursive: true })
  await writeFile(join(windowsPrefix, "node_modules", "@opencode", "cli", "package.json"), JSON.stringify({ name: "@opencode/cli" }))
  await writeFile(exe, "an executable")
  const shim = join(windowsPrefix, "opencode.cmd")
  await writeFile(shim, ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*', ""].join("\r\n"))
  assert.equal(cmdShimTarget(shim), exe, "the shim's executable")
  assert.equal(openCodeBinaryTarget(shim), await realpath(exe), "followed from where the shim really is")
  assert.deepEqual(openCodeUnusedBuilds(openCodeBinaryTarget(shim)).map((folder) => folder.split("/").pop()), ["cli-windows-x64-baseline"], "and the builds beside it")
  await writeFile(join(windowsPrefix, "other.cmd"), "@ECHO off\r\nnode other.js %*\r\n")
  assert.equal(cmdShimTarget(join(windowsPrefix, "other.cmd")), null, "a script that runs no executable of its own names none")
  console.log("OpenCode runtime: actual version beats filename, every OpenCode 2 release and newer ones, prereleases before the API 2.0.4 released refused, explicit mismatch/unknown refused, one version check per executable, a failing executable named, launch rulesets merge into user configuration, configured database roots preserved")
} finally { await rm(root, { recursive: true, force: true }) }
