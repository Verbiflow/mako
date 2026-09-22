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
  assert.equal((await resolveOpenCodeInstallation("v2", env)).command, renamed)
  await assert.rejects(resolveOpenCodeInstallation("v1", env), /requires v1/)
  assert.equal((await resolveOpenCodeInstallation("v1", { ...env, OPENCODE_BIN_PATH: misleading })).generation, "v1")
  await assert.rejects(resolveOpenCodeInstallation("v2", { ...env, OPENCODE_BIN_PATH: misleading }), /requires v2/)
  await writeFile(renamed, "#!/bin/sh\nprintf 'unknown-version\\n'\n")
  await assert.rejects(resolveOpenCodeInstallation(undefined, env), /unsupported version/)
  assert.deepEqual(openCodeDatabasePaths({ XDG_DATA_HOME: root }), [join(root, "opencode", "opencode.db"), join(root, "opencode", "opencode-next.db")])
  assert.deepEqual(openCodeDatabasePaths({ XDG_DATA_HOME: root, OPENCODE_DB: "custom.db" }), [join(root, "opencode", "custom.db")])
  assert.deepEqual(openCodeDatabasePaths({ OPENCODE_DB: join(root, "exact.db") }), [join(root, "exact.db")])
  assert.deepEqual(openCodeDatabasePaths({ OPENCODE_DB: ":memory:" }), [])
  console.log("OpenCode runtime: actual version beats filename, explicit mismatch/unknown refused, configured database roots preserved")
} finally { await rm(root, { recursive: true, force: true }) }
