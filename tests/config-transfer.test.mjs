import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Monitor, displayState } from '../desktop/monitor.mjs'
import { exportConfig, importConfig, readConfigFile, writeConfigFile } from '../desktop/config-transfer.mjs'
import { emptyMail } from '../desktop/mail.mjs'

const password = 'fixture-passphrase'
function machine(t, name) {
  const prefix = name + ':'
  const monitor = new Monitor(':memory:', {
    encryptStringAsync: async (s) => Buffer.from(prefix + s),
    decryptStringAsync: async (b) => {
      assert.ok(b.toString().startsWith(prefix))
      return { result: b.toString().slice(prefix.length) }
    },
  })
  t.after(() => monitor.db.close())
  return monitor
}
function setupFetch(t) {
  t.mock.method(globalThis, 'fetch', async (input, { headers }) => {
    const path = new URL(input).pathname
    if (path.endsWith('/v1/usage')) {
      assert.equal(headers.Authorization, 'Bearer fixture-sub-key')
      return Response.json({ mode: 'unrestricted', balance: 35, daily_usage: [] })
    }
    const data = path.endsWith('/api/status') ? { quota_display_type: 'USD', quota_per_unit: 100, enable_data_export: false }
      : path.endsWith('/api/user/self') ? { id: 42, quota: 5000 } : { quota: 0 }
    return Response.json({ success: true, data })
  })
}
async function add(monitor, provider, name, token) {
  const input = { provider, origin: 'https://fixture.test', token, userId: '42', walletGroup: '分组一' }
  const { ticket } = await monitor.probe(input)
  return monitor.saveSite({ ticket, name, threshold: 7, walletGroup: '分组一', autoUsd: true, fallbackRate: 6 })
}

