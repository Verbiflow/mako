import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { extractFile, listPackage } from "@electron/asar"
import { preview } from "vite"
import { webHostProxy } from "../electron/web-dev-proxy.mjs"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import { invokeRuntime, probeRuntime } from "../dist-electron/runtime-connection.js"

const app = resolve(process.argv[2])
const root = await mkdtemp(join(tmpdir(), "mako-packaged-web-"))
const dataRoot = join(root, "profile")
const workspace = join(root, "workspace")
const location = runtimeLocation(dataRoot)
const archive = join(app, "Contents/Resources/app.asar")
const metadata = JSON.parse(extractFile(archive, "package.json").toString())
const conversation = randomUUID()
const client = randomUUID()
const marker = `SHARED_${randomUUID()}`
const call = (channel, ...args) => invokeRuntime(location.socket, client, channel, args)
const env = { ...process.env, MAKO_DATA_ROOT: dataRoot, MAKO_CURSOR_SDK_ROOT: join(root, "cursor"), MAKO_HOST_ONLY: "1", MAKO_WEB_ONLY: "1", MAKO_WEB_SOCKET: location.socket, MAKO_BACKEND_URL: "http://127.0.0.1:9/api/mcp", MAKO_BACKEND_TOKEN: "" }
for (const key of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "MAKO_PROFILE", "MAKO_STANDALONE"]) delete env[key]
let host
let browser
let gateway
async function until(read, predicate, label) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timed out: ${label}`)
}
try {
  await mkdir(workspace)
  await mkdir(location.directory, { recursive: true, mode: 0o700 })
  for (const path of listPackage(archive).filter(path => path.startsWith("/dist/"))) {
    // ASAR lists directories as well as files.
    let bytes
    try { bytes = extractFile(archive, path.slice(1)) } catch { continue }
    const destination = join(root, path.slice(1))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, bytes)
  }
  host = spawn(join(app, "Contents/MacOS/Mako"), ["--background"], { cwd: workspace, env, stdio: "ignore" })
  await until(() => probeRuntime(location.socket), result => result.state === "ready", "packaged host")
  gateway = await preview({ configFile: false, root, plugins: [webHostProxy(location.socket)], preview: { host: "127.0.0.1", port: 0 } })
  const origin = gateway.resolvedUrls.local[0]
  const fixture = join(root, "browser.cjs")
  await writeFile(fixture, `
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(root, "browser"))});
app.whenReady().then(async()=>{
 const windows=[];
 const wait=async(read,accept,label)=>{const end=Date.now()+180000;while(Date.now()<end){const value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,200));}throw Error('Timed out: '+label)};
 try {
  for(let i=0;i<2;i++){const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});windows.push(w);await w.loadURL(${JSON.stringify(origin)});await wait(()=>w.webContents.executeJavaScript('Boolean(window.mako)'),Boolean,'browser bridge');}
  const [a,b]=windows.map(w=>w.webContents);
  const id=${JSON.stringify(conversation)};
  const marker=${JSON.stringify(marker)};
  const first=crypto.randomUUID();
  await a.executeJavaScript('window.mako.liveStart("codex",'+JSON.stringify(${JSON.stringify(workspace)})+','+JSON.stringify({conversationId:id,title:'Packaged browser continuation verification',initialRequest:{id:first,text:'Remember '+marker+'. Reply with exactly '+marker+'. Do not use tools or change files.',attachments:[]}})+')');
  const snap=()=>b.executeJavaScript('window.mako.liveSnapshot('+JSON.stringify(id)+')');
  const started=await wait(snap,s=>s.requests.some(r=>r.id===first&&r.status==='completed'),'first browser completion');
  assert.ok(started.session.nativeId);
  const binding=started.control.activeBindingId;
  const second=crypto.randomUUID();
  await b.executeJavaScript('window.mako.liveContinue('+[id,binding,second,'Reply with the marker I asked you to remember. Do not use tools.'].map(JSON.stringify).join(',')+',[])');
  const continued=await wait(snap,s=>s.requests.some(r=>r.id===second&&r.status==='completed'),'second browser completion');
  assert.equal(continued.session.nativeId,started.session.nativeId);
  const secondStart=continued.blocks.findIndex(block=>block.type==='user'&&block.requestId===second);
  assert.ok(secondStart>=0);
  assert.ok(continued.blocks.slice(secondStart+1).filter(block=>block.type==='text').map(block=>block.text).join('').includes(marker),'The second browser reply must recall the first browser marker');
  windows[0].destroy();
  await b.reload();
  await wait(()=>b.executeJavaScript('Boolean(window.mako)'),Boolean,'reloaded bridge');
  const reloaded=await snap();
  assert.equal(reloaded.session.nativeId,started.session.nativeId);
  assert.equal(reloaded.requests.filter(r=>[first,second].includes(r.id)&&r.status==='completed').length,2);
  assert.ok(JSON.stringify(reloaded.blocks).includes(marker),'The browser must recover the shared answer after reload');
  console.log('PACKAGED_BROWSER_EVIDENCE '+JSON.stringify({nativeId:started.session.nativeId,binding,requests:[first,second]}));
 } finally {for(const w of windows)if(!w.isDestroyed())w.destroy();app.quit()}
}).catch(error=>{console.error(error);app.exit(1)});
`)
  const browserEnv = { ...process.env }
  delete browserEnv.ELECTRON_RUN_AS_NODE
  browser = spawn(createRequire(import.meta.url)("electron"), [fixture], { env: browserEnv, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  browser.stdout.on("data", chunk => { output += chunk })
  browser.stderr.on("data", chunk => { output += chunk })
  const deadline = setTimeout(() => browser.kill("SIGTERM"), 420_000)
  const [code] = await once(browser, "exit")
  clearTimeout(deadline)
  await writeFile(join(root, "browser.log"), output)
  assert.equal(code, 0, output)
  const evidence = JSON.parse(output.split("\n").find(line => line.startsWith("PACKAGED_BROWSER_EVIDENCE ")).slice("PACKAGED_BROWSER_EVIDENCE ".length))
  const requestId = randomUUID()
  await call("mako:live-continue", conversation, evidence.binding, requestId, "Reply with the marker I asked you to remember. Do not use tools.", [])
  const final = await until(() => call("mako:live-snapshot", conversation), state => state.requests.some(request => request.id === requestId && request.status === "completed"), "desktop transport completion")
  assert.equal(final.session.nativeId, evidence.nativeId)
  for (const id of [...evidence.requests, requestId]) assert.equal(final.requests.filter(request => request.id === id && request.status === "completed").length, 1)
  const lastPrompt = final.blocks.findIndex(block => block.type === "user" && block.requestId === requestId)
  assert.ok(lastPrompt >= 0)
  assert.ok(final.blocks.slice(lastPrompt + 1).filter(block => block.type === "text").map(block => block.text).join("").includes(marker), "The desktop reply must recall the browser marker")
  await writeFile(join(root, "evidence.json"), JSON.stringify({ build: metadata.makoBuild, conversation, ...evidence, desktopRequest: requestId, status: "passed" }, null, 2))
  console.log("PASS: packaged production browser assets, two browser windows, reload, sender close, and desktop transport continue one real Codex session")
} finally {
  if (host?.exitCode === null) await call("mako:live-close", conversation).catch(() => {})
  for (const child of [browser, host]) if (child && child.exitCode === null && child.signalCode === null) {
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.kill("SIGTERM")
    await once(child, "exit")
    clearTimeout(force)
  }
  if (gateway) await gateway.close()
  console.log(`Packaged browser evidence: ${root}`)
}
