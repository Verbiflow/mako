import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { parseArgs } from "node:util"
import { cloudUrl } from "../base/build-identity.js"
import { errorMessage } from "../base/error-message.js"
import { processHostEnvironment, type HostEnvironment } from "../base/host-environment.js"
import { acquireHostLock, hostLockHolder } from "../base/host-lock.js"
import { hostSecretStore, secretKeyFile } from "../base/host-secrets.js"
import { CloudAccountSchema, type CloudAccount, type CloudAccountState } from "../contracts/cloud-account.js"
import { invokeRuntime, probeRuntime, runtimeLocation } from "../transport/index.js"
import { CloudAccounts, cloudLegacyFiles, cloudSignInName, type DeviceCode } from "./cloud-account.js"
import { describeThisDevice } from "./device-description.js"
import { readJoinedCloud, writeJoinedCloud } from "../base/joined-cloud.js"

/**
 * `mako-host join`, `status` and `leave`: this machine as a device of its person's Mako account, signed in with a code
 * it shows (RFC 8628), for a machine with no browser, such as a Linux server. `join` and `leave` take the data root's
 * host lock while they run, so no host starts under them; while a host already runs there, `status` and `leave` ask
 * that host, whose sign-in it is, and nothing here touches its credential. `status` takes no lock: a reading must
 * never turn away a host starting under it (one polled with `status` as it started exited as already running). It
 * reads who holds the lock without taking it: a holder that answers on the host's socket is a host and is asked; one
 * that doesn't is a `join` waiting for its code or a host still starting, said as such; with nobody holding it, the
 * saved sign-in is read here, and the cloud isn't asked, since the credential is a lock holder's to use.
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
  if (command === "status") return await statusWithoutLock(environment, cloud, values.json === true)
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
      if (command === "join") return await join(accounts, environment, values.name)
      return await leave(await accounts.ready(), () => accounts.signOut())
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

/** The socket a host on this data root answers on. */
function hostSocket(environment: HostEnvironment): string {
  return process.env.MAKO_WEB_SOCKET ?? runtimeLocation(environment.dataRoot).socket
}

/**
 * `status` without the host lock. A holder that answers on the socket is a running host, asked as before. One that
 * doesn't answer holds the root for a `join` waiting for its code, or is a host still starting: the reading says so and
 * exits 0, reaching for no host. With no holder, the saved sign-in is read as a host reads it (an older build's file
 * adopted on that first read, as the host would adopt it), and the cloud isn't asked.
 */
async function statusWithoutLock(environment: HostEnvironment, cloud: string, json: boolean): Promise<number> {
  const { dataRoot } = environment
  const holder = await hostLockHolder(dataRoot)
  if (holder !== null) {
    const answers = await probeRuntime(hostSocket(environment), { timeoutMs: 2_000 }).then((probe) => probe.state === "ready", () => false)
    if (answers) return throughHost("status", environment, json)
    return reportHeld(cloud, holder, dataRoot, json)
  }
  try {
    const keyFile = secretKeyFile(environment.userRoot, { env: process.env, cloudMachine: false })
    const store = hostSecretStore(environment, { keyFile })
    store.adoptLegacy(cloudLegacyFiles(dataRoot))
    const accounts = new CloudAccounts({
      url: cloud,
      secrets: store.secrets,
      secretName: cloudSignInName(dataRoot),
      openExternal: async () => {},
      device: () => describeThisDevice(environment.version, undefined),
      onChange: () => {},
      links: false,
    })
    try {
      await accounts.ready()
      return report(accounts.account(), json, { host: "not running", kept: keyFile ?? "the keychain", checked: "not asked: the credential is a running host's, or a join's, to use" })
    } finally {
      accounts.close()
    }
  } catch (error) {
    console.error(`mako-host status: ${errorMessage({ error })}`)
    return 1
  }
}

/** What's true while another `mako-host` holds the data root and no host answers: who, and what it may be doing. */
function reportHeld(cloud: string, holder: number, dataRoot: string, json: boolean): number {
  const host = `not yet listening: mako-host (pid ${holder}) holds ${dataRoot}, a join waiting for its code or a host starting`
  if (json) {
    console.log(JSON.stringify({ cloud, local: { host, holder, kept: "unknown while the root is held" } }, null, 2))
    return 0
  }
  console.log([`Cloud:    ${cloud}`, `Host:     ${host}`, `Joined:   unknown until it's done; run mako-host status again`].join("\n"))
  return 0
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

/** With a host on this data root: the sign-in is the host's, so it's asked, never used from here. */
async function throughHost(command: Command, environment: HostEnvironment, json: boolean): Promise<number> {
  const socket = hostSocket(environment)
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
