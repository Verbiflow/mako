import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { claudeAccountCapability as claude } from "../electron/providers/claude/accounts.js"

// Exercise actual account consumers without reading or changing the user's Keychain.
if (process.platform === "darwin") {
  const root = await mkdtemp(join(os.tmpdir(), "mako-claude-credential-source-"))
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  mock.method(os, "homedir", () => root)
  syncBuiltinESMExports()
  const service = (dir: string) =>
    `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`
  const credentials = (token: string) => JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}` },
  })
  const keychain = join(root, "keychain.json")
  const stores: Record<string, string> = {}
  const setKeychain = async (name: string, token: string) => {
    stores[name] = credentials(token)
    await writeFile(keychain, JSON.stringify(stores))
  }
  let bearer: string | null = null
  globalThis.fetch = async (_input, init) => {
    bearer = new Headers(init?.headers).get("Authorization")
    return new Response("{}", { status: 200 })
  }
  try {
    const bin = join(root, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "security"), `#!${process.execPath}
const fs = require('node:fs');
const file = ${JSON.stringify(keychain)};
const args = process.argv.slice(2);
const get = key => args[args.indexOf(key) + 1];
const stores = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] === 'find-generic-password') {
  if (!args.includes('-a')) process.exit(1);
  const value = stores[get('-s')];
  if (!value) process.exit(44);
  process.stdout.write(value);
} else if (args[0] === 'add-generic-password') {
  stores[get('-s')] = get('-w');
  fs.writeFileSync(file, JSON.stringify(stores));
} else process.exit(1);
`, { mode: 0o700 })
    process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
    const routed = join(root, ".subrouter", "fixture", "claude", "profile")
    await mkdir(routed, { recursive: true })
    await writeFile(join(routed, ".credentials.json"), credentials("old-file"))
    process.env.CLAUDE_CONFIG_DIR = routed
    await setKeychain(service(routed), "fresh-native")
    assert.equal((await claude.accountUsage("default")).status, "ok")
    assert.equal(bearer, "Bearer fresh-native", "default follows the inherited native scope")

    // The file may be corrupt while the native Keychain login remains healthy.
    await writeFile(join(routed, ".credentials.json"), "broken")
    await claude.captureAccount("saved")
    const saved = join(root, ".mako", "accounts", "claude", "saved")
    assert.equal(await readFile(join(saved, ".credentials.json"), "utf8"), credentials("fresh-native"))
    const capturedStores = JSON.parse(await readFile(keychain, "utf8"))
    assert.equal(capturedStores[service(saved)], credentials("fresh-native"))
    stores[service(saved)] = capturedStores[service(saved)]
    await writeFile(join(saved, ".credentials.json"), "broken")
    const env = await claude.accountEnv("saved", {
      ...process.env,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/unrelated-account",
      ANTHROPIC_AUTH_TOKEN: "unrelated-token",
    })
    assert.equal(env.CLAUDE_CONFIG_DIR, saved)
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined)
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)

    // Usage resolves the same named account as launch, even with a router name collision.
    await writeFile(join(root, ".subrouter", "fixture", "claude.json"), JSON.stringify({
      profiles: { saved: { dir: "profile" } },
    }))
    await setKeychain(service(saved), "captured-current")
    await claude.accountUsage("saved")
    assert.equal(bearer, "Bearer captured-current")

    // Follow native explicit secure-storage overrides for the default account only.
    const secure = join(root, "secure")
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure
    await setKeychain(service(secure), "secure-current")
    await claude.accountUsage("default")
    assert.equal(bearer, "Bearer secure-current")
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = ""
    await setKeychain("Claude Code-credentials", "unscoped-current")
    await claude.accountUsage("default")
    assert.equal(bearer, "Bearer unscoped-current")

    // When Keychain has no entry, native plaintext fallback still works.
    delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR
    delete stores[service(routed)]
    await writeFile(keychain, JSON.stringify(stores))
    await writeFile(join(routed, ".credentials.json"), credentials("file-only"))
    await claude.accountUsage("default")
    assert.equal(bearer, "Bearer file-only")
    await rm(join(routed, ".credentials.json"))
    assert.deepEqual(await claude.accountUsage("default"), { status: "missing-credentials" })
    console.log("Claude credential source: native Keychain precedence, scoped/default overrides, capture, account isolation, router collision, and file fallback pass")
  } finally {
    globalThis.fetch = originalFetch
    for (const key of ["PATH", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
}
