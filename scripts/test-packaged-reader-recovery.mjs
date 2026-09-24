import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,writeFile,appendFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import WebSocket from 'ws'
import {extractFile} from '@electron/asar'

// Real packaged host, preload, catalog and renderer; private native-format
// history only. No provider prompt or installed user profile is touched.
const app=resolve(process.argv[2]),root=await mkdtemp('/tmp/mako-reader-')
const home=join(root,'home'),profile=join(root,'profile'),native=join(home,'.codex/sessions/2026/09/24/rollout-recovery.jsonl')
await mkdir(join(home,'.codex/sessions/2026/09/24'),{recursive:true})
await mkdir(join(home,'.mako'),{recursive:true})
await writeFile(join(home,'.mako/syncd-login-optout'),'')
const record=text=>JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n'
await writeFile(native,JSON.stringify({type:'session_meta',payload:{id:randomUUID(),cwd:root}})+'\n'+JSON.stringify({type:'turn_context',payload:{model:'gpt-6-astra'}})+'\n'+Array.from({length:140},(_,i)=>record(`Reader recovery fixture ${i}`)).join(''))
const env={...process.env,HOME:home,MAKO_STANDALONE:'1',MAKO_DATA_ROOT:profile,MAKO_BACKEND_URL:'http://127.0.0.1:9/api/mcp',MAKO_BACKEND_TOKEN:'',MAKO_RELAY:'0'}
for(const key of ['ELECTRON_RUN_AS_NODE','VITE_DEV_SERVER_URL','MAKO_WEB_SOCKET','MAKO_HOST_ONLY','MAKO_WEB_ONLY','MAKO_CURSOR_SDK_ROOT','CLAUDE_CONFIG_DIR','XDG_DATA_HOME','OPENCODE_DB'])delete env[key]
const child=spawn(join(app,'Contents/MacOS/Mako'),[`--user-data-dir=${profile}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1'],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']})
let logs='',socket,sequence=0
for(const pipe of [child.stdout,child.stderr])pipe.on('data',data=>{logs=(logs+data).slice(-100000)})
const pending=new Map(),report={root,app,kind:'private native-format history; real packaged reader loss and UI recovery',build:JSON.parse(extractFile(join(app,'Contents/Resources/app.asar'),'package.json')).makoBuild}
async function until(read,label){const end=Date.now()+60000;while(Date.now()<end){assert.equal(child.exitCode,null,'app exited');const v=await read();if(v)return v;await delay(100)}throw Error('Timed out: '+label)}
function command(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'))},30000);pending.set(id,r=>{clearTimeout(timer);if(r.error)reject(Error(JSON.stringify(r.error)));else resolve(r.result)});socket.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function capture(name){const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(shot.data,'base64'))}
async function click(selector){const p=await evaluate(`(()=>{const e=${selector};if(!e)throw Error('Missing control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p})}
try{
 const port=await until(async()=>Number((await readFile(join(profile,'DevToolsActivePort'),'utf8').catch(()=>'' )).split('\n')[0]),'debugger')
 const target=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page'&&p.url.startsWith('mako-app:')),'renderer')
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((res,rej)=>{socket.once('open',res);socket.once('error',rej)})
 socket.on('message',data=>{const m=JSON.parse(data.toString());pending.get(m.id)?.(m);pending.delete(m.id)})
 await until(()=>evaluate('Boolean(window.mako&&document.querySelector(".composer-input"))'),'composer')
 await click("[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Recent')")
 const selector=`[data-flip-key=${JSON.stringify(native)}]`
 await until(()=>evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`),'native fixture row')
 await click(`document.querySelector(${JSON.stringify(selector)})`)
 await until(()=>evaluate("document.body.textContent.includes('Reader recovery fixture 139')"),'native tail')
 await click("document.querySelector('.composer-input')")
 await command('Input.insertText',{text:'Unsent draft survives reader replacement'})
 await capture('before-reader-loss')
 const log=await readFile(join(profile,'logs/host.log'),'utf8')
 const reader=Number(/shared catalog connected pid=(\d+)/.exec(log)?.[1]);assert.ok(reader)
 report.previousReader=reader
 // This PID came from our private host and HOME, not the user's shared reader.
 process.kill(reader,'SIGKILL')
 await appendFile(native,record('Arrived while the reader was offline'))
 const started=performance.now()
 await until(()=>evaluate("document.body.textContent.includes('Arrived while the reader was offline')"),'missed update catches up')
 report.recoveryMs=Math.round(performance.now()-started)
 await appendFile(native,record('Live follow resumed after recovery'))
 await until(()=>evaluate("document.body.textContent.includes('Live follow resumed after recovery')"),'new follow update')
 assert.equal(await evaluate("document.querySelector('.composer-input').value"),'Unsent draft survives reader replacement')
 assert.equal(await evaluate("document.body.textContent.split('Arrived while the reader was offline').length-1"),1)
 await capture('recovered-and-following')
 report.newReaders=[...((await readFile(join(profile,'logs/host.log'),'utf8')).matchAll(/shared catalog connected pid=(\d+)/g))].map(m=>Number(m[1]))
 assert.notEqual(report.newReaders.at(-1),reader)
 report.outcome='passed'
}catch(error){report.outcome='failed';report.error=String(error);if(socket?.readyState===WebSocket.OPEN){report.text=await evaluate('document.body.innerText').catch(()=>null);await capture('failure').catch(()=>{})}process.exitCode=1}
finally{
 await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(root,'app.log'),logs)
 if(socket?.readyState===WebSocket.OPEN)await evaluate("window.mako.lifecycleCommand({kind:'wait',action:'quit'})").catch(()=>{})
 socket?.close()
 for(let i=0;i<100&&child.exitCode===null;i++)await delay(100)
 if(child.exitCode===null){child.kill('SIGTERM');report.forcedCleanup=true;process.exitCode=1;await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n')}
 console.log('Reader recovery proof: '+root)
}
