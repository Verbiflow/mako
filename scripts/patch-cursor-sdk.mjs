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
//    a new child starts at zero, so both rewrite the file in full, which the
//    SDK's own streamed writer (`streamFullJsonlWrites`) does a megabyte at a
//    time instead of as one string.
// A cached streaming tool's source failure reaches every active and later
// replay reader in the SDK itself since 1.0.40 (`scripts/test-cursor-tool-stream.mjs`).
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "1.2.0"
const MARKER = "/*mako:patched:4*/"
const ANY_MARKER = "/*mako:patched"

/**
 * `s` is one transcript file's record: how many root messages it holds, how
 * many summary archives the state had, and the id of its last message. A
 * count of 0 makes the SDK's incremental writer write in full. A full write
 * drops the first of two leading user messages, so a file is rewritten until
 * it holds 16 messages: both are written by then unless 15 are system prompts.
 */
const appendTranscript = writer => [
  "appendTranscript(e,t,r,n,o){",
  `const i=e.resolveFilePath(n,"jsonl"),s=${writer}.transcripts.get(i)??{count:0,archives:0,last:void 0,chain:Promise.resolve()};${writer}.transcripts.set(i,s);`,
  "const k=x=>null==x?void 0:\"string\"==typeof x?x:Buffer.from(x).toString(\"hex\"),a=()=>r.summaryArchives?.length??0;",
  "return s.chain=s.chain.then((()=>{const m=r.rootPromptMessagesJson,c=s.count>=16&&a()===s.archives&&m.length>=s.count&&k(m[s.count-1])===s.last?s.count:0;",
  "return e.writeFromStateIncremental(t,r,n,c,o)})).then((c=>{s.count=c||0,s.archives=a(),s.last=s.count>0?k(r.rootPromptMessagesJson[s.count-1]):void 0}),(()=>{s.count=0})),s.chain}",
].join("")

/** The same in the esm and cjs builds: the module's names don't differ between them in 1.2.0. */
const BLOB_STORE = [
  [
    "class I{constructor(t){this.persistBlob=t,this.blobs=new Map}",
    `${MARKER}class I{constructor(t,r){this.persistBlob=t,this.loadBlob=r,this.blobs=new Map}`,
  ],
  [
    "async getBlob(t,r){return this.blobs.get((0,n.nj)(r))}",
    "async getBlob(t,r){const e=(0,n.nj)(r),s=this.blobs.get(e);return void 0===s&&this.loadBlob?await this.loadBlob(e):s}",
  ],
  [
    "this.blobs.set(s,i),await(this.persistBlob?.(s,i))}",
    "this.blobs.set(s,i),await(this.persistBlob?.(s,i)),this.loadBlob&&this.blobs.get(s)===i&&this.blobs.delete(s)}",
  ],
  [
    "const e=await this.getScopedAgentDocument(t);return e?.latestCheckpoint?this.setBlobStore(t,await f(this.localStore,t,e.latestCheckpoint)):this.createPersistingBlobStore(t)}",
    "return await this.getScopedAgentDocument(t),this.createPersistingBlobStore(t)}",
  ],
  [
    "createPersistingBlobStore(t){const r=new I(this.createPersistBlob(t));return this.blobStores.set(t,r),r}",
    "createPersistingBlobStore(t){const r=new I(this.createPersistBlob(t),this.createLoadBlob(t));return this.blobStores.set(t,r),r}createLoadBlob(t){return async r=>{const e=await this.localStore.checkpoints.get({agentId:t,blobId:r});return null==e?void 0:T(e)}}",
  ],
  [
    "const e=await f(this.localStore,t,r.latestCheckpoint),n=this.setBlobStore(t,e),o=await n.getBlob((0,s.q6)(),k(e.rootBlobId));",
    "const n=this.createPersistingBlobStore(t),o=await n.getBlob((0,s.q6)(),k(r.latestCheckpoint.rootBlobId));",
  ],
  [
    "const e=await f(this.localStore,t,r.latestCheckpoint),o=new n.We;",
    "const e=r.latestCheckpoint,o=new n.We;",
  ],
  [
    "const a=new n.pH(this.setBlobStore(t,e),o);",
    "const a=new n.pH(this.createPersistingBlobStore(t),o);",
  ],
]

