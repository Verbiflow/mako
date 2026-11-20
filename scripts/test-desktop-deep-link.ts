import assert from "node:assert/strict"
import { deepLinkInArgv, parseDeepLink } from "../electron/desktop-deep-link.ts"

/** What a `mako:` link asks the desktop for, from the URL Windows hands it on a launch or a second launch. */
assert.deepEqual(parseDeepLink("mako://open?path=C%3A%5CUsers%5Cada%5Cproject"), { kind: "open-project", path: "C:\\Users\\ada\\project" })
assert.deepEqual(parseDeepLink("mako://open?path=%2FUsers%2Fada%2Fproject"), { kind: "open-project", path: "/Users/ada/project" })
// A relative folder names nothing the app can open: it only comes forward.
assert.deepEqual(parseDeepLink("mako://open?path=project"), { kind: "focus" })
assert.deepEqual(parseDeepLink("mako://open"), { kind: "focus" })
assert.deepEqual(parseDeepLink("mako://thread/session%3A42"), { kind: "open-thread", subject: "session:42" })
assert.deepEqual(parseDeepLink("mako://thread/"), { kind: "focus" })
assert.deepEqual(parseDeepLink("mako://"), { kind: "focus" })
assert.deepEqual(parseDeepLink("MAKO://thread/a"), { kind: "open-thread", subject: "a" })
assert.equal(parseDeepLink("https://runmako.co/thread/a"), undefined)
assert.equal(parseDeepLink("not a url"), undefined)

// Windows puts the link after the executable and Chromium's switches.
assert.deepEqual(
  deepLinkInArgv(["C:\\Program Files\\Mako\\Mako.exe", "--allow-file-access-from-files", "mako://thread/abc"]),
  { kind: "open-thread", subject: "abc" },
)
assert.equal(deepLinkInArgv(["Mako.exe", "--at-login"]), undefined)
assert.equal(deepLinkInArgv(["Mako.exe", "C:\\Users\\ada\\project"]), undefined)
console.log("desktop deep links: ok")
