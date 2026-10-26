import assert from "node:assert/strict"
import type { Element, Root } from "hast"
import { unified } from "unified"
import { visit } from "unist-util-visit"
import { parseProse } from "../src/lib/parsed-markdown"
import { plainMediaPaths } from "../src/lib/file-citations"
import { inlineFileLinks, inlineFileSpellings } from "../src/lib/inline-file-links"
import { rehypeAssetGroups } from "../src/lib/markdown-asset-groups"
import { VideoPlayback, type PlaybackDocument, type PlayableVideo } from "../src/lib/video-playback"
import { MEDIA_GRID_TILES, mediaBox, mediaGridColumns, naturalSize, visualAsset } from "../src/components/viewer/media-tile-layout"

/**
 * What the transcript decides about media without a window: which paths in
 * prose become previews, how a collection lays out, and when a video
 * pauses. Rendering is covered by the screenshots of the fixture page.
 */

function elements(tree: Root, tag: string): Element[] {
  const found: Element[] = []
  visit(tree, "element", (node: Element) => { if (node.tagName === tag) found.push(node) })
  return found
}
const firstParagraph = (markdown: string) => elements(parseProse(markdown), "p")[0]
const links = (markdown: string) => elements(parseProse(markdown), "a").map((node) => String(node.properties.href))

// Plain-text paths to media and pages link, outside code and links; other paths stay prose.
assert.deepEqual(plainMediaPaths("Saved to /tmp/shots/home.png."), [{ index: 9, path: "/tmp/shots/home.png" }])
assert.deepEqual(plainMediaPaths("See ~/Desktop/flow.mp4, ./out/report.html and ../site/index.htm!").map((found) => found.path), ["~/Desktop/flow.mp4", "./out/report.html", "../site/index.htm"])
assert.deepEqual(plainMediaPaths("Edit /etc/hosts and /src/app.ts, then open https://example.test/a.png or a/b.png"), [])
assert.deepEqual(plainMediaPaths("(/var/folders/x/rec.webm)").map((found) => found.path), ["/var/folders/x/rec.webm"])
assert.deepEqual(plainMediaPaths("no paths here"), [])
assert.deepEqual(links("The screenshot is at /tmp/shots/home.png and the run at ~/runs/flow.mp4."), ["/tmp/shots/home.png", "~/runs/flow.mp4"])
assert.deepEqual(links("Code keeps it: `/tmp/a.png`, and\n\n```\n/tmp/b.png\n```"), ["/tmp/a.png"], "a backticked path links as before; a code block stays code")
assert.deepEqual(links("[home](/tmp/x.png) and https://example.test/y.png"), ["/tmp/x.png", "https://example.test/y.png"], "a link's own text is never linked again")
assert.deepEqual(inlineFileLinks(firstParagraph("Saved to /tmp/shots/home.png.")), ["/tmp/shots/home.png"], "a plain path previews like a backticked one")

// A bare name previews only as a picture, video or audio the host resolves through the Thread's touches.
assert.deepEqual(inlineFileSpellings(firstParagraph("Made `home.png` and `notes.md`, see `/tmp/flow.mp4`.")), [
  { spelling: "home.png", bare: true },
  { spelling: "/tmp/flow.mp4", bare: false },
])
assert.deepEqual(inlineFileLinks(firstParagraph("Made `home.png` and `/tmp/flow.mp4`.")), ["/tmp/flow.mp4"], "bare names wait on the host")
assert.deepEqual(inlineFileSpellings(firstParagraph("Edited `utils.ts`.")), [], "a bare source file stays a link")

// One list item's files are found as a paragraph's are.
const item = elements(parseProse("- Home: /tmp/shots/home.png\n- Flow: `./out/flow.mp4`"), "li")
assert.deepEqual(item.map((node) => inlineFileSpellings(node).map((entry) => entry.spelling)), [["/tmp/shots/home.png"], ["./out/flow.mp4"]])

// A list of files and nothing else is one gallery; a list with words beside its files stays a list.
const grouped = (markdown: string) => {
  return unified().use(rehypeAssetGroups).runSync(parseProse(markdown))
}
const gallery = grouped("Shots:\n\n- /tmp/a.png\n- /tmp/b.png\n- `/tmp/c.mp4`\n\nDone.")
assert.equal(elements(gallery, "ul").length, 0)
assert.deepEqual(elements(gallery, "p").filter((node) => node.properties.dataAssetGroup).map((node) => node.children.filter((child) => child.type === "element").length), [3])
assert.equal(elements(grouped("- Home: /tmp/a.png\n- Pricing: /tmp/b.png"), "ul").length, 1)
assert.equal(elements(grouped("- /tmp/a.png\n\n- /tmp/b.png"), "ul").length, 0, "a loose list of files is a gallery too")
assert.equal(elements(grouped("- /tmp/a.png"), "ul").length, 1, "one file keeps its bullet")

