import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { deleteKeychain, readKeychain, writeKeychain } from "@mako/host/harnesses/accounts-common"

const CallSchema = z.object({ args: z.array(z.string()), stdin: z.string() })
const securityStandIn = fileURLToPath(new URL("./fixtures/security-stand-in.cjs", import.meta.url))

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
    // A keychain that keeps what it's given and reports it back, recording each call; `-i` reads no more of a line
    // than the real one does (4,096 characters), which once saved a long sign-in cut short.
    await writeFile(security, `#!${process.execPath}
const fs = require("node:fs"), security = require(${JSON.stringify(securityStandIn)})
const raw = process.argv.slice(2), store = ${JSON.stringify(join(root, "store.json"))}
const stdin = raw[0] === "-i" ? fs.readFileSync(0, "utf8") : ""
fs.appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify({ args: raw[0] === "-i" ? ["-i"] : raw, stdin }) + "\\n")
const words = raw[0] === "-i" ? [...stdin.trim().slice(0, 4096).matchAll(/"((?:\\\\.|[^"\\\\])*)"|(\\S+)/g)].map(([, quoted, bare]) => quoted === undefined ? bare : quoted.replace(/\\\\(.)/g, "$1")) : raw
const items = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : {}
const id = words[words.indexOf("-s") + 1]
if (words[0] === "add-generic-password") { items[id] = security.value(words); fs.writeFileSync(store, JSON.stringify(items)); process.exit(raw[0] === "-i" && stdin.trim().length > 4096 ? 1 : 0) }
if (words[0] === "find-generic-password") { if (!(id in items)) process.exit(44); process.stderr.write(security.report(items[id])); process.exit(0) }
if (words[0] === "delete-generic-password") { if (!(id in items)) process.exit(44); delete items[id]; fs.writeFileSync(store, JSON.stringify(items)); process.exit(0) }
process.exit(1)
`, { mode: 0o700 })
    const calls = async () => (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map((line) => CallSchema.parse(JSON.parse(line)))
    await writeKeychain("mako-fixture", "fixture")
    assert.equal(await readKeychain("mako-fixture"), "fixture")
    await deleteKeychain("mako-fixture")

    const credential = "{\n  \"token\": \"credential-must-not-appear ü\"\n}"
    await rm(join(root, "calls"), { force: true })
    await writeKeychain("mako \"fixture\"", credential)
    const [written] = await calls()
    assert.deepEqual(written?.args, ["-i"], "The credential never sits in security's arguments")
    assert.equal(written?.stdin, `add-generic-password -U -s "mako \\"fixture\\"" -a "${userInfo().username}" -X ${Buffer.from(credential).toString("hex")}\n`, "It's handed over on stdin, as hex, so a line break or quote in it survives")
    assert.equal(await readKeychain("mako \"fixture\""), credential.trim(), "and read back whole before the write counts")

    // Past what `security -i` reads whole, the value goes as an argument, as Claude Code writes its own, and lands whole.
    const long = JSON.stringify({ claudeAiOauth: { refreshToken: "r".repeat(100) }, mcpOAuth: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`server-${index}`, "t".repeat(120)])) })
    await rm(join(root, "calls"), { force: true })
    await writeKeychain("mako-long", long)
    const [longWrite] = await calls()
    assert.equal(longWrite?.args[0], "add-generic-password", "a long value isn't sent through -i, which would cut it short")
    assert.equal(await readKeychain("mako-long"), long, "and reads back whole")

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
      "Account Keychain: values go to security on stdin, past its line limit as arguments, and count as written only once they read back whole; hex and plain reports read back whole; failures are visible and redacted; absent entries are idempotent"
    )
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(root, { recursive: true, force: true })
  }
}
