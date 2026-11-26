import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Monitor, displayState } from '../desktop/monitor.mjs'
import { querySite, requestJson, siteAddress } from '../desktop/new-api.mjs'
import { deliver, emptyMail, mailConfig } from '../desktop/mail.mjs'
import { querySub2Api } from '../desktop/sub2api.mjs'
import { saveProfitSource } from '../desktop/profit.mjs'
import { exportConfig, importConfig } from '../desktop/config-transfer.mjs'

test('admin profit persists net site-wide revenue and reconciles each local calendar day once', async (t) => {
  const crypto = { encryptStringAsync: async v => Buffer.from(v), decryptStringAsync: async v => ({ result: v.toString() }) }
  const dir = await mkdtemp(join(tmpdir(), 'quotadesk-profit-'))
  const database = join(dir, 'profit.sqlite')
  let m = new Monitor(database, crypto)
  t.after(async () => { m.db.close(); await rm(dir, { recursive: true, force: true }) })
  const at = (day, hour) => new Date(2026, 0, day, hour).getTime()
  let now = at(31, 14), denied = false, missCost = false, todayQuota = 112
  t.mock.method(Date, 'now', () => now)
  const seen = []
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const u = new URL(input)
    const ok = data => Response.json({ success: true, data })
    if (u.pathname === '/api/status') {
      assert.ok(!options.headers.Authorization)
      return ok({ quota_display_type: 'USD', quota_per_unit: 8, usd_exchange_rate: 7 })
    }
    assert.equal(u.searchParams.get('type'), '2')
    const end = Number(u.searchParams.get('end_timestamp'))
    if (u.host === 'income.test') {
      assert.equal(u.pathname, '/api/log/stat')
      assert.equal(options.headers['New-Api-User'], '23')
      assert.equal(options.headers.Authorization, 'Bearer fixture-admin')
      assert.ok(!u.searchParams.has('username'))
      seen.push([Number(u.searchParams.get('start_timestamp')), end])
      if (denied) return new Response(null, { status: 403 })
      return ok({ quota: end === at(32, 0) / 1000 - 1 ? 128 : todayQuota })
    }
    assert.equal(u.host, 'upstream.test')
    assert.equal(u.pathname, '/api/log/self/stat')
    assert.equal(options.headers.Authorization, 'Bearer fixture-cost')
    return missCost ? new Response(null, { status: 503 }) : ok({ quota: 28 })
  })
  const source = { origin: 'https://income.test', token: 'fixture-admin', userId: '23', rate: null }
  const upstream = { id: 'u', name: '上游', origin: 'https://upstream.test', accountId: 1, provider: 'new-api',
    health: 'ok', unit: 'USD', quotaScale: 0.125, balance: 200, usage: true, checked: now, tried: now, threshold: 0,
    paused: false, revision: 1, history: [], logs: [], periodDay: '2026-01-31', todayValue: 5, billing: { unit: 'USD', rmbRate: 6 } }
  m.change(s => { s.sites = [upstream, { ...upstream, id: 'self', origin: source.origin }] })
  for (const id of ['u', 'self']) m.putSecret(id, Buffer.from('fixture-cost'))
  denied = true
  await assert.rejects(saveProfitSource(m, source), /权限/)
  assert.equal(m.state.profit, undefined)
  denied = false
  await saveProfitSource(m, source)
  const days = () => displayState(m.state).profit.days
  assert.equal(days()[0].revenue, 98)
  assert.equal(days()[0].cost, 30)
  assert.equal(days()[0].profit, 68)
  assert.deepEqual(seen.at(-1), [at(31, 0) / 1000, now / 1000])
  assert.ok(!JSON.stringify(m.state).includes('fixture-admin'))
  m.db.close()
  m = new Monitor(database, crypto)
  now = at(32, 9)
  todayQuota = 0
  m.change(s => { for (const site of s.sites) Object.assign(site, { tried: now, periodDay: '2026-02-01', todayValue: null }) })
  missCost = true
  await m.sweep()
  assert.deepEqual(seen.at(-1), [at(31, 0) / 1000, at(32, 0) / 1000 - 1])
  assert.deepEqual(days().map(r => [r.day, r.revenue, r.cost, r.profit, r.estimated]), [
    ['2026-02-01', 0, 0, 0, false], ['2026-01-31', 112, 30, 82, true],
  ])
  assert.deepEqual(days()[0].missing, ['上游'])
  missCost = false
  now += 16 * 60000
  m.change(s => { for (const site of s.sites) Object.assign(site, { tried: now, todayValue: 1 }) })
  await Promise.all([m.sweep(), m.sweep()])
  assert.deepEqual(days().map(r => [r.revenue, r.cost, r.profit]), [[0, 6, -6], [112, 21, 91]])
  denied = true
  await assert.rejects(saveProfitSource(m, source), /权限/)
  assert.equal(days()[0].profit, -6)
  const dest = new Monitor(':memory:', crypto)
  t.after(() => dest.db.close())
  const { bytes } = await exportConfig(m, 'fixture-password')
  assert.ok(!bytes.includes(Buffer.from('fixture-admin')))
  await importConfig(dest, bytes, 'fixture-password', false)
  assert.deepEqual(displayState(dest.state).profit, displayState(m.state).profit)
  assert.equal(await dest.secret('profit-source'), 'fixture-admin')
})

test('profit backfills whole days and counts a shared wallet estimate once until key readings arrive', async t => {
  const m = new Monitor(':memory:', { encryptStringAsync: async v => Buffer.from(v), decryptStringAsync: async v => ({ result: v.toString() }) })
  t.after(() => m.db.close())
  const now = new Date(2026, 10, 2, 18).getTime(), today = '2026-11-02'
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async url => Response.json({ success: true,
    data: new URL(url).pathname === '/api/status' ? { quota_display_type: 'CNY', quota_per_unit: 1, usd_exchange_rate: 1 } : { quota: 30 } }))
  const wallet = { provider: 'sub2api', name: '共享钱包', origin: 'https://wallet.test',
    unit: 'USD', walletGroup: '', balanceKind: 'wallet', balance: 3, health: 'ok', paused: false,
    periodDay: today, todayValue: null, history: [], tried: now,
    walletSpend: { history: [{ day: today, value: 9, at: now }] } }
  m.change(s => { s.sites = ['a', 'b'].map(id => ({ ...wallet, id, keyFingerprint: id })) })
  await saveProfitSource(m, { origin: 'https://income.test', token: 'fixture', start: '2026-10-31' })
  const rows = () => displayState(m.state).profit.days
  assert.equal(rows()[0].profit, 21)
  assert.equal(rows()[0].estimated, true)
  await m.sweep()
  assert.deepEqual(rows().map(r => [r.day, r.revenue, r.profit]), [[today, 30, 21], ['2026-11-01', 30, 30], ['2026-10-31', 30, 30]])
  m.change(s => { s.sites[1].todayValue = 2 })
  assert.deepEqual([rows()[0].cost, rows()[0].profit, rows()[0].missing], [2, 28, ['共享钱包']])
  m.change(s => { s.sites[0].todayValue = 0; s.sites[1].todayValue = 2 })
  assert.equal(rows()[0].cost, 2)
  assert.equal(rows()[0].estimated, false)
  await saveProfitSource(m, { origin: 'https://income.test', token: '', start: '2026-10-30' })
  await m.sweep()
  assert.deepEqual(rows().map(r => r.day), [today, '2026-11-01', '2026-10-31', '2026-10-30'])
})

