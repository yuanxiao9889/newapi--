import { dayKey, isDayKey, profitScale, readDayQuota, siteAddress } from './new-api.mjs'
import { profitSecret, siteIdentity } from './config-transfer.mjs'

function nextDay(day) {
  const [year, month, date] = day.split('-').map(Number)
  return dayKey(new Date(year, month - 1, date + 1))
}

function costSites(sites, origin) {
  return sites.filter(s => s.origin !== origin && !(s.provider === 'custom' && s.origin.startsWith(origin + '/')))
}

function captureCosts(row, sites, day, today, addMembers) {
  for (const s of sites) {
    const key = siteIdentity(s)
    let cost = row.costs[key]
    if (!cost) {
      if (!addMembers) continue
      cost = row.costs[key] = { name: s.name, value: null }
    }
    if (cost.final) continue
    if (day === today || cost.rate == null) {
      cost.rate = s.autoUsd ? s.usdPerUnit * (s.usdRate ?? s.fallbackRate) : s.billing?.rmbRate ?? 1
      cost.quotaRate = Number.isFinite(s.quotaScale) ? s.quotaScale * cost.rate : null
      cost.group = s.provider === 'sub2api' ? JSON.stringify([s.origin, s.walletGroup || '']) : null
    }
    const historical = day < today && day !== s.periodDay
    const actual = historical ? s.keyUsage?.daily?.find(p => p.label === day)?.actual : null
    const value = actual ?? (s.periodDay === day ? s.todayValue : s.history?.find(p => p.day === day)?.value)
    if (Number.isFinite(value)) {
      cost.value = value * cost.rate
      cost.estimated = day < today || s.estimatedSince != null || s.paused || s.health !== 'ok'
      if (Number.isFinite(actual)) {
        cost.estimated = false
        cost.final = true
      }
    }
    const wallet = s.walletSpend?.history?.find(p => p.day === day)
    if (wallet) {
      cost.wallet = wallet.value * cost.rate
      cost.walletAt = wallet.at
    }
  }
}

// Freeze daily membership and rates so edits and removals cannot rewrite prior profits.
export function captureProfit(state, at) {
  const p = state.profit
  if (!p) return
  const today = dayKey(new Date(at))
  const sites = costSites(state.sites, p.origin)
  for (let day = p.lastDay ? nextDay(p.lastDay) : p.start; day <= today; day = nextDay(day)) {
    p.days[day] = { revenue: null, closed: false, costs: {} }
    captureCosts(p.days[day], sites, day, today, true)
    p.lastDay = day
  }
  if (p.days[today]) captureCosts(p.days[today], sites, today, today, true)
}

function dayView(day, row, today) {
  let cost = 0, estimated = false
  const missing = [], groups = new Map()
  function add(c) {
    if (c.value == null) missing.push(c.name)
    else {
      cost += c.value
      estimated ||= c.estimated || (day < today && !c.final)
    }
  }
  for (const c of Object.values(row.costs)) {
    if (!c.group) add(c)
    else {
      if (!groups.has(c.group)) groups.set(c.group, [])
      groups.get(c.group).push(c)
    }
  }
  for (const members of groups.values()) {
    const wallet = members.filter(c => Number.isFinite(c.wallet)).sort((a, b) => b.walletAt - a.walletAt)[0]
    if (wallet && members.every(c => c.value == null)) {
      cost += wallet.wallet
      estimated = true
    } else members.forEach(add)
  }
  const ready = row.revenue != null && (day === today || row.closed)
  return { day, revenue: row.revenue, cost, missing, estimated,
    profit: ready ? row.revenue - cost : null }
}

export function profitView(p, at = Date.now()) {
  if (!p) return null
  const today = dayKey(new Date(at))
  const days = Object.keys(p.days).sort().reverse().map(day => dayView(day, p.days[day], today))
  return { origin: p.origin, userId: p.userId, rate: p.rate, start: p.start, checked: p.checked,
    error: p.error, days }
}

