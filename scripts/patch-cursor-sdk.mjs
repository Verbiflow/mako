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
//
// Each replacement is written against 1.4.0's ESM bytes and found in any release, in either build, by its shape
// (`lib/anchored-patch.mjs`): the bundler's short names may change and chunks may be renumbered; the code an anchor
// stands on may not. A release that changed it fails the install, naming the patch and the anchor that is gone.
// The patch's own locals are `mako$` names, which no bundle uses, so they can't capture one of the bundle's.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { z } from "zod"
import { fileURLToPath } from "node:url"
import { applyAnchored, bind, locate } from "./lib/anchored-patch.mjs"

/** The release the anchors below were written against. Any other is patched by shape, or refused naming why. */
export const CURSOR_SDK_ANCHORED_ON = "1.4.0"
const MARKER = "/*mako:patched:13*/"
const ANY_MARKER = "/*mako:patched"

/**
 * `s` is one transcript file's record: how many root messages it holds, how many summary archives the state had,
 * and the id of its last message. A count of 0 makes the SDK's incremental writer write in full. A full write drops
 * the first of two leading user messages, so a file is rewritten until it holds 16 messages: both are written by then
 * unless 15 are system prompts. `Ij` is the transcript writer's class.
 */
const APPEND_TRANSCRIPT = [
  "appendTranscript(mako$e,mako$t,mako$r,mako$n,mako$o){",
  'const mako$i=mako$e.resolveFilePath(mako$n,"jsonl"),mako$s=Ij.transcripts.get(mako$i)??{count:0,archives:0,last:void 0,chain:Promise.resolve()};Ij.transcripts.set(mako$i,mako$s);',
  'const mako$k=mako$x=>null==mako$x?void 0:"string"==typeof mako$x?mako$x:Buffer.from(mako$x).toString("hex"),mako$a=()=>mako$r.summaryArchives?.length??0;',
  "return mako$s.chain=mako$s.chain.then((()=>{const mako$m=mako$r.rootPromptMessagesJson,mako$c=mako$s.count>=16&&mako$a()===mako$s.archives&&mako$m.length>=mako$s.count&&mako$k(mako$m[mako$s.count-1])===mako$s.last?mako$s.count:0;",
  "return mako$e.writeFromStateIncremental(mako$t,mako$r,mako$n,mako$c,mako$o)})).then((mako$c=>{mako$s.count=mako$c||0,mako$s.archives=mako$a(),mako$s.last=mako$s.count>0?mako$k(mako$r.rootPromptMessagesJson[mako$s.count-1]):void 0}),(()=>{mako$s.count=0})),mako$s.chain}",
].join("")

/** The blob store: `i.nj` keys a blob id, `g` loads every blob of an agent, `R` holds them. */
const CHECKPOINT_BLOBS = [
  ["class R{constructor(t){this.persistBlob=t,this.blobs=new Map}", `${MARKER}class R{constructor(t,mako$r){this.persistBlob=t,this.loadBlob=mako$r,this.blobs=new Map}`],
  [
    "async getBlob(t,r){return this.blobs.get((0,i.nj)(r))}",
    "async getBlob(t,r){const mako$e=(0,i.nj)(r),mako$s=this.blobs.get(mako$e);return void 0===mako$s&&this.loadBlob?await this.loadBlob(mako$e):mako$s}",
  ],
  ["this.blobs.set(n,s),await(this.persistBlob?.(n,s))}", "this.blobs.set(n,s),await(this.persistBlob?.(n,s)),this.loadBlob&&this.blobs.get(n)===s&&this.blobs.delete(n)}"],
  [
    "const e=await this.getScopedAgentDocument(t);return e?.latestCheckpoint?this.setBlobStore(t,await g(this.localStore,t,e.latestCheckpoint)):this.createPersistingBlobStore(t)}",
    "return await this.getScopedAgentDocument(t),this.createPersistingBlobStore(t)}",
  ],
  [
    "createPersistingBlobStore(t){const r=new R(this.createPersistBlob(t));return this.blobStores.set(t,r),r}",
    "createPersistingBlobStore(t){const r=new R(this.createPersistBlob(t),this.createLoadBlob(t));return this.blobStores.set(t,r),r}createLoadBlob(mako$t){return async mako$r=>{const mako$e=await this.localStore.checkpoints.get({agentId:mako$t,blobId:mako$r});return mako$e??void 0}}",
  ],
  [
    "const e=await g(this.localStore,t,r.latestCheckpoint),n=this.setBlobStore(t,e),s=await n.getBlob((0,o.q6)(),T(e.rootBlobId));",
    "const n=this.createPersistingBlobStore(t),s=await n.getBlob((0,o.q6)(),T(r.latestCheckpoint.rootBlobId));",
  ],
  ["const e=await g(this.localStore,t,r.latestCheckpoint),i=new s.We;", "const e=r.latestCheckpoint,i=new s.We;"],
  ["const u=new n.pH(this.setBlobStore(t,e),i);", "const u=new n.pH(this.createPersistingBlobStore(t),i);"],
]

