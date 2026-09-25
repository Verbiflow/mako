import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readLocalAppMetadata } from "./local-app-metadata.mjs"
import { z } from "zod"

const run = promisify(execFile)
const identitySchema = z.string().regex(/^[A-Fa-f0-9]{40}$/, "Use the certificate's 40-character SHA-1 fingerprint, not a name or ad-hoc identity").transform((value) => value.toUpperCase())
const localMetadataSchema = z.object({
  makoDistribution: z.literal("local"),
  makoLocalSigningIdentity: identitySchema,
})

export function localMacConfig(config, identity) {
  const fingerprint = identitySchema.parse(identity)
  return {
    ...config,
    forceCodeSigning: true,
    extraMetadata: {
      ...config.extraMetadata,
      makoDistribution: "local",
      makoLocalSigningIdentity: fingerprint,
    },
    mac: { ...config.mac, identity: fingerprint, notarize: false, timestamp: "none" },
    publish: null,
  }
}

export async function resolveLocalIdentity(requested, installed = "/Applications/Mako.app") {
  if (requested !== undefined) return identitySchema.parse(requested)
  let identity
  try {
    identity = localMetadataSchema.parse(readLocalAppMetadata(installed)).makoLocalSigningIdentity
  } catch {
    throw new Error("Set MAKO_LOCAL_SIGNING_IDENTITY to your local certificate's SHA-1 fingerprint for the first build. Later local builds reuse the verified installed app's signer.")
  }
  await verifyLocalSignature(installed, identity)
  return identity
}

export async function verifyLocalSignature(app, identity, previous) {
  const fingerprint = identitySchema.parse(identity)
  const requirement = `identifier "dev.mako.app" and certificate leaf = H"${fingerprint}"`
  await run("codesign", ["--verify", "--deep", "--strict", "--test-requirement", `=${requirement}`, app], { timeout: 60_000, maxBuffer: 1024 * 1024 })
  const { stdout, stderr } = await run("codesign", ["--display", "--verbose=4", "-r-", app], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  const details = stdout + stderr
  const signature = z.object({ cdhash: z.string().regex(/^[a-f0-9]{40}$/i), requirement: z.string().min(1) }).parse({
    cdhash: /^CDHash=(.+)$/m.exec(details)?.[1],
    requirement: /^designated => (.+)$/m.exec(details)?.[1],
  })
  assert.doesNotMatch(signature.requirement, /\bcdhash\b/, "A local build must retain a certificate-backed identity across rebuilds")
  if (previous) {
    const prior = await verifyLocalSignature(previous, fingerprint)
    await run("codesign", ["--verify", "--test-requirement", `=${prior.requirement}`, app], { timeout: 60_000 })
    await run("codesign", ["--verify", "--test-requirement", `=${signature.requirement}`, previous], { timeout: 60_000 })
  }
  return signature
}
