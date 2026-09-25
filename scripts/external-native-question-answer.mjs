// Disposable independent controller, using the selected app's own native adapter.
import {readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {app} from 'electron'

async function run() {
const input=JSON.parse(await readFile(process.env.MAKO_EXTERNAL_QUESTION_INPUT,'utf8'))
app.setPath('userData',join(input.root,'external-profile'))
await app.whenReady()
const module=path=>import(pathToFileURL(join(input.app,'Contents/Resources/app.asar/dist-electron',path)).href)
const {providerHost}=await module('providers/index.js')
const {bindCodexApp,stopCodexApps}=await module('codex-app.js')
const driver=providerHost.liveDrivers.get('codex'),id=randomUUID(),events=[]
const observe=event=>events.push(event)
bindCodexApp(observe)
try {
  const session=await driver.start(input.cwd,{conversationId:id,resume:input.question.sessionId,modeId:driver.modes.find(mode=>mode.access==='full')?.id??driver.defaultMode,emit:observe})
  if(session.nativeId!==input.question.sessionId)throw Error('External controller opened a different session')
  const start=events.length
  await driver.prompt(id,driver.sessionQuestions.encodeAnswer(input.question,input.answers),[],undefined,{operationId:randomUUID(),attemptId:randomUUID(),report(){}})
  const deadline=Date.now()+120000
  while(!events.slice(start).some(e=>e.type==='live-session'&&e.session.status==='ready')) {
    const failed=events.slice(start).find(e=>e.type==='live-session'&&e.session.status==='failed')
    if(failed)throw Error(failed.session.error)
    if(Date.now()>deadline)throw Error('External answer deadline')
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  await writeFile(join(input.root,'external-controller.json'),JSON.stringify({nativeId:session.nativeId,completed:true},null,2))
} finally {await driver.close(id);stopCodexApps()}
}
void run().then(()=>app.exit(),error=>{console.error(error);app.exit(1)})