test('balance-only polling carries the last daily reading through a restart, recharge and month boundary', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'quotadesk-spend-'))
  const database = join(folder, 'wallet.sqlite')
  const crypto = { encryptStringAsync: async (v) => Buffer.from(v), decryptStringAsync: async (v) => ({ result: v.toString() }) }
  let monitor = new Monitor(database, crypto)
  t.after(async () => { monitor.db.close(); await rm(folder, { recursive: true, force: true }) })
  const at = (day, hour) => new Date(2026, 0, day, hour).getTime()
  let now = at(31, 17), balance = 100
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ balance }))
  const input = { provider: 'custom', origin: 'https://fixture.test/balance', token: 'a',
    custom: { balancePath: 'balance', auth: 'bearer', currency: 'USD' } }
  const { ticket } = await monitor.probe(input)
  const id = monitor.saveSite({ ticket, threshold: 0, fallbackRate: 7 })
  const site = () => monitor.state.sites[0]
  const read = async (day, hour, value) => {
    now = at(day, hour)
    balance = value
    await monitor.poll(id)
    return site().todayValue
  }
  assert.equal(site().todayValue, null)
  assert.equal(await read(31, 23, 90), 10)
  assert.equal(site().estimatedSince, at(31, 17))
  monitor.db.close()
  monitor = new Monitor(database, crypto)
  assert.equal(await read(32, 1, 83), 7)
  assert.equal(await read(32, 2, 133), 7)
  assert.equal(await read(32, 3, 128), 12)
  assert.equal(await read(32, 3, 128), 12)
  assert.equal(displayState(monitor.state).sites[0].todayValue, 84)
  assert.deepEqual(site().history, [{ day: '2026-01-31', value: 10 }, { day: '2026-02-01', value: 12 }])
  assert.equal(await read(34, 10, 60), null)
  assert.equal(await read(34, 12, 56), 4)
  assert.equal(site().estimatedSince, at(34, 10))
  const replacement = await monitor.probe({ ...input, id, token: 'b' })
  monitor.saveSite({ id, ticket: replacement.ticket, threshold: 0, fallbackRate: 7 })
  assert.deepEqual([site().todayValue, site().history], [null, []])
})

test('New API prefers direct daily spend including zero, then cumulative quota across recharges', async (t) => {
  const mon = new Monitor(':memory:', { encryptStringAsync: async (v) => Buffer.from(v), decryptStringAsync: async (v) => ({ result: v.toString() }) })
  t.after(() => mon.db.close())
  let quota = 500, used = 10, direct = 5
  t.mock.method(globalThis, 'fetch', async (input) => {
    const { pathname } = new URL(input)
    if (pathname === '/api/status') return Response.json({ success: true, data: { quota_display_type: 'USD', quota_per_unit: 2, enable_data_export: false } })
    if (pathname === '/api/user/self') return Response.json({ success: true, data: { id: 1, quota, used_quota: used } })
    return direct == null ? new Response(null, { status: 403 }) : Response.json({ success: true, data: { quota: direct } })
  })
  const { ticket } = await mon.probe({ origin: 'https://fixture.test', token: 'a' })
  const id = mon.saveSite({ ticket, threshold: 0 })
  direct = null
  used += 8
  quota += 90
  await mon.poll(id)
  assert.equal(mon.state.sites[0].todayValue, 6.5)
  direct = 0
  await mon.poll(id)
  assert.deepEqual([mon.state.sites[0].todayValue, mon.state.sites[0].estimatedSince], [0, null])
})

test('SUB2API uses a shared wallet estimate once and replaces it with Key spend when available', async (t) => {
  const mon = new Monitor(':memory:', { encryptStringAsync: async (v) => Buffer.from(v), decryptStringAsync: async (v) => ({ result: v.toString() }) })
  t.after(() => mon.db.close())
  let balance = 100, usage = {}
  t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json({ mode: 'unrestricted', balance, daily_usage: [],
    usage: options.headers.Authorization === 'Bearer b' ? usage : {} }))
  const ids = []
  for (const token of ['a', 'b']) {
    const { ticket } = await mon.probe({ provider: 'sub2api', origin: 'https://fixture.test', token })
    ids.push(mon.saveSite({ ticket, threshold: 0 }))
  }
  balance = 90
  for (const id of ids) await mon.poll(id)
  const amounts = () => displayState(mon.state).sites.map((s) => s.todayValue).filter(Number.isFinite)
  assert.deepEqual(amounts(), [10])
  assert.equal(displayState(mon.state).sites.filter((s) => s.walletSpendEstimate).length, 1)
  usage = { today: { actual_cost: 0 }, total: { actual_cost: 10 } }
  await mon.poll(ids[1])
  assert.deepEqual(amounts(), [0])
  usage = { total: { actual_cost: 13 } }
  await mon.poll(ids[1])
  assert.deepEqual(amounts(), [3])
})

