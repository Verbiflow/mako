import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const exec = promisify(execFile)
const script = resolve("scripts/linux-control/prepare-acceptance.mjs")
const root = await mkdtemp(join(tmpdir(), "mako-acceptance-payload-test-"))
const hash = value => createHash("sha256").update(value).digest("hex")
async function put(path, value) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), value)
}
async function prepare(destination) {
  return exec(process.execPath, [script, join(root, "driver"), join(root, destination)], { cwd: root })
}
try {
  const patch = "test patch"
  const binary = "test driver"
  await put("vendor/cua-driver/release.json", JSON.stringify({ version: "test", base: "base", patch: "release.patch" }))
  await put("vendor/cua-driver/release.patch", patch)
  await put("driver/provenance.json", JSON.stringify({ version: "test", base: "base", platform: "linux-x64", patchSha256: hash(patch), binarySha256: hash(binary) }))
  await put("driver/cua-driver", binary)
  await put("driver/LICENSE-Cua.md", "test license")
  await put("scripts/lib/control-cli-probe.mjs", "// fixture CLI probe")
  await put("packages/control-runtime/dist/desktop-session-worker.js", "import './helper.js';")
  await put("packages/control-runtime/dist/browser-service.js", "export const browser = true;")
  await put("packages/control-runtime/dist/helper.js", "export const harmless = 1;")
  await put("packages/control/package.json", JSON.stringify({ name: "@mako/control", version: "0.1.0", type: "module" }))
  await put("packages/control-runtime/package.json", '{"name":"@mako/control-runtime","type":"module"}')
  for (const name of ["control", "control-runtime"])
    for (const file of ["README.md", "LICENSE"]) await put(`packages/${name}/${file}`, "Fixture documentation and license")
  await put("packages/control/dist/program/worker.js", "export const worker = true;")
  const canary = "DO_NOT_UPLOAD_THIS_CREDENTIAL"
  await put(".env", canary)
  await put(".git/config", canary)
  await put("node_modules/private-package/secret.json", canary)
  await put("dist-electron/unrelated-session.json", canary)
  await put("driver/extra-private-file", canary)
  await cp("scripts/linux-control/runtime", join(root, "scripts/linux-control/runtime"), { recursive: true })
  for (const name of ["Dockerfile.acceptance", "start-desktop.sh", "start-recording.sh", "wait-desktop.py", "fixture.py", "probe.mjs", "recording-fixture.py", "recording-probe.mjs", "run-acceptance.sh", "start-wayland.sh", "wayland-probe.mjs", "wayland-gestures.mjs", "identity.sh"]) {
    await put(`scripts/linux-control/${name}`, "test fixture")
  }
  await prepare("payload")
  const payload = JSON.parse(await readFile(join(root, "payload/payload.json"), "utf8"))
  assert.ok(payload.files.some(file => file.path === "packages/control-runtime/dist/helper.js"), "Referenced host module survives without rebundling")
  assert.ok(payload.files.some(file => file.path === "packages/control-runtime/dist/browser-service.js"), "Shared code identity includes the browser backend even in native-only acceptance")
  assert.ok(payload.files.some(file => file.path === "packages/control/dist/program/worker.js"), "Worker loaded by URL survives packaging")
  for (const file of payload.files) {
    const bytes = await readFile(join(root, "payload", file.path))
    assert.equal(bytes.includes(canary), false, file.path)
    assert.equal(hash(bytes), file.sha256, file.path)
  }
  await assert.rejects(prepare("payload"), /EEXIST/, "Never merge into an existing payload")
  await put("driver/cua-driver", "tampered driver")
  await assert.rejects(prepare("tampered"), /does not match its provenance/)
  await put("driver/cua-driver", binary)
  await put("packages/control-runtime/dist/desktop-session-worker.js", "import './private.js';")
  await put("secret.js", `export const secret = '${canary}';`)
  await symlink(join(root, "secret.js"), join(root, "packages/control-runtime/dist/private.js"))
  await assert.rejects(prepare("symlink"), /AssertionError/, "A referenced symlink cannot export a file outside the allowed host directory")
  const lockPath = join(root, "scripts/linux-control/runtime/package-lock.json")
  const lock = JSON.parse(await readFile(lockPath, "utf8"))
  lock.packages["../private/node_modules/example"] = { version: "1.0.0" }
  await writeFile(lockPath, JSON.stringify(lock))
  await assert.rejects(prepare("escaped-lock"), /Unexpected lockfile path/, "Generated lockfiles must not retain machine-specific dependency paths")
  console.log("Acceptance payload excludes credential canaries, verifies provenance, preserves workers and rejects symlinks/overwrite")
} finally {
  await rm(root, { recursive: true, force: true })
}