/**
 * `y` rejects when an append fails, `J` when the stream is aborted. One subscription on `y` rejects every read still
 * waiting, not only the latest: two outstanding `next()` calls both reject in the unpatched SDK. A read after the
 * failure rejects at once.
 */
const BIDI_READS = [
  [
    "I={[Symbol.asyncIterator](){const t=B[Symbol.asyncIterator]();return{next:()=>Promise.race([t.next(),y]),",
    "I={[Symbol.asyncIterator](){const t=B[Symbol.asyncIterator]();let mako$f;const mako$o=[];y.catch((mako$t=>{mako$f=[mako$t];for(const mako$r of mako$o)mako$r(mako$t);mako$o.length=0}));return{next:()=>mako$f?Promise.reject(mako$f[0]):new Promise(((mako$r,mako$e)=>{mako$o.push(mako$e),t.next().then((mako$t=>{const mako$n=mako$o.indexOf(mako$e);mako$n<0||mako$o.splice(mako$n,1),mako$r(mako$t)}),(mako$t=>{const mako$n=mako$o.indexOf(mako$e);mako$n<0||mako$o.splice(mako$n,1),mako$e(mako$t)}))})),",
  ],
  ["let g,_;const J=new Promise(((t,r)=>{_=()=>r(new d)}));", "let g,_,mako$z;const J=new Promise(((t,r)=>{_=()=>{const mako$t=new d;r(mako$t),mako$z?.(mako$t)}}));"],
  ["const r=await Promise.race([m.next(),J]);", "const r=await new Promise(((mako$t,mako$r)=>{mako$z=mako$r,m.next().then(mako$t,mako$r)}));"],
]

/** The transcript store's file writer, which binds `fo` (node:fs/promises) and `s` (node:path) where it is. */
const TRANSCRIPT_WRITE = 'async function Pj(e,t){const r=(0,s.dirname)(e);await(0,fo.mkdir)(r,{recursive:!0}),await(0,fo.writeFile)(e,t,"utf-8")}'
/** The streamed writer's head, which binds the file it writes as `r`. */
const STREAMED_HEAD = "async writeJsonlStreamed(e,t){const{filePath:r,appendFile:n}=t;let o=[],s=0,i=0,"
/** The transcript writer's class, `Ij`. */
const WRITER_CLASS = "class Ij{constructor(e){this.writeChain=Promise.resolve(),"
const STAGED = '+".mako-"+process.pid+".tmp"'
/**
 * The bundle's `fs` only carries the functions it already calls, so `appendFile` is not among them: passing
 * `fs.appendFile` stores `undefined`, and every transcript write then hydrates the whole conversation at once.
 * `writeFile` with flag `a` is the same call.
 */
const WRITER_OPTIONS = 'writeText:!1,writeJsonl:!0,appendFile:(mako$p,mako$d)=>makoLock(mako$p,(()=>fo.writeFile(mako$p,mako$d,{flag:"a"}))),streamFullJsonlWrites:!0,'

