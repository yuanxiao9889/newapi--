import { dayKey } from './new-api.mjs'

// SUB2API reports spending per Key. Its wallet and subscription can cover other Keys.
function spendingDelta(provider, previous, data) {
  if (provider === 'sub2api') {
    for (const read of [s => s.keyUsage?.total?.actual, s => s.quotaUsed]) {
      const before = read(previous), after = read(data)
      if (Number.isFinite(before) && Number.isFinite(after) && after >= before) return after - before
    }
    return null
  }
  if (Number.isFinite(previous.usedQuota) && Number.isFinite(data.usedQuota) && data.usedQuota >= previous.usedQuota)
    return (data.usedQuota - previous.usedQuota) * data.quotaScale
  if (Number.isFinite(previous.balance) && Number.isFinite(data.balance))
    return Math.max(0, previous.balance - data.balance)
  return null
}

export function dailySpend(provider, previous, data, now) {
  const day = data.periodDay || dayKey(new Date(now))
  const [year, month, date] = day.split('-').map(Number)
  const yesterday = dayKey(new Date(year, month - 1, date - 1))
  const compatible = previous?.checked > 0 && previous.unit === data.unit &&
    previous.balanceScope === data.balanceScope &&
    (previous.quotaScale == null || previous.quotaScale === data.quotaScale)
  const lastDay = compatible && (previous.periodDay || dayKey(new Date(previous.checked)))
  const history = new Map()
  if (compatible) for (const p of previous.history ?? []) history.set(p.day, p)
  for (const p of data.history ?? []) history.set(p.day, p)
  let value = data.todayValue ?? null
  let estimatedSince = null
  if (value === null && (lastDay === day || lastDay === yesterday)) {
    const delta = spendingDelta(provider, previous, data)
    if (delta !== null) {
      const continued = lastDay === day && Number.isFinite(previous.todayValue)
      value = (continued ? previous.todayValue : 0) + delta
      estimatedSince = continued ? previous.estimatedSince ?? new Date(year, month - 1, date).getTime() : previous.checked
    }
  }
  if (value === null) history.delete(day)
  else history.set(day, { day, value })
  return { periodDay: day, todayValue: value, estimatedSince,
    history: [...history.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-62) }
}
