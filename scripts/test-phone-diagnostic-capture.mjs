import vm from "node:vm"
import { createHash, randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import { tmpdir, constants as osConstants } from "node:os"
import { dirname, join, resolve, parse } from "node:path"
import { execFileSync } from "node:child_process"
import net from "node:net"
import { capture } from "./phone-diagnostic-capture.mjs"

// Fake producer only: no Electron, browser, fixture server, provider, profile or network request.
const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "mako-phone-capture-controls-"))
const results = [], groups = new Set()
const childSource = `
import * as fs from 'node:fs'; import {join} from 'node:path'; import {spawn} from 'node:child_process';
const mode=process.env.FAKE_MODE, input=process.env.MAKO_TEST_EVIDENCE, dir=join(input,'phone-scroll-ui');
fs.mkdirSync(dir,{recursive:true});
const name=mode==='long-name'?'flick-diagnostic-'+'1'.repeat(200)+'-1234-abc.json':'flick-diagnostic-'+process.pid+'-1234-abc.json', path=join(dir,name);
const attempts=['setup','cleanup','readback','write'].map(name=>({name,status:'completed'}));
const packet={mode:'instrumented diagnostic; not normative performance acceptance',status:'completed',attempts:attempts.slice(0,-1),oracle:{status:'passed-instrumented-only',tasks:[]},tracing:'removed-not-requested',screenshot:'removed-not-requested',budgets:{operationMs:1000,captureMs:15000,rendererBytes:16384,fileBytes:65536,files:1,traceBytes:0,screenshots:0,statusBytes:4096},primaryThrown:false,disposition:'continue-original-test',renderer:{status:'active',cleanup:'completed'}};
const initial={status:'requested',oracle:'not-run',attempts:[],file:name};
const status={status:'completed',oracle:packet.oracle.status,attempts,file:name,disposition:packet.disposition};
if(mode==='unknown-write'){status.status='diagnostic-unavailable';status.disposition='abort-before-next-scope';status.attempts.at(-1).status='timed-out'}
if(mode==='missing-ack'){status.attempts.at(-1).status='requested'}
if(mode==='bad-order'){status.attempts[1].name='readback';status.attempts[2].name='cleanup'}
if(mode==='bad-status'){status.oracle='invented-pass'}
if(mode==='utf8-line'){status.note='汉'.repeat(1500)}
if(mode==='escape'){status.file='../escape.json'}
if(mode==='long-name'){status.file='flick-diagnostic-'+'1'.repeat(200)+'-1234-abc.json'}
if(mode==='bad-packet'){packet.oracle.status='not-run'}
let bytes=Buffer.from(JSON.stringify(packet));
if(mode==='max-size')bytes=Buffer.concat([bytes,Buffer.alloc(65536-bytes.length,32)]);
if(mode==='oversize')bytes=Buffer.concat([bytes,Buffer.alloc(65537-bytes.length,32)]);
if(mode==='partial')bytes=Buffer.from('{"partial":');
if(mode!=='absent')fs.writeFileSync(path,bytes);
fs.writeFileSync(join(dir,'screenshot.png'),'DO NOT STAGE');fs.mkdirSync(join(dir,'profile'));fs.writeFileSync(join(dir,'profile','private'),'DO NOT STAGE');
if(mode==='inventory')for(let n=0;n<65;n++)fs.writeFileSync(join(dir,'extra-'+n),'x');
if(mode==='multiple')fs.writeFileSync(join(dir,'flick-diagnostic-999-1234-def.json'),bytes);
if(mode==='symlink'){fs.renameSync(path,join(input,'target.json'));fs.symlinkSync(join(input,'target.json'),path)}
if(mode==='hardlink')fs.linkSync(path,join(input,'linked.json'));
if(mode==='parent-link'){fs.renameSync(dir,join(input,'elsewhere'));fs.symlinkSync(join(input,'elsewhere'),dir)}
if(mode==='fifo'){fs.unlinkSync(path);const {execFileSync}=await import('node:child_process');execFileSync('mkfifo',[path])}
console.log('FLICK_DIAGNOSTIC_STATUS '+JSON.stringify(initial));
if(mode==='overflow')process.stdout.write(('x'.repeat(100)+'\\n').repeat(2600));
if(mode==='long-line')process.stdout.write('x'.repeat(4097)+'\\n');
if(mode==='split-status'){const final='FLICK_DIAGNOSTIC_STATUS '+JSON.stringify(status)+'\\n';process.stdout.write(final.slice(0,31));await new Promise(done=>setTimeout(done,10));process.stdout.write(final.slice(31))}
else if(mode!=='missing-status')process.stdout.write('FLICK_DIAGNOSTIC_STATUS '+JSON.stringify(status)+(mode==='partial-status'?'':'\\n'));
if(mode==='extra-status')console.log('FLICK_DIAGNOSTIC_STATUS '+JSON.stringify(status));
if(mode==='late-write')fs.writeFileSync(path,'{partial');
if(mode==='late-write'||mode==='completed-late-write'){
 const producer=spawn(process.execPath,['--input-type=module','-e',"import fs from 'node:fs';setTimeout(()=>fs.writeFileSync(process.argv[1],process.argv[2]),150);setInterval(()=>{},1000)",path,JSON.stringify(packet)],{stdio:'ignore'});
 fs.writeFileSync(join(input,'late-pid'),String(producer.pid));process.exit(Number(process.env.FAKE_EXIT||0));
}
if(mode==='hang'||mode==='resist'){if(mode==='resist')process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}
else if(mode==='signal')process.kill(process.pid,'SIGTERM');
else process.exit(Number(process.env.FAKE_EXIT||0));
`
const identity = { commit: "c".repeat(40), tree: "d".repeat(40), phoneSha256: "89384447ba8f900f6755fc76175876c83b427b52daea68d85b8ad3588696d95e", node: process.versions.node, electron: "fake-not-executed" }
function actualMembers(group) {
  const table = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 1000, maxBuffer: 1048576 })
  return table.split("\n").filter(line => { const [, pgid, state] = line.trim().split(/\s+/); return Number(pgid) === group && state && !state.startsWith("Z") })
}
async function run(mode, { code = 0, expected, publicationFault, longIdentity = false, unknown = false, abort = false, missingCommand = false } = {}) {
  const parent = fs.mkdtempSync(join(root, "case-")), upload = join(parent, "upload")
  let timer
  const controller = new AbortController()
  if (abort) timer = setTimeout(() => controller.abort("SIGTERM"), 150)
  const result = await capture({ parent, upload, cwd: process.cwd(), identity: longIdentity ? { ...identity, tooLong: "x".repeat(4097) } : identity,
    command: missingCommand ? join(root,"not-an-executable") : process.execPath, args: ["--input-type=module", "-e", childSource], env: { ...process.env, FAKE_MODE: mode, FAKE_EXIT: String(code) },
    limits: { runMs: ["hang", "resist"].includes(mode) ? 250 : 2000, termMs: 100, killMs: 300 }, abort: controller.signal,
    inspectGroup: unknown ? () => { throw Error("planted process inspection unavailable") } : undefined,
    writeManifest: publicationFault ? (path, bytes, options) => { if (publicationFault === "partial") fs.writeFileSync(path, bytes.subarray(0, 10), options); else if (publicationFault === "oversize") { fs.writeFileSync(path, Buffer.alloc(65537), options); return } else if (publicationFault === "link") { const target = join(parent,"other");fs.writeFileSync(target,bytes);fs.symlinkSync(target,path);return } throw Error("planted manifest failure") } : undefined,
  })
  clearTimeout(timer)
  if(result.manifest.test?.group)groups.add(result.manifest.test.group)
  assert.equal(result.exit, expected, mode+" exit")
  assert.equal(result.manifest.invocations, 1)
  if (code) assert.equal(result.manifest.test.code, code)
  if (mode === "signal") assert.equal(result.manifest.test.signal, "SIGTERM")
  if (["hang", "resist"].includes(mode)) assert.equal(result.manifest.test.timeout, !abort)
  if (abort) assert.equal(result.manifest.test.cancelled, "SIGTERM")
  if (mode === "resist") assert.equal(result.manifest.test.signal,"SIGKILL","TERM-resistant owned group must reach KILL")
  assert.equal(actualMembers(result.manifest.test.group).length, 0, "real owned process group is empty before test removes input")
  if (unknown) assert.equal(result.manifest.test.cleanup,"unknown")
  else assert.equal(result.manifest.test.cleanup,"group-empty")
  if (publicationFault || longIdentity) { assert.equal(result.published,false);assert.equal(fs.existsSync(upload),false) }
  else {
    assert.equal(result.published,true)
    const names=fs.readdirSync(upload).sort()
    assert.deepEqual(names,result.manifest.validation==="validated"?["manifest.json","packet.json"]:["manifest.json"])
    const bytes=fs.readFileSync(join(upload,"manifest.json"));assert.ok(bytes.length<=4096)
    const manifest=JSON.parse(bytes);assert.equal(manifest.test.code,result.manifest.test.code);assert.equal(manifest.exit,expected)
    if(names.includes("packet.json")){assert.ok(fs.statSync(join(upload,"packet.json")).size<=65536);assert.equal(fs.lstatSync(join(upload,"packet.json")).isSymbolicLink(),false)}
  }
  assert.ok(Buffer.byteLength(result.summary)<=1024)
  if(mode==='absent')assert.equal(result.manifest.captureStatus.channel,'stdout observation; file integrity validated separately')
  if(mode==='unknown-write'){assert.equal(result.manifest.captureStatus.attempts.at(-1).status,'timed-out');assert.equal(result.manifest.validation,'unavailable')}
  if(mode==='late-write')assert.equal(result.manifest.test.cleanup,'group-empty')
  results.push({mode,code,generation:result.manifest.generation,exit:result.exit,validation:result.manifest.validation,published:result.published,publicationFault,cleanup:result.manifest.test.cleanup,signal:result.manifest.test.signal,timeout:result.manifest.test.timeout,error:result.manifest.error,publicationError:result.publicationError})
}

