import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { parseArgs } from "node:util"
import { cloudUrl } from "../base/build-identity.js"
import { errorMessage } from "../base/error-message.js"
import { processHostEnvironment, type HostEnvironment } from "../base/host-environment.js"
import { acquireHostLock } from "../base/host-lock.js"
import { hostSecretStore, secretKeyFile } from "../base/host-secrets.js"
import { CloudAccountSchema, type CloudAccount, type CloudAccountState } from "../contracts/cloud-account.js"
import { invokeRuntime, runtimeLocation } from "../transport/index.js"
import { CloudAccounts, cloudLegacyFiles, cloudSignInName, type DeviceCode } from "./cloud-account.js"
import { describeThisDevice } from "./device-description.js"
import { readJoinedCloud, writeJoinedCloud } from "../base/joined-cloud.js"

/**
 * `mako-host join`, `status` and `leave`: this machine as a device of its person's Mako account, signed in with a code
 * it shows (RFC 8628), for a machine with no browser, such as a Linux server. Each takes the data root's host lock
 * while it runs, so no host starts under it; while a host already runs there, `status` and `leave` ask that host,
 * whose sign-in it is, and nothing here touches its credential.
 */
const USAGE = `Usage:
  mako-host join [--name <name>] [--cloud <url>]   add this machine to your Mako account with a code you confirm on another device
  mako-host status [--json]                       this machine's device, account and links
  mako-host leave                                 sign this machine out and remove it from the account

The data root is MAKO_DATA_ROOT's, else the default; --cloud is kept for the host that runs after it.`

type Command = "join" | "status" | "leave"