test('a transient wallet failure retries once, respects cooldowns across restart and clears on recovery', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'quotadesk-retry-'))
  const database = join(folder, 'wallet.sqlite')
  const crypto = {
    encryptStringAsync: async (token) => Buffer.from(token),
    decryptStringAsync: async (bytes) => ({ result: bytes.toString() }),
  }
  let mon = new Monitor(database, crypto)
  t.after(async () => { mon.db.close(); await rm(folder, { recursive: true, force: true }) })
  let now = Date.now(), failure = '', reads = 0
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'fetch', async () => {
    reads++
    if (failure === 'timeout') throw new DOMException('fetch timed out', 'TimeoutError')
    if (failure === '503') return new Response(null, { status: 503 })
    if (failure === '429') return new Response(null, { status: 429, headers: { 'Retry-After': '1200' } })
    return Response.json({ mode: 'unrestricted', balance: 40, daily_usage: [] })
  })
  const { ticket } = await mon.probe({ origin: 'https://sample.test', token: 'fixture', provider: 'sub2api' })
  const id = mon.saveSite({ ticket, threshold: 0 })
  const site = () => mon.state.sites[0]
  const lastGood = site().checked
  now += 15 * 60000
  failure = 'timeout'
  await mon.sweep()
  assert.equal(site().health, 'retrying')
  assert.equal(site().issue.label, '请求超时')
  assert.equal(site().issue.retryAt, now + 30000)
  assert.deepEqual([site().checked, site().balance], [lastGood, 40])
  await assert.rejects(mon.refreshSite(id), /30 秒/)
  mon.db.close()
  mon = new Monitor(database, crypto)
  now += 29999
  await mon.sweep(true)
  assert.equal(reads, 2)
  failure = '429'
  now++
  await Promise.all([mon.sweep(), mon.sweep()])
  assert.equal(reads, 3)
  assert.deepEqual([site().health, site().issue.count, site().issue.label], ['offline', 2, '请求限流 429'])
  assert.match(site().logs[0].text, /HTTP 429.*连续失败 2 次/)
  now += 1200000 - 1
  await mon.sweep()
  await mon.sweep(true)
  assert.equal(reads, 3)
  failure = ''
  now++
  await mon.sweep()
  assert.deepEqual([site().health, site().issue, site().checked], ['ok', undefined, now])
  failure = '503'
  now += 15 * 60000
  await mon.sweep()
  assert.deepEqual([site().health, site().issue.count, site().issue.label], ['retrying', 1, '服务暂不可用 503'])
  failure = ''
  now += 30000
  await mon.sweep()
  assert.equal(site().health, 'ok')
  assert.equal(site().checked, now)
})

test('New API reports the 429 cooldown even when its parallel configuration check fails first', async (t) => {
  const until = new Date(Math.ceil(Date.now() / 1000) * 1000 + 120000).toUTCString()
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/api/status')
    ? new Response(null, { status: 503 })
    : new Response(null, { status: 429, headers: { 'Retry-After': until } }))
  await assert.rejects(querySite({ origin: 'https://sample.test', token: 'fixture' }), (err) => {
    assert.equal(err.label, '请求限流 429')
    assert.equal(err.retryAt, Date.parse(until))
    assert.match(err.message, /余额查询.*限流/)
    return true
  })
})

test('403 access pages and browser challenges are distinguished from API permission failures', async (t) => {
  let headers
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403, headers }))
  for (const [responseHeaders, message, authFailure] of [
    [{ 'content-type': 'text/html; charset=UTF-8', server: 'cloudflare' }, /访问限制网页/, false],
    [{ 'cf-mitigated': 'challenge' }, /Cloudflare 要求浏览器验证/, false],
    [{ 'content-type': 'application/json', server: 'cloudflare' }, /权限不足/, true],
  ]) {
    headers = responseHeaders
    await assert.rejects(requestJson('https://sample.test', {}, '余额查询'), (err) => {
      assert.equal(err.status, 403)
      assert.equal(err.authFailure, authFailure)
      assert.match(err.message, message)
      return true
    })
  }
})

test('transport errors expose safe causes while certificate problems require attention immediately', async (t) => {
  let code
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('sensitive upstream details', { cause: Object.assign(Error('sensitive'), { code }) })
  })
  for (const [cause, label, transient] of [
    ['ENOTFOUND', 'DNS 解析失败', true], ['UND_ERR_CONNECT_TIMEOUT', '请求超时', true],
    ['ECONNRESET', '网络连接中断', true], ['ECONNREFUSED', '连接被拒绝', true],
    ['CERT_HAS_EXPIRED', '证书验证失败', false],
  ]) {
    code = cause
    await assert.rejects(requestJson('https://sample.test', {}, '站点配置'), (err) => {
      assert.deepEqual([err.label, err.transient], [label, transient])
      assert.ok(!err.message.includes('sensitive'))
      return true
    })
  }
})

test('Chromium proxy failures and cancelled redirects retain actionable descriptions', async (t) => {
  let message
  t.mock.method(globalThis, 'fetch', async () => { throw Error(message) })
  for (const [reason, expected] of [
    ['net::ERR_PROXY_CONNECTION_FAILED', /系统代理连接失败/],
    ['net::ERR_CERT_AUTHORITY_INVALID', /证书验证失败/],
    ['Redirect was cancelled', /请填写最终的站点网址/],
  ]) {
    message = reason
    await assert.rejects(requestJson('https://sample.test', {}, '余额查询'), expected)
  }
})

test('existing offline sites show the recorded cause and keep the observed sequence of failures', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'quotadesk-legacy-issue-'))
  const database = join(folder, 'wallet.sqlite')
  let mon = new Monitor(database, {})
  t.after(async () => { mon.db.close(); await rm(folder, { recursive: true, force: true }) })
  const checked = Date.now() - 900000, tried = checked + 60000
  const old = { health: 'offline', checked, tried, logs: [{ at: tried, text: '余额查询：HTTP 503' }] }
  mon.change((s) => s.sites.push(old, { ...old, logs: [...old.logs, { at: tried - 1, text: '站点配置：HTTP 503' }] }))
  mon.db.close()
  mon = new Monitor(database, {})
  assert.deepEqual(mon.state.sites.map((s) => [s.health, s.issue.count, s.issue.label]), [
    ['retrying', 1, '服务暂不可用 503'], ['offline', 2, '服务暂不可用 503'],
  ])
})

