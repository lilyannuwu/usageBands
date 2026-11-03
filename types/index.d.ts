export type Entry = {
  usd: number
  input: number
  output: number
  activeMs: number
}

export type Ledger = Record<string, Entry>

export type Cost = {
  sessionUsd: number | null
  totalUsd: number
  input: number
  output: number
  activeMs: number
}

export type Limit = {
  kind: string
  percentUsed: number
}

export type Limits = {
  tokens: number | null
  window: number
  percent: number | null
  isEstimated: boolean
  limits: Limit[]
}

export type BandSettings = {
  showCost: boolean
  showLimits: boolean
  hide: string[]
  yellowAt: number
  redAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bands': {
      cost: Cost | null
      limits: Limits | null
      settings: BandSettings | null
    }
  }
}
