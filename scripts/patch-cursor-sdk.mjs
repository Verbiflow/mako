// Two Cursor SDK costs grow with the whole conversation instead of the turn:
//
// 1. The local agent store copies every checkpoint blob an agent ever wrote into
//    memory, as base64 and then as bytes, at the start of every run (loadLatest),
//    on the first checkpoint save, and when reading the conversation. A 2.4 GB
//    conversation needs 3.2 GB of base64 and exhausts the child's V8 heap; smaller
//    ones keep the whole store resident until the child exits. The patched store
//    reads through to SQLite one blob at a time.
// 2. The transcript writer rewrites the full JSONL transcript, hydrating every
//    message blob, at each checkpoint, and again for every subagent the
//    conversation ever spawned. The patched writer uses the SDK's own incremental
//    append, with one written count and one write chain per transcript file so
//    the parent's nested writes and a subagent's own writer stay ordered. It
//    appends only while the conversation state extends what was written: a
//    server-side summary replaces the root messages and adds an archive, and
//    a new child starts at zero, so both rewrite the file in full as before.
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "1.0.31"
const MARKER = "/*mako:patched:3*/"
const ANY_MARKER = "/*mako:patched"

/**
 * `s` is one transcript file's record: how many root messages it holds, how
 * many summary archives the state had, and the id of its last message. A
 * count of 0 makes the SDK's incremental writer write in full. A full write
 * drops the first of two leading user messages, so a file is rewritten until
 * it holds 16 messages: both are written by then unless 15 are system prompts.
 */
const APPEND_TRANSCRIPT = [
  "appendTranscript(e,t,r,n,o){",
  "const i=e.resolveFilePath(n,\"jsonl\"),s=f.transcripts.get(i)??{count:0,archives:0,last:void 0,chain:Promise.resolve()};f.transcripts.set(i,s);",
  "const k=x=>null==x?void 0:\"string\"==typeof x?x:Buffer.from(x).toString(\"hex\"),a=()=>r.summaryArchives?.length??0;",
  "return s.chain=s.chain.then((()=>{const m=r.rootPromptMessagesJson,c=s.count>=16&&a()===s.archives&&m.length>=s.count&&k(m[s.count-1])===s.last?s.count:0;",
  "return e.writeFromStateIncremental(t,r,n,c,o)})).then((c=>{s.count=c||0,s.archives=a(),s.last=s.count>0?k(r.rootPromptMessagesJson[s.count-1]):void 0}),(()=>{s.count=0})),s.chain}",
].join("")
const BLOB_STORE = [
  [
    "class I{constructor(e){this.persistBlob=e,this.blobs=new Map}",
    `${MARKER}class I{constructor(e,t){this.persistBlob=e,this.loadBlob=t,this.blobs=new Map}`,
  ],
  [
    "getBlob(e,t){return a(this,void 0,void 0,(function*(){return this.blobs.get((0,r.nj)(t))}))}",
    "getBlob(e,t){return a(this,void 0,void 0,(function*(){const n=(0,r.nj)(t),s=this.blobs.get(n);return void 0===s&&this.loadBlob?yield this.loadBlob(n):s}))}",
  ],
  [
    "this.blobs.set(s,o),yield null===(e=this.persistBlob)||void 0===e?void 0:e.call(this,s,o)}))}",
    "this.blobs.set(s,o),yield null===(e=this.persistBlob)||void 0===e?void 0:e.call(this,s,o),this.loadBlob&&this.blobs.get(s)===o&&this.blobs.delete(s)}))}",
  ],
  [
    "const n=yield this.getScopedAgentDocument(e);return(null==n?void 0:n.latestCheckpoint)?this.setBlobStore(e,yield f(this.localStore,e,n.latestCheckpoint)):this.createPersistingBlobStore(e)}))}",
    "return yield this.getScopedAgentDocument(e),this.createPersistingBlobStore(e)}))}",
  ],
  [
    "createPersistingBlobStore(e){const t=new I(this.createPersistBlob(e));return this.blobStores.set(e,t),t}",
    "createPersistingBlobStore(e){const t=new I(this.createPersistBlob(e),this.createLoadBlob(e));return this.blobStores.set(e,t),t}createLoadBlob(e){return t=>a(this,void 0,void 0,(function*(){const n=yield this.localStore.checkpoints.get({agentId:e,blobId:t});return null==n?void 0:L(n)}))}",
  ],
  [
    "const n=yield f(this.localStore,e,t.latestCheckpoint),r=this.setBlobStore(e,n),i=yield r.getBlob((0,s.q6)(),R(n.rootBlobId));",
    "const r=this.createPersistingBlobStore(e),i=yield r.getBlob((0,s.q6)(),R(t.latestCheckpoint.rootBlobId));",
  ],
  [
    "const n=yield f(this.localStore,e,t.latestCheckpoint),i=new r.We;",
    "const n=t.latestCheckpoint,i=new r.We;",
  ],
  [
    "const a=new r.pH(this.setBlobStore(e,n),i);",
    "const a=new r.pH(this.createPersistingBlobStore(e),i);",
  ],
]
const TRANSCRIPTS = [
  [
    "class f{constructor(e){this.writeChain=Promise.resolve(),",
    `${MARKER}class f{static transcripts=new Map;constructor(e){this.writeChain=Promise.resolve(),`,
  ],
  [
    "Object.assign({writeText:!1,writeJsonl:!0},t?{pathResolver:t}:{})",
    "Object.assign({writeText:!1,writeJsonl:!0,appendFile:o.appendFile},t?{pathResolver:t}:{})",
  ],
  [
    "this.nestedSubagentTranscriptStore=new a.YF(this.projectDir,e.blobStore,p,{writeText:!1,writeJsonl:!0,",
    "this.nestedSubagentTranscriptStore=new a.YF(this.projectDir,e.blobStore,p,{writeText:!1,writeJsonl:!0,appendFile:o.appendFile,",
  ],
  [
    "yield this.transcriptStore.writeFromStateFull(e,t,this.conversationId);",
    "yield this.appendTranscript(this.transcriptStore,e,t,this.conversationId);",
  ],
  [
    "(yield this.nestedSubagentTranscriptStore.writeFromStateFull(e,n.conversationState,t))",
    "(yield this.appendTranscript(this.nestedSubagentTranscriptStore,e,n.conversationState,t))",
  ],
  [
    "yield this.transcriptStore.writeFromStateFull(e,t,this.conversationId,{turnEnded:r})",
    "yield this.appendTranscript(this.transcriptStore,e,t,this.conversationId,{turnEnded:r})",
  ],
  [
    "waitForPendingWrites(){return this.writeChain}",
    APPEND_TRANSCRIPT + "waitForPendingWrites(){return this.writeChain}",
  ],
]
export const CURSOR_SDK_PATCHES = [
  { target: "dist/esm/index.js", replacements: BLOB_STORE, change: "read-through checkpoint blobs" },
  { target: "dist/cjs/index.js", replacements: BLOB_STORE, change: "read-through checkpoint blobs" },
  { target: "dist/esm/357.js", replacements: TRANSCRIPTS, change: "incremental transcripts" },
]

