import { SessionArchive } from '../../dist/archive.js'
const archive = new SessionArchive(process.argv[2])
process.on('message', async message => {
  try {
    if (message.type === 'stop') { await archive.stop(); process.disconnect(); return }
    if (message.type === 'drop') { await archive.drop(message.path, 'harness'); process.send({type:'done'}) }
  } catch(error) { process.send({type:'failure',message:error.stack}) }
})
await archive.load()
process.send({type:'ready'})