test('portable encrypted configs merge by account/key, re-encrypt local secrets and resume polling', async (t) => {
  setupFetch(t)
  const src = machine(t, 'source'), dest = machine(t, 'target')
  const first = await add(src, 'new-api', '暂停的站点', 'fixture-new-token')
  await src.updateSite({ id: first, paused: true })
  await add(src, 'sub2api', '共享钱包', 'fixture-sub-key')
  src.preferences({ theme: 'dark', minutes: 30, globalThreshold: 2, followSystemProxy: false })
  await src.configure({ config: { ...emptyMail, provider: 'resend', from: 'from@example.test', to: 'one@example.test' },
    secret: 'fixture-mail-secret' })
  const fdAddress = 'https://api.flashcat.cloud/event/push/alert/standard?integration_key=fixture-transfer'
  await src.configureFlashduty({ enabled: false, address: fdAddress })
  const { bytes, count } = await exportConfig(src, password)
  assert.equal(count, 2)
  for (const value of ['fixture-new-token', 'fixture-mail-secret', 'fixture-sub-key', 'fixture-transfer', 'fixture.test', 'example.test'])
    assert.ok(!bytes.includes(Buffer.from(value)))
  assert.notDeepEqual(bytes, (await exportConfig(src, password)).bytes)
  const dir = await mkdtemp(join(tmpdir(), 'quotadesk-config-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'config.qdconfig')
  await writeConfigFile(file, bytes)
  await writeConfigFile(file, bytes)
  assert.deepEqual(await readdir(dir), ['config.qdconfig'])
  assert.deepEqual(await importConfig(dest, await readConfigFile(file), password, true), { added: 2, skipped: 0 })
  const [newApi, sub] = dest.state.sites
  assert.equal(dest.state.followSystemProxy, false)
  assert.equal(await dest.secret('flashduty'), fdAddress)
  assert.deepEqual(dest.state.flashduty, { enabled: false, configured: true })
  assert.deepEqual([newApi.paused, newApi.userId, newApi.threshold, newApi.autoUsd, sub.walletGroup],
    [true, '42', 7, true, '分组一'])
  assert.deepEqual([dest.state.theme, dest.state.minutes, dest.state.globalThreshold, dest.state.mail.to],
    ['dark', 30, 2, 'one@example.test'])
  assert.equal(await dest.secret(newApi.id), 'fixture-new-token')
  assert.equal(await dest.secret(sub.id), 'fixture-sub-key')
  assert.equal(await dest.secret('mail'), 'fixture-mail-secret')
  assert.ok(!JSON.stringify(displayState(dest.state)).includes('fixture-new-token'))
  await dest.sweep()
  assert.deepEqual(dest.state.sites.map((s) => s.health), ['pending', 'ok'])
  assert.equal(displayState(dest.state).sites[1].accountBalance, 210)
  dest.preferences({ theme: 'light', followSystemProxy: true })
  dest.change((s) => { s.sites[0].name = '保留本机备注' })
  assert.deepEqual(await importConfig(dest, bytes, password, false), { added: 0, skipped: 2 })
  assert.deepEqual([dest.state.theme, dest.state.sites[0].name], ['light', '保留本机备注'])
  assert.equal(dest.state.followSystemProxy, true)
})

test('incorrect passwords, corrupt files and partial database writes leave the destination intact', async (t) => {
  setupFetch(t)
  const src = machine(t, 'source'), dest = machine(t, 'target')
  await add(src, 'new-api', '样例', 'fixture-new-token')
  await add(src, 'sub2api', '样例二', 'fixture-sub-key')
  await dest.configure({ config: emptyMail, secret: 'local-original' })
  const original = structuredClone(dest.state)
  const { bytes } = await exportConfig(src, password)
  const corrupt = Buffer.from(bytes)
  corrupt[corrupt.length - 1] ^= 1
  await assert.rejects(importConfig(dest, bytes, 'wrong-password', true), /密码/)
  await assert.rejects(importConfig(dest, corrupt, password, true), /完整/)
  await assert.rejects(importConfig(dest, Buffer.from('bad'), password, true), /文件/)
  const write = dest.putSecret.bind(dest)
  let writes = 0
  t.mock.method(dest, 'putSecret', (id, cipher) => {
    if (++writes === 2) throw Error('fixture write failure')
    write(id, cipher)
  })
  await assert.rejects(importConfig(dest, bytes, password, true), /write failure/)
  assert.deepEqual(dest.state, original)
  assert.equal(await dest.secret('mail'), 'local-original')
  assert.equal(dest.db.prepare('SELECT COUNT(*) AS n FROM secrets').get().n, 1)
})

test('custom balance monitors keep their query, key and alert behavior across configuration transfer', async (t) => {
  const src = machine(t, 'source'), dest = machine(t, 'target')
  const origin = 'https://fixture.test/v1/balance'
  const custom = { auth: 'bearer', balancePath: 'balance', currency: 'CNY' }
  const input = { provider: 'custom', token: 'fixture-custom-key', origin, custom }
  let amount = '12.50', scope = 'tenant'
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, origin)
    assert.equal(options.headers.Authorization, 'Bearer fixture-custom-key')
    assert.equal(options.redirect, 'manual')
    return Response.json({ object: 'balance', balance: amount, currency: 'CNY', scope })
  })
  const probe = await src.probe(input)
  assert.deepEqual([probe.accountBalance, probe.balanceScope, probe.usage], [12.5, 'tenant', false])
  const id = src.saveSite({ ticket: probe.ticket, threshold: 5, name: 'TokenMei' })
  const duplicate = await src.probe(input)
  assert.throws(() => src.saveSite({ ticket: duplicate.ticket, threshold: 0 }), /已经添加/)
  const { bytes } = await exportConfig(src, password)
  assert.ok(!bytes.includes(Buffer.from(input.token)))
  assert.deepEqual(await importConfig(dest, bytes, password, false), { added: 1, skipped: 0 })
  assert.deepEqual(await importConfig(dest, bytes, password, false), { added: 0, skipped: 1 })
  const importedId = dest.state.sites[0].id
  amount = '-0.45'
  scope = 'sub_account'
  await dest.sweep()
  const view = displayState(dest.state)
  assert.deepEqual(view.sites[0].custom, custom)
  assert.deepEqual(view.wallets, [{ unit: 'CNY', value: -0.45, rmb: -0.45 }])
  assert.equal(view.sites[0].balanceScope, 'sub_account')
  assert.deepEqual([view.sites[0].todayValue, view.sites[0].monthValue, view.sites[0].history], [null, null, []])
  assert.equal(view.notices[0].balance, -0.45)
  for (const invalid of ['', false, null, 'N/A', {}, '1e999']) {
    amount = invalid
    await dest.refreshSite(importedId)
    assert.equal(dest.state.sites[0].health, 'offline')
    assert.equal(dest.state.sites[0].balance, -0.45)
  }
  amount = '0.00'
  await dest.refreshSite(importedId)
  assert.equal(dest.state.sites[0].balance, 0)
  const edited = await src.probe({ ...input, id, token: '' })
  assert.equal(edited.balance, 0)
  await assert.rejects(src.probe({ ...input, id, token: '', origin: origin + '/changed' }), /重新填写/)
  await assert.rejects(src.probe({ ...input, id, origin: 'https://elsewhere.test' }), /另一个站点/)
})

test('custom queries support nested numeric fields, X-API-Key and dollar balances', async (t) => {
  const mon = machine(t, 'source')
  const custom = { auth: 'x-api-key', balancePath: 'data.0.available', currency: 'USD' }
  const input = { provider: 'custom', origin: 'https://fixture.test/prefix/v1/', custom, token: 'fixture-api-key' }
  t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
    assert.equal(url, input.origin)
    assert.equal(headers['X-API-Key'], input.token)
    assert.equal(headers.Authorization, undefined)
    return Response.json({ data: [{ available: 2 }] })
  })
  const { ticket } = await mon.probe(input)
  assert.throws(() => mon.saveSite({ ticket, threshold: 0 }), /换算参数/)
  mon.saveSite({ ticket, threshold: 20, fallbackRate: 7 })
  assert.equal(displayState(mon.state).sites[0].accountBalance, 14)
  assert.equal(mon.state.notices[0].unit, 'CNY')
  const dest = machine(t, 'target')
  await importConfig(dest, (await exportConfig(mon, password)).bytes, password, false)
  await dest.sweep()
  assert.deepEqual(displayState(dest.state).wallets, [{ unit: 'CNY', value: 14, rmb: 14 }])
  await assert.rejects(mon.probe({ ...input, custom: { ...custom, balancePath: 'data.missing' } }), /找不到/)
})
