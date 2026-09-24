import { readFile } from 'node:fs/promises'
import { SessionArchive } from '../../dist/archive.js'
const archive = new SessionArchive(process.argv[2])
let release
process.on('message', async message => {
  try {
    if (message.type === 'release') { release?.(); return }
    if (message.type === 'stop') { await archive.stop(); process.disconnect(); return }
    if (message.type === 'forget') { await archive.forget(message.path); process.send({type:'done'}); return }
    if (message.type === 'capture') {
      let reads = 0
      archive.note(message.ref, async () => {
        const result = JSON.parse(await readFile(message.source,'utf8'))
        reads++
        if (message.hold && reads === 1) {
          const gate = new Promise(resolve => { release = resolve })
          process.send({type:'reading'})
          await gate
        }
        return result
      })
      await archive.flush()
      process.send({type:'done',reads})
    }
  } catch(error) { process.send({type:'failure',message:error.stack}) }
})
await archive.load()
process.send({type:'ready'})
