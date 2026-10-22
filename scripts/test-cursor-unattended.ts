import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memorySecrets } from "@mako/host/base/secrets"
import { CursorSdkAuth } from "@mako/host/harnesses/cursor/sdk/auth"
import { CursorSdkError } from "@mako/host/harnesses/cursor/sdk/client"
import { CursorCredentialStore } from "@mako/host/harnesses/cursor/sdk/credentials"
import { createCursorSdkDriver, type CursorSdkLiveClient } from "@mako/host/harnesses/cursor/sdk/driver"
import { UNATTENDED_SIGN_IN } from "@mako/host/harnesses/live-driver"
import { CURSOR_SDK_WIRE_VERSION, type SdkMethod, type SdkResult } from "@mako/host/harnesses/cursor/sdk/wire"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { admitted } from "./fixtures/admitted-start.ts"

/**
 * Cursor with no key anywhere, started where nobody can sign it in (a cloud machine): the start fails at once, saying
 * so, rather than waiting on a browser sign-in nobody will finish. The production driver, an injected child, no network.
 */
const root = mkdtempSync(join(tmpdir(), "mako-cursor-unattended-"))
const client: CursorSdkLiveClient = {
  alive: true,
  exited: new Promise(() => {}),
  hello: async () => ({ wire: CURSOR_SDK_WIRE_VERSION, sdkVersion: "fixture", node: process.version }),
  request: async <Method extends SdkMethod>(method: Method): Promise<SdkResult<Method>> => {
    throw new CursorSdkError({ kind: "authentication", message: `API key is required (${method})`, code: "unauthenticated" })
  },
  close: async () => {},
  kill() {},
}
let browser = 0
const auth = new CursorSdkAuth({
  env: async () => ({}),
  openUrl: async () => {
    browser++
    throw new Error("nobody is here to sign in")
  },
  credentials: new CursorCredentialStore(memorySecrets({ durable: false })),
  cliKey: async () => null,
  client: () => client,
})
const driver = createCursorSdkDriver({ stores: new NativeStores(false), auth, stateRoot: () => root, home: root, client: () => client, models: async () => [] })
try {
  const asked: string[] = []
  const started = performance.now()
  await assert.rejects(
    driver.start(root, admitted("cursor", { conversationId: randomUUID(), unattended: true, emit: (event) => { if (event.type === "live-permission") asked.push(event.type) } }, { env: {} })),
    { message: UNATTENDED_SIGN_IN },
  )
  assert.deepEqual(asked, [], "no sign-in offered")
  assert.equal(browser, 0, "no browser opened")
  assert.ok(performance.now() - started < 5_000, "at once")
  console.log("PASS: Cursor started where nobody can sign it in fails at once, offering no sign-in")
} finally {
  rmSync(root, { recursive: true, force: true })
}