test('SUB keys retain independent spend and one shared wallet across refresh, conversion, restart and regrouping', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'quotadesk-sub-'))
  const database = join(folder, 'keys.sqlite')
  const crypto = {
    encryptStringAsync: async (s) => Buffer.from(s),
    decryptStringAsync: async (b) => ({ result: b.toString() }),
  }
  let mon = new Monitor(database, crypto)
  t.after(async () => { mon.db.close(); await rm(folder, { recursive: true, force: true }) })
  let wallet = 50, invalid = false
  t.mock.method(globalThis, 'fetch', async (input, opts) => {
    const url = new URL(input)
    assert.equal(url.pathname, '/relay/v1/usage')
    assert.equal(opts.redirect, 'manual')
    assert.equal(opts.headers['New-Api-User'], undefined)
    assert.equal(url.searchParams.get('days'), '31')
    if (invalid) return Response.json({ error: opts.headers.Authorization }, { status: 401 })
    const spend = opts.headers.Authorization === 'Bearer sk-fixture-A' ? 2 : 3
    return Response.json({ mode: 'unrestricted', isValid: true, balance: wallet, unit: 'USD',
      daily_usage: [{ date: url.searchParams.get('end_date'), requests: 4, actual_cost: spend, cost: 7 }],
      usage: { total: { requests: 7, actual_cost: spend + 1 } },
      model_stats: [{ model: 'model-A', actual_cost: spend, input_tokens: 5 }] })
  })
  const probe = (key, suffix = '') => mon.probe({ provider: 'sub2api', origin: 'https://example.test/relay' + suffix, token: key })
  const a = mon.saveSite({ ticket: (await probe('sk-fixture-A', '/key-usage')).ticket, threshold: 0 })
  const b = mon.saveSite({ ticket: (await probe('sk-fixture-B', '/v1/')).ticket, threshold: 0 })
  const duplicate = await probe('sk-fixture-A', '/v1/usage')
  assert.throws(() => mon.saveSite({ ticket: duplicate.ticket, walletGroup: 'different', threshold: 0 }), /Key 已经添加/)
  assert.throws(() => mon.saveSite({ ticket: duplicate.ticket, id: b, threshold: 0 }), /Key 已经添加/)
  const view = () => displayState(mon.state)
  assert.deepEqual(view().wallets, [{ unit: 'CNY', value: 50, rmb: 50 }])
  assert.deepEqual(view().sites.map((s) => [s.todayValue, s.monthValue]), [[2, 2], [3, 3]])
  assert.equal(view().sites[0].keyUsage.models[0].input, 5)
  assert.ok(!JSON.stringify(view()).includes('sk-fixture'))
  await mon.setAutoUsd({ id: a, enabled: true, fallbackRate: 7 })
  wallet = 40
  await mon.poll(b)
  assert.deepEqual(view().wallets, [{ unit: 'CNY', value: 280, rmb: 280 }])
  assert.equal(view().sites[0].todayValue, 14)
  assert.equal(view().sites[0].keyUsage.daily[0].actual, 2)
  mon.db.close()
  mon = new Monitor(database, crypto)
  await mon.updateSite({ id: b, walletGroup: '第二个账户' })
  assert.deepEqual(view().wallets, [{ unit: 'CNY', value: 350, rmb: 350 }, { unit: 'CNY', value: 40, rmb: 40 }])
  await mon.updateSite({ id: b, walletGroup: '默认账户' })
  assert.equal(view().wallets.length, 1)
  await mon.updateSite({ id: a, remove: true })
  assert.deepEqual(view().wallets, [{ unit: 'CNY', value: 40, rmb: 40 }])
  invalid = true
  await mon.poll(b)
  assert.equal(view().sites[0].health, 'invalid')
  assert.equal(view().sites[0].balance, 40)
  assert.ok(!JSON.stringify(view()).includes('sk-fixture'))
})

test('account balance uses only wallet observations in the same group, including probes and manual refresh', async (t) => {
  const monitor = new Monitor(':memory:', {
    encryptStringAsync: async (token) => Buffer.from(token),
    decryptStringAsync: async (bytes) => ({ result: bytes.toString() }),
  })
  t.after(() => monitor.db.close())
  let wallet = 42, walletReads = 0
  t.mock.method(globalThis, 'fetch', async (_url, { headers }) => {
    if (headers.Authorization === 'Bearer wallet-key') {
      walletReads++
      return Response.json({ mode: 'unrestricted', balance: wallet })
    }
    return Response.json({ mode: 'quota_limited', quota: { used: 19, limit: 20, remaining: 1 } })
  })
  const input = { origin: 'https://account.test', provider: 'sub2api' }
  const probe = (token, options) => monitor.probe({ ...input, token, ...options })
  const save = (p) => monitor.saveSite({ ticket: p.ticket, threshold: 5 })
  const first = await probe('limited-key')
  assert.deepEqual([first.accountBalance, first.balance], [null, 1])
  const id = save(first)
  const view = () => displayState(monitor.state)
  assert.equal(view().unreadWalletCount, 1)
  assert.equal(monitor.state.notices.length, 0)
  const source = save(await probe('wallet-key'))
  assert.equal((await probe('another-key')).accountBalance, 42)
  assert.equal((await probe('replacement', { id: source })).accountBalance, null)
  assert.equal((await probe('another-key', { walletGroup: '独立账户' })).accountBalance, null)
  assert.equal(view().unreadWalletCount, 0)
  assert.equal(view().wallets.length, 1)
  assert.deepEqual(view().sites.map((s) => s.accountBalance), [42, 42])
  wallet = 0
  await monitor.refreshSite(id)
  assert.equal(walletReads, 2)
  assert.deepEqual(view().sites.map((s) => s.accountBalance), [0, 0])
  assert.equal(view().sites[0].walletSourceId, source)
  assert.equal(view().sites[0].walletChecked, view().sites[1].checked)
  assert.deepEqual(monitor.state.notices.map((n) => n.siteId), [source])
  assert.equal(monitor.state.notices[0].unit, 'CNY')
  await monitor.updateSite({ id, walletGroup: '第二个账户' })
  assert.equal(view().sites[0].accountBalance, null)
  assert.equal(view().unreadWalletCount, 1)
  await monitor.updateSite({ id, walletGroup: '' })
  await monitor.updateSite({ id: source, remove: true })
  assert.equal(view().sites[0].accountBalance, null)
  assert.equal(view().sites[0].balance, 1)
})

