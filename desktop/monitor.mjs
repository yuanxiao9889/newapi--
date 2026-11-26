import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { ApiError, dayKey, querySite, readUsdQuote, siteAddress } from './new-api.mjs'
import { querySub2Api } from './sub2api.mjs'
import { dailySpend } from './daily-spend.mjs'
import { customConfig, queryCustom } from './custom-balance.mjs'
import { emptyMail, mailConfig, mailIdentity, deliver, recipients } from './mail.mjs'
import { nextRecipient, setRecipients, updateDelivery, needsDeliveryRecovery, recoverDelivery } from './notice-mail.mjs'
import { integrationAddress, sendFlashduty } from './flashduty.mjs'
import { siteIdentity } from './config-transfer.mjs'
import { captureProfit, pollProfit, profitView } from './profit.mjs'

const copy = structuredClone
const empty = () => ({
  version: 1,
  sites: [],
  notices: [],
  minutes: 15,
  followSystemProxy: true,
  globalThreshold: null,
  theme: 'system',
  mail: { ...emptyMail },
})
function text(v, max) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}
function walletGroupName(value) {
  const name = text(value, 80)
  return name === '默认账户' ? '' : name
}
function limit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw Error('请输入有效的非负阈值。')
  return value
}
function log(site, at, message) {
  site.logs = [{ at, text: message }, ...site.logs].slice(0, 60)
}

function recordFailure(site, error, now, count = (site.issue?.count ?? 0) + 1) {
  const pending = error.transient && count === 1
  const delay = error.status === 429 ? 60000 : pending ? 30000 : 0
  const retryAt = Math.max(delay ? now + delay : 0, error.retryAt || 0)
  site.tried = now
  site.health = pending ? 'retrying' : error.authFailure ? 'invalid' : 'offline'
  site.issue = {
    label: error.label ?? error.message.replace(/[。.]$/, ''),
    detail: error.message,
    count: error.transient ? count : 0,
    retryAt,
  }
}

// Older workspaces stored only a log message and the last attempt time.
function legacyError(message) {
  const http = message.match(/HTTP (\d{3})\b/)
  if (http) return new ApiError(message, Number(http[1]))
  if (message.includes('站点请求限流')) return new ApiError(message, 429)
  if (message.includes('连接失败或超时'))
    return new ApiError(message, 0, { label: '连接异常或超时', transient: true })
}
function restoreLegacyIssue(site) {
  const index = site.logs.findIndex((l) => l.at === site.tried)
  if (index < 0) return
  const detail = site.logs[index].text
  const error = legacyError(detail)
  if (!error) {
    site.issue = { label: site.health === 'invalid' ? (detail.includes('权限') ? '权限不足' : '认证失败') : detail.replace(/。$/, ''),
      detail, count: 0, retryAt: 0 }
    return
  }
  let count = 1
  for (const log of site.logs.slice(index + 1)) {
    if (log.at <= site.checked || !legacyError(log.text)?.transient) break
    count++
  }
  recordFailure(site, error, site.tried, count)
}

function pollDue(site, now, minutes, force) {
  if (site.paused || now < (site.issue?.retryAt ?? 0)) return false
  return force || site.health === 'retrying' || now - site.tried >= minutes * 60000
}
function amount(value, unit) {
  const label = unit === 'CNY' ? '¥' : unit === 'USD' ? '$' : unit.split('@')[0] + ' '
  return label + value.toLocaleString('zh-CN', { maximumFractionDigits: 6 })
}

function rmbFactor(data, fallbackRate) {
  const factor = data.usdPerUnit * (data.usdRate ?? fallbackRate)
  if (!(factor > 0) || !Number.isFinite(factor) || !Number.isFinite(data.balance * factor))
    throw Error('缺少有效的美元兑人民币换算参数，请检查站点汇率。')
  return factor
}

function displayUnit(site) {
  return site.autoUsd || site.provider === 'sub2api' ? 'CNY' : site.billing?.unit ?? 'CNY'
}

// /v1/usage returns no wallet owner ID. Group by deployment and the local account label.
function walletKey(site) {
  return JSON.stringify([site.origin, walletGroupName(site.walletGroup)])
}

function sharedWallets(sites) {
  const shared = new Map()
  for (const site of sites) {
    if (site.provider !== 'sub2api' || site.balanceKind !== 'wallet' || !Number.isFinite(site.balance)) continue
    const key = walletKey(site)
    const group = shared.get(key) ?? {}
    if (!group.latest || site.checked >= group.latest.checked) group.latest = site
    if (site.autoUsd && (!group.quote || site.checked >= group.quote.checked)) group.quote = site
    if (!site.paused && (!group.active || site.checked >= group.active.checked)) group.active = site
    shared.set(key, group)
  }
  return shared
}

