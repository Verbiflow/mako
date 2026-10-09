import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { dataKeyPath, openHostSecrets } from "../electron/host-secrets.js"
import { processKeychain } from "../electron/keychain.js"
import { handOverSecretKey } from "../electron/secret-key-link.js"
import { aesSealer, fileSecrets, SecretLocked, wrappedKey, type Secrets } from "../electron/secrets.js"
import { chromiumSafeStorage } from "../electron/secure-storage.js"
import { electronSecretEncryption } from "../electron/secure-storage-electron.js"
import { startWebHost } from "../electron/web-host.js"

/**
 * One step of `test-secrets-keychain.mjs` or `test-node-host-secrets.mjs`, in a process of its own: write or
 * read a synthetic secret through the host's real store and Electron's real
 * `safeStorage`, serve the store as a Node-mode host does, hand that host
 * the data key as the desktop does, or read the keychain item in Node mode
 * as a host without a desktop does. Prints what happened, never the value.
 * Nothing is awaited at the top level: Electron is ready only once its main
 * module has loaded.
 */
interface Report {
  runtime: "electron" | "node"
  available: boolean
  keychain?: boolean
  wrote?: boolean
  matched?: boolean
  wanted?: boolean
  handed?: string
  adopted?: boolean
  opened?: boolean
  failed?: string
}

async function readBack(secrets: Secrets, expected: string, report: Report, name = "proof"): Promise<void> {
  try {
    report.matched = (await secrets.read("saved-key", name))?.value === expected
  } catch (error) {
    report.failed = error instanceof SecretLocked ? `locked:${error.reason}` : error instanceof Error ? error.name : "unknown"
  }
}

async function check(): Promise<void> {
  const root = process.env.PROOF_ROOT ?? ""
  const expected = process.env.PROOF_VALUE ?? ""
  const socket = process.env.PROOF_SOCKET ?? ""
  const appName = process.env.PROOF_APP ?? ""
  // Electron's main process is "browser"; its Helper in Node mode has no type and no `app`.
  const app = process.type === "browser" ? (await import("electron")).app : undefined
  await app?.whenReady()
  const encryption = electronSecretEncryption()
  const keychain = chromiumSafeStorage({ appName, keychain: processKeychain(() => import("@napi-rs/keyring")) })
  const legacyFile = join(root, "legacy", "proof-legacy.bin")
  const sealedByNode = join(root, "sealed-by-node.bin")
  const report: Report = { runtime: app ? "electron" : "node", available: await encryption.available() }
  const step = process.env.PROOF_STEP
  if (step === "serve") {
    const { secrets, handover } = openHostSecrets({ userRoot: root, encryption, legacy: [] })
    const host = await startWebHost(socket, async () => JSON.stringify({ ok: true, value: null }), async () => new Response(""), undefined, undefined, undefined, handover)
    report.wanted = await handover.wanted()
    console.log("PROOF_READY")
    const end = Date.now() + 30_000
    while ((await handover.wanted()) && Date.now() < end) await delay(50)
    await readBack(secrets, expected, report)
    host.close()
  } else if (step === "hand") {
    try {
      report.handed = await handOverSecretKey(socket, dataKeyPath(root), encryption)
    } catch (error) {
      report.failed = error instanceof Error ? error.message : "unknown"
    }
  } else if (step === "keychain-read") {
    report.keychain = await keychain.available()
    await readBack(openHostSecrets({ userRoot: root, encryption, keychain, legacy: [] }).secrets, expected, report)
  } else if (step === "legacy-write") {
    await writeFile(legacyFile, await encryption.encrypt(expected))
    report.wrote = true
  } else if (step === "legacy-read") {
    report.keychain = await keychain.available()
    const legacy = [{
      path: (kind: string, name: string) => kind === "saved-key" && name === "proof-legacy" ? legacyFile : null,
      names: async () => ["proof-legacy"],
    }]
    await readBack(openHostSecrets({ userRoot: root, encryption, keychain, legacy }).secrets, expected, report, "proof-legacy")
    report.adopted = !(await readFile(legacyFile).then(() => true, () => false))
  } else if (step === "node-seal") {
    report.keychain = await keychain.available()
    await writeFile(sealedByNode, await keychain.encrypt(expected))
    report.wrote = true
  } else if (step === "electron-open") {
    report.opened = (await encryption.decrypt(await readFile(sealedByNode))) === expected
    await rm(sealedByNode, { force: true })
  } else {
    const secrets = fileSecrets(join(root, "secrets"), aesSealer(wrappedKey(dataKeyPath(root), encryption)))
    const name = process.env.PROOF_SAVED_KEY ?? "proof"
    if (step === "write") report.wrote = Boolean(await secrets.write("saved-key", name, expected).catch(() => null))
    else await readBack(secrets, expected, report, name)
  }
  console.log(`PROOF ${JSON.stringify(report)}`)
  if (app) app.exit(0)
  else process.exit(0)
}

void check()
