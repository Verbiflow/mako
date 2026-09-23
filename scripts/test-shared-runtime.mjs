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
const env = {...process.env, MAKO_DATA_ROOT:dataRoot, VITE_DEV_SERVER_URL:url, MAKO_BACKEND_URL:"http://127.0.0.1:9/api/mcp", MAKO_BACKEND_TOKEN:""}
for (const key of ["ELECTRON_RUN_AS_NODE","MAKO_PROFILE","MAKO_PROD","MAKO_STANDALONE"]) delete env[key]
const processes = []
const connectId=randomUUID()
const call=(channel,...args)=>invokeRuntime(location.socket,connectId,channel,args)
const until=async(read,predicate,label)=>{
  const end=Date.now()+90_000
  while(Date.now()<end){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,50))}
  throw new Error(`Timed out: ${label}`)
}
const launch=(args,extra)=>{
  const child=spawn(executable,args,{env:{...env,...extra},stdio:["ignore","pipe","pipe"]})
  processes.push(child)
  child.stdout.on("data",chunk=>{if(process.env.MAKO_TEST_TRACE)process.stdout.write(chunk)})
  child.stderr.on("data",chunk=>{if(process.env.MAKO_TEST_TRACE)process.stderr.write(chunk)})
  return child
}
async function client(name, production = false) {
  const child=launch([resolve("."),"--background","--remote-debugging-port=0"],{MAKO_HOST_ONLY:"0",MAKO_CLIENT_ID:name,MAKO_PROD:production?"1":""})
  let port
  child.stderr.on("data",chunk=>{const match=chunk.toString().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(match)port=Number(match[1])})
  await until(async()=>port,Boolean,`${name} debugger`)
  const pages=await until(async()=>fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json()),rows=>rows.some(row=>row.type==="page"),`${name} page`)
  const socket=new WebSocket(pages.find(row=>row.type==="page").webSocketDebuggerUrl)
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
  const click=async(selector)=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    const point=await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing element');const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point})
    await send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point})
  }
  const capture=async(name)=>{const image=await send("Page.captureScreenshot",{format:"png"});await writeFile(join(root,name),Buffer.from(image.data,"base64"))}
  const close=async()=>{socket.close();if(child.exitCode===null){child.kill("SIGTERM");await once(child,"exit")}}
  return {child,send,evaluate,click,capture,close}
}
let conversation
try {
  const host=launch([resolve("."),"--background"],{MAKO_HOST_ONLY:"1",MAKO_WEB_ONLY:"1",MAKO_WEB_SOCKET:location.socket})
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
  if (process.argv.includes("--transport-only")) {
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
    await page.click(rowSelector)
  }
  await a.evaluate(`window.dispatchEvent(new CustomEvent('mako:compose',{detail:{text:'Draft A remains private'}}))`)
  await b.evaluate(`window.dispatchEvent(new CustomEvent('mako:compose',{detail:{text:'Draft B remains private'}}))`)
  await a.send("Page.reload")
  await until(()=>a.evaluate("document.querySelector('.composer-input')?.value").catch(()=>null),value=>value==="Draft A remains private","reloaded draft")
  assert.equal(await b.evaluate("document.querySelector('.composer-input').value"),"Draft B remains private")
  assert.equal(await a.evaluate(`Boolean(document.querySelector('[data-model-picker][data-harness="devin"]'))`),true,"Reload must retain the active conversation's provider")
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
  await reopened.click(rowSelector)
  await until(()=>reopened.evaluate(`document.body.textContent.includes(${JSON.stringify(marker)})`),Boolean,"caught-up transcript")
  assert.equal((await snapshot()).session.nativeId,waiting.session.nativeId)
  const mirror=await client("client-b", true)
  await until(()=>mirror.evaluate(`Boolean(document.querySelector(${JSON.stringify(rowSelector)}))`),Boolean,"mirror sidebar row")
  await mirror.click(rowSelector)
  await until(()=>mirror.evaluate(`document.body.textContent.includes(${JSON.stringify(marker)})`),Boolean,"second process caught up")
  const menuSelector = `[data-conversation-id="${conversation}"] button[aria-label^="Actions for "]`
  await until(()=>reopened.evaluate(`Boolean(document.querySelector(${JSON.stringify(menuSelector)}))`),Boolean,"thread actions")
  await reopened.click(menuSelector)
  await until(()=>reopened.evaluate(`Boolean(document.querySelector('[data-thread-action="archive"]'))`),Boolean,"archive action")
  await reopened.click('[data-thread-action="archive"]')
  const archived=await until(()=>call("mako:thread-archives"),state=>state.keys.includes(`live:${conversation}`),"archive receipt")
  assert.ok(archived.revision > 0)
  await until(()=>reopened.evaluate(`document.querySelector(${JSON.stringify(rowSelector)})===null`),Boolean,"archive event in client A")
  await until(()=>mirror.evaluate(`document.querySelector(${JSON.stringify(rowSelector)})===null`),Boolean,"archive event in client B")
  await reopened.click('[aria-label="Thread view"] button:nth-child(3)')
  await until(()=>reopened.evaluate("document.querySelector('[data-thread-row]')!==null"),Boolean,"archived shelf")
  await reopened.capture("archived-shared-thread.png")
  await reopened.click(menuSelector)
  await until(()=>reopened.evaluate(`document.querySelector('[data-thread-action="archive"]')?.textContent.includes('Restore')`),Boolean,"restore action")
  await reopened.click('[data-thread-action="archive"]')
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
