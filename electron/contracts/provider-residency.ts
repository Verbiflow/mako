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
}
