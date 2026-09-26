import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { controlSessionProbe } from "./lib/control-session-probe.ts"
import { connectMcpComputerDriver } from "../packages/control-runtime/src/computer-driver-client.js"

// The native driver process is killed from outside while an action is in
// flight. The "app" it drives keeps its state in a file, so effects that
// reached it before the kill survive the driver, as a real app's would.
const root = await mkdtemp(join(tmpdir(), "mako-driver-death-"))
const log = join(root, "driver.jsonl")
const app = join(root, "app.json")
const holdRead = join(root, "hold-read")
await writeFile(app, JSON.stringify({ "42:7": "", "43:9": "", "44:1": "" }))

const driver = `
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const LOG=${JSON.stringify(log)}, APP=${JSON.stringify(app)}, HOLD=${JSON.stringify(holdRead)};
const note=(entry)=>appendFileSync(LOG, JSON.stringify({pid:process.pid,...entry})+'\\n');
const read=()=>JSON.parse(readFileSync(APP,'utf8'));
const change=(key,update)=>{const state=read(); state[key]=update(state[key]??''); writeFileSync(APP, JSON.stringify(state));};
const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const reply=(value)=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
const target={session:{type:'string'},pid:{type:'integer'},window_id:{type:'integer'},element_token:{type:'string'}};
const server=new Server({name:'death-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,()=>({tools:[
  {name:'get_window_state',description:'Capture.',inputSchema:{type:'object',properties:{...target,max_elements:{type:'integer'}},required:['session','pid','window_id']}},
  {name:'press_key',description:'Press a key.',inputSchema:{type:'object',properties:{...target,key:{type:'string'}},required:['session','key']}},
  {name:'set_value',description:'Set a value.',inputSchema:{type:'object',properties:{...target,value:{type:'string'}},required:['session','element_token','value']}},
  {name:'list_apps',description:'Apps',inputSchema:{type:'object',properties:{session:{type:'string'}}}},
  {name:'list_windows',description:'Windows',inputSchema:{type:'object',properties:{session:{type:'string'},pid:{type:'integer'}}}}
]}));
let snapshot=0;
const tokens=new Map();
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const name=request.params.name, args=request.params.arguments;
  if(name==='list_apps') return reply({apps:[{pid:1,active:true,name:'Other'},{pid:42,active:false,name:'Fixture'},{pid:43,active:false,name:'Neighbour'},{pid:44,active:false,name:'Unseen'}]});
  if(name==='list_windows') return reply({windows:[{pid:args.pid,window_id:{42:7,43:9,44:1}[args.pid],z_index:1,is_on_screen:true,title:'Fixture'}]});
  if(name==='get_window_state'){
    if(existsSync(HOLD)){ note({event:'read-start',window:args.window_id}); await new Promise(()=>{}); }
    const id='p'+process.pid.toString(16)+'n'+(++snapshot);
    const key=args.pid+':'+args.window_id;
    tokens.set(id+':3',key);
    note({event:'read',key});
    return reply({snapshot_id:id,pid:args.pid,window_id:args.window_id,elements:[{element_token:id+':3',role:'AXTextField',label:'Name',value:read()[key]}],elements_complete:true});
  }
  if(name==='press_key'){
    const key=args.pid===undefined?'unscoped':args.pid+':'+args.window_id;
    // Key down reaches the app first; the key up follows after a delay the
    // test uses to kill the driver between them.
    note({event:'down',key,value:args.key});
    change(key,value=>value+args.key);
    await sleep(600);
    note({event:'up',key,value:args.key});
    return reply({route:'background',effect:'unverifiable'});
  }
  if(name==='set_value'){
    const key=tokens.get(args.element_token);
    for(let index=0;index<args.value.length;index++){
      change(key,()=>args.value.slice(0,index+1));
      note({event:'char',key,index});
      await sleep(150);
    }
    return reply({route:'accessibility',effect:'unverifiable'});
  }
  throw new Error('Unexpected tool '+name);
});
await server.connect(new StdioServerTransport());
note({event:'start'});
`

const Entry = z.object({
  pid: z.number(),
  event: z.string(),
  key: z.string().optional(),
  value: z.string().optional(),
  index: z.number().optional(),
})
type Entry = z.infer<typeof Entry>
const entries = async (): Promise<Entry[]> =>
  existsSync(log)
    ? (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => Entry.parse(JSON.parse(line)))
    : []
const appState = async () =>
  z.record(z.string(), z.string()).parse(JSON.parse(await readFile(app, "utf8")))