/** `rO` is the transcript store's class, `n` the subagent whose transcript the nested store writes. */
const TRANSCRIPTS = [
  [
    TRANSCRIPT_WRITE,
    `async function Pj(e,t){return makoLock(e,(async()=>{const r=(0,s.dirname)(e);await(0,fo.mkdir)(r,{recursive:!0});const mako$n=e${STAGED},mako$o=await(0,fo.open)(mako$n,"w");try{await mako$o.writeFile(t,"utf-8"),await mako$o.sync()}finally{await mako$o.close()}await(0,fo.rename)(mako$n,e),await makoSyncDir(e)}))}` +
      // Runs `work` inside the process's transcript lock (`transcript-lock.ts`); outside Mako's child there is none.
      'function makoLock(mako$p,mako$w){const mako$k=globalThis[Symbol.for("mako:cursor-transcript-lock")];return mako$k?mako$k(mako$p,mako$w):mako$w()}' +
      // A rename is durable once its folder is synced. Windows can't open a folder as a file (EISDIR, or EPERM),
      // and makes a rename durable without it; a file system that can't sync a folder says so (EINVAL, ENOTSUP,
      // EOPNOTSUPP). Any other failure is a rename that may not last, so the write fails.
      'async function makoSyncDir(mako$p){const mako$d=(0,s.dirname)(mako$p);let mako$h;try{mako$h=await(0,fo.open)(mako$d,"r")}catch(mako$e){if("win32"===process.platform&&("EISDIR"===mako$e?.code||"EPERM"===mako$e?.code))return;throw mako$e}try{await mako$h.sync()}catch(mako$e){if(!["EINVAL","ENOTSUP","EOPNOTSUPP"].includes(mako$e?.code))throw mako$e}finally{await mako$h.close()}}',
  ],
  [
    STREAMED_HEAD,
    // The whole rewrite runs under the file's lock. Its chunks go to a file of its own, so they need no lock of theirs.
    `async writeJsonlStreamed(e,t){return makoLock(t.filePath,(()=>this.makoWriteJsonlStreamed(e,t)))}async makoWriteJsonlStreamed(e,t){const{filePath:mako$f}=t,r=mako$f${STAGED};let o=[],s=0,i=0,`,
  ],
  ["0===i?await this.writeFile(r,e):await n(r,e),i++", 'await(0,fo.writeFile)(r,e,{flag:0===i?"w":"a"}),i++', { binds: [TRANSCRIPT_WRITE] }],
  [
    'await c(),e.span.setAttribute("streamed",!0),e.span.setAttribute("chunkCount",i),',
    'await c(),i>0&&await(async()=>{const mako$t=await(0,fo.open)(r,"r+");try{await mako$t.sync()}finally{await mako$t.close()}await(0,fo.rename)(r,mako$f),await makoSyncDir(mako$f)})(),e.span.setAttribute("streamed",!0),e.span.setAttribute("chunkCount",i),',
    { binds: [TRANSCRIPT_WRITE, STREAMED_HEAD] },
  ],
  [WRITER_CLASS, `${MARKER}class Ij{static transcripts=new Map;constructor(e){this.writeChain=Promise.resolve(),`],
  [
    "this.transcriptStore=new rO(this.projectDir,e.blobStore,Pj,{writeText:!1,writeJsonl:!0,...t?",
    `this.transcriptStore=new rO(this.projectDir,e.blobStore,Pj,{${WRITER_OPTIONS}...t?`,
    { binds: [TRANSCRIPT_WRITE] },
  ],
  [
    "this.nestedSubagentTranscriptStore=new rO(this.projectDir,e.blobStore,Pj,{writeText:!1,writeJsonl:!0,",
    `this.nestedSubagentTranscriptStore=new rO(this.projectDir,e.blobStore,Pj,{${WRITER_OPTIONS}`,
    { binds: [TRANSCRIPT_WRITE] },
  ],
  ["await this.transcriptStore.writeFromStateFull(e,t,this.conversationId);", "await this.appendTranscript(this.transcriptStore,e,t,this.conversationId);"],
  [
    "await this.nestedSubagentTranscriptStore.writeFromStateFull(e,n.conversationState,t)",
    "await this.appendTranscript(this.nestedSubagentTranscriptStore,e,n.conversationState,t)",
  ],
  [
    "await this.transcriptStore.writeFromStateFull(e,t,this.conversationId,{turnEnded:r})",
    "await this.appendTranscript(this.transcriptStore,e,t,this.conversationId,{turnEnded:r})",
  ],
  ["waitForPendingWrites(){return this.writeChain}", APPEND_TRANSCRIPT + "waitForPendingWrites(){return this.writeChain}", { binds: [WRITER_CLASS] }],
]

/** `oB` is the backend every local run's context logs to. */
const RUN_LOG = [["oB={log(){}}", 'oB={log(mako$e,mako$t){process.emit("mako:cursor-sdk-log",mako$t)}}']]