function walletBalances(sites, shared) {
  const wallets = []
  for (const site of sites) {
    if (site.provider !== 'sub2api') {
      const value = site.autoUsd ? site.balance * rmbFactor(site, site.fallbackRate) : site.balance
      wallets.push({ unit: displayUnit(site), value, rmb: value * (site.billing?.rmbRate ?? 1) })
    }
  }
  for (const { latest, quote } of shared.values()) {
    const rmb = latest.balance * (quote ? rmbFactor(quote, quote.fallbackRate) : 1)
    wallets.push({ unit: 'CNY', value: rmb, rmb })
  }
  return wallets
}

// Show a wallet estimate only once per account and day, when no Key reported spend.
function walletSpendFallbacks(sites) {
  const groups = new Map()
  for (const site of sites.filter((s) => s.provider === 'sub2api')) {
    const key = walletKey(site)
    const group = groups.get(key) ?? { reported: new Set(), estimates: new Map() }
    if (Number.isFinite(site.todayValue)) group.reported.add(site.periodDay)
    for (const p of site.history ?? []) group.reported.add(p.day)
    for (const p of site.walletSpend?.history ?? []) {
      const previous = group.estimates.get(p.day)
      if (!previous || p.at > previous.point.at) group.estimates.set(p.day, { id: site.id, point: p })
    }
    groups.set(key, group)
  }
  const result = new Map()
  for (const { reported, estimates } of groups.values()) {
    for (const [day, { id, point }] of estimates) {
      if (reported.has(day)) continue
      const rows = result.get(id) ?? []
      rows.push(point)
      result.set(id, rows)
    }
  }
  return result
}

export function displayState(state) {
  const shared = sharedWallets(state.sites)
  const walletSpending = walletSpendFallbacks(state.sites)
  const unread = new Set(state.sites.filter((s) => s.provider === 'sub2api' && !shared.has(walletKey(s))).map(walletKey))
  return { ...state, profit: profitView(state.profit), unreadWalletCount: unread.size, wallets: walletBalances(state.sites, shared), sites: state.sites.map((site) => {
    const source = site.provider === 'sub2api' ? shared.get(walletKey(site))?.latest : site
    const factor = site.autoUsd ? rmbFactor(site, site.fallbackRate) : 1
    const points = walletSpending.get(site.id) ?? []
    const walletToday = points.find((p) => p.day === site.periodDay)
    const view = { ...site, accountBalance: source?.balance == null ? null : source.balance * factor,
      todayValue: walletToday?.value ?? site.todayValue, estimatedSince: walletToday?.since ?? site.estimatedSince,
      walletSpendEstimate: !!walletToday, history: points.length ? [...site.history, ...points] : site.history,
      walletChecked: source?.checked ?? null, walletSourceId: source?.id ?? null }
    if (!site.autoUsd) return view
    return { ...view, balance: site.balance == null ? null : site.balance * factor,
      todayValue: view.todayValue == null ? null : view.todayValue * factor,
      monthValue: site.monthValue == null ? null : site.monthValue * factor,
      history: view.history.map((p) => ({ ...p, value: p.value * factor })),
    }
  }) }
}

function configureAutoUsd(site, data, enabled, fallbackRate) {
  if (typeof enabled !== 'boolean') throw Error('无效的美元计费设置。')
  if (enabled && fallbackRate != null && (!Number.isFinite(fallbackRate) || fallbackRate <= 0))
    throw Error('备用汇率必须大于 0。')
  if (enabled) {
    rmbFactor(data, fallbackRate)
    site.billing = null
  }
  site.autoUsd = enabled
  site.fallbackRate = enabled ? fallbackRate ?? null : null
}

function queryBalance({ provider, origin, custom, userId }, token, previous) {
  if (provider === 'custom') return queryCustom({ origin, token, custom })
  if (provider === 'sub2api') return querySub2Api({ origin, token })
  return querySite({ origin, token, userId }, previous)
}

function closeNotice(notice, now) {
  notice.closed = now
  if (['pending', 'failed'].includes(notice.flashduty?.status)) notice.flashduty.status = 'cancelled'
  if (notice.recipients) {
    for (const r of notice.recipients)
      if (['pending', 'failed'].includes(r.delivery)) r.delivery = 'cancelled'
    updateDelivery(notice)
  }
}