export async function saveProfitSource(monitor, input) {
  const origin = siteAddress(input.origin)
  const previous = monitor.state.profit
  if (previous && previous.origin !== origin) throw Error('当前利润账本已关联其他收入站。')
  const token = String(input.token || '').trim().replace(/^Bearer\s+/i, '') ||
    (previous && await monitor.secret(profitSecret))
  if (!token || token.length > 8192 || /[\r\n]/.test(token)) throw Error('请输入有效的管理员访问令牌。')
  const userId = String(input.userId ?? '').trim()
  if (userId && !/^[1-9]\d*$/.test(userId)) throw Error('用户 ID 应为正整数。')
  const rate = input.rate ?? null
  if (rate != null && !(Number.isFinite(rate) && rate > 0)) throw Error('折算比例必须大于零。')
  const at = Date.now(), day = dayKey(new Date(at))
  const start = input.start ?? previous?.start ?? day
  if (!isDayKey(start) || start > (previous?.start ?? day)) throw Error('请选择有效的起算日期，已有账本只支持向前补查。')
  const [scale, quota] = await Promise.all([profitScale(origin, rate), readDayQuota({ origin, userId }, token, day, at, true)])
  const cipher = await monitor.crypto.encryptStringAsync(token)
  monitor.change(state => {
    if (state.profit?.revision !== previous?.revision) throw Error('收入站配置已更新，请重新打开设置。')
    const p = state.profit ??= { days: {}, start }
    const costs = costSites(state.sites, origin)
    for (let d = start; d < p.start; d = nextDay(d)) {
      p.days[d] = { revenue: null, closed: false, costs: {} }
      captureCosts(p.days[d], costs, d, day, true)
    }
    p.start = start
    Object.assign(p, { origin, userId, rate, revision: (p.revision ?? 0) + 1, checked: at, tried: at, error: '', retryAt: 0 })
    captureProfit(state, at)
    if (Object.entries(p.days).some(([d, row]) => d < day && !row.closed)) p.tried = 0
    Object.assign(p.days[day], { revenue: quota * scale, scale })
    monitor.putSecret(profitSecret, cipher)
  })
}

async function closeCosts(monitor, source, day, today) {
  const row = structuredClone(source.days[day])
  const sites = costSites(monitor.state.sites, source.origin)
  captureCosts(row, sites, day, today, false)
  for (const s of sites) {
    const c = row.costs[siteIdentity(s)]
    if (!c || c.final || !c.quotaRate || s.paused || (s.provider ?? 'new-api') !== 'new-api') continue
    try {
      const token = await monitor.secret(s.id)
      c.value = await readDayQuota(s, token, day, Date.now(), false) * c.quotaRate
      c.estimated = false
      c.final = true
    } catch {
      // Balance-only credentials can still supply the archived estimate.
    }
  }
  return row.costs
}

export async function pollProfit(monitor, force) {
  const at = Date.now(), today = dayKey(new Date(at))
  const initial = monitor.state.profit
  if (!initial || at < initial.retryAt || (!force && initial.lastDay === today && at - initial.tried < monitor.state.minutes * 60000)) return
  const current = () => monitor.state.profit?.revision === initial.revision
  monitor.change(state => { captureProfit(state, at); state.profit.tried = at })
  try {
    const source = monitor.state.profit
    const token = await monitor.secret(profitSecret)
    const scale = await profitScale(source.origin, source.rate)
    const revenue = await readDayQuota(source, token, today, at, true) * scale
    if (!current()) return
    monitor.change(state => {
      Object.assign(state.profit.days[today], { revenue, scale })
      Object.assign(state.profit, { checked: at, error: '', retryAt: 0 })
    })
    // Settle missed local days in bounded batches after sleep or an extended shutdown.
    const outstanding = Object.keys(source.days).filter(day => day < today && !source.days[day].closed)
    for (const day of outstanding.slice(0, 7)) {
      const value = await readDayQuota(source, token, day, at, true) * (source.days[day].scale ?? scale)
      const costs = await closeCosts(monitor, source, day, today)
      if (!current()) return
      monitor.change(state => Object.assign(state.profit.days[day], { revenue: value, costs, closed: true }))
    }
    if (outstanding.length > 7) monitor.change(state => { state.profit.tried = 0 })
    // Revisit a closed day when an upstream can replace a missing or estimated reading.
    const sites = costSites(monitor.state.sites, source.origin).filter(s => !s.paused)
    const retry = Object.entries(source.days).filter(([day, row]) => row.closed && sites.some(s => {
      const c = row.costs[siteIdentity(s)]
      return c && !c.final && ((c.quotaRate && s.usage && (s.provider ?? 'new-api') === 'new-api') ||
        s.keyUsage?.daily?.some(p => p.label === day && Number.isFinite(p.actual)))
    })).sort(([, a], [, b]) => (a.costCheck ?? 0) - (b.costCheck ?? 0))[0]
    if (retry) {
      const [day] = retry
      const costs = await closeCosts(monitor, source, day, today)
      if (current()) monitor.change(state => Object.assign(state.profit.days[day], { costs, costCheck: at }))
    }
  } catch (e) {
    if (current()) monitor.change(state => Object.assign(state.profit, { error: e.message, retryAt: e.retryAt || 0 }))
  }
}
