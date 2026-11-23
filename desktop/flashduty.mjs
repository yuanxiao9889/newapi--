import { fetchHttp } from './http.mjs'

export function integrationAddress(input) {
  const value = String(input ?? '').trim().replace(/^https\\:/i, 'https:')
  const url = URL.canParse(value) ? new URL(value) : null
  if (!url || !['https://api.flashcat.cloud', 'https://api.flashduty.com'].includes(url.origin) ||
      url.pathname !== '/event/push/alert/standard' || url.username || url.password || url.hash ||
      url.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{1,256}$/.test(url.searchParams.get('integration_key') ?? ''))
    throw Error('请粘贴 Flashduty 自定义事件的完整 HTTPS 集成地址，包含 integration_key。')
  return url.href
}

export async function sendFlashduty(address, event) {
  const url = integrationAddress(address)
  let response, body
  try {
    response = await fetchHttp(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    })
    body = await response.text()
  } catch {
    throw Error('无法连接 Flashduty 或请求超时，请检查网络和系统代理。')
  }
  if (!response.ok) throw Error('Flashduty 拒绝事件（HTTP ' + response.status + '），请检查集成地址。')
  if (!body.trim()) return
  let result
  try { result = JSON.parse(body) } catch { throw Error('Flashduty 响应格式异常，无法确认事件已接收。') }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.err || result.error || result.success === false ||
      (result.code != null && ![0, '0', 200, '200'].includes(result.code)))
    throw Error('Flashduty 未确认接收事件，请检查集成状态。')
}