function assertVersion(read) {
  const { version } = JSON.parse(read("package.json"))
  if (version !== VERSION)
    throw new Error(`scripts/patch-cursor-sdk.mjs targets @cursor/sdk ${VERSION}, found ${version}. Check whether the new version still loads every blob per run and rewrites whole transcripts, then port or delete this patch.`)
}

/** Checks every replacement, including the SDK bytes inside the built archive. */
export function assertCursorSdkPatched(read) {
  assertVersion(read)
  for (const { target, replacements, change } of CURSOR_SDK_PATCHES) {
    const source = read(target)
    if (!replacements.every(([, patched]) => source.includes(patched)))
      throw new Error(`@cursor/sdk ${target} lacks Mako's complete ${change} patch; rebuild with scripts/patch-cursor-sdk.mjs`)
  }
}

export function patchCursorSdk(root) {
  const read = (target) => readFileSync(join(root, target), "utf8")
  assertVersion(read)
  for (const { target, replacements, change } of CURSOR_SDK_PATCHES) {
    const file = join(root, target)
    let source = read(target)
    if (replacements.every(([, patched]) => source.includes(patched))) continue
    if (source.includes(ANY_MARKER)) throw new Error(`@cursor/sdk ${target} has an incomplete or older Mako patch; reinstall @cursor/sdk before rebuilding`)
    for (const [from, to] of replacements) {
      const count = source.split(from).length - 1
      if (count !== 1) throw new Error(`@cursor/sdk ${target}: expected one match, found ${count}: ${from.slice(0, 80)}`)
      source = source.replace(from, () => to)
    }
    writeFileSync(file, source)
    console.log(`patched @cursor/sdk ${target}: ${change}`)
  }
  assertCursorSdkPatched(read)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..", "..")
  if (process.argv.includes("--check")) assertCursorSdkPatched((target) => readFileSync(join(root, target), "utf8"))
  else patchCursorSdk(root)
}
