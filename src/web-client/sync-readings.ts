import { SyncRecorder } from "@mako/host/contracts/sync-readings"

/** How this browser follows the account's devices, for its Diagnostics: the same readings a Mac keeps (`SyncRecorder`). */
export const webSync = new SyncRecorder()
