import { ApiError, requestJson } from './new-api.mjs'

export function customConfig(input) {
  const balancePath = String(input?.balancePath ?? '').trim()
  if (!balancePath || balancePath.length > 256 || !balancePath.split('.').every((key) => /^[\p{L}\p{N}_-]+$/u.test(key)))
    throw Error('请填写余额字段路径，例如 balance 或 data.balance。')
  if (!['bearer', 'x-api-key'].includes(input.auth)) throw Error('请选择有效的 API Key 鉴权方式。')
  if (!['CNY', 'USD'].includes(input.currency)) throw Error('请选择余额币种。')
  return { balancePath, auth: input.auth, currency: input.currency }
}

export async function queryCustom({ origin, token, custom }) {
  const { balancePath, auth, currency } = customConfig(custom)
  const headers = auth === 'bearer' ? { Authorization: 'Bearer ' + token } : { 'X-API-Key': token }
  const body = await requestJson(origin, { ...headers, Accept: 'application/json' }, '余额查询', '自定义接口')
  let field = body
  for (const key of balancePath.split('.')) {
    if (field === null || typeof field !== 'object' || !Object.hasOwn(field, key))
      throw new ApiError('响应中找不到配置的余额字段，请检查字段路径。')
    field = field[key]
  }
  const balance = typeof field === 'string' && /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(field.trim())
    ? Number(field) : field
  if (!Number.isFinite(balance)) throw new ApiError('余额字段必须是有效数字或数字字符串。')
  if (body?.object === 'balance' && typeof body.currency === 'string' && body.currency !== currency)
    throw new ApiError('接口返回的币种与配置不一致，请检查余额币种。')
  return {
    accountId: null, balance, unit: currency, usdPerUnit: currency === 'USD' ? 1 : null, usdRate: null,
    balanceScope: ['tenant', 'sub_account'].includes(body?.scope) ? body.scope : null,
    usage: false, usageNote: '', todayValue: null, monthValue: null, periodDay: '', history: [], historyAt: 0,
  }
}
