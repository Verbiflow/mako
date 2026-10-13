import type { AuthoringSource } from "@/lib/types"

/** What each place an agent reads its configuration from covers, as Settings names it. */
export const AUTHORING_SCOPES = {
  user: "Every project",
  project: "This project",
  local: "This project, this Mac",
  managed: "Managed",
  imported: "Read from another agent",
} as const satisfies Record<AuthoringSource["scope"], string>
