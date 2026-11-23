import type { BalanceKind, BalanceScope, CustomQuery, Desk, Mail, Provider, Site, Unit } from './model'
export type Probe = {
  ticket: string
  unit: Unit
  balance: number | null
  accountBalance: number | null
  sharedWalletAt: number | null
  balanceKind?: BalanceKind
  balanceScope?: BalanceScope
  unlimited?: boolean
  usdRate: number | null
  usdPerUnit: number | null
  usage: boolean
  usageNote: string
  accountId: number | null
}
interface Native {
  state(): Promise<Desk>
  exportConfig(p: { password: string }): Promise<{ count: number } | null>
  importConfig(p: { password: string; applyPreferences: boolean }): Promise<{ added: number; skipped: number } | null>
  openSite(p: { id: string }): Promise<void>
  setAutoUsd(p: { id: string; enabled: boolean; fallbackRate: number | null }): Promise<void>
  onChange(fn: (state: Desk) => void): () => void
  probe(p: { origin: string; token: string; userId: string; provider: Provider; custom?: CustomQuery; id?: string; walletGroup?: string }): Promise<Probe>
  saveSite(p: { id?: string; ticket: string; name: string; threshold: number;
    autoUsd?: boolean; fallbackRate?: number | null; walletGroup?: string }): Promise<string>
  updateSite(p: {
    id: string
    threshold?: number
    billing?: Site['billing']
    walletGroup?: string
    paused?: boolean
    remove?: boolean
  }): Promise<void>
  refresh(p?: { id: string }): Promise<void>
  preferences(p: Partial<Pick<Desk, 'theme' | 'minutes' | 'globalThreshold' | 'followSystemProxy'>>): Promise<void>
  saveMail(p: { config: Mail; secret: string }): Promise<void>
  testMail(p: { config: Mail; secret: string }): Promise<number>
  saveFlashduty(p: { enabled: boolean; address: string }): Promise<void>
  testFlashduty(p: { enabled: boolean; address: string }): Promise<void>
  retryFlashduty(p: { id: string }): Promise<void>
  retry(p: { id: string }): Promise<void>
}
declare global {
  interface Window {
    quotaDesk: Native
  }
}
export const api = window.quotaDesk
export function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}
