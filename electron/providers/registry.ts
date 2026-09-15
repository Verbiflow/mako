export interface ProviderCapability {
  provider: string
}

export class ProviderRegistry<T extends ProviderCapability> {
  private readonly values = new Map<string, T>()
  private readonly validate?: (value: T) => void

  constructor(validate?: (value: T) => void) {
    this.validate = validate
  }

  register(value: T): () => void {
    this.validate?.(value)
    if (this.values.has(value.provider)) {
      throw new Error(`Provider ${value.provider} already registered this capability`)
    }
    this.values.set(value.provider, value)
    return () => {
      if (this.values.get(value.provider) === value) this.values.delete(value.provider)
    }
  }

  get(provider: string): T | undefined {
    return this.values.get(provider)
  }

  list(): T[] {
    return [...this.values.values()]
  }
}
