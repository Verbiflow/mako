// Two Cursor SDK costs grow with the whole conversation instead of the turn:
//
// 1. The local agent store copies every checkpoint blob an agent ever wrote into
//    memory, as base64 and then as bytes, at the start of every run (loadLatest),
//    on the first checkpoint save, and when reading the conversation. A 2.4 GB
//    conversation needs 3.2 GB of base64 and exhausts the child's V8 heap; smaller
//    ones keep the whole store resident until the child exits. The patched store
//    reads through to SQLite one blob at a time. `checkpoints.get` already hands
//    back a copy of its own, so a read is not copied again: a turn on a 146-turn
//    conversation rewrites its transcript from every blob, and the extra copy
//    added 60 MB to that turn's peak (2026-11-04).
// 2. The transcript writer rewrites the full JSONL transcript, hydrating every
//    message blob, at each checkpoint, and again for every subagent the
//    conversation ever spawned. The patched writer uses the SDK's own incremental
//    append, with one written count and one write chain per transcript file so
//    the parent's nested writes and a subagent's own writer stay ordered. It
//    appends only while the conversation state extends what was written: a
//    server-side summary replaces the root messages and adds an archive, and
//    a new child starts at zero, so both rewrite the file in full, which the
//    SDK's own streamed writer (`streamFullJsonlWrites`) does a megabyte at a
//    time instead of as one string. That writer only runs when `appendFile` is
//    set. The bundle's fs binding lacks it (it only carries functions the
//    bundle already calls), so the option was `undefined` and every rewrite
//    hydrated every summary archive at once: one turn on an 80-turn conversation
//    peaked at 2.1 GB (2026-11-04). The patch appends with `writeFile`.
//    A full write, streamed or not, goes to a file of its own beside the
//    transcript, synced, renamed over it, and the folder synced, so a child
//    killed mid-write leaves the transcript as it was and a crash of the
//    machine doesn't lose the rename. Every write of a transcript, an append
//    or a rewrite, runs inside the file's lock (`transcript-lock.ts`), a file
//    lock the kernel drops when its holder dies, so one child writes a file at
//    a time. An append killed mid-write leaves a torn last line, which
//    whoever next takes the lock, a writer or the Cursor child opening the
//    agent, cuts off first (`transcript-tails.ts`).
// 3. Each bidi stream races every read, of what the backend sends and of what
//    the client appends, against a promise pending for the stream's life, and
//    each race leaves a reaction on that promise. Every message the stream
//    carried stays reachable through them, with the network chunk its fields
//    were decoded from, and the appending side outlives its run: one idle
//    child held 53,360 such messages, most of its 233 MB (2026-11-04). The
//    patched reads leave one subscription on each such promise, and that
//    subscription settles every read still waiting.
// Separately, an agent store waits 5 s for a lock before a write fails, and
// Mako's checkpoint collector compacts a quiet store with a VACUUM that holds
// the lock for as long as rewriting what's kept takes (10.7 s for 1.9 GB on
// 2026-11-01). The patched store waits a minute, so a run resumed meanwhile,
// from this host or another, writes once the compaction ends.
// Separately, the SDK runs every turn with a logger that drops every entry,
// among them its only account of why a run's stream was cut and how it retried
// or resumed. The patched logger hands each entry to the process as a
// `mako:cursor-sdk-log` event, where the Cursor child keeps that account.
// A cached streaming tool's source failure reaches every active and later
// replay reader in the SDK itself since 1.0.40 (`scripts/test-cursor-tool-stream.mjs`).
// Separately, the SDK's retry loop resumes a run whose stream broke from the
// last checkpoint the backend sent, with an empty resume action. The calls
// the client ran after that checkpoint keep their effects, but the resumed
// model can't see them: it redid an edit under other names and disowned a
// commit it had made. The patched loop awaits the process's resume hook
// before each retry, and when the hook gives words, sends them as a user
// message on that checkpoint instead (on a resend of the turn's own message,
// after its words), so the model goes on from what happened.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "1.3.1"
const MARKER = "/*mako:patched:11*/"
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

