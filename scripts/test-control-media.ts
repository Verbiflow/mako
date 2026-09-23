import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mediaExecutable } from "../electron/control-media.js"

const root = await mkdtemp(join(tmpdir(), "mako-media-resolver-"))
const prior = Object.getOwnPropertyDescriptor(process, "resourcesPath")
try {
  Object.defineProperty(process, "resourcesPath", { configurable: true, value: root })
  assert.match(mediaExecutable("ffmpeg"), /vendor\/control-media\/darwin-arm64\/ffmpeg$/)
  await writeFile(join(root, "app.asar"), "fixture")
  assert.throws(() => mediaExecutable("ffmpeg"), /missing its recording encoder/)
  const media = join(root, "control-media", `${process.platform}-${process.arch}`)
  await mkdir(media, { recursive: true })
  await writeFile(join(media, "ffmpeg"), "fixture")
  assert.equal(mediaExecutable("ffmpeg"), join(media, "ffmpeg"))
  assert.throws(() => mediaExecutable("ffprobe"), /missing its recording encoder/)
} finally {
  if (prior) Object.defineProperty(process, "resourcesPath", prior)
  else Reflect.deleteProperty(process, "resourcesPath")
  await rm(root, { recursive: true, force: true })
}
console.log("Recording executable resolution passed")
