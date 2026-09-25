import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { codexProfileLoader } from "../electron/providers/codex/profile.js"

const root = await mkdtemp(join(tmpdir(), "mako-codex-discovery-"))
const executable = join(root, "codex")
const calls = join(root, "calls.jsonl")
await writeFile(
  executable,
  `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
let initialized = false;
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({pid:process.pid,method:m.method,params:m.params})+'\\n');
  const reply = result => process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
  if (m.method === 'initialize') { reply({}); return; }
  if (m.method === 'initialized') { initialized=true; return; }
  if (!initialized) process.exit(2);
  // A delayed duplicate must not satisfy the next request.
  process.stdout.write(JSON.stringify({id:m.id-1,result:{data:[{model:'stale'}]}})+'\\n');
  if (m.method === 'model/list') {
    if (process.env.FAIL_CATALOG === '1') process.exit(3);
    reply({data:[{model:m.params.cursor ? 'second' : 'first',isDefault:!m.params.cursor}],nextCursor:m.params.cursor ? null : 'page-two'});
  } else if (m.method === 'config/read') {
    if (process.env.FAIL_CONFIG === '1') process.stdout.write(JSON.stringify({id:m.id,error:{code:-1}})+'\\n');
    else reply({config:{model:'second',model_reasoning_effort:'high',apiKey:'fixture-private'}});
  } else process.exit(4);
});
`,
  { mode: 0o700 }
)
const env = { ...process.env, CODEX_EXECUTABLE: executable }
try {
  const profile = await codexProfileLoader.load(env, root)
  assert.deepEqual(
    profile.models.map((model) => model.id),
    ["first", "second"]
  )
  assert.equal(profile.settings?.model, "second")
  assert.equal(profile.settings?.options?.effort, "high")
  assert.ok(!JSON.stringify(profile).includes("fixture-private"))
  const row = z.object({
    pid: z.number(),
    method: z.string(),
    params: z.object({ cwd: z.string().optional() }),
  })
  const requests = (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => row.parse(JSON.parse(line)))
  assert.deepEqual(
    requests.map((request) => request.method),
    ["initialize", "initialized", "model/list", "model/list", "config/read"]
  )
  assert.equal(new Set(requests.map((request) => request.pid)).size, 1)
  assert.equal(requests.at(-1)?.params.cwd, root)
  for (const pid of new Set(requests.map((request) => request.pid)))
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  const partial = await codexProfileLoader.load(
    { ...env, FAIL_CONFIG: "1" },
    root
  )
  assert.equal(partial.models.length, 2)
  assert.ok(partial.configurationError)
  assert.equal(partial.settings, undefined)
  await assert.rejects(
    codexProfileLoader.load({ ...env, FAIL_CATALOG: "1" }, root),
    /exited/
  )
  console.log(
    "Codex discovery: one initialized process for pages/config, exact reply matching, native defaults, rejected configuration, catalog failure and cleanup verified"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