/**
 * In the retry loop `y` is the attempt, `w` the action it sends, `g` the checkpoint, `c` the run's request id
 * (`Run.requestId`), and `i` the agent protocol module the loop builds its actions from: `QFf` a conversation action,
 * `Vtf` a user message action, `RGk` a user message, `xyI` its mode. The hook (`CURSOR_SDK_RESUME_HOOK` in the Cursor
 * child) is asked with the attempt, the action the SDK would send and the request id, and answers `{ text, plan }` or
 * nothing; a hook that throws changes nothing. The anchor holds only the action and the checkpoint, so the probes bind
 * the rest: 1.4.1 moved the attempt off `y` and put the action there.
 */
const RESUME_ACCOUNT = [
  [
    "try{return await s.runAttempt({state:g,action:w,",
    'try{return await s.runAttempt({state:g,action:y>0?await(async()=>{let mako$t;try{mako$t=await globalThis[Symbol.for("mako:cursor-sdk-resume")]?.({attempt:y,action:w.action.case,requestId:c})}catch{}' +
      'if("string"!=typeof mako$t?.text||!mako$t.text)return w;const mako$u=mako$e=>new i.QFf({action:{case:"userMessageAction",value:new i.Vtf(mako$e)}});' +
      'if("resumeAction"===w.action.case)return mako$u({userMessage:new i.RGk({text:mako$t.text,mode:mako$t.plan?i.xyI.PLAN:i.xyI.AGENT})});' +
      'if("userMessageAction"===w.action.case){const mako$e=w.action.value;return mako$u({...mako$e,userMessage:new i.RGk({...mako$e.userMessage,text:(mako$e.userMessage?.text??"")+"\\n\\n"+mako$t.text})})}return w})():w,',
    { binds: ["s.beginAttempt?.({attempt:y,originalRequestId:c})", 'new i.QFf({action:{case:"resumeAction"'] },
  ],
]

const STORE_LOCK_WAIT = [["PRAGMA busy_timeout = 5000;", "PRAGMA busy_timeout = 60000;"]]

/** Each patch once: what it is for, the 1.4.0 chunk it was written in (where to look first) and its replacements. */
const PATCHES = [
  { id: "checkpoint-blobs", change: "read-through checkpoint blobs", chunk: "index.js", replacements: CHECKPOINT_BLOBS },
  { id: "bidi-reads", change: "bidi reads that let go of each message", chunk: "index.js", replacements: BIDI_READS },
  { id: "transcripts", change: "incremental, locked transcript writes", chunk: "993.js", replacements: TRANSCRIPTS },
  { id: "run-log", change: "the run log", chunk: "993.js", replacements: RUN_LOG },
  { id: "resume-account", change: "the resume account", chunk: "993.js", replacements: RESUME_ACCOUNT },
  { id: "store-lock-wait", change: "a minute's wait for the agent store's lock", chunk: "18.js", replacements: STORE_LOCK_WAIT },
]

/** Every patch for each build. `target` is where it was in 1.4.0; `sites` its replacements as anchored sites. */
export const CURSOR_SDK_PATCHES = ["esm", "cjs"].flatMap((build) =>
  PATCHES.map(({ id, change, chunk, replacements }) => ({
    id,
    build,
    change,
    target: `dist/${build}/${chunk}`,
    sites: replacements.map(([from, to, { binds } = {}], at) => ({ from, to, binds, label: `${change} (${build}, replacement ${at + 1} of ${replacements.length})` })),
  })),
)

/** The files of each build, from a folder or an archive's listing. */
export const folderFiles = (root) => (build) => readdirSync(join(root, "dist", build)).filter((file) => file.endsWith(".js"))

/**
 * The file of `patch`'s build holding every one of its sites, by their unpatched text or, with `patched`, by what
 * the patch wrote: the one file that holds them all, or the 1.4.0 chunk's name when several do.
 */
export function patchFile(read, files, patch, patched = false) {
  const holders = files(patch.build).filter((file) => {
    const source = read(`dist/${patch.build}/${file}`)
    return patch.sites.every((site) => locate(source, patched ? site.to : site.from).count === 1 && (patched || site.binds?.every((probe) => locate(source, probe).count === 1) !== false))
  })
  const chunk = patch.target.split("/").pop()
  const file = holders.length === 1 ? holders[0] : holders.includes(chunk) ? chunk : undefined
  return file && `dist/${patch.build}/${file}`
}

