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

// Types `text` one character per 150 ms; "*" repeats forever.
const typist = `
const [app, log, key, text] = process.argv.slice(1);
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
let index = 0;
const step = () => {
  const forever = text === '*';
  if (!forever && index >= text.length) return;
  const state = JSON.parse(readFileSync(app, 'utf8'));
  state[key] = forever ? String(index) : text.slice(0, index + 1);
  writeFileSync(app, JSON.stringify(state));
  appendFileSync(log, JSON.stringify({ pid: process.pid, event: 'char', key, index }) + '\\n');
  index++;
  setTimeout(step, 150);
};
step();
`
const driver = `
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const LOG=${JSON.stringify(log)}, APP=${JSON.stringify(app)}, HOLD=${JSON.stringify(holdRead)}, TYPIST=${JSON.stringify(typist)};
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
  if(name==='set_value' && args.value.startsWith('~')){
    // Like the driver's daemon: the typing runs in another process that
    // outlives this one. The reply never comes.
    const key=tokens.get(args.element_token);
    const typist=spawn(process.execPath,['-e',TYPIST,APP,LOG,key,args.value.slice(1)],{detached:true,stdio:'ignore'});
    typist.unref();
    note({event:'typist',key,typist:typist.pid});
    await new Promise(()=>{});
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
  typist: z.number().optional(),
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
      const pid = all.findLast((entry) => entry.event === "start")!.pid
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
let failNextStart = false
const server = controlSessionProbe(
  { command: process.execPath, args: ["--input-type=module", "--eval", driver] },
  "driver-death",
  async (process) => {
    if (failNextStart) {
      failNextStart = false
      throw new Error("fixture driver failed to start")
    }
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
        pageValue = "text" in command ? String(command.text) : String(z.object({ value: z.unknown() }).parse(command).value)
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

  // 6. The replacement driver fails to start: the queued input was never sent,
  // so it is not-dispatched and leaves its window usable.
  from = (await entries()).length
  const [restart] = await Promise.all([
    run(`${handles}
await w.observe(); await neighbour.observe();
const results=await Promise.allSettled([w.pressKey('m'), neighbour.pressKey('n')]);
return results.map((result)=>result.status==='rejected'?{code:result.reason.code,outcome:result.reason.outcome,message:result.reason.message}:'fulfilled');`),
    killWhen(from, (fresh) => {
      const ready = fresh.some((entry) => entry.event === "down" && entry.value === "m")
      if (ready) failNextStart = true
      return ready
    }),
  ])
  assert.deepEqual(restart.map((fault: { code: string; outcome: string }) => [fault.code, fault.outcome]), [
    ["driver-exited", "unknown"],
    ["driver-unavailable", "not-dispatched"],
  ])
  assert.match(restart[1].message, /could not start \(fixture driver failed to start\)\. Nothing was dispatched/)
  const afterRestart = await run(`${handles}
await neighbour.pressKey('n');
return {sent:true};`)
  assert.deepEqual(afterRestart, { sent: true }, "A start failure does not block the window")
  all = await entries()
  assert.equal(downs(all, "43:9", "n").length, 1)

  // 7. A native refusal before any driver call is not-dispatched and leaves the
  // window usable, like a start failure.
  const refused = await run(`${handles}
const ref=(await w.observe()).get({role:'TextField',name:'Name'}).ref;
let refusal; try { await w.click(ref,{count:3}) } catch(e) { refusal=[e.code,e.outcome] }
await w.pressKey('p');
return {refusal};`)
  assert.deepEqual(refused.refusal, ["native-preflight-failed", "not-dispatched"])
  assert.equal(downs(await entries(), "42:7", "p").length, 1)

  // 8. The input outlives the driver process, as the real daemon's typing
  // did. Recovery must wait for it to finish, not return a half-typed view.
  const typists: number[] = []
  const typistOf = (fresh: Entry[]) => {
    const started = fresh.find((entry) => entry.event === "typist")?.typist
    if (started && !typists.includes(started)) typists.push(started)
  }
  from = (await entries()).length
  const orphanText = "orphaned input"
  const [orphan] = await Promise.all([
    run(`${handles}
const ref=(await w.observe()).get({role:'TextField',name:'Name'}).ref;
try { await w.setValue(ref,${JSON.stringify("~" + orphanText)}); return {fault:null} } catch(e) { return {fault:fault(e)} }`),
    killWhen(from, (fresh) => {
      typistOf(fresh)
      return fresh.filter((entry) => entry.event === "char").length === 3
    }),
  ])
  assert.deepEqual([orphan.fault?.code, orphan.fault?.outcome], ["driver-exited", "unknown"])
  const settleStart = Date.now()
  const settled = await run(`${handles}
let blocked; try { await w.pressKey('x') } catch(e) { blocked=e.code }
const view=await w.observe();
await w.pressKey('s');
return {blocked,field:view.get({role:'TextField',name:'Name'}).value};`)
  assert.equal(settled.blocked, "observation-required")
  assert.equal(settled.field, orphanText, "The recovering observation waits for input still landing")
  assert.ok(Date.now() - settleStart >= 600, "Settling took at least two reads")
  assert.equal(downs(await entries(), "42:7", "s").length, 1, "A settled window accepts input")

  // 9. Input that never settles: observation refuses rather than handing back
  // a view of a window that is still changing.
  from = (await entries()).length
  const [endless] = await Promise.all([
    run(`${handles}
const ref=(await w.observe()).get({role:'TextField',name:'Name'}).ref;
try { await w.setValue(ref,'~*'); return {fault:null} } catch(e) { return {fault:fault(e)} }`),
    killWhen(from, (fresh) => {
      typistOf(fresh)
      return fresh.some((entry) => entry.event === "char")
    }),
  ])
  assert.equal(endless.fault?.code, "driver-exited")
  const unsettled = await run(`${handles}
let observed; try { await w.observe(); observed='settled' } catch(e) { observed=[e.code,e.outcome] }
let blocked; try { await w.pressKey('y') } catch(e) { blocked=e.code }
return {observed,blocked};`)
  assert.deepEqual(unsettled, { observed: ["target-unsettled", "rejected"], blocked: "observation-required" })
  for (const pid of typists)
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  typists.length = 0
  const recoveredLater = await run(`${handles}
await new Promise((resolve)=>setTimeout(resolve,300));
await w.observe(); await w.pressKey('t');
return {ok:true};`)
  assert.deepEqual(recoveredLater, { ok: true })
  assert.equal(downs(await entries(), "42:7", "y").length, 0)
  console.log(`PASS native driver death: ${spawns - 1} kills mid-action, no replay, unrelated targets usable`)
} finally {
  for (const { typist } of await entries())
    if (typist)
      try {
        process.kill(typist, "SIGKILL")
      } catch {}
  await server.close()
  await rm(root, { recursive: true, force: true })
}