const STORE_LOCK_WAIT = [["PRAGMA busy_timeout = 5000;", "PRAGMA busy_timeout = 60000;"]]

/** The same in the esm and cjs builds: the module's names don't differ between them in 1.2.0 or 1.3.1. */
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
    "createPersistingBlobStore(t){const r=new I(this.createPersistBlob(t),this.createLoadBlob(t));return this.blobStores.set(t,r),r}createLoadBlob(t){return async r=>{const e=await this.localStore.checkpoints.get({agentId:t,blobId:r});return e??void 0}}",
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
 * The same in the esm and cjs builds. `J` rejects when an append fails, `w`
 * when the stream is aborted. One subscription on `J` rejects every read
 * still waiting, not only the latest: two outstanding `next()` calls both
 * reject in the unpatched SDK. A read after the failure rejects at once.
 */
export const BIDI_READS = [
  [
    "b={[Symbol.asyncIterator](){const t=B[Symbol.asyncIterator]();return{next:()=>Promise.race([t.next(),J]),",
    "b={[Symbol.asyncIterator](){const t=B[Symbol.asyncIterator]();let f;const o=[];J.catch((t=>{f=[t];for(const r of o)r(t);o.length=0}));return{next:()=>f?Promise.reject(f[0]):new Promise(((r,e)=>{o.push(e),t.next().then((t=>{const n=o.indexOf(e);n<0||o.splice(n,1),r(t)}),(t=>{const n=o.indexOf(e);n<0||o.splice(n,1),e(t)}))})),",
  ],
  [
    "let g,_;const w=new Promise(((t,r)=>{_=()=>r(new p)}));",
    "let g,_,z;const w=new Promise(((t,r)=>{_=()=>{const t=new p;r(t),z?.(t)}}));",
  ],
  [
    "const r=await Promise.race([m.next(),w]);",
    "const r=await new Promise(((t,r)=>{z=r,m.next().then(t,r)}));",
  ],
]

/**
 * `writer` is the transcript writer's class, `store` the transcript store's, `write` its file writer, `fs`
 * node:fs/promises, `child` the variable holding each subagent's state where the writer writes their transcripts,
 * `chunks` the streamed writer's count of chunks written.
 * The bundle's `fs` only carries the functions it already calls, so `appendFile` is not among them: passing
 * `fs.appendFile` stores `undefined`, and every transcript write then hydrates the whole conversation at once.
 * `writeFile` with flag `a` is the same call.
 */
