import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { once } from "node:events"
import { createRequire } from "node:module"
import { createServer } from "vite"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import { runtimeInfo, invokeRuntime } from "../dist-electron/runtime-connection.js"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { spawnHost } from "./lib/host-launch.mjs"

const root = await mkdtemp(join(tmpdir(), "mako-shared-runtime-"))
const dataRoot = join(root, "host-data")
const workspace = join(root, "workspace")
await mkdir(workspace)
const location = runtimeLocation(dataRoot)
await mkdir(location.directory, {recursive:true,mode:0o700})
const server = await createServer({cacheDir:join(root,"vite"),plugins:[manualDevUpdates()],define:{"import.meta.env.MAKO_MANUAL_RELOAD":"true"},server:{host:"127.0.0.1",port:0}})
await server.listen()
const url = server.resolvedUrls.local[0]
const executable = createRequire(import.meta.url)("electron")
const transportOnly = process.argv.includes("--transport-only")
// The transport check starts no provider, so it needs nothing of the person's: a scratch home keeps every keychain item out of reach.
const home = transportOnly ? join(root, "home") : homedir()
if (transportOnly) await mkdir(home)
const env = {...process.env, HOME:home, MAKO_DATA_ROOT:dataRoot, VITE_DEV_SERVER_URL:url}
for (const key of ["ELECTRON_RUN_AS_NODE","MAKO_PROFILE","MAKO_PROD","MAKO_WEB_SOCKET"]) delete env[key]
const processes = []
const connectId=randomUUID()
const call=(channel,...args)=>invokeRuntime(location.socket,connectId,channel,args)
const until=async(read,predicate,label)=>{
  const end=Date.now()+90_000
  while(Date.now()<end){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,50))}
  throw new Error(`Timed out: ${label}`)
}
const track=(child)=>{
  processes.push(child)
  child.stdout.on("data",chunk=>{if(process.env.MAKO_TEST_TRACE)process.stdout.write(chunk)})
  child.stderr.on("data",chunk=>{if(process.env.MAKO_TEST_TRACE)process.stderr.write(chunk)})
  return child
}
const launch=(args,extra)=>track(spawn(executable,args,{env:{...env,...extra},stdio:["ignore","pipe","pipe"]}))
async function client(name, production = false) {
  const child=launch([resolve("."),"--background","--remote-debugging-port=0",...(transportOnly?["--use-mock-keychain"]:[])],{MAKO_CLIENT_ID:name,MAKO_PROD:production?"1":""})
  let port
  child.stderr.on("data",chunk=>{const match=chunk.toString().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(match)port=Number(match[1])})
  await until(async()=>port,Boolean,`${name} debugger`)
  // A production client's first page is the one-time storage bridge on the old
  // origin; its debugger target ends when the desk replaces it.
  const desk=row=>row.type==="page"&&new URL(row.url).searchParams.get("runtime")==="shared"
  const pages=await until(async()=>fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()),rows=>rows.some(desk),`${name} page`)
  const socket=new WebSocket(pages.find(desk).webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject})
  let sequence=0
  const pending=new Map()
  socket.onmessage=event=>{
    const message=JSON.parse(event.data)
    if(message.method === 'Runtime.exceptionThrown') console.error(name, message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    if(message.method === 'Network.loadingFailed') console.error(name, message.params.errorText)
    const held=pending.get(message.id)
    if(!held)return
    pending.delete(message.id)
    clearTimeout(held.timer)
    if(message.error)held.reject(new Error(message.error.message));else held.resolve(message.result)
  }
  socket.onclose=()=>{for(const held of pending.values()){clearTimeout(held.timer);held.reject(new Error('Client debugger disconnected'))}pending.clear()}
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Client ${name}: ${method} timed out`))},180_000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async(expression)=>{
    const response=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true})
    if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text)
    return response.result.value
  }
  await send('Runtime.enable')
  await send('Network.enable')
  await until(()=>evaluate("Boolean(window.mako)").catch(()=>false),Boolean,`${name} bridge`)
  try {
    await until(()=>evaluate("Boolean(document.querySelector('.composer-input:not([readonly])'))").catch(()=>false),Boolean,`${name} boot`)
  } catch (error) {
    const image=await send("Page.captureScreenshot",{format:"png"})
    await writeFile(join(root,`${name}-boot-failure.png`),Buffer.from(image.data,"base64"))
    throw error
  }
  /** `across` is where to press along the element, from its left edge: the middle unless asked. */
  const click=async(selector,across=0.5)=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
    // The rail reorders as the person's other agents work, so press only where the element itself is hit,
    // after hovering there: a row reveals its controls only under the pointer.
    const frames=`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`
    const point=await until(async()=>{
      await evaluate(frames)
      const at=await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing element');const r=node.getBoundingClientRect();return{x:r.x+r.width*${across},y:r.y+r.height/2}})()`)
      await send("Input.dispatchMouseEvent",{type:"mouseMoved",...at})
      await evaluate(frames)
      return await evaluate(`document.querySelector(${JSON.stringify(selector)})?.contains(document.elementFromPoint(${at.x},${at.y}))`)?at:null
    },Boolean,`${selector} under the pointer`)
    await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point})
    await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point})
  }
  // A row can still move between that check and the press; it's open once it's the lit row.
  const openRow=async(selector)=>{
    for(let attempt=1;;attempt++){
      // Over the title: a hovered row's controls cover its right half.
      await click(selector,0.2)
      const lit=`Boolean(document.querySelector(${JSON.stringify(`${selector}[data-active]`)}))`
      const end=Date.now()+2_000
      while(Date.now()<end){if(await evaluate(lit))return;await new Promise(resolve=>setTimeout(resolve,50))}
      if(attempt===5){await capture(`${name}-open-row-failure.png`);throw new Error(`${selector} did not open`)}
    }
  }
  const capture=async(name)=>{const image=await send("Page.captureScreenshot",{format:"png"});await writeFile(join(root,name),Buffer.from(image.data,"base64"))}
  const close=async()=>{socket.close();if(child.exitCode===null){child.kill("SIGTERM");await once(child,"exit",{signal:AbortSignal.timeout(30_000)}).catch(()=>{throw new Error(`Client ${name} did not exit on SIGTERM`)})}}
  return {child,send,evaluate,click,openRow,capture,close}
}
let conversation
try {
  const host=track(spawnHost({...env,MAKO_WEB_SOCKET:location.socket},{stdio:["ignore","pipe","pipe"]}))
  console.log(`Starting isolated host ${host.pid}; evidence ${root}`)
  const info=await until(()=>runtimeInfo(location.socket),Boolean,"shared host")
  assert.equal(info.pid,host.pid)
  console.log("Shared host is ready")
  const a=await client("client-a")
  const b=await client("client-b", true)
  assert.notEqual(a.child.pid,b.child.pid)
  for (const page of [a, b]) {
    const failure = await page.evaluate(`window.mako.liveStart('transport-fixture',${JSON.stringify(workspace)},{conversationId:${JSON.stringify(randomUUID())},threadPath:undefined,displayPrompt:undefined,modeId:undefined,tuning:{model:undefined,options:undefined},initialRequest:undefined}).then(()=>null,error=>error.message)`)
    assert.match(failure, /transport-fixture has no available interactive transport/, "Valid optional fields must reach the shared host from each Electron client")
  }
  if (transportOnly) {
    await a.close()
    await b.close()
    console.log("PASS: development and production-renderer Electron clients forward live-start options with undefined fields to the shared host; no provider was started")
  } else {
  const cwdB=join(root,"other-workspace")
  await mkdir(cwdB)
  await a.evaluate(`window.mako.setCwd(${JSON.stringify(workspace)})`)
  await b.evaluate(`window.mako.setCwd(${JSON.stringify(cwdB)})`)
  assert.equal(await a.evaluate("window.mako.boot().then(boot=>boot.tabs.find(tab=>tab.id===boot.activeTabId).session.meta.cwd)"),workspace)
  assert.equal(await b.evaluate("window.mako.boot().then(boot=>boot.tabs.find(tab=>tab.id===boot.activeTabId).session.meta.cwd)"),cwdB)
  conversation=randomUUID()
  const requestId=randomUUID()
  const marker=`SHARED_${randomUUID()}`
  const prompt=`Use ask_user_question to ask me to choose Continue or Wait. After I choose Continue, reply with exactly ${marker}. Do not read or change files.`
  await a.evaluate(`window.mako.liveStart('devin',${JSON.stringify(workspace)},{...${JSON.stringify({conversationId:conversation,title:"Shared runtime verification",modeId:"ask",tuning:{model:"gpt-6-astra-high"},initialRequest:{id:requestId,text:prompt,attachments:[]}})},threadPath:undefined,displayPrompt:undefined,resume:undefined})`)
  const snapshot=()=>call("mako:live-snapshot",conversation)
  const waiting=await until(snapshot,state=>state.permissions.some(p=>p.questions?.length),"provider question")
  const providerPid=Number((await readFile(join(homedir(),".local/share/devin/cli/session_locks",`${waiting.session.nativeId}.lock`),"utf8")).trim())
  assert.ok(providerPid>0)
  const rowSelector = `[data-conversation-id="${conversation}"]`
  for (const page of [a,b]) {
    await until(()=>page.evaluate(`Boolean(document.querySelector(${JSON.stringify(rowSelector)}))`),Boolean,"shared sidebar row")
    await page.openRow(rowSelector)
  }
  await a.evaluate(`window.dispatchEvent(new CustomEvent('mako:compose',{detail:{text:'Draft A remains private'}}))`)
  await b.evaluate(`window.dispatchEvent(new CustomEvent('mako:compose',{detail:{text:'Draft B remains private'}}))`)
  // Page.reload answers before the navigation, so the old page would satisfy every check below.
  const loadedAt=await a.evaluate("performance.timeOrigin")
  await a.send("Page.reload")
  await until(()=>a.evaluate("performance.timeOrigin").catch(()=>loadedAt),origin=>origin!==loadedAt,"reloaded page")
  await until(()=>a.evaluate("document.querySelector('.composer-input')?.value").catch(()=>null),value=>value==="Draft A remains private","reloaded draft")
  assert.equal(await b.evaluate("document.querySelector('.composer-input').value"),"Draft B remains private")
  await until(()=>a.evaluate("document.querySelector('[data-model-picker]')?.dataset.harness ?? null").catch(()=>null),harness=>harness==="devin","Reload must retain the active conversation's provider")
  assert.equal((await snapshot()).session.nativeId,waiting.session.nativeId)
  assert.equal(Number((await readFile(join(homedir(),".local/share/devin/cli/session_locks",`${waiting.session.nativeId}.lock`),"utf8")).trim()),providerPid)
  await a.capture("before-closing-clients.png")
  await a.close()
  await b.close()
  assert.equal((await runtimeInfo(location.socket)).pid,host.pid)
  assert.equal((await snapshot()).permissions[0].id,waiting.permissions[0].id)
  process.kill(providerPid,0)
  const permission=waiting.permissions.find(p=>p.questions?.length)
  const answers=Object.fromEntries(permission.questions.map(q=>[q.id,[q.options[0]?.value??q.options[0]?.label??"Continue"]]))
  await call("mako:live-permission", conversation, permission.id, {kind:"answers",answers})
  await until(snapshot,state=>state.requests.some(r=>r.id===requestId&&r.status==="completed"),"completion while every client is closed")
  process.kill(providerPid,0)
  const reopened=await client("client-a")
  await until(()=>reopened.evaluate(`Boolean(document.querySelector(${JSON.stringify(rowSelector)}))`),Boolean,"reopened sidebar row")
  await reopened.openRow(rowSelector)
  await until(()=>reopened.evaluate(`document.body.textContent.includes(${JSON.stringify(marker)})`),Boolean,"caught-up transcript")
  assert.equal((await snapshot()).session.nativeId,waiting.session.nativeId)
  const mirror=await client("client-b", true)
  await until(()=>mirror.evaluate(`Boolean(document.querySelector(${JSON.stringify(rowSelector)}))`),Boolean,"mirror sidebar row")
  await mirror.openRow(rowSelector)
  await until(()=>mirror.evaluate(`document.body.textContent.includes(${JSON.stringify(marker)})`),Boolean,"second process caught up")
  const menuSelector = `[data-conversation-id="${conversation}"] button[aria-label^="Actions for "]`
  // Only the open menu's item: a closing menu stays in the page until its exit animation ends.
  const archiveAction = '[role="menu"][data-state="open"] [data-thread-action="archive"]'
  await until(()=>reopened.evaluate(`Boolean(document.querySelector(${JSON.stringify(menuSelector)}))`),Boolean,"thread actions")
  await reopened.click(menuSelector)
  await until(()=>reopened.evaluate(`Boolean(document.querySelector(${JSON.stringify(archiveAction)}))`),Boolean,"archive action")
  await reopened.click(archiveAction)
  const archived=await until(()=>call("mako:thread-archives"),state=>state.keys.includes(`live:${conversation}`),"archive receipt")
  assert.ok(archived.revision > 0)
  await until(()=>reopened.evaluate(`document.querySelector(${JSON.stringify(rowSelector)})===null`),Boolean,"archive event in client A")
  await until(()=>mirror.evaluate(`document.querySelector(${JSON.stringify(rowSelector)})===null`),Boolean,"archive event in client B")
  await reopened.click('button[aria-label="Filter and sort"]')
  await until(()=>reopened.evaluate(`Boolean(document.querySelector('[data-rail-show="archived"]'))`),Boolean,"archive filter")
  await reopened.click('[data-rail-show="archived"]')
  await until(()=>reopened.evaluate(`Boolean(document.querySelector('[aria-label="Thread view"] [aria-pressed="true"]')?.textContent==='Archived'&&document.querySelector(${JSON.stringify(rowSelector)}))`),Boolean,"archived shelf")
  await reopened.capture("archived-shared-thread.png")
  await reopened.click(menuSelector)
  await until(()=>reopened.evaluate(`document.querySelector(${JSON.stringify(archiveAction)})?.textContent.includes('Restore')`),Boolean,"restore action")
  await reopened.click(archiveAction)
  await until(()=>call("mako:thread-archives"),state=>!state.keys.includes(`live:${conversation}`),"restore receipt")
  await reopened.click('[aria-label="Thread view"] button:nth-child(1)')
  await until(()=>mirror.evaluate(`Boolean(document.querySelector(${JSON.stringify(rowSelector)}))`),Boolean,"restore event in other client")
  const stopRequest=randomUUID()
  await call("mako:live-prompt",conversation,stopRequest,"Ask me to choose Continue or Wait using ask_user_question, and wait for my answer. Do not read or change files.",[])
  await until(snapshot,state=>state.permissions.some(p=>p.questions?.length),"stoppable pending question")
  const queued=randomUUID()
  const resumedMarker = `RESUMED_${randomUUID()}`
  await call("mako:live-prompt",conversation,queued,`Reply with exactly ${resumedMarker}. Do not use tools.`,[])
  const stopSelector = `[data-conversation-id="${conversation}"] button[aria-label^="Stop "]`
  await until(()=>reopened.evaluate(`Boolean(document.querySelector(${JSON.stringify(stopSelector)}))`),Boolean,"sidebar stop")
  await reopened.click(stopSelector)
  await reopened.capture("sidebar-stop-requested.png")
  await until(snapshot,state=>state.requests.find(r=>r.id===stopRequest)?.status==="interrupted","sidebar cancellation receipt")
  assert.equal((await snapshot()).requests.find(r=>r.id===queued).status,"held")
  await reopened.capture("sidebar-stopped-thread.png")
  await reopened.click('[aria-label="Resume queued message"]')
  await until(snapshot,state=>state.requests.find(r=>r.id===queued)?.status==="completed","explicit queue resume")
  await until(()=>mirror.evaluate(`document.body.textContent.includes(${JSON.stringify(resumedMarker)})`),Boolean,"resumed reply in other client")
  await call("mako:live-close",conversation)
  await reopened.close()
  await mirror.close()
  console.log("PASS: independent desktop clients share one daemon; drafts and workspaces stay separate; reload and closing every client preserve the same provider process; reopening catches up; archive syncs both ways; sidebar Stop pauses the queue")
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if(conversation) await call("mako:live-close",conversation).catch(()=>{})
  for(const child of processes.reverse())if(child.exitCode===null&&child.signalCode===null){
    const force=setTimeout(()=>child.kill("SIGKILL"),3000)
    child.kill("SIGTERM")
    await once(child,"exit")
    clearTimeout(force)
  }
  await server.close()
  console.log(`Shared-runtime evidence: ${root}`)
}