async function sourceControls() {
  const source=fs.readFileSync(new URL("./test-phone-scroll-ui.mjs",import.meta.url),"utf8")
  assert.equal(createHash("sha256").update(source).digest("hex"),identity.phoneSha256)
  const payload=source.split('const FLICK_DIAGNOSTIC = `')[1].split('`\n\n')[0]
  const block=source.slice(source.indexOf('    // 3. A flick up glides'),source.indexOf('    // 4. Back at the end'))
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
  const execute=new AsyncFunction('assert','toEnd','now','flick','rest','fromEnd','longTasks','holds','evaluate','writeFile','join','evidence','process','FLICK_DIAGNOSTIC','console','setTimeout','clearTimeout','let since,held;'+block)
  const never=()=>new Promise(()=>{})
  for(const fault of ['setup','write'])for(const primary of [new Error('original'),null,undefined,0]){
    let flicks=0, caught=false, thrown
    try{await execute(assert,async()=>{},async()=>100,async()=>{flicks++;throw primary},async()=>{},async()=>1000,async()=>[68],async()=>({worst:0}),async code=>{
      if(code.includes('RequestDeadline='))return fault==='setup'?never():true
      return code.includes('__readFlickDiagnostic')?'{"status":"active","cleanup":"completed"}':true
    },fault==='write'?never:async()=>{},join,'/not-written',{pid:1,env:{MAKO_FLICK_DIAGNOSTICS:'1'}},payload,{log(){}},fn=>setTimeout(fn,5),clearTimeout)}catch(value){caught=true;thrown=value}
    assert.equal(caught,true)
    if(fault==='setup'){assert.equal(flicks,0);assert.equal(thrown.code,'FLICK_DIAGNOSTIC_UNAVAILABLE')}
    else{assert.equal(flicks,1);assert.equal(thrown,primary)}
  }
  for(const partial of [false,true]){
    const observers=[]
    class Observer{
      static supportedEntryTypes=['longtask','long-animation-frame']
      constructor(){this.active=false;this.queued=[];this.takes=0;observers.push(this)}
      observe({type}){if(partial&&type==='long-animation-frame')throw Error('partial');this.active=true}
      takeRecords(){this.takes++;return this.queued}
      disconnect(){this.active=false;this.queued=[]}
    }
    const context=vm.createContext({window:{},PerformanceObserver:Observer,performance:{now:()=>100,timeOrigin:0}})
    vm.runInContext(payload,context,{timeout:1000})
    if(!partial){observers[0].queued.push({startTime:100,duration:68,name:'self',attribution:[]});context.window.__finishFlickDiagnostic();assert.equal(context.window.__flickDiagnosticResult.tasks[0].ms,68)}
    assert.equal(observers.filter(each=>each.active).length,0)
    assert.equal(observers.reduce((n,each)=>n+each.takes,0),2)
    assert.equal(context.window.__finishFlickDiagnostic(),true)
  }
  results.push({mode:'cleared-source-lifecycle',asyncCases:8,collectorCases:2,sourceSha256:identity.phoneSha256})
}


