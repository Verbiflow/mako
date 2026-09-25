import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { claudeProfileLoader } from "../electron/providers/claude/profile.js"
import { resolveHarnessTuning } from "../electron/harness-models.js"

const root = await mkdtemp(join(tmpdir(), "mako-claude-discovery-"))
const calls = join(root, "calls.jsonl")
const gate = join(root, "release")
const executable = join(root, "claude")
await writeFile(calls, "")
await writeFile(
  executable,
  `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const config = args[args.indexOf('--mcp-config') + 1];
const strict = args.includes('--strict-mcp-config') && config === '{"mcpServers":{}}';
let model;
createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  const request = message.request.subtype;
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({request, strict, pid:process.pid, hookless: args[args.indexOf('--settings') + 1] === '{"disableAllHooks":true}'}) + '\\n');
  process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'stale',response:{applied:{effort:'stale'},effective:{}}}})+'\\n');
  const respond = response => process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:message.request_id,response}}) + '\\n');
  if (request === 'list_models') respond({models:[
    {value:'default',resolvedModel:'fixture-model'},
    {value:'fixture-model',supportsEffort:true,supportedEffortLevels:['low','high'],supportsFastMode:true},
    {value:'other-model',supportsEffort:true,supportedEffortLevels:['low','high'],supportsFastMode:true}
  ]});
  else if (request === 'set_model') {
    if (process.env.REJECT_MODEL === message.request.model) {
      process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:message.request_id}})+'\\n'); return;
    }
    model=message.request.model; respond({});
  }
  else {
    const timer = setInterval(() => {
      if (!existsSync(${JSON.stringify(gate)})) return;
      clearInterval(timer);
      respond({applied:{effort:model === 'fixture-model' ? 'high' : 'low'},effective:{fastMode:model === 'other-model',unrelated:'private-setting-fixture'}});
    }, 5);
  }
});
`,
  { mode: 0o700 }
)
const env = {
  ...process.env,
  CLAUDE_CODE_EXECUTABLE: executable,
  CLAUDE_CONFIG_DIR: root,
}
const row = z.object({
  request: z.enum(["list_models", "set_model", "get_settings"]),
  pid: z.number(),
  hookless: z.boolean(),
  strict: z.boolean(),
})
const requests = async () =>
  (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => row.parse(JSON.parse(line)))
const full = claudeProfileLoader.load(env, root)
const duplicate = claudeProfileLoader.load({ ...env }, root)
void full.catch(() => {})
try {
  const deadline = Date.now() + 5000
  while (
    !(await requests()).some((entry) => entry.request === "get_settings")
  ) {
    assert.ok(Date.now() < deadline, "Model defaults were not requested")
    await delay(10)
  }
  assert.ok(claudeProfileLoader.loadForSend)
  const quick = await Promise.race([
    claudeProfileLoader.loadForSend(env, root),
    delay(1000).then(() => {
      throw new Error("Launch waited for unrelated model defaults")
    }),
  ])
  assert.equal(quick.models.length, 2)
  assert.equal(
    quick.models[0].options.find((option) => option.id === "effort")?.current,
    undefined
  )
  assert.deepEqual(
    resolveHarnessTuning(quick, {
      model: "fixture-model",
      options: { effort: "low" },
    }),
    { model: "fixture-model", options: { effort: "low" } }
  )
  assert.throws(
    () =>
      resolveHarnessTuning(quick, {
        model: "fixture-model",
        options: { effort: "unsupported" },
      }),
    /not supported/
  )
  assert.equal(
    (await requests()).filter((entry) => entry.request === "list_models")
      .length,
    1
  )
  await writeFile(gate, "ready")
  const detailed = await full
  assert.deepEqual(await duplicate, detailed)
  assert.equal(
    new Set((await requests()).map((entry) => entry.pid)).size,
    1,
    "Catalog, all defaults, overlapping display and send must share one process"
  )
  assert.equal(
    detailed.models[1].options.find((option) => option.id === "effort")
      ?.current,
    "low"
  )
  assert.equal(
    detailed.models[1].options.find((option) => option.id === "fast")?.current,
    true
  )
  assert.ok((await requests()).every((entry) => entry.hookless))
  assert.notEqual(
    claudeProfileLoader.cacheKey(env),
    claudeProfileLoader.cacheKey({
      ...env,
      ANTHROPIC_AUTH_TOKEN: "other-account",
    })
  )
  assert.notEqual(
    claudeProfileLoader.cacheKey(env),
    claudeProfileLoader.cacheKey({
      ...env,
      CLAUDE_CODE_EXECUTABLE: "other-cli",
    })
  )
  const isolated = await claudeProfileLoader.load(
    { ...env, ANTHROPIC_AUTH_TOKEN: "other-account" },
    root
  )
  assert.equal(isolated.models.length, 2)
  assert.equal(new Set((await requests()).map((entry) => entry.pid)).size, 2)
  const refreshed = await claudeProfileLoader.load(env, root)
  assert.equal(refreshed.models.length, 2)
  assert.equal(
    new Set((await requests()).map((entry) => entry.pid)).size,
    3,
    "A finished process must not survive as a stale cache"
  )
  assert.equal(
    detailed.models[0].options.find((option) => option.id === "effort")
      ?.current,
    "high"
  )
  assert.equal(
    quick.models[0].options.find((option) => option.id === "effort")?.current,
    undefined,
    "Background enrichment cannot mutate a launch catalogue"
  )
  assert.ok(
    (await requests()).every((entry) => entry.strict),
    "Read-only discovery must not start MCP servers"
  )
  assert.ok(!JSON.stringify(detailed).includes("private-setting-fixture"))
  const rejected = await claudeProfileLoader.load(
    { ...env, REJECT_MODEL: "other-model" },
    root
  )
  assert.ok(rejected.configurationError)
  assert.equal(
    rejected.models[1].options.find((option) => option.id === "effort")
      ?.current,
    undefined,
    "A rejected switch must not inherit the previous model's defaults"
  )
  const beforeConcurrent = new Set((await requests()).map((entry) => entry.pid))
    .size
  await Promise.all([
    claudeProfileLoader.load(env, root),
    claudeProfileLoader.load(
      { ...env, ANTHROPIC_AUTH_TOKEN: "another-account" },
      root
    ),
    claudeProfileLoader.load(env, undefined),
  ])
  assert.equal(
    new Set((await requests()).map((entry) => entry.pid)).size,
    beforeConcurrent + 3
  )
  console.log(
    "Claude discovery: launch validates the catalogue without waiting for defaults, background defaults remain exact, MCP startup is excluded, and private settings stay redacted"
  )
} finally {
  await writeFile(gate, "ready")
  await full.catch(() => {})
  await rm(root, { recursive: true, force: true })
}