export async function deviceCommand(command: Command, args: string[]): Promise<number> {
  let values: { name?: string; cloud?: string; json?: boolean; help?: boolean }
  try {
    values = parseArgs({
      args,
      options: {
        name: { type: "string" },
        cloud: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }).values
  } catch (error) {
    console.error(`mako-host ${command}: ${errorMessage({ error })}\n${USAGE}`)
    return 64
  }
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (command !== "join" && (values.name !== undefined || values.cloud !== undefined)) {
    console.error(`mako-host ${command}: --name and --cloud are for join\n${USAGE}`)
    return 64
  }
  const environment = processHostEnvironment()
  const { dataRoot } = environment
  const cloud = values.cloud ?? (process.env.MAKO_CLOUD_URL || readJoinedCloud(dataRoot) || cloudUrl(environment))
  if (!cloud) {
    console.error(`mako-host ${command}: which Mako cloud? Pass --cloud <url> to join, or set MAKO_CLOUD_URL`)
    return 64
  }
  await mkdir(dataRoot, { recursive: true })
  const lock = await acquireHostLock(dataRoot)
  if (lock.kind === "taken") return throughHost(command, environment, values.json === true)
  try {
    const keyFile = secretKeyFile(environment.userRoot, { env: process.env, cloudMachine: false })
    const store = hostSecretStore(environment, { keyFile })
    store.adoptLegacy(cloudLegacyFiles(dataRoot))
    const accounts = new CloudAccounts({
      url: cloud,
      secrets: store.secrets,
      secretName: cloudSignInName(dataRoot),
      openExternal: async () => {},
      device: () => describeThisDevice(environment.version, values.name),
      onChange: () => {},
      links: false,
    })
    try {
      const kept = keyFile ?? "the keychain"
      if (command === "join") return await join(accounts, environment, values.name)
      if (command === "leave") return await leave(await accounts.ready(), () => accounts.signOut())
      return await status(accounts, values.json === true, { host: "not running", kept })
    } finally {
      accounts.close()
    }
  } catch (error) {
    console.error(`mako-host ${command}: ${errorMessage({ error })}`)
    return 1
  } finally {
    await lock.release()
  }
}

async function join(accounts: CloudAccounts, environment: HostEnvironment, name: string | undefined): Promise<number> {
  const before = await accounts.ready()
  if (before.state.status === "signed-in") {
    console.log(`Already joined: ${describeJoined(before)}.${name && name !== before.state.device.name ? ` (--name ${name} is for a new join; run mako-host leave first to rename it.)` : ""}`)
    return 0
  }
  const stop = new AbortController()
  const interrupted = () => stop.abort()
  process.once("SIGINT", interrupted)
  process.once("SIGTERM", interrupted)
  try {
    const after = await accounts.join(showCode, stop.signal)
    if (after.state.status !== "signed-in") {
      console.error(after.state.status === "signed-out" && after.state.notice ? after.state.notice.message : "This machine didn't join.")
      return 1
    }
    const origin = accounts.gateway()?.origin
    if (origin) await writeJoinedCloud(environment.dataRoot, origin)
    console.log(`\nJoined: ${describeJoined(after)}. Run \`mako-host\` to serve it to the account.`)
    return 0
  } catch (error) {
    if (stop.signal.aborted) {
      console.error("\nStopped waiting; this machine didn't join.")
      return 130
    }
    throw error
  } finally {
    process.off("SIGINT", interrupted)
    process.off("SIGTERM", interrupted)
  }
}

function showCode(code: DeviceCode): void {
  const minutes = Math.max(1, Math.round((Date.parse(code.expiresAt) - Date.now()) / 60_000))
  console.log(`To add this machine to your Mako account, open this page on a device that's signed in:

  ${code.verificationUriComplete}

and confirm the code ${code.code} there (or go to ${code.verificationUri} and type it in). It expires in ${minutes} minutes.

Waiting for the code to be confirmed…`)
}

async function leave(before: CloudAccount, signOut: () => Promise<CloudAccount>): Promise<number> {
  if (before.state.status !== "signed-in") {
    console.log("Not joined: nothing to leave.")
    return 0
  }
  const left = describeJoined(before)
  const after = await signOut()
  if (after.state.status === "signed-out" && after.state.finishing)
    console.log(`Signed out here. The cloud couldn't be reached, so ${before.state.device.name} is removed from the account when the host next starts here, or when \`mako-host leave\` runs again.`)
  else console.log(`Left: ${left} is removed from the account.`)
  return 0
}

async function status(accounts: CloudAccounts, json: boolean, local: { host: string; kept: string }): Promise<number> {
  const account = await accounts.ready()
  let checked: string | undefined
  if (account.state.status === "signed-in") {
    // The credential is this process's to use while it holds the lock: one answer from the cloud says it still works.
    checked = await accounts.devices().then(
      ({ devices }) => `the cloud lists ${devices.length} device${devices.length === 1 ? "" : "s"} on the account`,
      (error: Error) => `the cloud couldn't be asked: ${errorMessage({ error })}`
    )
  }
  return report(accounts.account(), json, { ...local, ...(checked && { checked }) })
}

/** With a host on this data root: the sign-in is the host's, so it's asked, never used from here. */
async function throughHost(command: Command, environment: HostEnvironment, json: boolean): Promise<number> {
  const socket = process.env.MAKO_WEB_SOCKET ?? runtimeLocation(environment.dataRoot).socket
  const client = randomUUID()
  const call = async (channel: string) => CloudAccountSchema.parse(await invokeRuntime(socket, client, channel, []))
  try {
    const account = await call("mako:cloud-account")
    if (command === "status") return report(account, json, { host: `running, on ${socket}`, kept: "the host's secret store" })
    if (command === "leave") return await leave(account, () => call("mako:cloud-sign-out"))
    if (account.state.status === "signed-in") {
      console.log(`Already joined: ${describeJoined(account)}.`)
      return 0
    }
    console.error(`A Mako host runs on ${environment.dataRoot} and isn't joined. Stop it, run mako-host join, then start it again.`)
    return 1
  } catch (error) {
    console.error(`mako-host ${command}: the host on ${socket}: ${errorMessage({ error })}`)
    return 1
  }
}

function describeJoined(account: CloudAccount): string {
  if (account.state.status !== "signed-in") return "not joined"
  const { device, account: person } = account.state
  return `"${device.name}" (device ${device.id}, ${device.kind}) in ${person.email}'s account on ${account.cloud ?? "the cloud"}`
}

function report(account: CloudAccount, json: boolean, local: { host: string; kept: string; checked?: string }): number {
  if (json) {
    console.log(JSON.stringify({ ...account, local }, null, 2))
    return 0
  }
  const { state } = account
  const lines = [`Cloud:    ${account.cloud ?? "none"}`, `Host:     ${local.host}`, `Joined:   ${joinedLine(state)}`]
  if (state.status === "signed-in") {
    lines.push(
      `Device:   ${state.device.name} (${state.device.id}), ${state.device.kind}, ${state.device.platform}${state.device.appVersion ? `, ${state.device.appVersion}` : ""}`,
      `Account:  ${state.account.name} <${state.account.email}>, entitled to ${state.account.entitlements.join(", ") || "nothing yet"}`,
      `Kept in:  ${local.kept}`,
      `Links:    ${local.host === "not running" ? "none open (the host isn't running)" : `account ${state.connection}, runtime ${state.runtime ?? "unknown"}`}`
    )
    if (local.checked) lines.push(`Checked:  ${local.checked}`)
  }
  console.log(lines.join("\n"))
  return 0
}

function joinedLine(state: CloudAccountState): string {
  if (state.status === "signed-in") return "yes"
  if (state.status === "signing-in") return `waiting for a code to be confirmed at ${state.url}`
  if (state.status === "unavailable") return `no: ${state.message}`
  return state.finishing ? "no; a sign-out is still being finished" : state.notice ? `no: ${state.notice.message}` : "no"
}