async function captureInvariants() {
  const source=fs.readFileSync(new URL("./phone-diagnostic-capture.mjs",import.meta.url),"utf8")
  const body=source.slice(source.indexOf('\nconst SOURCE_SHA'),source.indexOf('\nif (process.argv[1]')).replace('export async function capture','async function capture')
  const context=vm.createContext({fs,osConstants,createHash,randomUUID,dirname,join,resolve,parse,process,Buffer,setTimeout,clearTimeout,console,
    spawn:()=>{throw Error("No child allowed in pure invariant controls")},execFileSync:()=>{throw Error("No OS query allowed in pure invariant controls")},net:{}})
  vm.runInContext(body,context,{timeout:1000})
  context.portFree=async()=>{}
  const passed='passed-instrumented-only'
  const cases=[
    {label:'zero/pass',oracle:passed,code:0,exit:0},
    {label:'zero/not-run',oracle:'not-run',code:0,exit:70,unavailable:true},
    {label:'zero/threw',oracle:'threw',code:0,exit:70,unavailable:true},
    {label:'zero/wrong-disposition',oracle:passed,disposition:'abort-before-next-scope',code:0,exit:70,unavailable:true},
    {label:'zero/unavailable-packet',oracle:passed,packetStatus:'diagnostic-unavailable',code:0,exit:70,unavailable:true},
    {label:'zero/write-unknown',oracle:passed,writeUnknown:true,code:0,exit:70,unavailable:true},
    {label:'known-nonzero/threw',oracle:'threw',code:7,exit:7},
    {label:'later-failure-after-pass',oracle:passed,code:7,exit:7},
    {label:'known-nonzero/invalid-packet',oracle:passed,packetOracle:'not-run',code:7,exit:7,unavailable:true},
    {label:'signal/threw',oracle:'threw',code:null,signal:'SIGTERM',exit:143},
    {label:'deadline-preserved',oracle:passed,code:0,timeout:true,exit:124},
    {label:'cancellation-preserved',oracle:passed,code:0,cancelled:'SIGTERM',exit:143},
  ]
  for(const each of cases){
    const attempts=['setup','cleanup','readback','write'].map(name=>({name,status:'completed'})),file='flick-diagnostic-123-1234-abc.json'
    const disposition=each.disposition??(each.oracle==='threw'?'throw-original':'continue-original-test')
    const status={status:'completed',oracle:each.oracle,disposition,file,attempts}
    const packet={mode:'instrumented diagnostic; not normative performance acceptance',tracing:'removed-not-requested',screenshot:'removed-not-requested',status:each.packetStatus??'completed',
      oracle:{status:each.packetOracle??each.oracle},primaryThrown:each.oracle==='threw',disposition,attempts:attempts.slice(0,3),renderer:{status:'active',cleanup:'completed'},
      budgets:{operationMs:1000,captureMs:15000,rendererBytes:16384,fileBytes:65536,files:1,traceBytes:0,screenshots:0,statusBytes:4096}}
    if(each.writeUnknown){status.status='diagnostic-unavailable';status.disposition='abort-before-next-scope';attempts[3].status='timed-out'}
    context.childOnce=async(command,args,options)=>{
      const directory=join(options.env.MAKO_TEST_EVIDENCE,'phone-scroll-ui');fs.mkdirSync(directory);fs.writeFileSync(join(directory,file),JSON.stringify(packet))
      return {code:each.code,signal:each.signal??null,timeout:!!each.timeout,cancelled:each.cancelled??null,exited:true,cleanup:'group-empty',pipesClosed:true,group:null,stderrBytes:0,
        output:{total:1000,overflow:false,invalid:false,statusCount:2,initial:{status:'requested',oracle:'not-run',file,attempts:[]},final:status}}
    }
    const parent=fs.mkdtempSync(join(root,'pure-')),upload=join(parent,'upload'),result=await context.capture({parent,upload,cwd:parent,identity:{test:'pure invariant'}})
    assert.equal(result.exit,each.exit,each.label)
    assert.equal(result.manifest.validation,each.unavailable?'unavailable':'validated',each.label)
    assert.equal(result.published,true)
    assert.deepEqual(fs.readdirSync(upload).sort(),each.unavailable?['manifest.json']:['manifest.json','packet.json'])
    assert.equal(JSON.parse(fs.readFileSync(join(upload,'manifest.json'))).test.code,each.code)
    results.push({mode:'capture-invariant',label:each.label,exit:result.exit,validation:result.manifest.validation,published:result.published,packetStaged:!each.unavailable})
  }
}