test('SUB quotas, subscription and rate windows expose key spend without creating wallets or false zero balances', async (t) => {
  const gateway = { origin: 'https://fixture.test', token: 'fixture' }
  const now = new Date(2026, 0, 31, 12)
  let body
  t.mock.method(globalThis, 'fetch', async (input) => {
    const params = new URL(input).searchParams
    assert.equal(params.get('start_date'), '2026-01-01')
    assert.equal(params.get('end_date'), '2026-01-31')
    assert.ok(params.get('timezone'))
    return Response.json(body)
  })
  body = { mode: 'quota_limited', quota: { used: 7, limit: 10, remaining: 3 },
    daily_usage: [{ date: '2026-01-01', actual_cost: 0.5, cost: 8 }, { date: '2026-01-31', actual_cost: 0 }] }
  const quota = await querySub2Api(gateway, now)
  assert.deepEqual([quota.balanceKind, quota.balance, quota.monthValue, quota.todayValue], ['quota', 3, 0.5, 0])
  body = { mode: 'quota_limited', rate_limits: [{ window: '5h', used: 1, limit: 2, remaining: 1 }] }
  const window = await querySub2Api(gateway, now)
  assert.deepEqual([window.balance, window.monthValue, window.todayValue, window.keyUsage.limits[0].used], [null, null, null, 1])
  const monitor = new Monitor(':memory:', {})
  t.after(() => monitor.db.close())
  monitor.tickets.set('window', { origin: gateway.origin, provider: 'sub2api', keyFingerprint: 'key-one',
    data: window, at: now.getTime(), expires: Date.now() + 60000, cipher: Buffer.from('fixture') })
  monitor.saveSite({ ticket: 'window', threshold: 20, autoUsd: true, fallbackRate: 7 })
  assert.equal(displayState(monitor.state).sites[0].balance, null)
  assert.equal(monitor.state.notices.length, 0)
  body = { mode: 'unrestricted', remaining: -1, subscription: {}, usage: { today: { actual_cost: 0.5 } },
    model_stats: [{ model: 'A', actual_cost: 2.5 }] }
  const sub = await querySub2Api(gateway, now)
  assert.deepEqual([sub.keyUsage.unlimited, sub.balance, sub.monthValue, sub.todayValue], [true, null, 2.5, 0.5])
  assert.deepEqual(displayState({ sites: [quota, window, sub].map((s) => ({ ...s, provider: 'sub2api' })) }).wallets, [])
  body = { mode: 'unrestricted', balance: 0, daily_usage: [{ date: '2026-01-31', cost: 12 }] }
  const partial = await querySub2Api(gateway, now)
  assert.deepEqual([partial.balance, partial.todayValue, partial.monthValue, partial.keyUsage.daily[0].cost], [0, null, null, 12])
  body = { mode: 'unrestricted', balance: 0, daily_usage: [] }
  assert.equal((await querySub2Api(gateway, now)).monthValue, 0)
  body = { mode: 'unrestricted', balance: 'error' }
  await assert.rejects(querySub2Api(gateway, now), /无效的钱包余额/)
})

test('global threshold applies across units and restarts while preserving individual thresholds', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'quotadesk-threshold-'))
  const database = join(folder, 'wallet.sqlite')
  const deliveries = []
  function open() {
    const mon = new Monitor(database, {}, undefined, async (_cfg, _secret, msg) => deliveries.push(msg))
    t.mock.method(mon, 'dispatch', () => {})
    return mon
  }
  let mon = open()
  t.after(async () => {
    mon.db.close()
    await rm(folder, { recursive: true, force: true })
  })
  mon.change((s) => {
    delete s.globalThreshold // Simulate a workspace created before the unified setting.
    s.mail = { ...emptyMail, enabled: true, to: 'test@example.test' }
    const add = (id, unit, balance, threshold, paused = false, health = 'ok') =>
      s.sites.push({ id, name: id, unit, balance, threshold, paused, health, low: false, logs: [], history: [] })
    add('usd', 'USD', 39.48, 20)
    add('points', '积分@fixture', 33.83, 10)
    add('equal', 'CNY', 40, 5)
    add('paused', 'USD', 8, 4, true)
    add('offline', 'USD', 5, 3, false, 'offline')
  })
  mon.db.close()
  mon = open()
  assert.equal(mon.state.globalThreshold, null)
  for (const invalid of [-1, NaN, Infinity, '40']) {
    assert.throws(() => mon.preferences({ globalThreshold: invalid }), /阈值/)
  }
  assert.equal(mon.state.notices.length, 0)
  mon.preferences({ globalThreshold: 40 })
  assert.deepEqual(mon.state.sites.map((s) => s.low), [true, true, false, false, false])
  assert.deepEqual(mon.state.notices.map((n) => [n.sourceUnit, n.unit, n.threshold]),
    [['积分@fixture', 'CNY', 40], ['USD', 'CNY', 40]])
  await mon.drain()
  assert.equal(deliveries.length, 2)
  mon.preferences({ globalThreshold: 40 })
  mon.preferences({ globalThreshold: 39.9 })
  await mon.drain()
  assert.equal(deliveries.length, 2)
  await assert.rejects(mon.updateSite({ id: 'usd', threshold: 9 }), /统一预警金额/)
  const at = Date.now()
  function ticket(id) {
    mon.tickets.set(id, { origin: 'https://example.test', userId: '', data: {
      unit: 'USD', accountId: 7, balance: 30, history: [], usageNote: '',
    }, cipher: Buffer.from('fixture'), at, expires: at + 60000 })
  }
  ticket('add')
  const id = mon.saveSite({ ticket: 'add', name: 'new', threshold: 3 })
  assert.equal(mon.state.notices[0].threshold, 39.9)
  mon.preferences({ globalThreshold: 50 })
  ticket('replace')
  mon.saveSite({ ticket: 'replace', name: 'new', threshold: 50, id })
  assert.equal(mon.state.sites.find((s) => s.id === id).threshold, 39.9)
  mon.db.close()
  mon = open()
  assert.equal(mon.state.globalThreshold, 50)
  mon.preferences({ globalThreshold: 0 })
  assert.ok(mon.state.notices.every((n) => n.closed))
  assert.ok(mon.state.sites.every((s) => !s.low))
  await mon.drain()
  assert.equal(deliveries.length, 2)
  mon.preferences({ globalThreshold: null })
  assert.deepEqual(mon.state.sites.map((s) => s.threshold), [20, 10, 5, 4, 3, 39.9])
  assert.deepEqual(mon.state.notices.filter((n) => !n.closed).map((n) => n.siteId), [id])
})

