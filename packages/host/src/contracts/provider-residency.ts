export interface ProviderResidencyEntry {
  conversationId: string
  provider: string
  title: string
  state:
    | "active"
    | "warm"
    | "protected"
    | "hibernated"
    | "disconnected"
  /**
   * What the session runs besides a turn, for the diagnostics readout:
   * the provider's own count, and each active roster entry with the native
   * messages it was read from. Absent when nothing runs.
   */
  work?: {
    /** The provider's level count (`backgroundTasks`). */
    level: number
    entries: {
      nativeId: string
      work: string
      title: string
      state: string
      ambient: boolean
      source?: string
      startedAt?: number
    }[]
  }
}

export interface ProviderResidencySnapshot {
  entries: ProviderResidencyEntry[]
  active: number
  warm: number
  protected: number
  hibernated: number
  disconnected: number
  warmLimit: number
  idleMs: number
  memory: ConversationMemory
}

/** The conversations the host holds in memory; see `ResidencyBudget`. */
export interface ConversationMemory {
  loaded: number
  /** Let go this host life; each loads again when something reads it. */
  unloaded: number
  /** What `loaded` weighs, by `liveContentWeight`. */
  bytes: number
  /** The part of `bytes` that is running or waiting and cannot go. */
  pinnedBytes: number
  budget: number
}
