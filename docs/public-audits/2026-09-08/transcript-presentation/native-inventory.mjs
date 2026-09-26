import {readFile, writeFile} from 'node:fs/promises'
import {dirname, resolve, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {homedir} from 'node:os'
import {CodexProvider} from '../../../../packages/sessions/dist/providers/codex.js'
import {ClaudeProvider} from '../../../../packages/sessions/dist/providers/claude.js'
import {CursorProvider} from '../../../../packages/sessions/dist/providers/cursor.js'
import {DevinCliProvider} from '../../../../packages/sessions/dist/providers/devin-cli.js'
import {OpenCodeProvider} from '../../../../packages/sessions/dist/providers/opencode.js'

// Explicit session paths only. Never scans a catalog or prints transcript bodies.
// Usage: node .../native-inventory.mjs manifest.json
const here = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
const providers = {
  codex: new CodexProvider(homedir()),
  claude: new ClaudeProvider(homedir()),
  cursor: new CursorProvider(homedir()),
  devin: new DevinCliProvider(homedir()),
  opencode: new OpenCodeProvider(homedir()),
}
const rows = []
for (const item of manifest) {
  const provider = providers[item.provider]
  if (!provider) throw new Error('Unknown provider')
  const thread = await provider.read(item.path)
  const entries = thread?.entries ?? []
  const blocks = entries.flatMap(entry => entry.kind === 'assistant' ? entry.blocks : [])
  const tools = blocks.filter(block => block.type === 'tool')
  const attachments = [
    ...entries.flatMap(entry => entry.kind === 'user' ? entry.attachments ?? [] : []),
    ...blocks.filter(block => block.type === 'attachment'),
    ...tools.flatMap(tool => tool.attachments ?? []),
  ]
  rows.push({
    provider: item.provider,
    nativeId: thread?.ref.nativeId,
    loaded: Boolean(thread),
    entries: entries.length,
    tools: tools.length,
    attachments: attachments.map(({mimeType, source}) => ({mimeType, source: source.kind})),
    toolNames: [...new Set(tools.map(tool => tool.name))],
  })
}
await writeFile(process.argv[3] ? resolve(process.argv[3]) : join(here, 'native-evidence.json'), JSON.stringify(rows, null, 2) + '\n')
console.log(JSON.stringify(rows, null, 2))
