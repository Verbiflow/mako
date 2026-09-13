/**
 * The one sentence a refusal uses when another Mako host has a session live.
 * Shared by the ledger (`session-memory.ts`), which raises it before a
 * resume spawns anything, and the continuation plan, which reads the hold
 * from the catalogued ref, so both entry points say the same thing.
 */
export function heldReason(hostLabel: string): string {
  return `This session is live in ${hostLabel}. Finish or close it there before replying here, or fork it to continue separately.`
}
