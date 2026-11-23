import { fetchHttp } from './http.mjs'

export function siteAddress(value, provider = 'new-api') {
  let url
  try {
    const text = String(value ?? '').trim()
    if (!text) throw Error()
    url = new URL(text.includes('://') ? text : 'https://' + text)
  } catch {
    throw new Error('请输入有效的站点地址。')
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error('站点地址应为 HTTP(S) 网址，可包含部署子路径。')
  if (provider === 'custom') return url.href
  const endpoint = provider === 'sub2api' ? /\/(?:key-usage|v1(?:\/usage)?)$/ : /\/(?:api|v1)$/
  return url.origin + url.pathname.replace(/\/+$/, '').replace(endpoint, '')
}

const httpLabels = {
  401: '认证失败', 403: '权限不足', 404: '接口不存在', 408: '请求超时', 429: '请求限流',
  500: '服务器内部错误', 502: '网关异常', 503: '服务暂不可用', 504: '网关超时',
}

export class ApiError extends Error {
  constructor(message, status = 0, { label, transient, retryAt = 0, range = false, authFailure = [401, 403].includes(status) } = {}) {
    super(message)
    this.status = status
    this.authFailure = authFailure
    this.label = label ?? (status ? (httpLabels[status] || 'HTTP 错误') + ' ' + status : undefined)
    this.transient = transient ?? ([408, 425, 429].includes(status) || (status >= 500 && status < 600))
    this.retryAt = retryAt
    this.range = range
  }
}

function retryAfter(value) {
  if (!value) return 0
  const at = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value)
  return Number.isFinite(new Date(at).getTime()) && at > Date.now() ? at : 0
}

