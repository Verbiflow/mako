import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { videoHelperExecutable } from "../dist/video-helper.js"
import { recordingVideoEncoding } from "../dist/recording-encoder-process.js"

// The video helper Mako records and streams with: the configured one when it exists, an absolute path only, else
// PATH's, else a checkout's build; refused, never guessed, when the configured one isn't there.
assert.equal(recordingVideoEncoding().codec, "h264")
const directory = await realpath(await mkdtemp(join(tmpdir(), "mako-media-paths-")))
const original = process.env.MAKO_VIDEO_HELPER
try {
  const configured = join(directory, "mako-video")
  await writeFile(join(configured), "fixture", { mode: 0o755 })
  process.env.MAKO_VIDEO_HELPER = configured
  assert.equal(videoHelperExecutable(), configured)
  process.env.MAKO_VIDEO_HELPER = "relative/mako-video"
  assert.equal(videoHelperExecutable(), undefined, "a relative path is refused")
  process.env.MAKO_VIDEO_HELPER = join(directory, "missing")
  assert.equal(videoHelperExecutable(), undefined, "a configured helper that isn't there is refused, not replaced")
  console.log("Media paths: the configured video helper, relative and missing refusal passed")
} finally {
  if (original === undefined) delete process.env.MAKO_VIDEO_HELPER
  else process.env.MAKO_VIDEO_HELPER = original
  await rm(directory, { recursive: true, force: true })
}