// Local fixtures use the JSON envelopes, quota units and inclusive time boundaries of New API.
test('wallet reads, optional usage, persistent alert cycles and token replacement', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'quotadesk-test-')),
    database = join(folder, 'wallet.sqlite')
  let quota = 700000,
    usageAllowed = true,
    tokenValid = true,
    brokenBalance = false,
    kind = 'CNY',
    received = 0,
    accessCount = 0,
    block
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost')
    const respond = (data) => res.end(JSON.stringify({ success: true, data }))
    if (u.pathname === '/api/status') {
      assert.equal(req.headers.authorization, undefined)
      return respond({
        quota_display_type: kind,
        quota_per_unit: 500000,
        usd_exchange_rate: 7,
        custom_currency_symbol: '点',
        custom_currency_exchange_rate: 3,
        enable_data_export: true,
      })
    }
    assert.equal(req.headers.authorization, 'Bearer local-fixture')
    assert.equal(req.headers['new-api-user'], '42')
    if (!tokenValid) {
      res.writeHead(401)
      return res.end()
    }
    if (u.pathname === '/api/user/self') {
      accessCount++
      if (block) await block
      return respond({ id: 42, quota: brokenBalance ? null : quota })
    }
    if (!usageAllowed) {
      res.writeHead(403)
      return res.end()
    }
    if (u.pathname === '/api/log/self/stat') {
      assert.equal(u.searchParams.get('type'), '2')
      assert.ok(+u.searchParams.get('end_timestamp') >= +u.searchParams.get('start_timestamp'))
      return respond({ quota: 50000 })
    }
    if (u.pathname === '/api/data/self')
      return respond([{ created_at: Math.floor(Date.now() / 1000) - 86400, quota: 25000 }])
    res.writeHead(404)
    res.end()
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  const crypto = {
    encryptStringAsync: async (s) => Buffer.from('fixture:' + s),
    decryptStringAsync: async (b) => ({ result: b.toString().slice(8) }),
  }
  const send = async (c, secret, msg) => {
    assert.equal(secret, 'mail-pass')
    assert.equal(msg.to, 'me@example.com')
    received++
  }
  let mon = new Monitor(database, crypto, undefined, send)
  t.after(async () => {
    server.closeAllConnections()
    server.close()
    mon.db.close()
    await rm(folder, { recursive: true, force: true })
  })
  const input = { origin, token: 'local-fixture', userId: '42' }
  assert.equal(siteAddress(origin + '/api/'), origin)
  const test = await mon.probe(input)
  assert.ok(Math.abs(test.balance - 9.8) < 1e-10)
  assert.ok(!JSON.stringify(test).includes('local-fixture'))
  const id = mon.saveSite({ ticket: test.ticket, threshold: 5, name: '本地站点' })
  const cfg = {
    ...emptyMail,
    enabled: true,
    host: 'smtp.example.com',
    from: 'me@example.com',
    to: 'me@example.com',
    account: 'local',
  }
  await mon.configure({ config: cfg, secret: 'mail-pass' })
  quota = 200000
  await Promise.all([mon.poll(id), mon.poll(id)])
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(received, 1)
  assert.equal(mon.state.notices[0].delivery, 'sent')
  assert.equal(mon.state.sites[0].todayValue, 0.7)
  assert.equal(mon.state.sites[0].monthValue, 0.7)
  await mon.poll(id)
  assert.equal(received, 1)
  assert.ok(!JSON.stringify(mon.state).includes('mail-pass'))
  mon.db.close()
  mon = new Monitor(database, crypto, undefined, send)
  await mon.poll(id)
  assert.equal(received, 1)
  tokenValid = false
  const last = mon.state.sites[0].checked
  await mon.poll(id)
  assert.equal(mon.state.sites[0].checked, last)
  assert.equal(mon.state.sites[0].health, 'invalid')
  tokenValid = true
  brokenBalance = true
  await mon.poll(id)
  assert.equal(mon.state.sites[0].checked, last)
  brokenBalance = false
  usageAllowed = false
  quota = 800000
  await mon.poll(id)
  assert.equal(mon.state.sites[0].usage, false)
  assert.equal(mon.state.sites[0].todayValue, 0.7)
  assert.ok(mon.state.sites[0].estimatedSince)
  assert.ok(mon.state.notices[0].closed)
  quota = 150000
  await mon.poll(id)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(received, 2)
  let release
  block = new Promise((r) => {
    release = r
  })
  const slow = mon.poll(id)
  await new Promise((r) => setTimeout(r, 15))
  await mon.updateSite({ id, paused: true })
  release()
  block = null
  await slow
  const count = accessCount
  await mon.sweep(true)
  assert.equal(accessCount, count)
  kind = 'CUSTOM'
  await mon.updateSite({ id, paused: false })
  assert.equal(mon.state.sites[0].threshold, 0)
  assert.equal(mon.state.sites[0].unit, '点@' + origin)
  await assert.rejects(
    mon.configure({ config: { ...cfg, host: 'different.example.com' }, secret: '' }),
    /填写/,
  )
  const duplicate = await mon.probe(input)
  assert.throws(
    () => mon.saveSite({ ticket: duplicate.ticket, name: '同一帐号', threshold: 1 }),
    /已经添加/,
  )
  await mon.updateSite({ id, remove: true })
  assert.equal(mon.state.sites.length, 0)
  assert.equal(await mon.secret(id), '')
})

test('opt-in USD conversion uses the site rate for display, usage and low-balance notices', async (t) => {
  const mon = new Monitor(':memory:', { encryptStringAsync: async () => Buffer.from('sample'),
    decryptStringAsync: async () => ({ result: 'fixture' }) })
  t.after(() => mon.db.close())
  let rate = 7
  t.mock.method(globalThis, 'fetch', async (input) => {
    const path = new URL(input).pathname
    const data = path === '/api/status'
      ? { quota_display_type: 'USD', quota_per_unit: 100, usd_exchange_rate: rate, enable_data_export: false }
      : path === '/api/user/self' ? { id: 1, quota: 300 } : { quota: 50 }
    return Response.json({ success: true, data })
  })
  const input = { origin: 'https://fixture.test', token: 'fixture' }
  const probe = await mon.probe(input)
  assert.deepEqual([probe.balance, probe.usdPerUnit, probe.usdRate], [3, 1, 7])
  const id = mon.saveSite({ ticket: probe.ticket, threshold: 20, autoUsd: true })
  const view = () => displayState(mon.state).sites[0]
  assert.deepEqual([view().balance, view().todayValue, view().monthValue, view().history.at(-1).value], [21, 3.5, 3.5, 3.5])
  assert.equal(mon.state.notices.length, 0)
  rate = 6
  await mon.poll(id)
  assert.deepEqual([view().balance, view().todayValue, mon.state.sites[0].balance], [18, 3, 3])
  assert.deepEqual([mon.state.notices[0].balance, mon.state.notices[0].unit], [18, 'CNY'])
  rate = null
  await mon.poll(id)
  assert.deepEqual([view().health, view().balance], ['offline', 18])
  const replacement = await mon.probe(input)
  assert.throws(() => mon.saveSite({ id, ticket: replacement.ticket, threshold: 20, autoUsd: true }), /汇率/)
  mon.saveSite({ id, ticket: replacement.ticket, threshold: 20, autoUsd: true, fallbackRate: 8 })
  assert.equal(view().balance, 24)
  assert.ok(mon.state.notices[0].closed)
  const reset = await mon.probe(input)
  mon.saveSite({ id, ticket: reset.ticket, threshold: 20, autoUsd: false })
  assert.deepEqual([view().balance, view().todayValue], [3, 0.5])

  // Existing profiles can predate the cached exchange-rate fields.
  mon.change((state) => {
    delete state.sites[0].usdPerUnit
    delete state.sites[0].usdRate
  })
  await assert.rejects(mon.setAutoUsd({ id, enabled: true }), /汇率/)
  assert.equal(view().balance, 3)
  rate = 7
  await mon.setAutoUsd({ id, enabled: true })
  assert.deepEqual([view().id, view().balance, view().todayValue, view().low], [id, 21, 3.5, false])
  await mon.setAutoUsd({ id, enabled: false })
  assert.deepEqual([view().balance, view().todayValue, view().low], [3, 0.5, true])
  mon.change((state) => { state.sites[0].usdRate = null })
  await mon.setAutoUsd({ id, enabled: true, fallbackRate: 8 })
  assert.equal(view().balance, 24)
  assert.equal(mon.state.sites.length, 1)
})