/** SIGKILL the driver once `ready` holds for entries logged after `from`. */
async function killWhen(from: number, ready: (fresh: Entry[]) => boolean) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const all = await entries()
    const fresh = all.slice(from)
    if (ready(fresh)) {
      const pid = fresh.at(-1)!.pid
      process.kill(pid, "SIGKILL")
      return { pid, fresh }
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Kill point never reached: ${JSON.stringify((await entries()).slice(from))}`)
}

const pageTarget = {
  browser: "fixture-browser",
  tab: "fixture-tab",
  generation: "fixture-generation",
  lease: "fixture-lease",
}
let pageValue = ""
let spawns = 0
const server = controlSessionProbe(
  { command: process.execPath, args: ["--input-type=module", "--eval", driver] },
  "driver-death",
  async (process) => {
    spawns++
    return connectMcpComputerDriver(process)
  },
  {
    surface: "control",
    browserCall: async (command) => {
      if (command.action === "observe")
        return {
          observation: `page-${pageValue || "empty"}`,
          nodes: [
            { depth: 0, role: "RootWebArea", name: "Fixture" },
            { ref: "abc123:1", depth: 1, role: "textbox", name: "Page proof", value: pageValue },
          ],
          viewport: null,
          matched: 1,
          nextOffset: null,
          omitted: 0,
          truncatedTextFields: 0,
        }
      if (command.action === "type" || command.action === "setValue") {
        pageValue = "text" in command ? String(command.text) : String((command as { value?: unknown }).value)
        return { typed: true }
      }
      throw new Error(`Unexpected browser call ${command.action}`)
    },
  }
)
const run = async (source: string) => {
  const reply = await server.request({ method: "exec", arguments: { source } })
  const text = z.array(z.object({ text: z.string().optional() })).parse(reply.content)[0]?.text
  assert.ok(!reply.isError, text ?? JSON.stringify(reply))
  return JSON.parse(z.string().parse(text))
}
const handles = `const w=control.window({pid:42,window_id:7});
const neighbour=control.window({pid:43,window_id:9});
const tab=control.tab({kind:'page',...${JSON.stringify(pageTarget)}});
const fault=(e)=>({code:e.code,outcome:e.outcome,message:e.message});`
const downs = (all: Entry[], key: string, value: string) =>
  all.filter((entry) => entry.event === "down" && entry.key === key && entry.value === value)

try {
  // 1. Mid-keystroke: the key down reached the app, the key up never came.
  let from = (await entries()).length
  const [midKey, killed] = await Promise.all([
    run(`${handles}
const page=await tab.observe(); state.pageRef=page.get({role:'textbox',name:'Page proof'}).ref;
const near=await neighbour.observe(); state.neighbourRef=near.get({role:'TextField',name:'Name'}).ref;
await w.observe();
try { await w.pressKey('a'); return {fault:null} } catch(e) { return {fault:fault(e)} }`),
    killWhen(from, (fresh) => fresh.some((entry) => entry.event === "down" && entry.value === "a")),
  ])
  assert.equal(midKey.fault?.outcome, "unknown", JSON.stringify(midKey))
  assert.equal(midKey.fault.code, "driver-exited")
  assert.match(midKey.fault.message, /stopped while this action was in flight/)
  assert.match(midKey.fault.message, /may have (partly )?happened/)
  assert.match(midKey.fault.message, /never retries the action: observe the target/)
  assert.equal((await appState())["42:7"], "a", "The key down reached the app before the driver died")
  assert.ok(
    !(await entries()).some((entry) => entry.pid === killed.pid && entry.event === "up"),
    "The driver died between key down and key up"
  )

  // After the host reconnects: the affected window stays blocked, other targets
  // work, the dead driver's tokens are refused, and nothing is replayed.
  from = (await entries()).length
  const recovered = await run(`${handles}
const faults={};
try { await w.pressKey('b') } catch(e) { faults.blocked=[e.code,e.outcome] }
try { await neighbour.setValue(state.neighbourRef,'stale') } catch(e) { faults.deadToken=[e.code,e.outcome] }
await neighbour.pressKey('z');
await tab.setValue(state.pageRef,'independent');
const seen=await w.observe();
await w.pressKey('b');
return {faults,field:seen.get({role:'TextField',name:'Name'}).value};`)
  assert.deepEqual(recovered.faults, {
    blocked: ["observation-required", "not-dispatched"],
    deadToken: ["stale-reference", "not-dispatched"],
  })
  assert.equal(recovered.field, "a", "Observation shows the partial effect")
  assert.equal(pageValue, "independent", "Browser evidence survives the native driver")
  let all = await entries()
  assert.equal(downs(all, "42:7", "a").length, 1, "The interrupted key is never replayed")
  assert.equal(downs(all, "42:7", "b").length, 1, "The blocked key was not dispatched before observation")
  assert.equal(downs(all, "43:9", "z").length, 1)
  assert.equal(spawns, 2, "One reconnect")
  assert.equal((await appState())["42:7"], "ab")

  // 2. Partly typed text: the host reports uncertainty and never retypes.
  from = (await entries()).length
  const [typing] = await Promise.all([
    run(`${handles}
const ref=(await w.observe()).get({role:'TextField',name:'Name'}).ref;
try { await w.setValue(ref,'hello world'); return {fault:null} } catch(e) { return {fault:fault(e)} }`),
    killWhen(from, (fresh) => fresh.filter((entry) => entry.event === "char").length === 3),
  ])
  assert.equal(typing.fault?.outcome, "unknown", JSON.stringify(typing))
  assert.equal(typing.fault.code, "driver-exited")
  const afterTyping = await run(`${handles}
let blocked; try { await w.pressKey('x') } catch(e) { blocked=e.code }
return {blocked,field:(await w.observe()).get({role:'TextField',name:'Name'}).value};`)
  assert.deepEqual(afterTyping, { blocked: "observation-required", field: "hel" })
  all = await entries()
  assert.equal(all.slice(from).filter((entry) => entry.event === "char").length, 3, "Partial typing is not resumed or replayed")

  // 3. A read that dies does not clear the barrier left by an unknown action.
  from = (await entries()).length
  const [unknownAgain] = await Promise.all([
    run(`${handles}
try { await w.pressKey('c'); return {fault:null} } catch(e) { return {fault:fault(e)} }`),
    killWhen(from, (fresh) => fresh.some((entry) => entry.event === "down" && entry.value === "c")),
  ])
  assert.equal(unknownAgain.fault?.outcome, "unknown")
  await writeFile(holdRead, "")
  from = (await entries()).length
  const [deadRead] = await Promise.all([
    run(`${handles}
try { await w.observe(); return {fault:null} } catch(e) { return {fault:fault(e)} }`),
    killWhen(from, (fresh) => fresh.some((entry) => entry.event === "read-start")),
  ])
  await unlink(holdRead)
  assert.equal(deadRead.fault?.code, "driver-exited", JSON.stringify(deadRead))
  assert.match(deadRead.fault.message, /No view was returned/)
  const afterRead = await run(`${handles}
let blocked; try { await w.pressKey('d') } catch(e) { blocked=e.code }
await w.observe(); await w.pressKey('d');
return {blocked};`)
  assert.equal(afterRead.blocked, "observation-required", "A failed read cannot authorize input")
  all = await entries()
  assert.equal(downs(all, "42:7", "c").length, 1)
  assert.equal(downs(all, "42:7", "d").length, 1)

  // 4. Actions queued behind the one that dies: a program's control calls run
  // in order, so neither was dispatched. Another app's input proceeds on the
  // new driver; the affected window's input is refused.
  from = (await entries()).length
  const [queued] = await Promise.all([
    run(`${handles}
await w.observe();
const results=await Promise.allSettled([w.pressKey('e'), neighbour.pressKey('f'), w.pressKey('k')]);
state.queuedMessages=results.map((result)=>result.reason?.message);
return results.map((result)=>result.status==='rejected'?[result.reason.code,result.reason.outcome]:'fulfilled');`),
    killWhen(from, (fresh) => fresh.some((entry) => entry.event === "down" && entry.value === "e")),
  ])
  assert.deepEqual(
    queued,
    [["driver-exited", "unknown"], "fulfilled", ["observation-required", "not-dispatched"]],
    JSON.stringify(await run("return state.queuedMessages"))
  )
  all = await entries()
  const killedAt = all.findIndex((entry) => entry.event === "down" && entry.value === "e")
  const neighbourKey = all.findIndex((entry) => entry.event === "down" && entry.value === "f")
  assert.ok(neighbourKey > killedAt && all[neighbourKey]!.pid !== all[killedAt]!.pid, "The queued key went to the new driver")
  assert.equal(downs(all, "42:7", "e").length, 1)
  assert.equal(downs(all, "42:7", "k").length, 0)

  // 5. Unscoped input: the task-level barrier outlives the driver.
  from = (await entries()).length
  const [unscoped] = await Promise.all([
    run(`${handles}
await w.observe();
try { await control.native('press_key',{key:'q'}); return {fault:null} } catch(e) { return {fault:fault(e)} }`),
    killWhen(from, (fresh) => fresh.some((entry) => entry.event === "down" && entry.value === "q")),
  ])
  assert.deepEqual([unscoped.fault?.code, unscoped.fault?.outcome], ["driver-exited", "unknown"])
  const afterUnscoped = await run(`const unseen=control.window({pid:44,window_id:1});
let blocked; try { await unseen.pressKey('h') } catch(e) { blocked=e.code }
await unseen.observe(); await unseen.pressKey('h');
return {blocked};`)
  assert.equal(afterUnscoped.blocked, "observation-required")
  all = await entries()
  assert.equal(downs(all, "unscoped", "q").length, 1)
  assert.equal(downs(all, "44:1", "h").length, 1)
  assert.equal(spawns, 7, "Each kill led to exactly one reconnect")
  console.log(`PASS native driver death: ${spawns - 1} kills mid-action, no replay, unrelated targets usable`)
} finally {
  await server.close()
  await rm(root, { recursive: true, force: true })
}