/**
 * Where `patch` is in an installed, patched SDK, with each site's names in this release (1.4.0's name to this
 * one's), its anchor's and its probes'. Tests run the patched code through these.
 */
export function installedPatch(read, files, id, build) {
  const patch = CURSOR_SDK_PATCHES.find((entry) => entry.id === id && entry.build === build)
  const file = patchFile(read, files, patch, true)
  if (!file) throw new Error(`@cursor/sdk ${build} lacks Mako's ${patch.change} patch; run scripts/patch-cursor-sdk.mjs`)
  const source = read(file)
  // A probe's text in a patched file may be what the patch wrote over it: find it either way.
  const sites = patch.sites.map((site) => {
    const at = locate(source, site.to)
    for (const probe of site.binds ?? []) {
      const bound = [probe, ...patch.sites.concat(CURSOR_SDK_PATCHES.filter((other) => other.build === build).flatMap((other) => other.sites)).filter((other) => other.from === probe).map((other) => other.to)]
        .map((text) => locate(source, text))
        .find((hit) => hit.count === 1)
      if (!bound) throw new Error(`${site.label}: probe gone: ${probe.slice(0, 100)}`)
      for (const [old, now] of bound.names) if (!at.names.has(old)) at.names.set(old, now)
    }
    return { ...site, index: at.index, length: at.length, names: at.names }
  })
  return { file, source, sites }
}

function noteVersion(read) {
  const { version } = JSON.parse(read("package.json"))
  if (version !== CURSOR_SDK_ANCHORED_ON) console.log(`@cursor/sdk ${version}: Mako's patches were written against ${CURSOR_SDK_ANCHORED_ON}; finding them by shape`)
  return version
}

/** Checks every patch, including the SDK bytes inside the built archive, whose files `files` lists. */
export function assertCursorSdkPatched(read, files) {
  const version = noteVersion(read)
  const missing = CURSOR_SDK_PATCHES.filter((patch) => !patchFile(read, files, patch, true))
  if (missing.length)
    throw new Error(`@cursor/sdk ${version} lacks Mako's complete ${missing.map((patch) => `${patch.change} (${patch.build})`).join(", ")} patch; rebuild with scripts/patch-cursor-sdk.mjs`)
}

/** Beside the package: the bytes of each file before Mako first patched it, so a patch can start again from them. */
export const PRISTINE_FOLDER = ".mako-pristine"
/** The store's record: the package version its bytes are of, and each kept file's sha256. */
const PristineManifest = z.object({ version: z.string(), files: z.record(z.string(), z.string()) })
const sha256 = (text) => createHash("sha256").update(text).digest("hex")

/**
 * What the installed files were before any patch, kept the first time each is patched (`.mako-pristine`, gzipped, with
 * the package's version and each file's hash). Kept for another version, or with bytes that don't hash to what was
 * kept, they are not there: `missing` says why.
 */
export function pristineStore(root, version) {
  const folder = join(root, PRISTINE_FOLDER)
  const manifestFile = join(folder, "manifest.json")
  const load = () => {
    if (!existsSync(manifestFile)) return { manifest: { version, files: {} }, why: `nothing is kept in ${PRISTINE_FOLDER}` }
    try {
      const parsed = PristineManifest.safeParse(JSON.parse(readFileSync(manifestFile, "utf8")))
      if (!parsed.success) return { manifest: { version, files: {} }, why: `${PRISTINE_FOLDER}/manifest.json isn't a manifest` }
      const manifest = parsed.data
      if (manifest.version !== version) return { manifest: { version, files: {} }, why: `${PRISTINE_FOLDER} holds @cursor/sdk ${manifest.version}'s bytes, not ${version}'s` }
      return { manifest }
    } catch (error) {
      return { manifest: { version, files: {} }, why: `${PRISTINE_FOLDER}/manifest.json can't be read: ${error.message}` }
    }
  }
  let state = load()
  return {
    get(target) {
      const hash = state.manifest.files[target]
      if (!hash) return { why: state.why ?? `${PRISTINE_FOLDER} keeps nothing of ${target}` }
      try {
        const text = gunzipSync(readFileSync(join(folder, `${target}.gz`))).toString("utf8")
        return sha256(text) === hash ? { text } : { why: `${PRISTINE_FOLDER}'s copy of ${target} doesn't hash to what was kept` }
      } catch (error) {
        return { why: `${PRISTINE_FOLDER}'s copy of ${target} can't be read: ${error.message}` }
      }
    },
    save(target, text) {
      if (text.includes(ANY_MARKER)) throw new Error(`refusing to keep a patched ${target} as its pristine bytes`)
      const file = join(folder, `${target}.gz`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, gzipSync(text))
      renameSync(`${file}.tmp`, file)
      state = { manifest: { version, files: { ...state.manifest.files, [target]: sha256(text) } } }
      writeFileSync(`${manifestFile}.tmp`, `${JSON.stringify(state.manifest, null, 2)}\n`)
      renameSync(`${manifestFile}.tmp`, manifestFile)
    },
  }
}