function transportError(subject, error, timedOut) {
  const code = error.cause?.code ?? error.cause?.errors?.[0]?.code ?? error.code ?? error.message?.match(/net::(ERR_[A-Z_]+)/)?.[1]
  let label = '网络连接中断', transient = true
  if (timedOut || error.name === 'TimeoutError' || ['ETIMEDOUT', 'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code))
    label = '请求超时'
  else if (['ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED'].includes(code)) label = 'DNS 解析失败'
  else if (['ECONNREFUSED', 'ERR_CONNECTION_REFUSED'].includes(code)) label = '连接被拒绝'
  else if (['ENETUNREACH', 'EHOSTUNREACH', 'ERR_ADDRESS_UNREACHABLE', 'ERR_INTERNET_DISCONNECTED'].includes(code)) label = '网络不可达'
  else if (['ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_SOCKS_CONNECTION_FAILED'].includes(code)) label = '系统代理连接失败'
  else if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code ?? '')) {
    label = '证书验证失败'
    transient = false
  }
  const detail = timedOut ? '请求超时（12 秒）' : label
  return new ApiError(subject + '：' + detail + '。', 0, { label, transient })
}
export function dayKey(d) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}
function localMidnight(d, offset = 0) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset)
}
function numeric(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw))
    throw new ApiError('站点返回了无效的额度字段。')
  return raw
}
export async function requestJson(url, headers, subject, platform = 'New API') {
  let response
  const signal = AbortSignal.timeout(12000)
  try {
    response = await fetchHttp(url, { headers, redirect: 'manual', signal })
    if (response.status >= 300 && response.status < 400)
      throw new ApiError('站点发生跳转，请填写最终的站点网址。')
    if (response.status === 403) {
      const challenge = response.headers.get('cf-mitigated') === 'challenge'
      const html = /^text\/html\b/i.test(response.headers.get('content-type') ?? '')
      if (challenge || html) {
        const detail = challenge ? 'Cloudflare 要求浏览器验证' : '站点返回了访问限制网页'
        throw new ApiError(subject + '：' + detail + '（HTTP 403）。请联系站点管理员核查 API 访问规则。', 403,
          { label: '站点访问受限 403', authFailure: false })
      }
    }
    if (!response.ok)
      throw new ApiError(
        subject +
          '：' +
          ({
            401: platform === 'New API' ? '令牌无效或已过期，请检查访问令牌及用户 ID。' : 'API Key 无效或已过期。',
            403: '权限不足，请检查令牌的查看权限。',
            404: platform === '自定义接口' ? '找不到余额接口，请检查完整查询地址。' : '找不到该接口，请检查站点地址与 ' + platform + ' 版本。',
          }[response.status] || (httpLabels[response.status] ?? '站点请求失败') + '（HTTP ' + response.status + '）。'),
        response.status,
        { retryAt: retryAfter(response.headers.get('Retry-After')) },
      )
    const reader = response.body.getReader(),
      chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 12 * 1024 * 1024) {
        await reader.cancel()
        throw new ApiError('站点响应过大，请稍后重试。')
      }
      chunks.push(value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new ApiError('响应不是 ' + platform + ' 的 JSON 数据，请检查站点地址。')
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    // Chromium rejects a manual redirect instead of returning the 3xx response.
    if (error.message === 'Redirect was cancelled')
      throw new ApiError('站点发生跳转，请填写最终的站点网址。')
    throw transportError(subject, error, signal.aborted)
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}
async function json(url, headers, subject) {
  const body = await requestJson(url, headers, subject)
  if (body?.success !== true) {
    // Servers may echo Authorization. Classify their message without persisting it.
    const message = JSON.stringify([body?.message, body?.code, body?.error]).toLowerCase()
    if (/time range|time_range|时间范围|时间跨度/.test(message))
      throw new ApiError('站点限制了单次查询的时间范围。', 400, { range: true })
    if (/too many requests|rate[ _-]?limit|请求过于频繁|请求频率过高|请求限流/.test(message))
      throw new ApiError(subject + '：站点提示请求限流。', 429, { label: '请求限流' })
    if (/new-api-user|user id|用户.?id/i.test(message))
      throw new ApiError('该站点要求正确的用户 ID，请填写控制台里的数字 ID。', 401)
    if (/permission|scope|权限/.test(message))
      throw new ApiError(subject + '：缺少所需查看权限。', 403)
    if (/auth|token|令牌|登录/.test(message))
      throw new ApiError('访问令牌无效、已过期或账号不可用。', 401)
    throw new ApiError(subject + '：站点未能完成请求。')
  }
  return body.data
}
function display(status, origin) {
  let kind = status.quota_display_type
  if (!kind) kind = status.display_in_currency === false ? 'TOKENS' : 'USD'
  const factor = (value) => {
    const n = numeric(value)
    if (n <= 0) throw new ApiError('站点未提供有效的额度换算参数。')
    return n
  }
  if (kind === 'TOKENS') return { unit: '积分@' + origin, scale: 1 }
  const per = factor(status.quota_per_unit)
  if (kind === 'USD') return { unit: 'USD', scale: 1 / per }
  if (kind === 'CNY') return { unit: 'CNY', scale: factor(status.usd_exchange_rate) / per }
  if (kind === 'CUSTOM')
    return {
      unit:
        String(status.custom_currency_symbol || '额度')
          .replace(/[@\r\n]/g, '')
          .slice(0, 16) +
        '@' +
        origin,
      scale: factor(status.custom_currency_exchange_rate) / per,
    }
  throw new ApiError('无法识别该站点的余额单位。')
}

function usdQuote(status, unit, scale) {
  const usdPerUnit = unit === 'USD' ? 1 : 1 / (status.quota_per_unit * scale)
  return {
    usdPerUnit: Number.isFinite(usdPerUnit) && usdPerUnit > 0 ? usdPerUnit : null,
    usdRate: Number.isFinite(status.usd_exchange_rate) && status.usd_exchange_rate > 0
      ? status.usd_exchange_rate : null,
  }
}

export async function readUsdQuote(site) {
  const status = await json(site.origin + '/api/status', { Accept: 'application/json' }, '站点配置')
  const { unit, scale } = display(status, site.origin)
  if (unit !== site.unit) throw new ApiError('站点计价单位已变更，请先刷新余额。')
  return usdQuote(status, unit, scale)
}

export async function querySite({ origin, token, userId }, previous, now = new Date()) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token }
  if (userId) headers['New-Api-User'] = userId
  const results = await Promise.allSettled([
    json(origin + '/api/status', { Accept: 'application/json' }, '站点配置'),
    json(origin + '/api/user/self', headers, '余额查询'),
  ])
  // Both requests belong to one observation. Honor the longest cooldown either returned.
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason)
  if (errors.length) {
    const error = errors.find((e) => !e.transient) ?? errors.find((e) => e.status === 429) ?? errors[0]
    error.retryAt = Math.max(...errors.map((e) => e.retryAt || 0))
    throw error
  }
  const [status, user] = results.map((r) => r.value)
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || !status)
    throw new ApiError('该地址没有返回有效的 New API 账户。')
  const { unit, scale } = display(status, origin)
  const today = dayKey(now),
    end = Math.floor(now.getTime() / 1000),
    startOfToday = Math.floor(localMidnight(now).getTime() / 1000)
  const startOfMonth = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000)
  const data = {
    accountId: user.id,
    unit,
    ...usdQuote(status, unit, scale),
    balance: numeric(user.quota) * scale,
    usedQuota: Number.isFinite(user.used_quota) ? user.used_quota : null,
    quotaScale: scale,
    usage: false,
    usageNote: '',
    todayValue: null,
    monthValue: null,
    periodDay: today,
    history: [],
    historyAt: 0,
  }
  async function range(route, start, last, stat, depth = 0) {
    try {
      const url =
        origin +
        route +
        '?start_timestamp=' +
        start +
        '&end_timestamp=' +
        last +
        (stat ? '&type=2' : '')
      const result = await json(url, headers, '消费统计')
      if (stat) return numeric(result?.quota)
      if (!Array.isArray(result) && result !== null)
        throw new ApiError('站点未返回有效的消费趋势。')
      return result || []
    } catch (error) {
      if (!error.range || last - start < 86400 || depth >= 6) throw error
      const middle = Math.floor((start + last) / 2)
      const left = await range(route, start, middle, stat, depth + 1),
        right = await range(route, middle + 1, last, stat, depth + 1)
      return stat ? left + right : left.concat(right)
    }
  }
  const same = previous?.unit === unit && previous?.accountId === user.id &&
    (previous.quotaScale == null || previous.quotaScale === scale)
  if (same) {
    data.history = previous.history
    data.historyAt = previous.historyAt || 0
  }
  try {
    const todayRaw = await range('/api/log/self/stat', startOfToday, end, true)
    data.todayValue = todayRaw * scale
    data.usage = true
    data.history = [
      ...data.history.filter((p) => p.day !== today),
      { day: today, value: data.todayValue },
    ]
    data.monthValue =
      startOfMonth === startOfToday
        ? data.todayValue
        : (await range('/api/log/self/stat', startOfMonth, end, true)) * scale
    if (
      status.enable_data_export !== false &&
      (!same || Date.now() - data.historyAt >= 3600000 || previous.periodDay !== today)
    ) {
      const first = localMidnight(now, -29)
      const rows = await range('/api/data/self', Math.floor(first.getTime() / 1000), end, false)
      const bins = new Map()
      for (const row of rows) {
        const date = dayKey(new Date(numeric(row.created_at) * 1000))
        bins.set(date, (bins.get(date) || 0) + numeric(row.quota) * scale)
      }
      // An empty or disabled export cannot establish zero spend for the missing days.
      data.history = Array.from({ length: 30 }, (_, i) => dayKey(localMidnight(first, i))).flatMap(
        (day) =>
          day === today
            ? [{ day, value: data.todayValue }]
            : bins.has(day)
              ? [{ day, value: bins.get(day) }]
              : data.history.filter((p) => p.day === day),
      )
      data.historyAt = Date.now()
    }
  } catch (error) {
    data.usageNote = error.message
  }
  if (!data.usage && !data.usageNote) data.usageNote = '站点未提供期间消费。'
  return data
}
