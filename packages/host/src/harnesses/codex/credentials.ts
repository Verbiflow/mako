import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse, stringify } from "smol-toml"
import { z } from "zod"
import { readKeychain } from "../accounts-common.js"
import { onMac } from "../../base/platform.js"
const AuthConfig = z.object({
  cli_auth_credentials_store: z.enum(["file", "keyring", "auto", "ephemeral"]).default("file"),
  features: z.object({ secret_auth_storage: z.boolean().optional() }).optional(),
})
const ModelProviderConfig = z.object({ model_provider: z.string().min(1).default("openai") })

async function optionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8") }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

/** Native storage policy; never let a stale auth.json shadow the chosen Keychain source. */
/** Where a Codex home keeps its sign-in, as its config names: its `auth.json`, or a Keychain item. */
export type CodexCredentialStore =
  | { kind: "file"; path: string }
  | { kind: "keychain"; service: string; account: string; fallback?: string }

/** The store a home's config names, or null for `ephemeral`, which keeps nothing. */
export async function codexCredentialStore(home: string): Promise<CodexCredentialStore | null> {
  const contents = await optionalFile(join(home, "config.toml"))
  const config = AuthConfig.parse(contents === null ? {} : parse(contents))
  const store = config.cli_auth_credentials_store
  if (store === "file") return { kind: "file", path: join(home, "auth.json") }
  if (store === "ephemeral") return null
  if (store !== "keyring" && store !== "auto") throw new Error("Codex credential storage is not recognized.")
  const secrets = config.features?.secret_auth_storage === true
  if (!onMac() || secrets)
    throw new Error("Mako cannot capture this Codex credential-store backend yet. Use native Codex sign-in with file storage to save this account.")
  const canonical = await realpath(home).catch(() => home)
  const account = `cli|${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`
  // `auto` reads the Keychain item first and the file when there is none.
  return store === "auto" ? { kind: "keychain", service: "Codex Auth", account, fallback: join(home, "auth.json") } : { kind: "keychain", service: "Codex Auth", account }
}

export async function readCodexCredentials(home: string): Promise<string | null> {
  const store = await codexCredentialStore(home)
  if (!store) return null
  if (store.kind === "file") return optionalFile(store.path)
  const keychain = await readKeychain(store.service, store.account, "required")
  if (keychain !== null || !store.fallback) return keychain
  return optionalFile(store.fallback)
}

/** The provider a home's sessions run on; Codex's own default when its config names none. */
export async function codexModelProvider(home: string): Promise<string> {
  const contents = await optionalFile(join(home, "config.toml")).catch(() => null)
  if (contents === null) return "openai"
  try {
    return ModelProviderConfig.parse(parse(contents)).model_provider
  } catch { return "openai" }
}

/** Captured credentials belong to this home, irrespective of the original storage backend. */
export async function managedCodexConfig(sourceHome: string, home: string, oauth: boolean): Promise<void> {
  const contents = await optionalFile(join(sourceHome, "config.toml"))
  const config = contents === null ? {} : parse(contents)
  if (oauth && config.model_provider !== undefined && config.model_provider !== "openai")
    throw new Error("The shared Codex config selects another model provider. Use the CLI profile for that provider instead of routing a saved ChatGPT account to it.")
  const serialized = stringify({ ...config, cli_auth_credentials_store: "file" })
  const destination = join(home, "config.toml")
  const existing = await lstat(destination).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })
  if (!existing?.isSymbolicLink() && await optionalFile(destination) === serialized) return
  // Replaces a legacy symlink without writing through it into the ordinary home.
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" })
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
}
