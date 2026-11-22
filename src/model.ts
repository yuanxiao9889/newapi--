export type Unit = string
export type Theme = 'system' | 'light' | 'dark'
export type Clock = 5 | 15 | 30 | 60
export type Health = 'ok' | 'pending' | 'retrying' | 'invalid' | 'offline'
export type History = { day: string; value: number }
export type Provider = 'new-api' | 'sub2api'
export type BalanceKind = 'wallet' | 'quota' | 'window' | 'subscription'
export const balanceLabels: Record<BalanceKind, string> = {
  wallet: '账户共享余额', quota: 'Key 剩余额度', window: 'Key 周期限额', subscription: '订阅剩余额度',
}
export type UsageRow = {
  requests: number | null; input: number | null; output: number | null
  cacheRead: number | null; cacheWrite: number | null; cost: number | null; actual: number | null
}
export type Wallet = { value: number; unit: Unit; rmb: number }
export type Site = {
  id: string
  name: string
  origin: string
  icon: number
  unit: Unit
  sourceUnit?: Unit
  billing?: { unit: Unit; rmbRate: number } | null
  autoUsd?: boolean
  usdRate?: number | null
  fallbackRate?: number | null
  provider?: Provider
  balance: number | null
  accountBalance: number | null
  walletChecked: number | null
  walletSourceId: string | null
  balanceKind?: BalanceKind
  walletGroup?: string
  keyUsage?: {
    month: string; unlimited: boolean; total: UsageRow | null
    daily: (UsageRow & { label: string })[] | null; models: (UsageRow & { label: string })[]
    limits: { label: string; used: number | null; limit: number | null }[]
  }
  usage: boolean
  health: Health
  issue?: { label: string; detail: string; count: number; retryAt: number }
  threshold: number
  paused: boolean
  low: boolean
  checked: number
  tried: number
  userId: string
  accountId: number | null
  usageNote: string
  todayValue: number | null
  monthValue: number | null
  periodDay: string
  history: History[]
  logs: { at: number; text: string }[]
}
export type Notice = {
  id: string
  siteId: string
  site: string
  at: number
  balance: number
  threshold: number
  unit: Unit
  closed?: number
  destination: string
  delivery: 'off' | 'sent' | 'pending' | 'failed' | 'sending' | 'uncertain' | 'cancelled'
  recipients?: { id: string; address: string; selected: boolean; delivery: Notice['delivery']; error?: string }[]
  error?: string
}
export type Mail = {
  enabled: boolean
  provider: 'smtp' | 'resend'
  host: string
  port: string
  from: string
  account: string
  to: string
  tls: 'STARTTLS' | 'TLS'
}
export type Desk = {
  globalThreshold: number | null
  version: 1
  sites: Site[]
  wallets: Wallet[]
  unreadWalletCount: number
  notices: Notice[]
  minutes: Clock
  theme: Theme
  mail: Mail
}
export const unitSymbol = (unit: Unit) =>
  unit === 'CNY' ? '¥' : unit === 'USD' ? '$' : unit.split('@')[0]
export function unitParts(unit: Unit) {
  if (unit === 'CNY') return { label: '人民币 CNY', host: '' }
  if (unit === 'USD') return { label: '美元 USD', host: '' }
  const [symbol, ...rest] = unit.split('@')
  const label = symbol === '积分' ? '站点积分' : symbol === '额度' ? '站点额度' : `站点额度（${symbol}）`
  try {
    return { label, host: new URL(rest.join('@')).host }
  } catch {
    return { label, host: '' }
  }
}
export function unitName(unit: Unit) {
  const { label, host } = unitParts(unit)
  return host ? `${label} · ${host}` : label
}
export const deliveryLabel: Record<Notice['delivery'], string> = {
  off: '邮件已关闭',
  sent: '服务商已接收',
  pending: '待发送',
  failed: '发送失败',
  sending: '发送中',
  uncertain: '投递待确认',
  cancelled: '已取消发送',
}
export function dayKey(d: Date) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}
export function days(n: number, now = new Date()) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now)
    d.setDate(d.getDate() + i - n + 1)
    return dayKey(d)
  })
}
export function money(value: number, unit: Unit) {
  const digits =
    Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 6 : unit.startsWith('积分@') ? 0 : 2
  return (
    unitSymbol(unit) +
    value.toLocaleString('en-US', {
      minimumFractionDigits: Math.min(2, digits),
      maximumFractionDigits: digits,
    })
  )
}
export function balanceText(site: Pick<Site, 'balance' | 'unit' | 'keyUsage' | 'balanceKind'>) {
  if (site.balance != null) return money(site.balance, site.unit)
  if (site.keyUsage?.unlimited) return '不限额'
  return site.balanceKind === 'window' ? '仅周期额度' : '未提供'
}
export const walletKeyHint = '查询账户余额，请添加同一账户下按钱包计费、未设置 Key 总额度和周期限额的 Key。'
export const time = (at: number) =>
  new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
export const fullTime = (at: number) =>
  new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
export function sumPeriod(s: Site, period: 'today' | 'month') {
  return (period === 'today' ? s.todayValue : s.monthValue) ?? 0
}
export function series(sites: Site[], n: number) {
  return days(n).map((day) => {
    const samples = sites.flatMap((s) => s.history.filter((p) => p.day === day))
    return { day, value: samples.length ? samples.reduce((v, p) => v + p.value, 0) : null }
  })
}
export function periodAvailable(site: Site, period: 'today' | 'month') {
  const date = dayKey(new Date())
  return period === 'today'
    ? site.periodDay === date && site.todayValue != null
    : site.periodDay.slice(0, 7) === date.slice(0, 7) && site.monthValue != null
}
export function stateLabel(site: Site) {
  if (site.paused) return ['paused', '已暂停']
  if (site.health === 'pending') return ['pending', '待首次查询']
  if (site.health === 'retrying') return ['retrying', (site.issue?.label ?? '查询异常') + ' · 待重试']
  if (site.health === 'invalid') return ['invalid', site.issue?.label ?? '认证失败']
  if (site.health === 'offline') return ['invalid', site.issue?.label ?? '查询异常']
  if (site.low) return ['low', '余额偏低']
  return ['ok', '正常']
}
