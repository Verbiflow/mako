import assert from "node:assert/strict"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { devinDefaultModel } from "../electron/providers/devin/settings.ts"
import { devinExecutable } from "../electron/providers/devin/executable.ts"

const root = await mkdtemp(join(tmpdir(), "mako-devin-settings-"))
const executable = join(root, "agent")
const trace = join(root, "trace.jsonl")
const data = join(root, "data")
const databasePath = join(data, "devin", "cli", "sessions.db")
await mkdir(join(data, "devin", "cli"), { recursive: true })
const database = new DatabaseSync(databasePath)
database.exec(
  "CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, pid INTEGER)"
)
database
  .prepare("INSERT INTO sessions VALUES (?, ?, 0)")
  .run("11111111-1111-4111-8111-111111111111", "/unrelated/user/workspace")
await writeFile(
  executable,
  `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync(path.join(process.env.XDG_DATA_HOME,'devin','cli','sessions.db'));
const trace = record => fs.appendFileSync(process.env.TRACE_FILE,JSON.stringify(record)+'\\n');
if (process.argv[2] === 'rm') {
  const id = process.argv.at(-1);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (row) {
    let running = true;
    try { process.kill(row.pid,0); } catch (error) { if(error.code==='ESRCH') running=false; }
    if(running || process.env.FAIL_REMOVE) process.exit(2);
    if(!process.env.NOOP_REMOVE) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
  trace({method:'rm',id}); db.close(); process.exit(0);
}
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    trace({method:request.method,workspace:request.params?.cwd,pid:process.pid});
    let result = {};
    if(request.method==='initialize') result={protocolVersion:1,agentCapabilities:{sessionCapabilities:{delete:{}}},authMethods:[]};
    if(request.method==='session/new') {
      const id=process.env.SLUG_IDS ? 'resonant-pendulum' : randomUUID(); db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(id,request.params.cwd,process.pid);
      if(process.env.LOSE_REPLY) process.exit(2);
      result={sessionId:id,configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:'fixture-model',options:[{value:'fixture-model',name:'Fixture model'}]}]};
    }
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
  }
});
`
)
await chmod(executable, 0o755)
const env = { ...process.env, TRACE_FILE: trace, XDG_DATA_HOME: data }
const TraceSchema = z.object({
  method: z.string(),
  workspace: z.string().optional(),
  pid: z.number().optional(),
})
const records = async () =>
  (await readFile(trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => TraceSchema.parse(JSON.parse(line)))
try {
  assert.equal(await devinDefaultModel(executable, env, root), "fixture-model")
  assert.deepEqual(
    (await records()).map((record) => record.method),
    ["initialize", "session/new", "rm"]
  )
  assert.equal(await devinDefaultModel(executable, { ...env, SLUG_IDS: "1" }, root), "fixture-model")
  await assert.rejects(devinDefaultModel(executable, { ...env, SLUG_IDS: "1", LOSE_REPLY: "1" }, root))
  assert.equal(database.prepare("SELECT COUNT(*) AS total FROM sessions").get()?.total, 1)
  await assert.rejects(
    devinDefaultModel(executable, { ...env, LOSE_REPLY: "1" }, root)
  )
  assert.equal(
    database.prepare("SELECT COUNT(*) AS total FROM sessions").get()?.total,
    1
  )
  await assert.rejects(
    devinDefaultModel(executable, { ...env, FAIL_REMOVE: "1" }, root)
  )
  const abandoned = (await records())
    .filter((record) => record.method === "session/new")
    .at(-1)
  assert.ok(abandoned?.workspace && abandoned.pid)
  await writeFile(
    join(abandoned.workspace, "owner.json"),
    JSON.stringify({ version: 1, state: "active", pid: abandoned.pid })
  )
  assert.equal(await devinDefaultModel(executable, env, root), "fixture-model")
  assert.equal(
    database.prepare("SELECT COUNT(*) AS total FROM sessions").get()?.total,
    1
  )
  await assert.rejects(
    devinDefaultModel(executable, { ...env, NOOP_REMOVE: "1" }, root),
    /did not remove/
  )
  assert.equal(await devinDefaultModel(executable, env, root), "fixture-model")
  assert.equal(
    database.prepare("SELECT COUNT(*) AS total FROM sessions").get()?.total,
    1
  )
  for (const record of (await records()).filter((record) => record.workspace)) {
    assert.ok(record.workspace)
    await assert.rejects(stat(record.workspace), { code: "ENOENT" })
  }
  console.log(
    "Devin probes release native locks before CLI deletion, recover lost replies and abandoned cleanup, and preserve unrelated sessions"
  )
  if (process.argv.includes("--live")) {
    const installed = devinExecutable()
    assert.ok(installed)
    const native = new DatabaseSync(
      join(
        process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
        "devin",
        "cli",
        "sessions.db"
      ),
      { readOnly: true }
    )
    try {
      const count = native.prepare(
        "SELECT COUNT(*) AS total FROM sessions WHERE working_directory LIKE ?"
      )
      const prefix = join(await realpath(tmpdir()), "mako-devin-probes", "%")
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = performance.now()
        const model = await devinDefaultModel(
          installed,
          process.env,
          process.cwd()
        )
        assert.ok(model)
        assert.equal(count.get(prefix)?.total, 0)
        console.log(
          `Devin live probe ${attempt + 1}: ${model}; ${Math.round(performance.now() - started)} ms; zero retained probe sessions`
        )
      }
    } finally {
      native.close()
    }
  }
} finally {
  database.close()
  await rm(root, { recursive: true, force: true })
}
