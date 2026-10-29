import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { fetchSources, readManifest, sha256, sourceIdentity } from "./lib/control-media-sources.mjs"

// The recording media's sources come from whichever listed URL serves the bytes their hash names, so one host being
// down (FFmpeg's own timed out CI's Linux host build again and again) only moves the fetch to the next.
const scratch = await mkdtemp(join(tmpdir(), "mako-media-sources-"))
try {
  const bytes = Buffer.from("the source archive")
  const source = (urls) => ({ name: "fixture", version: "1", archive: "fixture.tar.xz", sha256: sha256(bytes), urls })
  const serving = (served) => {
    const calls = []
    const download = async (url, file) => {
      calls.push(url)
      if (!(url in served)) throw new Error(`curl: (28) Connection timed out: ${url}`)
      await writeFile(file, served[url])
    }
    return { calls, download }
  }

  {
    // A host that times out and one that serves other bytes are passed over for the next; only matching bytes land.
    const directory = join(scratch, "fallback")
    const { calls, download } = serving({ "https://altered.example/a": Buffer.from("not the source"), "https://origin.example/a": bytes })
    const fetched = await fetchSources({ sources: [source(["https://down.example/a", "https://altered.example/a", "https://origin.example/a"])] }, directory, download)
    assert.deepEqual(calls, ["https://down.example/a", "https://altered.example/a", "https://origin.example/a"])
    assert.deepEqual(fetched, [{ archive: "fixture.tar.xz", from: "https://origin.example/a" }])
    assert.deepEqual(await readFile(join(directory, "fixture.tar.xz")), bytes)
    assert.deepEqual(await readdir(directory), ["fixture.tar.xz"], "no partial download is left beside the archive")

    // Held with the right hash, it is never fetched again: what CI's cache restores is used as it is.
    const again = serving({})
    assert.deepEqual(await fetchSources({ sources: [source(["https://origin.example/a"])] }, directory, again.download), [{ archive: "fixture.tar.xz", from: "held" }])
    assert.deepEqual(again.calls, [])
  }

  {
    // A held archive whose bytes don't match (cut short, or altered) is replaced, never used.
    const directory = join(scratch, "stale")
    await mkdir(directory)
    await writeFile(join(directory, "fixture.tar.xz"), bytes.subarray(0, 5))
    const { download } = serving({ "https://origin.example/a": bytes })
    assert.deepEqual(await fetchSources({ sources: [source(["https://origin.example/a"])] }, directory, download), [{ archive: "fixture.tar.xz", from: "https://origin.example/a" }])
    assert.deepEqual(await readFile(join(directory, "fixture.tar.xz")), bytes)
  }

  {
    // No URL serving the bytes is a failure naming each URL's reason, and leaves nothing behind.
    const directory = join(scratch, "unserved")
    const { download } = serving({ "https://altered.example/a": Buffer.from("not the source") })
    await assert.rejects(fetchSources({ sources: [source(["https://down.example/a", "https://altered.example/a"])] }, directory, download), (error) => {
      assert.match(error.message, /No URL served fixture\.tar\.xz/)
      assert.match(error.message, /https:\/\/down\.example\/a: curl: \(28\) Connection timed out/)
      assert.match(error.message, new RegExp(`https://altered\\.example/a: sha256 ${sha256(Buffer.from("not the source"))}`))
      return true
    })
    assert.deepEqual(await readdir(directory), [])
  }

  {
    // The real downloader: a refused connection fails at once and the next URL serves.
    const directory = join(scratch, "curl")
    const served = join(scratch, "served.tar.xz")
    await writeFile(served, bytes)
    const fetched = await fetchSources({ sources: [source(["https://127.0.0.1:1/fixture.tar.xz", pathToFileURL(served).href])] }, directory)
    assert.deepEqual(fetched, [{ archive: "fixture.tar.xz", from: pathToFileURL(served).href }])
    assert.deepEqual(await readFile(join(directory, "fixture.tar.xz")), bytes)
  }

  {
    // The checked-in manifest: HTTPS only, and FFmpeg's own site is the last resort, after mirrors on other hosts.
    const manifest = await readManifest(process.cwd())
    const ffmpeg = manifest.sources.find((entry) => entry.name === "ffmpeg")
    const hosts = ffmpeg.urls.map((url) => new URL(url).hostname)
    assert.equal(hosts.at(-1), "ffmpeg.org")
    const mirrors = new Set(hosts.slice(0, -1).filter((host) => host !== "ffmpeg.org" && host !== "www.ffmpeg.org"))
    assert.ok(mirrors.size >= 2, `FFmpeg has two mirrors on other hosts: ${hosts.join(", ")}`)
    assert.equal(new Set(manifest.sources.map((entry) => entry.archive)).size, manifest.sources.length)

    // A build recorded before the manifest listed mirrors is the same build: its sources are the same archives.
    const recorded = manifest.sources.map(({ urls, ...entry }) => ({ ...entry, url: urls.at(-1) }))
    assert.deepEqual(recorded.map(sourceIdentity), manifest.sources.map(sourceIdentity))

    const root = join(scratch, "plain-http")
    await mkdir(join(root, "vendor/control-media"), { recursive: true })
    await writeFile(join(root, "vendor/control-media/sources.json"), JSON.stringify({ recipe: 1, sources: [source(["http://mirror.example/a"])] }))
    await assert.rejects(readManifest(root), /fetched over HTTPS/)
  }
  console.log("control media sources: mirrors, fallback, held archives and the manifest pass")
} finally {
  await rm(scratch, { recursive: true, force: true })
}
