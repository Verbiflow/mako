import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,writeFile,appendFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import WebSocket from 'ws'
import {extractFile} from '@electron/asar'
import {PackagedApp} from './lib/packaged-app.mjs'

// Real packaged host, preload, catalog and renderer; private native-format
// history only. No provider prompt or installed user profile is touched.
const app=resolve(process.argv[2]),root=await mkdtemp('/tmp/mako-reader-')
const home=join(root,'home'),profile=join(root,'profile'),native=join(home,'.codex/sessions/2026/09/24/rollout-recovery.jsonl')
await mkdir(join(home,'.codex/sessions/2026/09/24'),{recursive:true})
await mkdir(join(home,'.mako'),{recursive:true})
await writeFile(join(home,'.mako/syncd-login-optout'),'')
const record=text=>JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n'
await writeFile(native,JSON.stringify({type:'session_meta',payload:{id:randomUUID(),cwd:root}})+'\n'+JSON.stringify({type:'turn_context',payload:{model:'gpt-6-astra'}})+'\n'+Array.from({length:140},(_,i)=>record(`Reader recovery fixture ${i}`)).join(''))
let logs=''
const pkg=new PackagedApp({executable:join(app,'Contents/MacOS/Mako'),root,workspace:root,
 env:{HOME:home,CLAUDE_CONFIG_DIR:undefined,XDG_DATA_HOME:undefined,OPENCODE_DB:undefined},
 onStdoutLine:line=>{logs=(logs+line+'\n').slice(-100000)}})
const report={root,app,kind:'private native-format history; real packaged reader loss and UI recovery',build:JSON.parse(extractFile(join(app,'Contents/Resources/app.asar'),'package.json')).makoBuild}
const until=(read,label)=>pkg.waitFor(read,Boolean,label,60000)
const command=(method,params)=>pkg.command(method,params)
const evaluate=expression=>pkg.evaluate(expression)
async function capture(name){const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(shot.data,'base64'))}
async function click(selector){const p=await evaluate(`(()=>{const e=${selector};if(!e)throw Error('Missing control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);for(const type of ['mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p})}
try{
 await pkg.start()
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
}catch(error){report.outcome='failed';report.error=String(error);if(pkg.socket?.readyState===WebSocket.OPEN){report.text=await evaluate('document.body.innerText').catch(()=>null);await capture('failure').catch(()=>{})}process.exitCode=1}
finally{
 await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(root,'app.log'),logs)
 if(pkg.socket?.readyState===WebSocket.OPEN)await evaluate("window.mako.lifecycleCommand({kind:'wait',action:'quit'})").catch(()=>{})
 // A quit stops the host, and the desktop leaves with it; anything still running failed to quit.
 const running=async()=>pkg.child?.exitCode===null||Boolean(await pkg.host())
 for(let i=0;i<100&&await running();i++)await delay(100)
 if(await running()){report.forcedCleanup=true;process.exitCode=1;await writeFile(join(root,'result.json'),JSON.stringify(report,null,2)+'\n')}
 await pkg.stop()
 console.log('Reader recovery proof: '+root)
}
