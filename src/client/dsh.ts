/** Minimal client-context typing for the DSH browser slot service. */
export interface ClientSlotOptions {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
}

export interface ClientSlots {
  inject(name: string, register: () => () => void): void
  register(options: ClientSlotOptions, component: unknown): () => void
}

export interface ClientContext {
  slots: ClientSlots
  effect?: (effect: () => (() => void) | void, label?: string) => void
  logger?: (name: string) => {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }
}
