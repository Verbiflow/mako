import { ControlCliProbe } from "./lib/control-cli-probe.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { ensureCuaEmbedded, stopCuaEmbedded } from "../dist-electron/cua-embedded.js"
import { resolveExecutable } from "../dist-electron/executable.js"
import { frontmostPid, sampleFrontmost } from "./lib/control-fixture.mjs"

// Uses the selected signed driver through the same shared engine as CLI/MCP.
// Invoke with ELECTRON_RUN_AS_NODE=1 from the installed Mako permission host.
const run = promisify(execFile)
const seconds = Number(process.argv[2] ?? 60)
const fps = Number(process.argv[3] ?? 60)
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 120)
assert.ok(Number.isInteger(fps) && fps >= 1 && fps <= 60)
const root = await mkdtemp(join(tmpdir(), "mkr-"))
const bundle = join(root, "Mako Capture Rate.app")
const binary = join(bundle, "Contents/MacOS/fixture")
const status = join(root, "state.json")
await mkdir(join(bundle, "Contents/MacOS"), { recursive: true })
await run("xcrun", ["swiftc", "-O", "scripts/lib/native-capture-rate-fixture.swift", "-o", binary], {timeout:180000})
await writeFile(join(bundle, "Contents/Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleIdentifier</key><string>dev.mako.capture-rate</string><key>CFBundleName</key><string>Mako Capture Rate</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>')
await run("codesign", ["--force", "--sign", "-", bundle])
const evidence = {status:"running", root, requested:{seconds,fps}, calls:[]}
const client = new ControlCliProbe({name:"native-capture-rate",version:"1"})
let pid
let sampler
async function cell(source) {
  let result = await client.request({method:"exec",arguments:{source}}, {timeout:70000})
  
  evidence.calls.push({source,result})
  assert.ok(!result.isError,JSON.stringify(result))
  const value = JSON.parse(result.content.filter(part => part.type === "text").at(-1).text)
  assert.ok(!value.code,JSON.stringify(value))
  return value
}
try {
  evidence.frontmostBefore = await frontmostPid()
  sampler = sampleFrontmost()
  await run("open", ["-n", "-g", bundle, "--args", status])
  let initial
  for (let count=0;count<100;count++) {
    initial = await readFile(status,"utf8").then(JSON.parse).catch(() => null)
    if (initial) break
    await delay(100)
  }
  assert.ok(initial)
  pid = initial.pid
  evidence.initial = initial
  const driver = resolveExecutable("cua-driver")
  evidence.driver = {path:driver,version:(await run(driver,["--version"])).stdout.trim()}
  const socket = await ensureCuaEmbedded(join(root,"driver"),"dev.mako.capture-rate")
  await client.start({native:{driver:driver,socket:socket},env:{...process.env}})
  if (process.env.MAKO_RATE_PREOBSERVE === "1") await cell(`return await control.window({pid:${pid},window_id:${initial.window}}).observe()` )
  await cell(`state.window=control.window({pid:${pid},window_id:${initial.window}});state.recording=await state.window.record({directory:${JSON.stringify(root)},fps:${fps},maxSide:1920,cursor:false,maxDurationMs:${(seconds+20)*1000}});return state.recording`)
  await delay(seconds*1000)
  evidence.fixture = JSON.parse(await readFile(status,"utf8"))
  let receipt = await cell("return await state.recording.stop()")
  for (let count=0;receipt.status === "finalizing" && count<120;count++) {
    await delay(1000)
    receipt = await cell("return await state.recording.status()")
  }
  evidence.recording = receipt
  assert.equal(receipt.status,"finished",JSON.stringify(receipt))
  assert.deepEqual(receipt.dimensions,{width:1920,height:1080})
  const source = join(receipt.directory,"source.mp4")
  evidence.probe = JSON.parse((await run("ffprobe",["-v","error","-show_streams","-show_format","-of","json",source],{maxBuffer:65536})).stdout)
  // The marker occupies y=40..80 in top-down 1080p coordinates. Decode only
  // this crop; exact binary blocks reveal repeated and missed source frames.
  const {stdout:pixels} = await run("ffmpeg",["-v","error","-i",source,"-vf","crop=768:40:32:40","-fps_mode","passthrough","-pix_fmt","gray","-f","rawvideo","pipe:1"],{encoding:"buffer",maxBuffer:256*1024*1024,timeout:120000})
  const stride = 768*40
  assert.equal(pixels.length % stride,0)
  const ids=[]
  for(let offset=0;offset<pixels.length;offset+=stride) {
    let id=0
    for(let bit=0;bit<16;bit++) if(pixels[offset+20*768+bit*48+20]>128) id |= 1<<bit
    ids.push(id)
  }
  const distinct = ids.filter((id,index) => index===0 || id!==ids[index-1]).length
  evidence.source = {frames:ids.length,distinct,seconds:Number(evidence.probe.format.duration),distinctFps:distinct/Number(evidence.probe.format.duration),firstIds:ids.slice(0,20)}
  evidence.foreground = [...await sampler.stop()]
  sampler = null
  evidence.acceptance = {
    foregroundUnchanged: evidence.foreground.every(([actual]) => actual===evidence.frontmostBefore),
    sustainedRate: evidence.source.distinctFps >= fps*0.95,
  }
  // A foreground change may be human activity or another process. Preserve
  // both results without attributing the change to capture from sampling alone.
  assert.ok(evidence.acceptance.foregroundUnchanged,"Foreground changed during the run; unchanged-foreground acceptance was not established")
  assert.ok(evidence.acceptance.sustainedRate,JSON.stringify(evidence.source))
  evidence.status="passed"
} catch(error) {
  evidence.status="failed"
  evidence.error=String(error)
  process.exitCode=1
} finally {
  await client.close().catch(() => {})
  await stopCuaEmbedded()
  if(pid) try {process.kill(pid,"SIGTERM")} catch {}
  if(sampler) evidence.foreground=[...await sampler.stop()]
  await writeFile(join(root,"evidence.json"),JSON.stringify(evidence,null,2))
  console.log(JSON.stringify({status:evidence.status,root,source:evidence.source,error:evidence.error}))
}
