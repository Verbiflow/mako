import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { deleteKeychain, readKeychain, writeKeychain } from "../electron/accounts-common.js"

if (process.platform === "darwin") {
  const root = await mkdtemp(join(tmpdir(), "mako-keychain-test-"))
  const originalPath = process.env.PATH
  try {
    const security = join(root, "security")
    await writeFile(security, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    process.env.PATH = `${root}:${originalPath ?? ""}`
    await assert.rejects(
      writeKeychain("mako-fixture", "credential-must-not-appear"),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Could not save/)
        assert.doesNotMatch(error.message, /credential-must-not-appear/)
        return true
      }
    )
    await assert.rejects(deleteKeychain("mako-fixture"), /Could not remove/)
    await writeFile(security, "#!/bin/sh\nexit 44\n", { mode: 0o700 })
    await deleteKeychain("mako-fixture")
    await writeFile(security, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    await writeKeychain("mako-fixture", "fixture")
    await deleteKeychain("mako-fixture")

    const credential = "{\n  \"token\": \"credential-must-not-appear ü\"\n}"
    await writeFile(security, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/args"\ncat > "${root}/stdin"\n`, { mode: 0o700 })
    await writeKeychain("mako \"fixture\"", credential)
    assert.equal(await readFile(join(root, "args"), "utf8"), "-i\n", "The credential never sits in security's arguments")
    const command = await readFile(join(root, "stdin"), "utf8")
    assert.equal(command, `add-generic-password -U -s "mako \\"fixture\\"" -a "${userInfo().username}" -X ${Buffer.from(credential).toString("hex")}\n`, "It's handed over on stdin, as hex, so a line break or quote in it survives")

    const report = async (stderr: string, code = 0) =>
      writeFile(security, `#!/bin/sh\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`, { mode: 0o700 })
    await report(`password: 0x${Buffer.from(credential).toString("hex").toUpperCase()}  "…"\n`)
    assert.equal(await readKeychain("mako-fixture"), credential.trim(), "A value with a line break or non-ASCII comes back whole, not as hex")
    await report('password: "deadbeef"\n')
    assert.equal(await readKeychain("mako-fixture"), "deadbeef", "A plain value that looks like hex is itself")
    await report("", 44)
    assert.equal(await readKeychain("mako-fixture", undefined, "required"), null, "A missing item is null, even when required")
    await report("password: \"credential-must-not-appear\"\n", 51)
    await assert.rejects(readKeychain("mako-fixture", undefined, "required"), (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Could not read macOS Keychain/)
      assert.doesNotMatch(JSON.stringify({ message: error.message, cause: error.cause }), /credential-must-not-appear/)
      return true
    })
    assert.equal(await readKeychain("mako-fixture"), null, "An optional read that fails is null")
    console.log(
      "Account Keychain: values go to security on stdin, never its arguments; hex and plain reports read back whole; failures are visible and redacted; absent entries are idempotent"
    )
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  }
}
