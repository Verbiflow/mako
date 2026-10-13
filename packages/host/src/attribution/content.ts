import { createHash } from "node:crypto"
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { sensitivePath } from "@mako/git"
import type { ContentRef } from "@mako/protocol"

/*
 * Content addresses are SHA-256 through Node's crypto, which uses the CPU's
 * SHA instructions: 2.6 GB/s on an M-series Mac against 55 MB/s for BLAKE3
 * in JavaScript (measured, `scripts/bench-attribution.ts`), and no native
 * package to ship. The contract names the algorithm in every reference, so a
 * tracker with native BLAKE3 writes `blake3:` and a peer rehashes on upload.
 */

/** Text up to this size is diffed by lines and kept; anything larger is hashed and attributed whole. */
export const TEXT_LIMIT = 1024 * 1024
/** Whole files up to this size are kept (binary ones too); larger ones only hashed. */
export const STORE_LIMIT = 1024 * 1024
/** Read in one piece up to this size; larger files are hashed as a stream. */
export const READ_LIMIT = 8 * 1024 * 1024
/** Git's test for binary: a zero byte in the first 8,000. */
const SNIFF = 8000
/** Fast and close to the best ratio for source: 173 KB of Markdown to 70 KB in 0.7 ms. */
const ZSTD_LEVEL = 3

export function contentRef(bytes: Uint8Array): ContentRef {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

/** A content address computed a piece at a time, for a file too large to read whole. */
export interface Hasher {
  update(bytes: Uint8Array): void
  digest(): ContentRef
}

export function hasher(): Hasher {
  const hash = createHash("sha256")
  return {
    update: (bytes) => void hash.update(bytes),
    digest: () => `sha256:${hash.digest("hex")}`,
  }
}

export function isText(bytes: Uint8Array): boolean {
  if (bytes.byteLength > TEXT_LIMIT) return false
  const end = Math.min(bytes.byteLength, SNIFF)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return false
  return true
}

const decoder = new TextDecoder("utf-8", { fatal: false })
export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function compress(bytes: Uint8Array): Uint8Array {
  return zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })
}

export function decompress(bytes: Uint8Array): Uint8Array {
  return zstdDecompressSync(bytes)
}

/** Folders whose files hold credentials, wherever they are. */
const SECRET_FOLDERS = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".gcloud", ".password-store", "Keychains"])
const SECRET_NAMES = [/^\.netrc$/, /^\.npmrc$/, /^\.pypirc$/, /\.p12$/, /\.pfx$/, /\.keystore$/, /^id_[a-z0-9]+$/, /^\.git-credentials$/, /^\.envrc$/]

/**
 * A path whose content is never kept or carried: `.env` files, keys and
 * credential stores. Its changes are journaled with their hash and size only.
 * A name test, not a secret scanner.
 */
export function secretPath(path: string): boolean {
  if (sensitivePath(path)) return true
  const parts = path.split("/")
  const name = parts.at(-1) ?? ""
  return SECRET_NAMES.some((pattern) => pattern.test(name)) || parts.some((part) => SECRET_FOLDERS.has(part))
}
