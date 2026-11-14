import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { codexChildLaunch, codexStartPrefetch } from "@mako/host/harnesses/codex-app"
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
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }))
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

  // A .js command is the official entrypoint only when that package says so. A neighbor's native build does not take its place.
  const customPkg = join(root, "custom/node_modules/@openai/custom")
  const custom = join(customPkg, "bin/custom.js")
  const neighbor = join(dirname(customPkg), "codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
  await mkdir(dirname(custom), { recursive: true })
  await mkdir(dirname(neighbor), { recursive: true })
  await writeFile(custom, "console.log('custom')\n")
  await chmod(custom, 0o755)
  await writeFile(join(customPkg, "package.json"), JSON.stringify({ name: "@openai/custom", bin: "bin/custom.js" }))
  await writeFile(neighbor, "")
  await chmod(neighbor, 0o755)
  assert.deepEqual(await codexLaunch(custom, platform), { executable: custom, env: {} }, "an explicit wrapper beside a platform package stays the wrapper")
  const extra = join(root, "beside/lib/node_modules/@openai/codex/bin/extra.js")
  await writeFile(extra, "")
  assert.deepEqual(await codexLaunch(extra, platform), { executable: extra, env: {} }, "a script in the package that is not its bin stays that script")

  const managers = ["CODEX_MANAGED_BY_NPM", "CODEX_MANAGED_BY_BUN", "CODEX_MANAGED_BY_PNPM", "CODEX_MANAGED_BY_VITE_PLUS"]
  const named = async (entry: string, which: string, env: NodeJS.ProcessEnv = {}) => {
    const launch = await codexLaunch(entry, which, env)
    return managers.find((name) => launch.env[name] === "1")
  }
  const platforms = [
    ["darwin-arm64", "codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
    ["darwin-x64", "codex-darwin-x64", "x86_64-apple-darwin", "codex"],
    ["linux-arm64", "codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
    ["linux-x64", "codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
    ["win32-x64", "codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
  ] as const
  for (const spec of platforms) {
    const [which, name, target, binary] = spec
    const folder = join(root, "managers", which)
    const pkg = join(folder, "node_modules/@openai/codex")
    const entry = join(pkg, "bin/codex.js")
    const built = join(dirname(pkg), name, "vendor", target, "bin", binary)
    await mkdir(dirname(entry), { recursive: true })
    await mkdir(dirname(built), { recursive: true })
    await writeFile(entry, "#!/usr/bin/env node\n")
    await chmod(entry, 0o755)
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }))
    await writeFile(built, "")
    await chmod(built, 0o755)
    const npm = await codexLaunch(entry, which, {})
    assert.equal(npm.executable, await realpath(built), `${which} starts the native build`)
    assert.equal(await named(entry, which), "CODEX_MANAGED_BY_NPM", which)
    assert.equal(await named(entry, which, { npm_config_user_agent: "bun/1.3.0" }), "CODEX_MANAGED_BY_BUN", `${which} bun user agent`)
    assert.equal(await named(entry, which, { npm_execpath: "/usr/local/bin/bun" }), "CODEX_MANAGED_BY_BUN", `${which} bun exec path`)
    await writeFile(join(folder, "node_modules/.modules.yaml"), "layoutVersion: 5\n")
    assert.equal(await named(entry, which, { npm_config_user_agent: "bun/1.3.0" }), "CODEX_MANAGED_BY_PNPM", `${which} pnpm owns it before bun's env`)
    const vitePkg = join(folder, "packages/@openai/codex/active/lib/node_modules/@openai/codex")
    const viteEntry = join(vitePkg, "bin/codex.js")
    const viteNative = join(dirname(vitePkg), name, "vendor", target, "bin", binary)
    await mkdir(dirname(viteEntry), { recursive: true })
    await mkdir(dirname(viteNative), { recursive: true })
    await writeFile(viteEntry, "#!/usr/bin/env node\n")
    await chmod(viteEntry, 0o755)
    await writeFile(join(vitePkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }))
    await writeFile(viteNative, "")
    await chmod(viteNative, 0o755)
    await writeFile(join(folder, "packages/@openai/codex.json"), JSON.stringify({ name: "@openai/codex", installId: "active" }))
    assert.equal(await named(viteEntry, which, { npm_config_user_agent: "bun/1.3.0" }), "CODEX_MANAGED_BY_VITE_PLUS", `${which} vite+ owns it before bun's env`)
    if (which === `${process.platform}-${process.arch}`) {
      const session = await codexChildLaunch({ PATH: "/usr/bin:/bin", npm_config_user_agent: "bun/1.3.0" }, viteEntry)
      assert.equal(session.command, await realpath(viteNative), "a session starts the native build")
      assert.equal(session.env.CODEX_MANAGED_BY_VITE_PLUS, "1", "a session keeps vite+")
      assert.equal(session.env.CODEX_MANAGED_BY_NPM, undefined)
    }
  }

  const hashed = join(root, "vite-hash/packages/@openai/codex#7/lib/node_modules/@openai/codex")
  const hashedEntry = join(hashed, "bin/codex.js")
  const hashedNative = join(dirname(hashed), "codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
  await mkdir(dirname(hashedEntry), { recursive: true })
  await mkdir(dirname(hashedNative), { recursive: true })
  await writeFile(hashedEntry, "#!/usr/bin/env node\n")
  await writeFile(join(hashed, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }))
  await writeFile(hashedNative, "")
  await chmod(hashedNative, 0o755)
  await writeFile(join(root, "vite-hash/packages/@openai/codex.json"), JSON.stringify({ name: "@openai/codex", installId: "#7" }))
  assert.equal(await named(hashedEntry, platform), "CODEX_MANAGED_BY_VITE_PLUS", "an older vite+ id is a directory suffix")

  const stored = join(root, "store/codex")
  const storedEntry = join(stored, "bin/codex.js")
  const storedNative = join(dirname(stored), "codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
  await mkdir(dirname(storedEntry), { recursive: true })
  await mkdir(dirname(storedNative), { recursive: true })
  await writeFile(storedEntry, "#!/usr/bin/env node\n")
  await chmod(storedEntry, 0o755)
  await writeFile(join(stored, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }))
  await writeFile(storedNative, "")
  await chmod(storedNative, 0o755)
  const linked = join(root, "linked/node_modules/@openai/codex")
  await mkdir(dirname(linked), { recursive: true })
  await symlink(stored, linked)
  await writeFile(join(root, "linked/node_modules/.modules.yaml"), "layoutVersion: 5\n")
  assert.equal(await named(join(linked, "bin/codex.js"), platform, { npm_config_user_agent: "npm/10.0.0" }), "CODEX_MANAGED_BY_PNPM", "pnpm linked the entrypoint, not the real package path")

  const bunPkg = join(root, ".bun/install/global/node_modules/@openai/codex")
  const bunEntry = join(bunPkg, "bin/codex.js")
  const bunNative = join(dirname(bunPkg), "codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
  await mkdir(dirname(bunEntry), { recursive: true })
  await mkdir(dirname(bunNative), { recursive: true })
  await writeFile(bunEntry, "#!/usr/bin/env node\n")
  await writeFile(join(bunPkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }))
  await writeFile(bunNative, "")
  await chmod(bunNative, 0o755)
  assert.equal(await named(bunEntry, platform), "CODEX_MANAGED_BY_BUN", "bun's global install directory")

  const host = platforms.find(([which]) => which === `${process.platform}-${process.arch}`)
  assert.ok(host, `${process.platform}-${process.arch} is a Codex platform`)
  const prefetchPkg = join(root, "prefetch/node_modules/@openai/codex")
  const prefetchEntry = join(prefetchPkg, "bin/codex.js")
  const prefetchNative = join(dirname(prefetchPkg), host[1], "vendor", host[2], "bin", host[3])
  await mkdir(dirname(prefetchEntry), { recursive: true })
  await mkdir(dirname(prefetchNative), { recursive: true })
  await writeFile(prefetchEntry, "#!/usr/bin/env node\n")
  await chmod(prefetchEntry, 0o755)
  await writeFile(join(prefetchPkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }))
  await writeFile(prefetchNative, "")
  await chmod(prefetchNative, 0o755)
  const prefetch = await codexStartPrefetch({
    PATH: "/usr/bin:/bin",
    HOME: root,
    CODEX_EXECUTABLE: prefetchEntry,
    npm_execpath: "/usr/local/bin/bun",
  }, root)
  assert.ok(prefetch)
  assert.equal(prefetch.command, await realpath(prefetchNative))
  assert.equal(prefetch.env.CODEX_MANAGED_BY_BUN, "1", "prefetch reads the launch env")
  assert.equal(prefetch.env.CODEX_MANAGED_BY_PNPM, undefined)
  assert.equal(prefetch.env.LOG_FORMAT, "json")
  const customPrefetch = await codexStartPrefetch({ PATH: "/usr/bin:/bin", HOME: root, CODEX_EXECUTABLE: custom }, root)
  assert.ok(customPrefetch)
  assert.equal(customPrefetch.command, custom, "prefetch leaves a custom wrapper in place")
  assert.equal(customPrefetch.env.CODEX_MANAGED_BY_NPM, undefined)

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
  "Codex executable: standalone compatibility and explicit selection hold with desktop PATH; only @openai/codex's own bin starts as its native build, and the package manager matches the wrapper's"
)
