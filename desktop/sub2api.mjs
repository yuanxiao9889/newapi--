import { ApiError, dayKey, requestJson } from './new-api.mjs'

const number = (value) => Number.isFinite(value) ? value : null

function usageRow(row) {
  return {
    requests: number(row.requests),
    input: number(row.input_tokens),
    output: number(row.output_tokens),
    cacheRead: number(row.cache_read_tokens),
    cacheWrite: number(row.cache_write_tokens ?? row.cache_creation_tokens),
    cost: number(row.cost),
    actual: number(row.actual_cost),
  }
}

function limits(data) {
  if (data.mode === 'quota_limited') {
    const windows = { '5h': '5 小时', '1d': '每日', '7d': '每周' }
    const rates = Array.isArray(data.rate_limits) ? data.rate_limits : []
    const rows = rates.filter((r) => r && Object.hasOwn(windows, r.window))
      .map((r) => ({ label: windows[r.window], used: number(r.used), limit: number(r.limit) }))
    if (data.quota) rows.unshift({ label: 'Key 总额度', used: number(data.quota.used), limit: number(data.quota.limit) })
    return rows
  }
  const sub = data.subscription
  if (!sub) return []
  return [['daily', '每日'], ['weekly', '每周'], ['monthly', '每月']]
    .filter(([period]) => number(sub[period + '_limit_usd']) > 0)
    .map(([period, label]) => ({ label, used: number(sub[period + '_usage_usd']), limit: sub[period + '_limit_usd'] }))
}

export async function querySub2Api({ origin, token }, now = new Date()) {
  const today = dayKey(now)
  const monthStart = today.slice(0, 7) + '-01'
  const params = new URLSearchParams({ start_date: monthStart, end_date: today, days: '31',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' })
  const data = await requestJson(origin + '/v1/usage?' + params, {
    Accept: 'application/json', Authorization: 'Bearer ' + token,
  }, 'Key 用量查询', 'SUB2API')
  if (data?.isValid === false) throw new ApiError('SUB2API 已停用该 Key。', 401)
  if (!['unrestricted', 'quota_limited'].includes(data?.mode) || (data.unit && data.unit !== 'USD'))
    throw new ApiError('站点未返回可识别的 SUB2API 用量数据。')

  let balanceKind, balance
  if (data.mode === 'quota_limited') {
    balanceKind = data.quota ? 'quota' : 'window'
    balance = number(data.quota?.remaining)
  } else if (Object.hasOwn(data, 'balance')) {
    balanceKind = 'wallet'
    balance = number(data.balance)
    if (balance === null) throw new ApiError('站点返回了无效的钱包余额。')
  } else {
    balanceKind = 'subscription'
    balance = data.remaining === -1 ? null : number(data.remaining)
  }

  const daily = Array.isArray(data.daily_usage) && data.daily_usage.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r?.date))
    ? data.daily_usage.map((r) => ({ label: r.date, ...usageRow(r) })).sort((a, b) => a.label.localeCompare(b.label))
    : null
  const models = Array.isArray(data.model_stats) ? data.model_stats.filter((r) => typeof r?.model === 'string')
    .map((r) => ({ label: r.model, ...usageRow(r) })) : []
  const total = data.usage?.total ? usageRow(data.usage.total) : null
  const todayRow = daily?.find((r) => r.label === today)
  const todayValue = daily === null ? number(data.usage?.today?.actual_cost) : todayRow ? todayRow.actual : 0
  const thisMonth = daily?.filter((r) => r.label >= monthStart && r.label <= today)
  // Model stats use the requested calendar-month range even on versions without daily rows.
  const monthRows = thisMonth ?? (models.length ? models : null)
  const monthValue = monthRows && monthRows.every((r) => r.actual !== null)
    ? monthRows.reduce((sum, r) => sum + r.actual, 0) : null
  const history = (daily ?? []).filter((r) => r.actual !== null).map((r) => ({ day: r.label, value: r.actual }))
  if (todayValue !== null && !history.some((r) => r.day === today)) history.push({ day: today, value: todayValue })
  const usage = todayValue !== null || monthValue !== null || total !== null || models.length > 0
  return {
    balanceKind, balance, accountId: null, unit: 'USD', usdPerUnit: 1, usdRate: null,
    todayValue, monthValue, periodDay: today, history, usage,
    usageNote: daily === null ? '站点未返回每日明细。' : '',
    keyUsage: { total, daily, models, month: today.slice(0, 7), limits: limits(data),
      unlimited: balanceKind === 'subscription' && data.remaining === -1 },
  }
}