// Older versions queued Flashduty at the first low reading, before email delivery.
function unconfirmedFlashduty(notice) {
  return !notice.closed && ['pending', 'failed'].includes(notice.flashduty?.status) &&
    notice.flashduty.confirmedAt == null
}

export class Monitor {
  constructor(file, crypto, onChange = () => {}, send = deliver) {
    this.db = new DatabaseSync(file)
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secrets(id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);',
    )
    const row = this.db.prepare('SELECT data FROM workspace WHERE id=1').get()
    this.state = row ? JSON.parse(row.data) : empty()
    if (this.state.version !== 1) throw Error('数据库版本不受支持。')
    this.state.flashduty ??= { enabled: false, configured: false }
    this.state.globalThreshold ??= null
    this.state.followSystemProxy ??= true
    for (const site of this.state.sites) {
      if (['offline', 'invalid'].includes(site.health) && !site.issue) restoreLegacyIssue(site)
    }
    this.crypto = crypto
    this.onChange = onChange
    this.send = send
    this.flights = new Map()
    this.tickets = new Map()
    this.sending = false
    this.sendingFlashduty = false
    const obsoleteLow = this.state.sites.filter((site) => site.provider === 'sub2api' && site.balanceKind !== 'wallet' &&
      (site.low || this.state.notices.some((n) => n.siteId === site.id && !n.closed)))
    const defaultSubIds = new Set(this.state.sites.filter((s) => s.provider === 'sub2api' && !s.autoUsd).map((s) => s.id))
    const legacySubNotice = (n) => !n.closed && n.unit === 'USD' && defaultSubIds.has(n.siteId)
    if (this.state.notices.some(needsDeliveryRecovery) || obsoleteLow.length ||
        this.state.notices.some(legacySubNotice) || this.state.notices.some(unconfirmedFlashduty))
      this.change((s) => {
        for (const n of s.notices.filter(legacySubNotice)) {
          n.sourceUnit ??= n.unit
          n.unit = 'CNY'
        }
        for (const n of s.notices.filter(needsDeliveryRecovery)) recoverDelivery(n)
        for (const n of s.notices.filter(unconfirmedFlashduty)) delete n.flashduty
        for (const old of obsoleteLow) this.evaluateBalance(s, s.sites.find((site) => site.id === old.id), Date.now())
      })
  }
  change(edit) {
    const next = copy(this.state)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (next.profit && next.profit.lastDay !== dayKey(new Date(Date.now()))) captureProfit(next, Date.now())
      edit(next)
      captureProfit(next, Date.now())
      this.db
        .prepare('INSERT OR REPLACE INTO workspace(id,data) VALUES(1,?)')
        .run(JSON.stringify(next))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.state = next
    this.onChange(next)
  }
  putSecret(id, bytes) {
    this.db.prepare('INSERT OR REPLACE INTO secrets VALUES(?,?)').run(id, bytes)
  }
  async secret(id) {
    const row = this.db.prepare('SELECT ciphertext FROM secrets WHERE id=?').get(id)
    if (!row) return ''
    try {
      return (await this.crypto.decryptStringAsync(Buffer.from(row.ciphertext))).result
    } catch {
      throw Error('Windows 无法解密已保存的凭据，请重新填写。')
    }
  }
  async probe(input) {
    const provider = input.provider ?? 'new-api'
    if (!['new-api', 'sub2api', 'custom'].includes(provider)) throw Error('请选择有效的站点类型。')
    const origin = siteAddress(input.origin, provider)
    const custom = provider === 'custom' ? customConfig(input.custom) : undefined
    const userId = provider === 'new-api' ? text(input.userId, 24) : ''
    let token = String(input.token ?? '').trim()
    if (custom?.auth !== 'x-api-key') token = token.replace(/^Bearer\s+/i, '')
    if (custom && input.id) {
      const saved = this.state.sites.find((s) => s.id === input.id && s.provider === provider)
      if (!saved || new URL(saved.origin).origin !== new URL(origin).origin) throw Error('如需查询另一个站点，请单独添加。')
      if (!token) {
        if (saved.origin !== origin) throw Error('查询地址已更改，请重新填写 API Key。')
        token = await this.secret(saved.id)
      }
    }
    if (!token || token.length > 8192 || /[\r\n]/.test(token))
      throw Error(provider === 'new-api' ? '请输入有效的个人访问令牌。' : '请输入有效的 API Key。')
    if (userId && !/^[1-9]\d*$/.test(userId)) throw Error('用户 ID 应为正整数。')
    const data = await queryBalance({ provider, origin, userId, custom }, token)
    const keyFingerprint = provider !== 'new-api' ? createHash('sha256').update(token).digest('hex') : undefined
    const ticket = randomUUID(),
      now = Date.now()
    for (const [id, t] of this.tickets)
      if (t.expires <= now || this.tickets.size >= 12) this.tickets.delete(id)
    this.tickets.set(ticket, {
      provider, keyFingerprint, custom,
      origin,
      userId,
      data,
      cipher: await this.crypto.encryptStringAsync(token),
      expires: now + 300000,
      at: now,
    })
    const sharedSource = provider === 'sub2api' && data.balanceKind !== 'wallet'
      ? sharedWallets(this.state.sites.filter((s) => s.id !== input.id)).get(walletKey({ origin, walletGroup: input.walletGroup }))?.latest
      : null
    return {
      ticket,
      accountBalance: provider === 'sub2api' && data.balanceKind !== 'wallet' ? sharedSource?.balance ?? null : data.balance,
      sharedWalletAt: sharedSource?.checked ?? null,
      unit: data.unit,
      balance: data.balance,
      usdRate: data.usdRate,
      usdPerUnit: data.usdPerUnit,
      usage: data.usage,
      usageNote: data.usageNote,
      accountId: data.accountId,
      balanceKind: data.balanceKind,
      balanceScope: data.balanceScope,
      unlimited: data.keyUsage?.unlimited,
    }
  }
  saveSite({ ticket, name, threshold, id, autoUsd, fallbackRate, walletGroup }) {
    const t = this.tickets.get(ticket)
    if (!t || t.expires < Date.now()) throw Error('连接测试已过期，请重新测试。')
    const existing = this.state.sites.find((s) => s.id === id)
    const provider = t.provider ?? 'new-api'
    const sameSite = existing && (provider === 'custom'
      ? new URL(existing.origin).origin === new URL(t.origin).origin : existing.origin === t.origin)
    if (id && (!sameSite || (existing.provider ?? 'new-api') !== provider || existing.accountId !== t.data.accountId))
      throw Error('新令牌属于另一个站点或账户，请单独添加。')
    const identity = siteIdentity({ origin: t.origin, provider, keyFingerprint: t.keyFingerprint, accountId: t.data.accountId })
    if (this.state.sites.some((s) => s.id !== id && siteIdentity(s) === identity))
      throw Error(provider === 'new-api' ? '该账户已经添加。' : '该 Key 已经添加。')
    const siteId = id || randomUUID()
    this.change((s) => {
      const site = s.sites.find((v) => v.id === siteId) || {
        id: siteId,
        icon: s.sites.length % 8,
        logs: [],
        paused: false,
        low: false,
        revision: 0,
      }
      if (!existing) s.sites.push(site)
      if (provider === 'custom') {
        configureAutoUsd(site, t.data, t.custom.currency === 'USD', fallbackRate)
      } else if (autoUsd !== undefined) {
        configureAutoUsd(site, t.data, autoUsd, fallbackRate)
      } else if (site.autoUsd) rmbFactor(t.data, site.fallbackRate)
      Object.assign(site, {
        provider,
        custom: t.custom,
        keyFingerprint: t.keyFingerprint,
        walletGroup: provider === 'sub2api' ? walletGroupName(walletGroup ?? existing?.walletGroup) : undefined,
        origin: t.origin,
        userId: t.userId,
        name: text(name, 80) || new URL(t.origin).hostname + (t.keyFingerprint ? ' · ' + t.keyFingerprint.slice(0, 6) : ''),
        threshold: s.globalThreshold === null ? limit(threshold) : (existing?.threshold ?? s.globalThreshold),
        revision: site.revision + 1,
      })
      this.putSecret(siteId, t.cipher)
      const sameMeter = existing && existing.origin === t.origin && existing.keyFingerprint === t.keyFingerprint &&
        existing.custom?.balancePath === t.custom?.balancePath && existing.unit === t.data.unit
      if (sameMeter && existing.checked > t.at) {
        this.evaluateBalance(s, site, Date.now())
      } else {
        this.apply(s, site, t.data, t.at, sameMeter ? existing : null)
      }
    })
    this.tickets.delete(ticket)
    this.dispatch()
    return siteId
  }
  apply(state, site, data, now, previous = site) {
    if (!site.autoUsd && site.provider !== 'custom' && site.unit && site.unit !== data.unit) {
      site.threshold = 0
      log(site, now, state.globalThreshold == null
        ? '站点已更换计价单位，请重新设置低余额阈值。'
        : '站点已更换计价单位，统一预警金额按新单位生效。')
    }
    const spend = dailySpend(site.provider, previous, data, now)
    if (site.provider === 'sub2api') {
      if (data.balanceKind === 'wallet') {
        const lastWallet = previous?.balanceKind === 'wallet'
          ? { ...previous, todayValue: null, estimatedSince: null, history: [], ...previous.walletSpend } : null
        const wallet = dailySpend('custom', lastWallet, { ...data, todayValue: null, history: [] }, now)
        const point = wallet.history.at(-1)
        if (point?.day === wallet.periodDay) Object.assign(point, { at: now, since: wallet.estimatedSince })
        site.walletSpend = wallet
      } else delete site.walletSpend
    }
    Object.assign(site, data, spend, { health: 'ok', checked: now, tried: now })
    delete site.issue
    const subject = site.provider === 'custom' ? '余额' : site.provider === 'sub2api' && site.balanceKind !== 'wallet' ? 'Key 用量' : '余额及消费统计'
    log(site, now, '已更新' + subject + (data.usageNote ? '。' + data.usageNote : ''))
    if (site.paused && !(site.provider === 'sub2api' && site.balanceKind !== 'wallet')) return
    this.evaluateBalance(state, site, now)
  }
  evaluateBalance(state, site, now) {
    const threshold = state.globalThreshold ?? site.threshold
    const balance = site.autoUsd ? site.balance * rmbFactor(site, site.fallbackRate) : site.balance
    const hasWallet = site.provider !== 'sub2api' || site.balanceKind === 'wallet'
    const low = hasWallet && site.balance != null && threshold > 0 && balance < threshold
    let open = state.notices.find((n) => n.siteId === site.id && !n.closed)
    if (open && (!low || (open.sourceUnit ?? open.unit) !== site.unit || open.unit !== displayUnit(site))) {
      closeNotice(open, now)
      open = undefined
    }
    if (low && (site.paused || site.health !== 'ok')) return
    site.low = low
    if (low && !open) {
      const notice = {
        id: randomUUID(),
        siteId: site.id,
        site: site.name,
        at: now,
        balance,
        threshold,
        unit: displayUnit(site),
        sourceUnit: site.unit,
      }
      setRecipients(notice, state.mail)
      state.notices.unshift(notice)
    } else if (low) {
      if (open.delivery === 'off' && state.mail.enabled) setRecipients(open, state.mail)
    }
  }
  poll(id, force = true) {
    if (this.flights.has(id)) return this.flights.get(id)
    const before = this.state.sites.find((s) => s.id === id)
    if (!before || !pollDue(before, Date.now(), this.state.minutes, force)) return Promise.resolve()
    // A refresh already in flight when the email is accepted cannot confirm escalation.
    const emailed = !force && this.state.flashduty.enabled && this.state.mail.enabled
      ? this.state.notices.find((n) => n.siteId === id && !n.closed && n.delivery === 'sent')
      : undefined
    const run = (async () => {
      let data, error
      try {
        const token = await this.secret(id)
        if (!token) throw Error('找不到已保存的令牌，请重新填写。')
        data = await queryBalance(before, token, before)
        if (before.autoUsd) rmbFactor(data, before.fallbackRate)
        if (data.accountId !== before.accountId) throw Error('令牌对应的账户已改变，请重新添加。')
      } catch (e) {
        error = e
      }
      const current = this.state.sites.find((s) => s.id === id)
      if (!current || current.paused || current.revision !== before.revision) return
      this.change((s) => {
        const site = s.sites.find((v) => v.id === id),
          now = Date.now()
        if (error) {
          recordFailure(site, error, now)
          const { count, retryAt } = site.issue
          const retryNote = site.health === 'retrying' ? '等待自动重试' : count > 1 ? '连续失败 ' + count + ' 次' : ''
          const wait = retryAt > now ? '，至少等待 ' + Math.ceil((retryAt - now) / 1000) + ' 秒' : ''
          log(site, now, error.message + (retryNote ? ' ' + retryNote : '') + wait)
          return
        }
        this.apply(s, site, data, now)
        if (emailed && site.low && s.mail.enabled && s.flashduty.enabled) {
          const n = s.notices.find((notice) => notice.id === emailed.id)
          if (n && !n.closed && n.delivery === 'sent' && (!n.flashduty || n.flashduty.status === 'cancelled')) {
            n.flashduty = { status: 'pending', attempts: 0, confirmedAt: now,
              balance: site.autoUsd ? site.balance * rmbFactor(site, site.fallbackRate) : site.balance,
              threshold: s.globalThreshold ?? site.threshold }
          }
        }
      })
      this.dispatch()
    })().finally(() => this.flights.delete(id))
    this.flights.set(id, run)
    return run
  }
  async refreshSite(id) {
    const site = this.state.sites.find((s) => s.id === id)
    if (!site || site.paused) return
    if (site.issue?.retryAt > Date.now())
      throw Error(site.issue.label + '，请在 ' + Math.ceil((site.issue.retryAt - Date.now()) / 1000) + ' 秒后刷新。')
    const source = site.provider === 'sub2api' && site.balanceKind !== 'wallet'
      ? sharedWallets(this.state.sites).get(walletKey(site))?.active : null
    await Promise.all([this.poll(id), source && this.poll(source.id)])
  }
  async sweep(force = false) {
    const due = this.state.sites
      .filter((s) => pollDue(s, Date.now(), this.state.minutes, force))
      .map((s) => s.id)
    const worker = async () => {
      while (due.length) await this.poll(due.shift(), force)
    }
    await Promise.all(Array.from({ length: Math.min(due.length, 3) }, worker))
    if (this.state.profit) {
      if (!this.profitFlight) this.profitFlight = pollProfit(this, force).finally(() => { this.profitFlight = null })
      await this.profitFlight
    }
    this.dispatch()
  }
  async setAutoUsd({ id, enabled, fallbackRate }) {
    const before = this.state.sites.find((s) => s.id === id)
    if (!before) throw Error('站点不存在。')
    if (before.provider === 'custom') throw Error('请在自定义接口设置中修改余额币种和汇率。')
    const quote = enabled && before.usdPerUnit == null ? await readUsdQuote(before) : null
    this.change((state) => {
      const site = state.sites.find((s) => s.id === id)
      if (!site || site.revision !== before.revision || site.unit !== before.unit)
        throw Error('站点设置已变更，请重新打开详情。')
      if (quote && site.usdPerUnit == null) Object.assign(site, quote)
      configureAutoUsd(site, site, enabled, fallbackRate)
      site.revision++
      this.evaluateBalance(state, site, Date.now())
    })
    this.dispatch()
  }
  async updateSite({ id, paused, threshold, remove, billing, walletGroup }) {
    this.change((s) => {
      const site = s.sites.find((v) => v.id === id)
      if (!site) throw Error('站点不存在。')
      if (remove) {
        this.db.prepare('DELETE FROM secrets WHERE id=?').run(id)
        s.sites = s.sites.filter((v) => v !== site)
        s.notices = s.notices.filter((n) => n.siteId !== id)
        return
      }
      if (typeof paused === 'boolean') {
        site.paused = paused
        site.revision++
        log(site, Date.now(), paused ? '监控已暂停' : '监控已恢复')
      }
      if (walletGroup !== undefined && site.provider === 'sub2api') site.walletGroup = walletGroupName(walletGroup)
      if (threshold !== undefined) {
        if (s.globalThreshold !== null) throw Error('已启用统一预警金额，请在站点管理中修改。')
        site.threshold = limit(threshold)
        log(site, Date.now(), '提醒阈值已更新')
      }
      if (billing !== undefined) {
        if (site.provider === 'custom') throw Error('请在自定义接口设置中修改余额币种和汇率。')
        if (site.provider === 'sub2api') throw Error('请使用站点详情中的美元换算开关。')
        if (billing !== null && (
          !['USD', site.unit].includes(billing.unit) || billing.unit === 'CNY' ||
          !Number.isFinite(billing.rmbRate) || billing.rmbRate <= 0 ||
          !Number.isFinite(site.balance * billing.rmbRate)
        )) throw Error('请选择有效的计价单位，并填写大于 0 的人民币折算比例。')
        site.billing = billing === null ? null : { unit: billing.unit, rmbRate: billing.rmbRate }
        if (site.autoUsd) {
          site.autoUsd = false
          site.fallbackRate = null
          site.revision++
          this.evaluateBalance(s, site, Date.now())
        }
      }
    })
    if (walletGroup !== undefined && !remove && paused === undefined && threshold === undefined && billing === undefined)
      return
    if (billing !== undefined && paused === undefined && threshold === undefined) {
      this.dispatch()
      return
    }
    if (!remove && !this.state.sites.find((s) => s.id === id).paused) {
      if (this.flights.has(id)) await this.flights.get(id)
      await this.poll(id)
    }
  }
  preferences(patch) {
    const thresholdChanged = patch.globalThreshold !== undefined && patch.globalThreshold !== this.state.globalThreshold
    this.change((s) => {
      if (patch.followSystemProxy !== undefined) {
        if (typeof patch.followSystemProxy !== 'boolean') throw Error('无效的系统代理设置。')
        s.followSystemProxy = patch.followSystemProxy
      }
      if (patch.theme !== undefined) {
        if (!['light', 'dark', 'system'].includes(patch.theme)) throw Error('无效主题')
        s.theme = patch.theme
      }
      if (patch.minutes !== undefined) {
        if (![5, 15, 30, 60].includes(patch.minutes)) throw Error('无效查询频率')
        s.minutes = patch.minutes
      }
      if (thresholdChanged) {
        s.globalThreshold = patch.globalThreshold === null ? null : limit(patch.globalThreshold)
        const now = Date.now()
        for (const site of s.sites) this.evaluateBalance(s, site, now)
      }
    })
    if (thresholdChanged) this.dispatch()
  }
  async configure(input, test = false) {
    const cfg = mailConfig(test ? { ...input.config, enabled: true } : input.config)
    const typed = String(input.secret ?? ''),
      oldIdentity = mailIdentity(this.state.mail)
    const same = oldIdentity === mailIdentity(cfg)
    const secret = typed || (cfg.enabled && same ? await this.secret('mail') : '')
    if (cfg.enabled && (cfg.provider === 'resend' || cfg.account) && !secret)
      throw Error('请填写发件服务的授权码或 API Key。')
    if (test) {
      const addresses = recipients(cfg.to)
      const errors = []
      for (const to of addresses) {
        try {
          await this.send(cfg, secret, {
            id: randomUUID(), to,
            subject: 'QuotaDesk 测试邮件',
            text: 'QuotaDesk 已成功连接你的邮件服务。',
          })
        } catch (error) {
          errors.push(to + '：' + error.message)
        }
      }
      if (errors.length) throw Error(
        '发件服务已确认接收 ' + (addresses.length - errors.length) + '/' + addresses.length +
        ' 封测试邮件。' + errors.join('；'),
      )
      return addresses.length
    }
    const cipher = typed ? await this.crypto.encryptStringAsync(typed) : null
    this.change((s) => this.applyMail(s, cfg, cipher, !same))
    if (cfg.enabled) {
      await this.sweep(true)
      this.dispatch()
    }
  }
  applyMail(state, cfg, cipher, clearOld) {
    if (cipher) this.putSecret('mail', cipher)
    else if (clearOld) this.db.prepare("DELETE FROM secrets WHERE id='mail'").run()
    state.mail = cfg
    for (const n of state.notices)
      if (!n.closed && n.delivery !== 'off' && (cfg.enabled || n.delivery !== 'sent'))
        setRecipients(n, cfg)
  }
  retry(id) {
    const n = this.state.notices.find((v) => v.id === id)
    if (!n || n.closed || !this.state.mail.enabled || !['failed', 'uncertain'].includes(n.delivery))
      throw Error('当前提醒无法重发。')
    this.change((s) => setRecipients(s.notices.find((v) => v.id === id), s.mail, true))
    this.dispatch()
  }
  async configureFlashduty({ enabled, address = '' }, test = false) {
    if (typeof enabled !== 'boolean' || typeof address !== 'string') throw Error('无效的 Flashduty 设置。')
    const typed = address.trim() ? integrationAddress(address) : ''
    if (test) {
      const target = typed || await this.secret('flashduty')
      await sendFlashduty(target, {
        title_rule: 'QuotaDesk · 测试余额提醒', description: '这是一条测试事件，请确认手机收到短信。',
        alert_key: 'quotadesk-test-' + randomUUID(), event_status: 'Warning', labels: { source: 'QuotaDesk', kind: 'test' },
      })
      return
    }
    const cipher = typed ? await this.crypto.encryptStringAsync(typed) : null
    this.change((state) => this.applyFlashduty(state, enabled, cipher))
    if (enabled) await this.sweep(true)
  }
  applyFlashduty(state, enabled, cipher, clearAddress = false) {
    if (cipher) this.putSecret('flashduty', cipher)
    else if (clearAddress) this.db.prepare("DELETE FROM secrets WHERE id='flashduty'").run()
    const configured = !!cipher || (!clearAddress && state.flashduty.configured)
    if (enabled && !configured) throw Error('请填写 Flashduty 集成地址。')
    state.flashduty = { enabled, configured }
    for (const notice of state.notices) {
      if (notice.closed || !notice.flashduty) continue
      if (!enabled && ['pending', 'failed'].includes(notice.flashduty.status)) notice.flashduty.status = 'cancelled'
      if (enabled && cipher && notice.flashduty.status === 'failed') Object.assign(notice.flashduty, { status: 'pending', attempts: 0 })
    }
  }
  async drainFlashduty() {
    if (this.sendingFlashduty || !this.state.flashduty.enabled) return
    this.sendingFlashduty = true
    try {
      while (this.state.flashduty.enabled) {
        const n = this.state.notices.find((notice) => {
          const job = notice.flashduty
          return !notice.closed && this.state.mail.enabled && notice.delivery === 'sent' && (job?.status === 'pending' ||
            (job?.status === 'failed' && job.attempts < 3 && job.retryAt <= Date.now())) &&
            this.state.sites.some((site) => site.id === notice.siteId && !site.paused && site.low && site.health === 'ok')
        })
        if (!n) break
        // Leave the work pending on disk until acknowledged. A restart uses the same event key.
        let failure
        try {
          const target = await this.secret('flashduty')
          const current = this.state.notices.find((notice) => notice.id === n.id)
          if (!current || current.closed || !this.state.flashduty.enabled || current.flashduty?.status === 'cancelled' ||
              !this.state.mail.enabled || current.delivery !== 'sent') continue
          const summary = n.site + ' 余额 ' + amount(n.flashduty.balance, n.unit) + '，低于阈值 ' + amount(n.flashduty.threshold, n.unit)
          await sendFlashduty(target, {
            title_rule: summary, description: summary, alert_key: 'quotadesk-' + n.id,
            event_status: 'Warning', event_time: Math.floor(n.flashduty.confirmedAt / 1000),
            labels: { source: 'QuotaDesk', kind: 'low_balance', site: n.site },
          })
        } catch (error) { failure = error }
        this.change((state) => {
          const notice = state.notices.find((item) => item.id === n.id)
          if (!notice) return
          const attempts = n.flashduty.attempts + 1
          Object.assign(notice.flashduty, failure ? {
            status: notice.closed || !state.flashduty.enabled ? 'cancelled' : 'failed',
            attempts, error: failure.message, retryAt: Date.now() + attempts * 60000,
          } : { status: 'sent', attempts, error: '' })
        })
      }
    } finally {
      this.sendingFlashduty = false
    }
  }
  retryFlashduty(id) {
    this.change((state) => {
      const n = state.notices.find((notice) => notice.id === id)
      if (!state.flashduty.enabled || !n || n.closed || n.flashduty?.status !== 'failed')
        throw Error('当前 Flashduty 事件无法重发。')
      Object.assign(n.flashduty, { status: 'pending', attempts: 0 })
    })
    this.dispatch()
  }
  dispatch() {
    this.drainFlashduty().catch((error) => console.error('Flashduty queue:', error.name))
    this.drain().catch((error) => console.error('Mail queue:', error.name))
  }
  async drain() {
    if (this.sending) return
    this.sending = true
    try {
      for (;;) {
        const config = copy(this.state.mail)
        if (!config.enabled) break
        const now = Date.now()
        const n = this.state.notices.find(
          (v) =>
            !v.closed &&
            nextRecipient(v, now) &&
            this.state.sites.some((site) => site.id === v.siteId && !site.paused),
        )
        if (!n) break
        const target = nextRecipient(n, now)
        this.change((s) => {
          const a = s.notices.find((v) => v.id === n.id)
          const r = a.recipients.find((v) => v.id === target.id)
          r.delivery = 'sending'
          r.attempts++
          updateDelivery(a)
        })
        let failure
        try {
          const body =
            n.site +
            ' 在 ' +
            new Date(n.at).toLocaleString('zh-CN') +
            ' 的钱包余额为 ' +
            amount(n.balance, n.unit) +
            '，低于提醒阈值 ' +
            amount(n.threshold, n.unit) +
            '。'
          await this.send(config, await this.secret('mail'), {
            id: target.id,
            to: target.address,
            subject: n.site + ' · 钱包余额提醒',
            text: body,
          })
        } catch (e) {
          failure = e
        }
        this.change((s) => {
          const a = s.notices.find((v) => v.id === n.id)
          if (!a) return
          const r = a.recipients.find((v) => v.id === target.id)
          r.delivery = !failure ? 'sent' : failure.uncertain ? 'uncertain' : a.closed ? 'cancelled' : 'failed'
          r.error = failure?.message || ''
          r.retryAt = Date.now() + Math.min(60, 2 ** r.attempts) * 60000
          updateDelivery(a)
        })
      }
    } finally {
      this.sending = false
    }
  }
}