/**
 * `writer` is the transcript writer's class, `store` the transcript store's, `write` its file writer, `fs`
 * node:fs/promises, `child` the variable holding each subagent's state where the writer writes their transcripts.
 */
function transcripts({ writer, store, write, fs, child }) {
  const options = `writeText:!1,writeJsonl:!0,appendFile:${fs}.appendFile,streamFullJsonlWrites:!0,`
  return [
    [
      `class ${writer}{constructor(e){this.writeChain=Promise.resolve(),`,
      `${MARKER}class ${writer}{static transcripts=new Map;constructor(e){this.writeChain=Promise.resolve(),`,
    ],
    [
      `this.transcriptStore=new ${store}(this.projectDir,e.blobStore,${write},{writeText:!1,writeJsonl:!0,...t?`,
      `this.transcriptStore=new ${store}(this.projectDir,e.blobStore,${write},{${options}...t?`,
    ],
    [
      `this.nestedSubagentTranscriptStore=new ${store}(this.projectDir,e.blobStore,${write},{writeText:!1,writeJsonl:!0,`,
      `this.nestedSubagentTranscriptStore=new ${store}(this.projectDir,e.blobStore,${write},{${options}`,
    ],
    [
      "await this.transcriptStore.writeFromStateFull(e,t,this.conversationId);",
      "await this.appendTranscript(this.transcriptStore,e,t,this.conversationId);",
    ],
    [
      `await this.nestedSubagentTranscriptStore.writeFromStateFull(e,${child}.conversationState,t)`,
      `await this.appendTranscript(this.nestedSubagentTranscriptStore,e,${child}.conversationState,t)`,
    ],
    [
      "await this.transcriptStore.writeFromStateFull(e,t,this.conversationId,{turnEnded:r})",
      "await this.appendTranscript(this.transcriptStore,e,t,this.conversationId,{turnEnded:r})",
    ],
    [
      "waitForPendingWrites(){return this.writeChain}",
      appendTranscript(writer) + "waitForPendingWrites(){return this.writeChain}",
    ],
  ]
}

export const CURSOR_SDK_PATCHES = [
  { target: "dist/esm/index.js", replacements: BLOB_STORE, change: "read-through checkpoint blobs" },
  { target: "dist/cjs/index.js", replacements: BLOB_STORE, change: "read-through checkpoint blobs" },
  { target: "dist/esm/336.js", replacements: transcripts({ writer: "fO", store: "F$", write: "pO", fs: "Vs", child: "n" }), change: "incremental transcripts" },
  { target: "dist/cjs/336.js", replacements: transcripts({ writer: "wO", store: "L$", write: "gO", fs: "Js", child: "n" }), change: "incremental transcripts" },
]

function assertVersion(read) {
  const { version } = JSON.parse(read("package.json"))
  if (version !== VERSION)
    throw new Error(`scripts/patch-cursor-sdk.mjs targets @cursor/sdk ${VERSION}, found ${version}. Check checkpoint blobs and transcript writes, then port or delete this patch.`)
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
    let source = read(target)
    if (replacements.every(([, patched]) => source.includes(patched))) continue
    if (source.includes(ANY_MARKER))
      throw new Error(`@cursor/sdk ${target} has an incomplete or older Mako patch; reinstall @cursor/sdk before rebuilding`)
    for (const [from, to] of replacements) {
      const count = source.split(from).length - 1
      if (count !== 1) throw new Error(`@cursor/sdk ${target}: expected one match, found ${count}: ${from.slice(0, 80)}`)
      source = source.replace(from, () => to)
    }
    writeFileSync(join(root, target), source)
    console.log(`patched @cursor/sdk ${target}: ${change}`)
  }
  assertCursorSdkPatched(read)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..", "..")
  if (process.argv.includes("--check")) assertCursorSdkPatched((target) => readFileSync(join(root, target), "utf8"))
  else patchCursorSdk(root)
}
