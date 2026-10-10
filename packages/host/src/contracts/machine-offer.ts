import { z } from "zod"

/**
 * What the host's machine can do for a person sitting at it, as clients are
 * told at boot, so a button the machine can't answer is hidden rather than
 * failing when pressed. The host probes it once (`electron/machine.ts`); a
 * client adds what it answers itself, as the desktop app answers the folder
 * chooser with its own dialog.
 */
export const MachineOfferSchema = z.object({
  /** The file manager that shows a path, named for its label; `null` when this host can't show one. */
  fileManager: z.enum(["finder", "file-manager"]).nullable(),
  /** Whether a person can pick a folder through this client. */
  chooseFolder: z.boolean(),
  /** Why something is missing, as a sentence; absent when the machine offers everything. */
  missing: z.string().optional(),
})

export type MachineOffer = z.infer<typeof MachineOfferSchema>

/** What a host from before the offer could do: it only ever ran on a Mac. */
export const UNSTATED_MACHINE_OFFER: MachineOffer = { fileManager: "finder", chooseFolder: true }
