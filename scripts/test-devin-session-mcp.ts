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
import { z } from "zod"
import { hookMayWrite } from "@mako/host/harnesses/call-gate"
import { devinPersonCodeRuns } from "@mako/host/harnesses/devin/person-code"
import { DEVIN_WRITE_MATCHER, DEVIN_WRITING_TOOLS, devinHoldsWrites, devinToolReads, prepareDevinMcp } from "@mako/host/harnesses/devin/session-mcp"
import { readdirSync, readFileSync } from "node:fs"

/** A recorded build's tool lists (`scripts/fixtures/native-tools`), by name. */
const Recorded = z.object({ configurations: z.array(z.object({ tools: z.record(z.string(), z.json()) })) })
const Hooks = z.object({ hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(z.object({ command: z.string() })) }))) })

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
  // The gate's hook: for the shell alone on a launch that holds no writes, before every tool on one that does.
  {
    const mako = { name: "mako", type: "http" as const, url: "http://127.0.0.1:9/c/mako", headers: [{ name: "Authorization", value: "Bearer fixture" }] }
    const hooksOf = async (holdsWrites: boolean) => {
      const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: root }
      const cleanup = await prepareDevinMcp([mako], env, false, true, holdsWrites)
      try {
        return Hooks.parse(JSON.parse(await readFile(join(env.XDG_CONFIG_HOME!, "devin", "config.json"), "utf8"))).hooks
      } finally {
        await cleanup()
      }
    }
    const plain = await hooksOf(false)
    assert.deepEqual([plain.PreToolUse!.at(-1)!.matcher, plain.PostToolUse!.at(-1)!.matcher], ["^exec$", "^exec$"])
    const held = await hooksOf(true)
    assert.deepEqual([held.PreToolUse!.at(-1)!.matcher, held.PostToolUse!.at(-1)!.matcher], [DEVIN_WRITE_MATCHER, "^exec$"], "a launch that holds writes asks before every tool that may write")
    assert.match(held.PreToolUse!.at(-1)!.hooks[0]!.command, /curl -s -m 8 .*\/c\/calls\/pre'$/)
    // The hook runs for what may write and never for a read, which would pay for its process on every call.
    const hooked = new RegExp(DEVIN_WRITE_MATCHER)
    for (const tool of ["exec", "write", "edit", "notebook_edit", "write_to_process", "kill_shell", "write_plan", "skill", "run_subagent", "mcp_call_tool", "request_scope", "mcp__notes__save", "mcp__mako__thread_history"])
      assert.ok(hooked.test(tool), `${tool} runs the hook`)
    for (const tool of ["read", "notebook_read", "grep", "code_search", "find_code_context", "find_file_by_name", "get_output", "read_subagent", "subagent", "mcp_list_tools", "mcp_list_servers", "mcp_read_resource", "todo_write", "webfetch", "web_search", "read_page_content", "ask_user_question", "exit_plan_mode", "execute", "rewrite"]) {
      assert.ok(!hooked.test(tool), `${tool} doesn't run the hook`)
    }
    assert.deepEqual(DEVIN_WRITING_TOOLS.filter((tool) => !/^[a-z_]+$/.test(tool)), [], "every name is safe inside the matcher's expression")
    // Every tool any recorded Devin build offers is either matched or known to only read: one a later build adds that
    // is neither fails here, when its tool list is recorded, before a launch could let it write unheld.
    const fixtures = new URL("./fixtures/native-tools/", import.meta.url)
    const builds = readdirSync(fixtures).filter((name) => name.startsWith("devin-"))
    assert.ok(builds.length > 0)
    for (const build of builds) {
      const offered = Recorded.parse(JSON.parse(readFileSync(new URL(build, fixtures), "utf8"))).configurations.flatMap((configuration) => Object.keys(configuration.tools))
      const unplaced = [...new Set(offered)].filter((tool) => !hooked.test(tool) && !devinToolReads(tool))
      assert.deepEqual(unplaced, [], `${build}: tools the hook neither runs for nor knows as reading`)
    }
    // Which of the hooked calls then wait is the gate's to say.
    for (const tool of ["write", "edit", "notebook_edit", "write_to_process", "kill_shell", "run_subagent", "mcp__notes__save", "a_tool_devin_adds"])
      assert.equal(hookMayWrite({ tool_name: tool }), true, `${tool} may write`)
    assert.equal(hookMayWrite({ tool_name: "exec", tool_input: { command: "git status" } }), false)
    assert.equal(hookMayWrite({ tool_name: "exec", tool_input: { command: "echo x > y" } }), true)
  }

  // Whether a launch holds writes: only with Mako's server to post to, and nothing of the person's that runs beside it.
  {
    const home = join(root, "person")
    const project = join(home, "repo")
    const cwd = join(project, "packages", "app")
    await mkdir(join(project, ".git"), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await mkdir(join(home, ".config", "devin"), { recursive: true })
    const env: NodeJS.ProcessEnv = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") }
    const mako = { name: "mako", process: false }
    const launch = (servers = [mako]) => ({ env, cwd, servers })
    const put = async (path: string, value: string) => {
      await mkdir(join(path, ".."), { recursive: true })
      await writeFile(path, value)
    }
    const hooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "exec", hooks: [{ type: "command", command: "true" }] }] } })
    assert.equal(await devinPersonCodeRuns(launch()), false, "a home with no hooks and no process servers runs none of the person's code")
    assert.equal(await devinHoldsWrites(launch()), true)
    assert.equal(await devinHoldsWrites(launch([])), false, "without Mako's server there is no gate to post to")
    assert.equal(await devinHoldsWrites(launch([mako, { name: "notes", process: true }])), false, "an MCP server run as a process is the person's code")
    assert.equal(await devinHoldsWrites(launch([mako, { name: "docs", process: false }])), true, "one reached over HTTP runs nothing here")
    await put(join(home, ".config", "devin", "config.json"), JSON.stringify({ theme_mode: "dark", hooks: { PreToolUse: [] } }))
    assert.equal(await devinPersonCodeRuns(launch()), false, "a config with no hook in it")
    const cases: [what: string, path: string, value: string][] = [
      ["the user's config.json", join(home, ".config", "devin", "config.json"), hooks],
      ["Claude Code's user settings, which Devin imports", join(home, ".claude", "settings.json"), hooks],
      ["hooks.v1.json at the repository's root", join(project, ".devin", "hooks.v1.json"), JSON.stringify({ UserPromptSubmit: [{ hooks: [{ type: "command", command: "true" }] }] })],
      ["config.local.json in a folder between the root and the working folder", join(project, "packages", ".devin", "config.local.json"), hooks],
      ["Claude Code's project settings in the working folder", join(cwd, ".claude", "settings.local.json"), hooks],
      ["a process server in the person's mcp_config.json", join(home, ".config", "devin", "mcp_config.json"), JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } })],
      ["a process server in the folder's mcp_config.local.json", join(cwd, ".devin", "mcp_config.local.json"), JSON.stringify({ mcpServers: { notes: { command: "notes-mcp" } } })],
      ["a config that isn't JSON", join(home, ".config", "devin", "config.json"), "{ not json"],
      ["hooks that aren't an event map", join(project, ".devin", "config.json"), JSON.stringify({ hooks: "all" })],
    ]
    for (const [what, path, value] of cases) {
      await put(path, value)
      assert.equal(await devinPersonCodeRuns(launch()), true, what)
      await rm(path)
      assert.equal(await devinPersonCodeRuns(launch()), false, `${what}, once gone`)
    }
    await put(join(home, ".config", "devin", "mcp_config.json"), JSON.stringify({ mcpServers: { docs: { url: "https://example.invalid" } } }))
    assert.equal(await devinPersonCodeRuns(launch()), false, "an HTTP server of the person's runs nothing here")
  }
  console.log(
    "Devin session MCP: isolated credentials, preserved native config, unrelated config continuity, independent idempotent cleanup, the gate's hook and which launches hold writes passed"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