try {
  await captureInvariants()
  if(!process.argv.includes("--capture-invariants")){
  await sourceControls()
  await run("normal",{expected:0})
  await run("normal",{missingCommand:true,expected:127})
  await run("normal",{code:7,expected:7})
  await run("signal",{expected:143})
  await run("hang",{expected:124})
  await run("resist",{expected:124})
  await run("hang",{abort:true,expected:143})
  await run("late-write",{expected:70})
  await run("late-write",{code:14,expected:14})
  await run("completed-late-write",{expected:0})
  await run("max-size",{expected:0})
  await run("split-status",{expected:0})
  await run("unknown-write",{expected:70})
  for(const mode of ["absent","oversize","inventory","multiple","symlink","parent-link","hardlink","fifo","partial","bad-packet","escape","long-name","bad-status","missing-ack","bad-order","missing-status","partial-status","extra-status","overflow","long-line","utf8-line"]){
    await run(mode,{expected:70});await run(mode,{code:9,expected:9})
  }
  for(const fault of ["throw","partial","oversize","link"]){await run("normal",{publicationFault:fault,expected:70});await run("normal",{publicationFault:fault,code:11,expected:11})}
  await run("normal",{longIdentity:true,expected:70});await run("normal",{longIdentity:true,code:12,expected:12})
  await run("normal",{unknown:true,expected:70});await run("normal",{unknown:true,code:13,expected:13})
  // Preflight rejects an occupied own port, a symlink parent, an escaping destination and a dangling upload link. Zero invocations.
  const occupied = net.createServer();await new Promise(done=>occupied.listen(21333,"127.0.0.1",done))
  const parent=fs.mkdtempSync(join(root,"preflight-"));
  // Even a broken preflight guard must only launch the fake producer, never the real phone command.
  const safePreflight={command:process.execPath,args:["--input-type=module","-e",childSource],env:{...process.env,FAKE_MODE:"normal"}}
  try {const r=await capture({parent,upload:join(parent,"upload"),identity,cwd:process.cwd(),...safePreflight});assert.equal(r.manifest.invocations,0);assert.equal(r.exit,70);results.push({mode:"occupied-port",exit:r.exit,invocations:0})}finally{await new Promise(done=>occupied.close(done))}
  const link=join(root,"parent-link");fs.symlinkSync(parent,link)
  const dangling=join(parent,"dangling");fs.symlinkSync(join(parent,"missing"),dangling)
  for(const [label,base,upload] of [["parent-link",link,join(link,"upload2")],["path-escape",parent,resolve(parent,"../escape")],["dangling-upload",parent,dangling]]){
    const r=await capture({parent:base,upload,identity,cwd:process.cwd(),...safePreflight});assert.equal(r.manifest.invocations,0);assert.equal(r.published,false);assert.equal(r.exit,70);results.push({mode:label,exit:r.exit,invocations:0})
  }
  }
  const output={kind:"real fake-child/temp-file controls; no GUI/provider/CI",adapterSha256:createHash("sha256").update(fs.readFileSync(new URL("./phone-diagnostic-capture.mjs",import.meta.url))).digest("hex"),cases:results}
  if(process.env.MAKO_CAPTURE_CONTROL_RECEIPT)fs.writeFileSync(process.env.MAKO_CAPTURE_CONTROL_RECEIPT,JSON.stringify(output,null,2))
  console.log(`PASS: ${results.length} bounded phone capture controls; no GUI or real phone invocation`)
} finally {
  // Never race removal with a producer whose group is still live or unknown, even when a control fails.
  let clean=true
  for(const group of groups)try{if(actualMembers(group).length)clean=false}catch{clean=false}
  if(clean)fs.rmSync(root,{recursive:true,force:true})
  else console.error(`Fixture cleanup UNKNOWN; retained ${root}`)
}