function transcripts({ writer, store, write, fs, child, chunks }) {
  const lock = "makoLock"
  const options = `writeText:!1,writeJsonl:!0,appendFile:(p,d)=>${lock}(p,(()=>${fs}.writeFile(p,d,{flag:"a"}))),streamFullJsonlWrites:!0,`
  const staged = `+".mako-"+process.pid+".tmp"`
  return [
    [
      `async function ${write}(e,t){const r=(0,s.dirname)(e);await(0,${fs}.mkdir)(r,{recursive:!0}),await(0,${fs}.writeFile)(e,t,"utf-8")}`,
      `async function ${write}(e,t){return ${lock}(e,(async()=>{const r=(0,s.dirname)(e);await(0,${fs}.mkdir)(r,{recursive:!0});const n=e${staged},o=await(0,${fs}.open)(n,"w");try{await o.writeFile(t,"utf-8"),await o.sync()}finally{await o.close()}await(0,${fs}.rename)(n,e),await makoSyncDir(e)}))}` +
        // Runs `work` inside the process's transcript lock (`transcript-lock.ts`); outside Mako's child there is none.
        `function ${lock}(p,w){const k=globalThis[Symbol.for("mako:cursor-transcript-lock")];return k?k(p,w):w()}` +
        // A rename is durable once its folder is synced. Windows can't open a folder as a file (EISDIR, or EPERM),
        // and makes a rename durable without it; a file system that can't sync a folder says so (EINVAL, ENOTSUP,
        // EOPNOTSUPP). Any other failure is a rename that may not last, so the write fails.
        `async function makoSyncDir(p){const d=(0,s.dirname)(p);let h;try{h=await(0,${fs}.open)(d,"r")}catch(e){if("win32"===process.platform&&("EISDIR"===e?.code||"EPERM"===e?.code))return;throw e}try{await h.sync()}catch(e){if(!["EINVAL","ENOTSUP","EOPNOTSUPP"].includes(e?.code))throw e}finally{await h.close()}}`,
    ],
    [
      `async writeJsonlStreamed(e,t){const{filePath:r,appendFile:n}=t;let o=[],s=0,${chunks}=0,`,
      // The whole rewrite runs under the file's lock. Its chunks go to a file of its own, so they need no lock of theirs.
      `async writeJsonlStreamed(e,t){return ${lock}(t.filePath,(()=>this.makoWriteJsonlStreamed(e,t)))}async makoWriteJsonlStreamed(e,t){const{filePath:f}=t,r=f${staged};let o=[],s=0,${chunks}=0,`,
    ],
    [
      `0===${chunks}?await this.writeFile(r,e):await n(r,e),${chunks}++`,
      `await(0,${fs}.writeFile)(r,e,{flag:0===${chunks}?"w":"a"}),${chunks}++`,
    ],
    [
      `await l(),e.span.setAttribute("streamed",!0),e.span.setAttribute("chunkCount",${chunks}),`,
      `await l(),${chunks}>0&&await(async()=>{const t=await(0,${fs}.open)(r,"r+");try{await t.sync()}finally{await t.close()}await(0,${fs}.rename)(r,f),await makoSyncDir(f)})(),e.span.setAttribute("streamed",!0),e.span.setAttribute("chunkCount",${chunks}),`,
    ],
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

/** `logger` is the backend every local run's context logs to. */
const runLog = logger => [`${logger}={log(){}}`, `${logger}={log(e,t){process.emit("mako:cursor-sdk-log",t)}}`]

/**
 * `proto` is the agent protocol module the retry loop builds its actions
 * from: `QFf` a conversation action, `Vtf` a user message action, `RGk` a user
 * message, `xyI` its mode. The hook (`CURSOR_SDK_RESUME_HOOK` in the Cursor
 * child) is asked with the attempt, the action the SDK would send and the
 * run's request id (`Run.requestId`), and answers `{ text, plan }` or
 * nothing; a hook that throws changes nothing.
 */
const resumeAccount = proto => [
  "try{return await s.runAttempt({state:m,action:g,",
  "try{return await s.runAttempt({state:m,action:w>0?await(async()=>{let t;try{t=await globalThis[Symbol.for(\"mako:cursor-sdk-resume\")]?.({attempt:w,action:g.action.case,requestId:a})}catch{}" +
    `if("string"!=typeof t?.text||!t.text)return g;const u=e=>new ${proto}.QFf({action:{case:"userMessageAction",value:new ${proto}.Vtf(e)}});` +
    `if("resumeAction"===g.action.case)return u({userMessage:new ${proto}.RGk({text:t.text,mode:t.plan?${proto}.xyI.PLAN:${proto}.xyI.AGENT})});` +
    `if("userMessageAction"===g.action.case){const e=g.action.value;return u({...e,userMessage:new ${proto}.RGk({...e.userMessage,text:(e.userMessage?.text??"")+"\\n\\n"+t.text})})}return g})():g,`,
]

/** The names `transcripts` takes, in each build of 1.3.1's local executor (1.2.0's `336.js` is `305.js` here, its code the same but for the minifier's names). */
export const TRANSCRIPT_BUILDS = {
  esm: { target: "dist/esm/305.js", writer: "ZO", store: "yM", write: "JO", fs: "Ys", child: "n", chunks: "a" },
  cjs: { target: "dist/cjs/305.js", writer: "YO", store: "SM", write: "QO", fs: "ti", child: "n", chunks: "i" },
}

export const CURSOR_SDK_PATCHES = [
  { target: "dist/esm/index.js", replacements: [...BLOB_STORE, ...BIDI_READS], change: "read-through checkpoint blobs and bidi reads" },
  { target: "dist/cjs/index.js", replacements: [...BLOB_STORE, ...BIDI_READS], change: "read-through checkpoint blobs and bidi reads" },
  { target: "dist/esm/305.js", replacements: [...transcripts(TRANSCRIPT_BUILDS.esm), runLog("EN"), resumeAccount("qr")], change: "incremental transcripts, the run log and the resume account" },
  { target: "dist/cjs/305.js", replacements: [...transcripts(TRANSCRIPT_BUILDS.cjs), runLog("IN"), resumeAccount("Gr")], change: "incremental transcripts, the run log and the resume account" },
  { target: "dist/esm/18.js", replacements: STORE_LOCK_WAIT, change: "a minute's wait for the agent store's lock" },
  { target: "dist/cjs/18.js", replacements: STORE_LOCK_WAIT, change: "a minute's wait for the agent store's lock" },
]

function assertVersion(read) {
  const { version } = JSON.parse(read("package.json"))
  if (version !== VERSION)
    throw new Error(`scripts/patch-cursor-sdk.mjs targets @cursor/sdk ${VERSION}, found ${version}. Check checkpoint blobs, bidi reads, transcript writes, the store's lock wait, the run log and the resume account, then port or delete this patch.`)
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

/**
 * Each target's bytes as npm ships them, from npm's cache when it holds the package: where a target carrying an older
 * or incomplete patch starts again, since a patch can't be undone in place. A checkout whose modules were installed
 * before this patch changed (the updater copies the person's own) has exactly those.
 */
function npmCopy() {
  let folder
  return {
    read(target) {
      if (!folder) {
        folder = mkdtempSync(join(tmpdir(), "mako-cursor-sdk-"))
        const packed = execFileSync("npm", ["pack", `@cursor/sdk@${VERSION}`, "--prefer-offline", "--silent", "--pack-destination", folder], { encoding: "utf8" }).trim().split("\n").pop()
        execFileSync("tar", ["-xzf", join(folder, packed), "-C", folder])
      }
      return readFileSync(join(folder, "package", target), "utf8")
    },
    close: () => folder && rmSync(folder, { recursive: true, force: true }),
  }
}

export function patchCursorSdk(root, shipped = npmCopy()) {
  const read = (target) => readFileSync(join(root, target), "utf8")
  assertVersion(read)
  try {
    for (const target of CURSOR_SDK_PATCHES) patchTarget(root, read, target, shipped)
  } finally {
    shipped.close?.()
  }
  assertCursorSdkPatched(read)
}

function patchTarget(root, read, { target, replacements, change }, shipped) {
  let source = read(target)
  if (replacements.every(([, patched]) => source.includes(patched))) return
  if (source.includes(ANY_MARKER)) {
    source = shipped.read(target)
    console.log(`@cursor/sdk ${target} had an older or incomplete Mako patch; patching npm's copy instead`)
  }
  for (const [from, to] of replacements) {
    const count = source.split(from).length - 1
    if (count !== 1) throw new Error(`@cursor/sdk ${target}: expected one match, found ${count}: ${from.slice(0, 80)}`)
    source = source.replace(from, () => to)
  }
  writeFileSync(join(root, target), source)
  console.log(`patched @cursor/sdk ${target}: ${change}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..", "..")
  if (process.argv.includes("--check")) assertCursorSdkPatched((target) => readFileSync(join(root, target), "utf8"))
  else patchCursorSdk(root)
}