// A collection of pictures and videos is a grid; one with any other file keeps its chips.
assert.equal(visualAsset({ id: "1", name: "home.png" }), true)
assert.equal(visualAsset({ id: "2", name: "flow.mp4" }), true)
assert.equal(visualAsset({ id: "3", name: "image", mimeType: "image/webp" }), true)
assert.equal(visualAsset({ id: "4", name: "report.pdf" }), false)
assert.equal(visualAsset({ id: "5", name: "report.html" }), false)
assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 12].map(mediaGridColumns), [1, 2, 3, 2, 3, 3, 3, 3])
assert.equal(MEDIA_GRID_TILES, 6)

// Video: nothing loads until near, one plays at a time, off screen, hidden or unmounted pauses.
class FakeVideo implements PlayableVideo {
  paused = true
  preload = "auto"
  pauses = 0
  play() { this.paused = false }
  pause() { this.paused = true; this.pauses += 1 }
}
class FakeDocument implements PlaybackDocument<FakeVideo> {
  hidden = false
  fullscreenElement: { contains(video: FakeVideo): boolean } | null = null
  listeners = new Set<() => void>()
  addEventListener(_type: "visibilitychange", listener: () => void) { this.listeners.add(listener) }
  removeEventListener(_type: "visibilitychange", listener: () => void) { this.listeners.delete(listener) }
  hide(hidden: boolean) { this.hidden = hidden; for (const listener of this.listeners) listener() }
}
const page = new FakeDocument()
const playback = new VideoPlayback(page)
const first = new FakeVideo()
const second = new FakeVideo()
const one = playback.attach(first)
const two = playback.attach(second)
assert.equal(first.preload, "none", "nothing loads before it's near the viewport")
one.near()
assert.equal(first.preload, "metadata")
assert.equal(second.preload, "none")
first.play()
one.playing()
second.play()
two.playing()
assert.deepEqual([first.paused, second.paused], [true, false], "starting one pauses the other")
two.shown(false)
assert.equal(second.paused, true, "scrolled out of view, it pauses")
second.play()
two.playing()
two.shown(true)
assert.equal(second.paused, false, "scrolling back never starts or stops it")
page.hide(true)
assert.equal(second.paused, true, "a hidden window pauses it")
page.hide(false)
second.play()
two.playing()
page.fullscreenElement = { contains: (video: FakeVideo) => video === second }
page.hide(true)
two.shown(false)
assert.equal(second.paused, false, "fullscreen keeps playing when the window hides")
page.fullscreenElement = { contains: (video: FakeVideo) => video === first }
first.play()
one.playing()
assert.equal(second.paused, true)
page.hide(true)
assert.equal(first.paused, false, "a video inside the fullscreen element counts as fullscreen")
page.fullscreenElement = null
page.hide(false)
one.release()
assert.equal(first.paused, true, "unmounting pauses it")
second.play()
two.playing()
assert.equal(second.paused, false, "the one left plays on its own")
two.release()
assert.equal(page.listeners.size, 0, "the last player gone, nothing listens")

console.log("Media view: plain and bare media paths preview through the host, list items like paragraphs, grids for media only, and videos load late and pause off screen, hidden and unmounted, one at a time")

// A picture never draws larger than its own pixels, one to a device pixel: a
// 320×160 chart is 320 CSS pixels wide on a 1x display and 160 on a 2x one,
// in the lightbox's Fit, inline and in a tile alike. Only Actual size draws
// exactly this, whatever the box.
assert.deepEqual(naturalSize(320, 160, 1), { width: 320, height: 160 })
assert.deepEqual(naturalSize(320, 160, 2), { width: 160, height: 80 })
assert.deepEqual(naturalSize(2704, 1694, 2), { width: 1352, height: 847 })
assert.deepEqual(naturalSize(100, 100, 1.5), { width: 66.67, height: 66.67 })
assert.equal(naturalSize(undefined, 160, 2), undefined, "unknown until its size is")
assert.equal(mediaBox(320, 160, 2).width, "min(100%, 30rem, 60.000rem, 160px)", "inline: no wider than its device pixels")
assert.equal(mediaBox(320, 160).width, "min(100%, 30rem, 60.000rem, 320px)")
