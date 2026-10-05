import type { AccountUsage } from "@/lib/types"
import type { ProviderAccount } from "@/state/accounts"
/** How an account is named wherever it is listed or chosen. */

const OPENCODE_PROVIDERS = new Map([
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["google", "Google"],
  ["openrouter", "OpenRouter"],
])

export function providerName(id: string): string {
  return OPENCODE_PROVIDERS.get(id) ?? id.charAt(0).toUpperCase() + id.slice(1)
}

export function authName(type: ProviderAccount["authType"]): string {
  if (type === "oauth") return "subscription"
  if (type === "api") return "API key"
  if (type === "wellknown") return "well-known login"
  return "login"
}

export function accountIdentity(account: ProviderAccount): string {
  if (account.missing) return "Account no longer available"
  if (account.email) return account.email
  if (account.source === "model-provider")
    return `${providerName(account.providerId ?? account.name)} ${authName(account.authType)}`
  if (account.name === "default") return account.route ? "Your terminal’s login" : "Signed in"
  return account.source === "mako" ? "Account added in Mako" : account.name
}

/** A login Mako keeps that no longer signs in: gone from its profile, or refused for its usage. */
export function isSignedOut(account: ProviderAccount, usage: AccountUsage | undefined): boolean {
  if (account.missing) return false
  return account.signedOut === true || usage?.status === "missing-credentials"
}
