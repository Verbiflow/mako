import { configureOpenCodePermissions } from "../electron/providers/opencode/permissions.ts"
import { openCodeAcpSource } from "../electron/providers/opencode/acp.ts"
import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCodeDatabasePaths, resolveOpenCodeInstallation } from "../electron/providers/opencode/installation.ts"

const root = await mkdtemp(join(tmpdir(), "mako-opencode-runtime-"))
try {
  const misleading = join(root, "opencode2")
  const renamed = join(root, "custom-agent")
  await writeFile(misleading, "#!/bin/sh\nprintf '1.4.11\\n'\n")
  await writeFile(renamed, "#!/bin/sh\nprintf 'opencode v2.0.1\\n'\n")
  await Promise.all([chmod(misleading, 0o700), chmod(renamed, 0o700)])
  const env = { ...process.env, OPENCODE_BIN_PATH: renamed }
  assert.equal((await resolveOpenCodeInstallation(env)).command, renamed)
  await assert.rejects(resolveOpenCodeInstallation({ ...env, OPENCODE_BIN_PATH: misleading }), /v2 only/)
  for (const access of [undefined, "ask", "edits", "full"] as const) {
    const launch = await openCodeAcpSource.launch({ appPath: root, execPath: process.execPath, env, access })
    assert.ok(launch)
    const nativeEnv = { OPENCODE_CONFIG_CONTENT: '{"model":"keep/model","agents":{"plan":{"system":"keep plan"},"build":{"system":"keep build","permissions":[{"action":"bash","resource":"*","effect":"allow"}]}},}' }
    launch.configureEnvironment(nativeEnv)
    const config = JSON.parse(nativeEnv.OPENCODE_CONFIG_CONTENT)
    assert.equal(config.model, "keep/model")
    assert.equal(config.agents.plan.system, "keep plan")
    assert.equal(config.agents.build.system, "keep build")
    assert.equal(config.agents.build.permissions[1].effect, access === "full" ? "allow" : "ask")
    assert.equal(config.agents.build.permissions.at(-1).action, access === "edits" ? "edit" : access === "full" ? "*" : "todowrite")
  }
  assert.throws(() => configureOpenCodePermissions({ OPENCODE_CONFIG_CONTENT: '{"agents":' }, "ask"))
  assert.throws(() => configureOpenCodePermissions({ OPENCODE_CONFIG_CONTENT: '{"agents":{"build":null}}' }, "ask"))
  for (const version of ["2.0.0", "2.19.7", "2.1.0-beta.3", "0.0.0-beta-19425", "0.0.0-next-12", "0.0.0-dev-2"]) {
    await writeFile(renamed, `#!/bin/sh\nprintf '${version}\\n'\n`)
    assert.equal((await resolveOpenCodeInstallation(env)).generation, "v2")
  }
  await writeFile(renamed, "#!/bin/sh\nprintf '3.0.0\\n'\n")
  await assert.rejects(resolveOpenCodeInstallation(env), /v2 only/)
  await writeFile(renamed, "#!/bin/sh\nprintf 'unknown-version\\n'\n")
  await assert.rejects(resolveOpenCodeInstallation(env), /v2 only/)
  assert.deepEqual(openCodeDatabasePaths({ XDG_DATA_HOME: root }), [join(root, "opencode", "opencode.db"), join(root, "opencode", "opencode-next.db")])
  assert.deepEqual(openCodeDatabasePaths({ XDG_DATA_HOME: root, OPENCODE_DB: "custom.db" }), [join(root, "opencode", "custom.db")])
  assert.deepEqual(openCodeDatabasePaths({ OPENCODE_DB: join(root, "exact.db") }), [join(root, "exact.db")])
  assert.deepEqual(openCodeDatabasePaths({ OPENCODE_DB: ":memory:" }), [])
  console.log("OpenCode runtime: actual version beats filename, explicit mismatch/unknown refused, configured database roots preserved")
} finally { await rm(root, { recursive: true, force: true }) }