test('Resend uses the original alert id for retries and surfaces provider rejection', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options })
    return { ok: calls.length === 2, status: calls.length === 2 ? 200 : 429 }
  })
  const cfg = { ...emptyMail, provider: 'resend', from: 'from@example.test' }
  const msg = { subject: '低余额', text: '测试', to: 'to@example.test', id: 'alert-fixture' }
  await assert.rejects(deliver(cfg, 'test-value', msg), /429/)
  await deliver(cfg, 'test-value', msg)
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.deepEqual(calls[0], calls[1])
  assert.equal(calls[1].options.headers['Idempotency-Key'], 'alert-fixture')
  assert.deepEqual(JSON.parse(calls[1].options.body).to, ['to@example.test'])
})

test('test mail validates the entire list and independently attempts every unique recipient', async (t) => {
  const cfg = {
    ...emptyMail, enabled: true, provider: 'resend', from: 'alerts@example.test',
    to: ' First@example.test, second@example.test；FIRST@example.test; third@example.test， ',
  }
  const addresses = ['First@example.test', 'second@example.test', 'third@example.test']
  const calls = []
  const mon = new Monitor(':memory:', {})
  t.after(() => mon.db.close())
  let rejectSecond = true
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.to.length, 1)
    assert.equal(body.subject, 'QuotaDesk 测试邮件')
    calls.push({ to: body.to[0], id: options.headers['Idempotency-Key'] })
    return { ok: !rejectSecond || body.to[0] !== addresses[1], status: 422 }
  })
  assert.equal(mailConfig(cfg).to, addresses.join(', '))
  const send = (config) => mon.configure({ config, secret: 'fixture' }, true)
  await assert.rejects(send({ ...cfg, to: cfg.to + 'broken' }), /broken/)
  await assert.rejects(send({ ...cfg, to: ' ; ，' }), /至少/)
  await assert.rejects(send({ ...cfg, from: cfg.to }), /发件邮箱/)
  assert.equal(calls.length, 0)
  await assert.rejects(send(cfg), /2\/3.*second@example.test/)
  assert.deepEqual(calls.map((m) => m.to), addresses)
  assert.equal(new Set(calls.map((m) => m.id)).size, 3)
  rejectSecond = false
  assert.equal(await send(cfg), 3)
  assert.equal(mon.state.mail.enabled, false)
})

test('each low-balance alert retains individual delivery results and retry keys across restarts', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'quotadesk-recipients-'))
  const database = join(folder, 'wallet.sqlite')
  const calls = []
  let fail = true
  function open() {
    const mon = new Monitor(database, {}, undefined, async (_config, _secret, msg) => {
      calls.push(msg)
      if (fail && msg.to === 'b@example.test') throw Error('rejected')
    })
    t.mock.method(mon, 'dispatch', () => {})
    return mon
  }
  let mon = open()
  t.after(async () => {
    mon.db.close()
    await rm(folder, { recursive: true, force: true })
  })
  const cfg = { ...emptyMail, enabled: true, host: 'localhost', from: 'alerts@example.test',
    to: 'a@example.test；b@example.test, c@example.test;a@example.test' }
  await mon.configure({ config: cfg })
  mon.change((s) => {
    const site = { id: 'site', name: '站点', threshold: 2, history: [], logs: [] }
    s.sites.push(site)
    mon.apply(s, site, { unit: 'CNY', balance: 1 }, Date.now())
  })
  await mon.drain()
  const [alert] = mon.state.notices
  assert.equal(alert.delivery, 'failed')
  assert.deepEqual(alert.recipients.map((r) => r.delivery), ['sent', 'failed', 'sent'])
  assert.deepEqual(calls.map((m) => m.to), ['a@example.test', 'b@example.test', 'c@example.test'])
  assert.equal(new Set(calls.map((m) => m.id)).size, 3)
  mon.db.close()
  mon = open()
  await mon.drain()
  assert.equal(calls.length, 3)
  fail = false
  mon.retry(alert.id)
  await mon.drain()
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[3], calls[1])
  assert.equal(mon.state.notices[0].delivery, 'sent')
  // Change recipients mid-incident, then start a fresh low-balance cycle.
  mon.change((s) => { s.sites[0].paused = true })
  await mon.configure({ config: { ...cfg, to: 'a@example.test;d@example.test' } })
  mon.change((s) => { s.sites[0].paused = false })
  await mon.drain()
  assert.deepEqual(calls.slice(4).map((m) => m.to), ['d@example.test'])
  mon.change((s) => {
    mon.apply(s, s.sites[0], { unit: 'CNY', balance: 5 }, Date.now())
    mon.apply(s, s.sites[0], { unit: 'CNY', balance: 1 }, Date.now())
  })
  await mon.drain()
  assert.equal(mon.state.notices.length, 2)
  assert.deepEqual(calls.slice(5).map((m) => m.to), ['a@example.test', 'd@example.test'])
})

