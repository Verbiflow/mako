import assert from "node:assert/strict"
import { mkdtemp, mkdir, copyFile, writeFile, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { mediaExecutable } from "../dist/control-media.js"
const directory = await realpath(await mkdtemp(join(tmpdir(), "mako-media-paths-")))
const original = process.env.MAKO_CONTROL_MEDIA_ROOT
try {
  const configured = join(directory, "configured")
  await mkdir(configured)
  for (const name of ["ffmpeg", "ffprobe"]) await writeFile(join(configured, name), "fixture")
  process.env.MAKO_CONTROL_MEDIA_ROOT = configured
  assert.equal(mediaExecutable("ffmpeg"), join(configured, "ffmpeg"))
  process.env.MAKO_CONTROL_MEDIA_ROOT = "relative"
  assert.throws(() => mediaExecutable("ffmpeg"), /must be absolute/)
  process.env.MAKO_CONTROL_MEDIA_ROOT = configured
  const resources = join(directory, "Mako.app/Contents/Resources")
  const modules = join(resources, "app.asar/node_modules/@mako/control-runtime/dist")
  await mkdir(modules, {recursive:true})
  for (const name of ["control-media", "executable"])
    await copyFile(new URL(`../dist/${name}.js`, import.meta.url), join(modules, `${name}.js`))
  await writeFile(join(modules, "package.json"), '{"type":"module"}')
  const packaged = await import(pathToFileURL(join(modules, "control-media.js")).href)
  assert.throws(() => packaged.mediaExecutable("ffmpeg"), /missing its recording encoder/)
  const binaries = join(resources, "control-media", `${process.platform}-${process.arch}`)
  await mkdir(binaries, {recursive:true})
  await writeFile(join(binaries, "ffmpeg"), "reviewed fixture")
  assert.equal(packaged.mediaExecutable("ffmpeg"), join(binaries, "ffmpeg"), "Packaged resources take priority over ambient overrides")
  console.log("Media paths: explicit Node configuration, packaged resources and missing-binary refusal passed")
} finally {
  if (original === undefined) delete process.env.MAKO_CONTROL_MEDIA_ROOT
  else process.env.MAKO_CONTROL_MEDIA_ROOT = original
  await rm(directory, {recursive:true,force:true})
}
