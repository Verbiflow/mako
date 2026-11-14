import type { RoleRules } from "@mako/host/contracts/fin-tuning"
import { formatTokens } from "./format"

/** Each role's field on every device's Settings › Fins: its title, the line under it, an example rule, and the toggle that shows what it adds. */
export const ROLE_FIELDS: readonly { role: RoleRules; label: string; description: string; placeholder: string; reads: string }[] = [
  { role: "forFins", label: "For every Fin", description: "Your own words, which every Fin reads before it starts.", placeholder: "Run the tests you touch before you report", reads: "What every Fin reads" },
  { role: "forApexes", label: "For every Apex", description: "Your own words, which every Apex reads before it starts a Fin.", placeholder: "Ask me before starting more than four Fins", reads: "What every Apex reads" },
]

/** About four characters a token: a rough count, said as one. */
export function roughTokens(text: string): string {
  return `~${formatTokens(Math.ceil(text.length / 4))} tokens`
}