test('startup isolates interrupted recipients and preserves the original single-address retry ID', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'quotadesk-mail-recovery-'))
  const database = join(folder, 'wallet.sqlite')
  const addresses = ['a@example.test', 'b@example.test', 'c@example.test']
  let mon = new Monitor(database, {})
  t.after(async () => {
    mon.db.close()
    await rm(folder, { recursive: true, force: true })
  })
  mon.change((s) => {
    s.mail = { ...emptyMail, enabled: true, to: addresses.join(', ') }
    s.sites.push({ id: 'fixture', paused: false })
    const base = { siteId: 'fixture', site: '本地测试', at: 1, balance: 1, threshold: 2, unit: 'CNY',
      delivery: 'sending', attempts: 1, retryAt: 0 }
    s.notices.push({ ...base, id: 'original-id', destination: addresses[1] })
    const states = ['sent', 'sending', 'pending']
    s.notices.push({ ...base, id: 'new-id', destination: s.mail.to, recipients: addresses.map((address, i) => ({
      id: 'delivery-' + i, address, selected: true, delivery: states[i], attempts: 1, retryAt: 0,
    })) })
  })
  mon.db.close()
  const calls = []
  mon = new Monitor(database, {}, undefined, async (_cfg, _secret, msg) => { calls.push(msg) })
  await mon.drain()
  assert.deepEqual(calls.map((m) => m.to), [addresses[2]])
  const [legacy, group] = mon.state.notices
  assert.equal(legacy.recipients[0].id, legacy.id)
  assert.equal(legacy.delivery, 'uncertain')
  assert.deepEqual(group.recipients.map((r) => r.delivery), ['sent', 'uncertain', 'sent'])
})

test('Flashduty escalates an emailed notice only on a later scheduled low reading and retries the same event', async (t) => {
  const crypto = { encryptStringAsync: async (v) => Buffer.from(v), decryptStringAsync: async (v) => ({ result: v.toString() }) }
  const dir = await mkdtemp(join(tmpdir(), 'quotadesk-flashduty-'))
  const db = join(dir, 'state.sqlite')
  let failMail = true, failQuery = false, now = Date.now()
  t.mock.method(Date, 'now', () => now)
  let mailCount = 0
  const sendMail = async () => {
    mailCount++
    if (failMail) throw Error('mail rejected')
  }
  let mon = new Monitor(db, crypto, undefined, sendMail)
  t.after(async () => { mon.db.close(); await rm(dir, { recursive: true, force: true }) })
  const address = 'https://api.flashcat.cloud/event/push/alert/standard?integration_key=fixture-key'
  let balance = 100, fail = false
  const events = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.toString() !== address) return failQuery ? new Response('', { status: 503 }) : Response.json({ balance })
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    events.push(JSON.parse(options.body))
    return Response.json({ err: fail ? 'invalid' : '' })
  })
  const idle = async () => {
    for (let i = 0; i < 100 && (mon.sendingFlashduty || mon.sending); i++) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(mon.sendingFlashduty, false)
    assert.equal(mon.sending, false)
  }
  const cycle = async () => {
    now += mon.state.minutes * 60000
    await mon.sweep()
    await idle()
  }
  const { ticket } = await mon.probe({ provider: 'custom', origin: 'https://fixture.test/balance', token: 'private-site-token',
    custom: { balancePath: 'balance', auth: 'bearer', currency: 'CNY' } })
  const id = mon.saveSite({ ticket, name: '测试站点', threshold: 30 })
  await assert.rejects(mon.configureFlashduty({ enabled: true, address: 'https://other.example/?integration_key=secret' }), /集成地址/)
  await mon.configureFlashduty({ enabled: false, address }, true)
  assert.equal(mon.state.flashduty.configured, false)
  await mon.configureFlashduty({ enabled: true, address })
  assert.equal(JSON.stringify(mon.state).includes('fixture-key'), false)
  assert.equal(events.length, 1)
  assert.equal(events[0].labels.kind, 'test')
  fail = true
  balance = 15
  await mon.poll(id); await idle()
  const notice = () => mon.state.notices[0]
  assert.equal(notice().delivery, 'off')
  await cycle()
  assert.equal(events.length, 1)
  // A pending event from the previous parallel-delivery rule must not escape on restart.
  mon.change((s) => { s.notices[0].flashduty = { status: 'pending', attempts: 0 } })
  mon.db.close()
  mon = new Monitor(db, crypto, undefined, sendMail)
  await cycle()
  assert.equal(events.length, 1)
  await mon.configure({ config: { ...emptyMail, enabled: true, host: 'localhost', from: 'me@example.test', to: 'me@example.test' } })
  await idle()
  assert.equal(notice().delivery, 'failed')
  await cycle()
  assert.equal(events.length, 1)
  failMail = false
  await cycle()
  assert.equal(notice().delivery, 'sent')
  assert.equal(events.length, 1)
  await mon.refreshSite(id); await idle()
  mon.preferences({ globalThreshold: 31 })
  await mon.configureFlashduty({ enabled: true })
  await idle()
  assert.equal(events.length, 1)
  failQuery = true
  await cycle()
  assert.equal(events.length, 1)
  failQuery = false
  balance = 12
  await cycle()
  assert.equal(notice().flashduty.status, 'failed')
  assert.equal(events[1].event_status, 'Warning')
  assert.match(events[1].title_rule, /测试站点.*12.*31/)
  assert.ok(!JSON.stringify(events).includes('private-site-token'))
  mon.db.close()
  mon = new Monitor(db, crypto, undefined, sendMail)
  fail = false
  mon.retryFlashduty(notice().id); await idle()
  assert.equal(notice().flashduty.status, 'sent')
  assert.equal(events[1].alert_key, events[2].alert_key)
  await cycle()
  assert.equal(events.length, 3)
  balance = 60
  await mon.poll(id)
  balance = 10
  await mon.poll(id); await idle()
  assert.equal(events.length, 3)
  balance = 31
  await cycle()
  assert.ok(notice().closed)
  assert.equal(events.length, 3)
  balance = 9
  const beforeMail = mailCount
  await cycle()
  assert.equal(mailCount, beforeMail + 1)
  assert.equal(events.length, 3)
  await cycle()
  assert.equal(events.length, 4)
  assert.notEqual(events[3].alert_key, events[2].alert_key)
  await mon.configureFlashduty({ enabled: false })
  balance = 55
  await mon.poll(id)
  balance = 9
  await mon.poll(id)
  assert.equal(events.length, 4)
})
