import assert from "node:assert/strict"
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareDevinMcp } from "@mako/host/harnesses/devin/session-mcp"

const root = await mkdtemp(join(tmpdir(), "mako-devin-mcp-test-"))
try {
  await mkdir(join(root, "devin"))
  await mkdir(join(root, "another-app"))
  await writeFile(join(root, "devin", "config.json"), '{"theme_mode":"dark"}')
  const original = JSON.stringify({
    mcpServers: {
      original: {
        url: "https://example.invalid",
        headers: { Authorization: "fixture-only" },
      },
    },
  })
  await writeFile(join(root, "devin", "mcp_config.json"), original)
  const first: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root }
  const second: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root }
  const cleanupFirst = await prepareDevinMcp(
    [
      {
        name: "test-server",
        command: "/usr/bin/true",
        args: [],
        env: [{ name: "TEST_TOKEN", value: "first-fixture" }],
      },
    ],
    first
  )
  const cleanupSecond = await prepareDevinMcp(
    [
      {
        name: "test-server",
        type: "http",
        url: "http://127.0.0.1:1",
        headers: [{ name: "Authorization", value: "second-fixture" }],
      },
    ],
    second
  )
  try {
    assert.ok(first.XDG_CONFIG_HOME && second.XDG_CONFIG_HOME)
    assert.notEqual(first.XDG_CONFIG_HOME, second.XDG_CONFIG_HOME)
    const config = join(first.XDG_CONFIG_HOME, "devin", "mcp_config.json")
    assert.equal((await stat(config)).mode & 0o777, 0o600)
    const contents = JSON.parse(await readFile(config, "utf8"))
    assert.equal(
      contents.mcpServers.original.headers.Authorization,
      "fixture-only"
    )
    assert.equal(
      contents.mcpServers["test-server"].env.TEST_TOKEN,
      "first-fixture"
    )
    assert.equal(
      await readFile(join(root, "devin", "mcp_config.json"), "utf8"),
      original
    )
    assert.equal(
      await realpath(join(first.XDG_CONFIG_HOME, "devin", "config.json")),
      await realpath(join(root, "devin", "config.json"))
    )
    assert.equal(
      await realpath(join(first.XDG_CONFIG_HOME, "another-app")),
      await realpath(join(root, "another-app"))
    )
    await cleanupFirst()
    await assert.rejects(stat(first.XDG_CONFIG_HOME), { code: "ENOENT" })
    assert.ok(await stat(second.XDG_CONFIG_HOME))
  } finally {
    await cleanupFirst()
    await cleanupSecond()
  }
  console.log(
    "Devin session MCP: isolated credentials, preserved native config, unrelated config continuity, and independent idempotent cleanup passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
