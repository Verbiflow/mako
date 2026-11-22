import assert from "node:assert/strict"
import { test } from "node:test"
import { computerWords, computerWordsFor, hostSaidPlatform, localComputerWords } from "../dist/computer-words.js"

const SENTENCES = [
  "Kept on this Mac.",
  "This Mac's clock; your Mac; the Mac it came from; its own Mac; their Mac; another Mac's call; every Mac; each Mac; no Mac.",
  "A Mac with Xcode. Mac. Macs. One of your Macs. macOS. A MacBook.",
]

test("a Mac's sentences come back as they were written, to the byte", () => {
  for (const sentence of SENTENCES) assert.equal(computerWords(sentence, "mac"), sentence)
})

test("off a Mac, a Mac that stands for the computer is a computer; the kind of device stays a Mac", () => {
  assert.deepEqual(SENTENCES.map((sentence) => computerWords(sentence, "computer")), [
    "Kept on this computer.",
    "This computer's clock; your computer; the computer it came from; its own computer; their computer; another computer's call; every computer; each computer; no computer.",
    "A Mac with Xcode. Mac. Macs. One of your Macs. macOS. A MacBook.",
  ])
})

test("the words follow what the host said, then the suites' choice, then the process, then the desktop app's system", () => {
  assert.equal(computerWordsFor("darwin"), "mac")
  assert.equal(computerWordsFor("win32"), "computer")
  assert.equal(computerWordsFor("linux"), "computer")
  const page = (hostPlatform) => ({ document: { documentElement: { dataset: hostPlatform ? { hostPlatform } : {} } } })
  assert.equal(localComputerWords({ ...page("win32"), process: { platform: "darwin", env: { MAKO_COMPUTER_WORDS: "mac" } } }), "computer")
  assert.equal(localComputerWords({ ...page("darwin"), navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Electron/43.0.0" } }), "mac")
  assert.equal(localComputerWords({ process: { platform: "linux", env: { MAKO_COMPUTER_WORDS: "mac" } } }), "mac")
  assert.equal(localComputerWords({ process: { platform: "darwin", env: { MAKO_COMPUTER_WORDS: "computer" } } }), "computer")
  assert.equal(localComputerWords({ process: { platform: "win32", env: {} } }), "computer")
  assert.equal(localComputerWords({ process: { platform: "linux", env: { MAKO_COMPUTER_WORDS: "other" } } }), "computer")
  assert.equal(localComputerWords({ process: { platform: "darwin", env: {} } }), "mac")
  assert.equal(localComputerWords({ ...page(), navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Electron/43.0.0 Safari/537.36" } }), "computer")
  assert.equal(localComputerWords({ ...page(), navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140 Electron/43.0.0" } }), "computer")
  assert.equal(localComputerWords({ ...page(), navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140 Electron/43.0.0" } }), "mac")
  // A page in a browser, or a phone, hasn't a host's system of its own: the Mac's words until the host has spoken.
  assert.equal(localComputerWords({ ...page(), navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537.36" } }), "mac")
  assert.equal(localComputerWords({}), "mac")
  const window = page()
  hostSaidPlatform("win32", window)
  assert.equal(localComputerWords(window), "computer")
  hostSaidPlatform("darwin", window)
  assert.equal(localComputerWords(window), "mac")
})