/** The lockfile's record of the installed package: npm writes it into `node_modules/.package-lock.json`. */
const LockEntry = z.object({ version: z.string(), integrity: z.string() })
const HiddenLock = z.object({ packages: z.record(z.string(), z.unknown()) })

/**
 * The package's files as npm shipped them, from the tarball npm's own cache on this machine holds, found by the
 * integrity the install recorded and checked against it; no npm request and no network. For modules a build before
 * `.mako-pristine` patched, which a local update's `npm install` keeps as they are. A failure says what was looked for.
 */
export function npmCacheCursorSdk(root, version) {
  let folder
  const tarball = () => {
    const lockFile = join(root, "..", "..", ".package-lock.json")
    if (!existsSync(lockFile)) throw new Error(`no ${lockFile} names the installed tarball`)
    const entry = LockEntry.safeParse(HiddenLock.parse(JSON.parse(readFileSync(lockFile, "utf8"))).packages["node_modules/@cursor/sdk"])
    if (!entry.success || entry.data.version !== version) throw new Error(`${lockFile} records no @cursor/sdk ${version}`)
    const [algorithm, digest] = entry.data.integrity.split(/-(.*)/s)
    const hex = Buffer.from(digest, "base64").toString("hex")
    // npm says where its cache is to the scripts it runs; asked otherwise, it answers from its configuration alone.
    let cache = process.env.npm_config_cache
    if (!cache) try {
      cache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    } catch (error) {
      throw new Error(`npm couldn't say where its cache is (exited ${error.status ?? error.signal}: ${`${error.stderr ?? ""}`.trim().split("\n").pop()})`)
    }
    const file = join(cache, "_cacache", "content-v2", algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
    if (!existsSync(file)) throw new Error(`npm's cache at ${cache} holds no tarball with @cursor/sdk ${version}'s integrity ${entry.data.integrity.slice(0, 24)}…`)
    const bytes = readFileSync(file)
    if (createHash(algorithm).update(bytes).digest("base64") !== digest) throw new Error(`npm's cached tarball for @cursor/sdk ${version} doesn't match its integrity`)
    return file
  }
  return {
    read(target) {
      if (!folder) {
        const file = tarball()
        folder = mkdtempSync(join(tmpdir(), "mako-cursor-sdk-"))
        execFileSync("tar", ["-xzf", file, "-C", folder], { stdio: ["ignore", "ignore", "pipe"] })
      }
      return readFileSync(join(folder, "package", target), "utf8")
    },
    close: () => folder && rmSync(folder, { recursive: true, force: true }),
  }
}

/**
 * Patches every build, with no network. A file that needs a patch takes every patch that lives in it at once, each
 * found in its unpatched bytes before any is written: the installed bytes when it carries no patch (kept then in
 * `.mako-pristine` before the first write), else what `.mako-pristine` kept, else npm's local cache (`cache`), else
 * it fails saying why and how to get the bytes back.
 */
export function patchCursorSdk(root, cache) {
  const read = (target) => readFileSync(join(root, target), "utf8")
  const files = folderFiles(root)
  const version = noteVersion(read)
  const pristine = pristineStore(root, version)
  cache ??= npmCacheCursorSdk(root, version)
  const failures = []
  try {
    for (const build of ["esm", "cjs"]) {
      const patches = CURSOR_SDK_PATCHES.filter((patch) => patch.build === build)
      const done = new Map(patches.map((patch) => [patch, patchFile(read, files, patch, true)]).filter(([, file]) => file))
      if (done.size === patches.length) continue
      // A file holding a patch, this one complete or any earlier one, starts again from its unpatched bytes, with every
      // patch that lives in it: a patch can't be undone in place, and some (the lock wait) leave no marker.
      const holding = new Set(done.values())
      const original = new Map()
      const unpatched = (target) => {
        if (!original.has(target)) {
          const source = read(target)
          if (!source.includes(ANY_MARKER) && !holding.has(target)) original.set(target, { text: source, keep: true })
          else {
            const kept = pristine.get(target)
            if (kept.text !== undefined) original.set(target, { text: kept.text })
            else {
              let text
              try {
                text = cache.read(target)
              } catch (error) {
                throw new Error(`@cursor/sdk ${version}'s ${target} carries an earlier Mako patch, and its unpatched bytes are neither kept beside it (${kept.why}) nor in npm's cache (${error.message}). Reinstall the package to get them back: rm -rf node_modules/@cursor/sdk && npm install`)
              }
              original.set(target, { text, keep: true })
            }
          }
        }
        return original.get(target).text
      }
      // Where a patch lives is looked for in each file's bytes as they are, unless an earlier patch's marker says they
      // were rewritten: a file holding only a finished patch (the lock wait) still holds every other anchor it had.
      // A marked file whose unpatched bytes can't be had is searched as it is: that only matters if the patch lives there.
      const blocked = new Map()
      const searched = (target) => {
        if (!read(target).includes(ANY_MARKER)) return read(target)
        try {
          return unpatched(target)
        } catch (error) {
          blocked.set(target, error)
          return read(target)
        }
      }
      const byFile = new Map()
      for (const patch of patches) {
        const file = done.get(patch) ?? patchFile(searched, files, patch)
        if (file) byFile.set(file, [...(byFile.get(file) ?? []), patch])
        else if (blocked.size) throw blocked.get(patch.target) ?? [...blocked.values()][0]
        else failures.push(explain(searched, files, patch))
      }
      if (failures.length) continue
      for (const [file, here] of byFile) {
        if (here.every((patch) => done.get(patch) === file)) continue
        const base = unpatched(file)
        const { source, renamed } = applyAnchored(base, here.flatMap((patch) => patch.sites))
        if (original.get(file).keep) pristine.save(file, base)
        writeFileSync(join(root, file), source)
        console.log(`patched @cursor/sdk ${file}: ${here.map((patch) => patch.change).join(", ")}${renamed.length ? ` (here ${renamed.join(" ")})` : ""}`)
      }
    }
    // Every file holding a patch keeps its unpatched bytes, so the next patch of it needs nothing else: one an earlier
    // build patched, and this one left as it was, takes them from npm's cache when it holds them, and goes without
    // otherwise (a patch that later needs them says so then).
    if (!failures.length)
      for (const patch of CURSOR_SDK_PATCHES) {
        const file = patchFile(read, files, patch, true)
        if (!file || pristine.get(file).text !== undefined) continue
        try {
          const text = cache.read(file)
          if (!text.includes(ANY_MARKER)) pristine.save(file, text)
        } catch {
          // Nothing cached: kept the next time the file is rewritten from bytes it can read.
        }
      }
  } finally {
    cache.close?.()
  }
  if (failures.length)
    throw new Error(`@cursor/sdk ${version} changed the code Mako's patches stand on (written against ${CURSOR_SDK_ANCHORED_ON}):\n${failures.join("\n")}\nPort each of those patches, or delete it where ${version} does the same itself.`)
  assertCursorSdkPatched(read, files)
}

/** Why no file holds `patch`: its sites' problems in the file that still holds the most of them. */
function explain(read, files, patch) {
  const problems = (file) => {
    const source = read(file)
    return patch.sites.flatMap((site) => {
      const hit = bind(source, site)
      return hit.problems ? hit.problems.map((problem) => `  ${site.label}: ${problem}`) : []
    })
  }
  const nearest = files(patch.build)
    .map((file) => `dist/${patch.build}/${file}`)
    .map((file) => ({ file, problems: problems(file) }))
    .sort((a, b) => a.problems.length - b.problems.length)[0]
  return `- ${patch.change} (${patch.build}; ${patch.target} in ${CURSOR_SDK_ANCHORED_ON}), nearest ${nearest.file}:\n${nearest.problems.join("\n") || "  every site is there, but more than one file holds them"}`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..", "..")
  if (process.argv.includes("--check")) assertCursorSdkPatched((target) => readFileSync(join(root, target), "utf8"), folderFiles(root))
  else patchCursorSdk(root)
}
