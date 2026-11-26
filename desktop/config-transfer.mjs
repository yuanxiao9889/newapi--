import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { integrationAddress } from './flashduty.mjs'
import { mailConfig } from './mail.mjs'
import { needsDeliveryRecovery, recoverDelivery, setRecipients } from './notice-mail.mjs'
import { isDayKey, siteAddress } from './new-api.mjs'
import { customConfig } from './custom-balance.mjs'

const derive = promisify(scrypt)
export const profitSecret = 'profit-source'
const legacyHeader = Buffer.from('QuotaDesk config v1\n')
const header = Buffer.from('QuotaDesk config v2\n')
const limit = 256 * 1024 * 1024
const overhead = header.length + 16 + 12 + 16 // salt, nonce and authentication tag

async function keyFor(password, salt) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024)
    throw Error('配置文件密码应为 8 至 1024 个字符。')
  return derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

async function seal(data, password) {
  const plain = Buffer.from(JSON.stringify(data))
  try {
    if (plain.length + overhead > limit) throw Error('备份文件超过 256 MB。')
    const salt = randomBytes(16), nonce = randomBytes(12)
    const key = await keyFor(password, salt)
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(header)
      const body = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.concat([header, salt, nonce, cipher.getAuthTag(), body])
    } finally { key.fill(0) }
  } finally { plain.fill(0) }
}

async function unseal(file, password) {
  const format = Buffer.isBuffer(file) && file.subarray(0, header.length)
  if (!format || file.length <= overhead || file.length > limit || (!format.equals(header) && !format.equals(legacyHeader)))
    throw Error('请选择受支持的 QuotaDesk 配置文件（.qdconfig）。')
  const start = header.length, key = await keyFor(password, file.subarray(start, start + 16))
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, file.subarray(start + 16, start + 28))
    cipher.setAAD(format)
    cipher.setAuthTag(file.subarray(start + 28, overhead))
    const plain = cipher.update(file.subarray(overhead))
    try {
      cipher.final()
      return { data: JSON.parse(plain.toString('utf8')), fullBackup: format.equals(header) }
    } finally { plain.fill(0) }
  } catch {
    throw Error('无法解密配置文件，请检查密码和文件是否完整。')
  } finally { key.fill(0) }
}

export async function writeConfigFile(path, bytes) {
  const temp = join(dirname(path), '.quotadesk-' + randomUUID() + '.tmp')
  const f = await open(temp, 'wx', 0o600)
  try {
    try { await f.writeFile(bytes); await f.sync() } finally { await f.close() }
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

export async function readConfigFile(path) {
  const f = await open(path, 'r')
  try {
    const { size } = await f.stat()
    if (size <= overhead || size > limit) throw Error('配置文件大小无效，最大支持 256 MB。')
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await f.read(bytes, offset, size - offset, offset)
      if (!bytesRead) throw Error('配置文件读取不完整。')
      offset += bytesRead
    }
    return bytes
  } finally { await f.close() }
}

function requireField(valid) {
  if (!valid) throw Error('配置文件中的站点或偏好设置无效。')
}

// Validate settings from either generation before attaching saved monitoring data.
function siteConfig(s) {
  const { name, origin, userId = '', accountId, threshold, paused, unit, balance, checked } = s
  const { provider = 'new-api', walletGroup = '', autoUsd = false, fallbackRate = null,
    usdPerUnit = null, usdRate = null, balanceKind } = s
  const billing = s.billing == null ? null : { unit: s.billing.unit, rmbRate: s.billing.rmbRate }
  requireField(['new-api', 'sub2api', 'custom'].includes(provider) && typeof origin === 'string' && URL.canParse(origin))
  const normalized = siteAddress(origin, provider)
  const custom = provider === 'custom' ? customConfig(s.custom) : undefined
  requireField(typeof name === 'string' && typeof walletGroup === 'string' && typeof userId === 'string' &&
    (!userId || /^[1-9]\d*$/.test(userId)) && typeof paused === 'boolean' && typeof autoUsd === 'boolean')
  if (custom) requireField(accountId === null && unit === custom.currency && !billing &&
    autoUsd === (unit === 'USD') && usdPerUnit === (autoUsd ? 1 : null) && usdRate === null)
  else if (provider === 'sub2api') requireField(accountId === null && ['wallet', 'window', 'quota', 'subscription'].includes(balanceKind))
  else requireField(Number.isSafeInteger(accountId) && accountId > 0)
  requireField(typeof unit === 'string' && unit.length > 0 && Number.isSafeInteger(checked) && checked > 0 &&
    Number.isFinite(threshold) && threshold >= 0 && (Number.isFinite(balance) || (provider === 'sub2api' && balance === null)))
  requireField([usdPerUnit, usdRate, fallbackRate].every((v) => v === null || (Number.isFinite(v) && v > 0)))
  const factor = usdPerUnit * (usdRate ?? fallbackRate)
  requireField(!autoUsd || (factor > 0 && Number.isFinite(factor) && Number.isFinite(balance * factor)))
  requireField(!billing || (!autoUsd && provider === 'new-api' && [unit, 'USD'].includes(billing.unit) &&
    billing.unit !== 'CNY' && Number.isFinite(billing.rmbRate) && billing.rmbRate > 0 && Number.isFinite(balance * billing.rmbRate)))
  return { name, origin: custom ? normalized : origin, provider, custom, userId, accountId, threshold, paused, walletGroup, autoUsd, fallbackRate,
    billing, unit, balance, checked, usdPerUnit, usdRate, balanceKind: provider === 'sub2api' ? balanceKind : undefined }
}

export async function exportConfig(monitor, password) {
  const { sites, notices, theme, minutes, globalThreshold, followSystemProxy, flashduty, mail } = monitor.state
  // Start all local secret reads against the same in-memory snapshot before awaiting decryption.
  const profit = monitor.state.profit
  const [entries, mailSecret, flashdutyAddress, profitToken] = await Promise.all([
    Promise.all(sites.map(async (s) => {
      const token = await monitor.secret(s.id)
      if (!token) throw Error('站点「' + s.name + '」缺少凭据，请重新填写后导出。')
      return { site: s, token }
    })),
    monitor.secret('mail'), monitor.secret('flashduty'), profit ? monitor.secret(profitSecret) : null,
  ])
  if (profit && !profitToken) throw Error('收入站缺少管理员凭据，请在利润页重新录入。')
  return { bytes: await seal({ entries, notices, theme, minutes, globalThreshold, followSystemProxy, mail, mailSecret, profit, profitToken,
    flashduty: { enabled: flashduty.enabled, address: flashdutyAddress } }, password), count: entries.length }
}

export function siteIdentity(s) {
  const provider = s.provider ?? 'new-api'
  return JSON.stringify([s.origin, provider, provider === 'new-api' ? s.accountId : s.keyFingerprint])
}

export async function importConfig(monitor, bytes, password, applyPreferences) {
  const { data, fullBackup } = await unseal(bytes, password)
  requireField(data && Array.isArray(data.entries) && typeof applyPreferences === 'boolean')
  const { theme, minutes, globalThreshold, mailSecret } = data
  requireField(data.followSystemProxy === undefined || typeof data.followSystemProxy === 'boolean')
  requireField(['system', 'light', 'dark'].includes(theme) && [5, 15, 30, 60].includes(minutes) &&
    (globalThreshold === null || (Number.isFinite(globalThreshold) && globalThreshold >= 0)) &&
    typeof mailSecret === 'string' && data.mail && typeof data.mail.enabled === 'boolean')
  const mail = mailConfig(data.mail)
  requireField(!mail.enabled || !(mail.provider === 'resend' || mail.account) || mailSecret.length > 0)
  const prepared = []
  const sourceIds = new Set()
  for (const entry of data.entries) {
    requireField(entry && entry.site && typeof entry.token === 'string' && entry.token.trim() &&
      entry.token.length <= 8192 && !/[\r\n]/.test(entry.token))
    const config = siteConfig(entry.site)
    const site = fullBackup ? { ...entry.site, ...config } : config
    if (fullBackup) {
      requireField(typeof site.id === 'string' && site.id && !sourceIds.has(site.id) &&
        Array.isArray(site.history) && site.history.every(p => typeof p?.day === 'string' && Number.isFinite(p.value)) &&
        Array.isArray(site.logs) && site.logs.every(l => Number.isFinite(l?.at) && typeof l.text === 'string') &&
        ['ok', 'pending', 'retrying', 'offline', 'invalid'].includes(site.health))
      sourceIds.add(site.id)
    }
    if (site.provider !== 'new-api') site.keyFingerprint = createHash('sha256').update(entry.token).digest('hex')
    prepared.push({ site, cipher: await monitor.crypto.encryptStringAsync(entry.token) })
  }
  const mailCipher = applyPreferences && mailSecret ? await monitor.crypto.encryptStringAsync(mailSecret) : null
  const fd = data.flashduty
  if (fullBackup) {
    requireField(fd && Array.isArray(data.notices))
    const ids = new Set()
    for (const n of data.notices) {
      requireField(n && sourceIds.has(n.siteId) && typeof n.id === 'string' && n.id && !ids.has(n.id) &&
        typeof n.site === 'string' && typeof n.unit === 'string' && Number.isFinite(n.at) &&
        Number.isFinite(n.balance) && Number.isFinite(n.threshold) &&
        (n.recipients == null || (Array.isArray(n.recipients) && n.recipients.every(r =>
          typeof r?.address === 'string' && typeof r.id === 'string'))))
      ids.add(n.id)
    }
  }
  if (fd !== undefined) requireField(fd && typeof fd.enabled === 'boolean' && typeof fd.address === 'string' && (!fd.enabled || fd.address))
  const fdCipher = applyPreferences && fd?.address ? await monitor.crypto.encryptStringAsync(integrationAddress(fd.address)) : null
  const book = fullBackup && data.profit
  if (book) {
    requireField(siteAddress(book.origin) === book.origin && typeof book.userId === 'string' &&
      (!book.userId || /^[1-9]\d*$/.test(book.userId)) && (book.rate == null || Number.isFinite(book.rate) && book.rate > 0) &&
      isDayKey(book.start) && isDayKey(book.lastDay) && book.start <= book.lastDay &&
      typeof data.profitToken === 'string' && data.profitToken.trim() && data.profitToken.length <= 8192 && !/[\r\n]/.test(data.profitToken) &&
      Number.isSafeInteger(book.checked) && Number.isSafeInteger(book.revision) &&
      book.days && Object.hasOwn(book.days, book.start) && Object.hasOwn(book.days, book.lastDay))
    for (const [day, row] of Object.entries(book.days)) {
      requireField(isDayKey(day) && day >= book.start && day <= book.lastDay && row && typeof row.closed === 'boolean' &&
        (row.revenue === null || Number.isFinite(row.revenue)) && row.costs && typeof row.costs === 'object' &&
        Object.values(row.costs).every(c => c && typeof c.name === 'string' && (c.value === null || Number.isFinite(c.value))))
    }
  }
  const profitCipher = book && !monitor.state.profit ? await monitor.crypto.encryptStringAsync(data.profitToken) : null
  let added = 0
  monitor.change((state) => {
    if (applyPreferences) {
      if (monitor.sending || monitor.sendingFlashduty) throw Error('正在发送提醒，请在投递结束后再次导入。')
      const thresholdChanged = state.globalThreshold !== globalThreshold
      Object.assign(state, { minutes, theme, globalThreshold })
      if (data.followSystemProxy !== undefined) state.followSystemProxy = data.followSystemProxy
      monitor.applyMail(state, mail, mailCipher, true)
      if (fd) monitor.applyFlashduty(state, fd.enabled, fdCipher, true)
      if (thresholdChanged) for (const s of state.sites) monitor.evaluateBalance(state, s, Date.now())
    }
    const known = new Set(state.sites.map(siteIdentity))
    if (profitCipher && !state.profit) {
      state.profit = book
      monitor.putSecret(profitSecret, profitCipher)
    }
    const restoredIds = new Map()
    for (const { site, cipher } of prepared) {
      const key = siteIdentity(site)
      if (known.has(key)) continue
      known.add(key)
      const id = fullBackup && !['mail', 'flashduty', profitSecret].includes(site.id) && !state.sites.some(s => s.id === site.id)
        ? site.id : randomUUID()
      if (fullBackup) {
        state.sites.push({ ...site, id })
        restoredIds.set(site.id, id)
      } else state.sites.push({ ...site, id, icon: state.sites.length % 8, revision: 1, tried: 0, health: 'pending',
        low: false, usage: false, todayValue: null, monthValue: null, periodDay: '', history: [], historyAt: 0,
        usageNote: '', logs: [{ at: Date.now(), text: '已导入站点配置。' }] })
      monitor.putSecret(id, cipher)
      added++
    }
    if (fullBackup && restoredIds.size) {
      const noticeIds = new Set(state.notices.map(n => n.id))
      for (const saved of data.notices) {
        const siteId = restoredIds.get(saved.siteId)
        if (!siteId) continue
        requireField(!noticeIds.has(saved.id))
        const n = { ...saved, siteId }
        if (needsDeliveryRecovery(n)) recoverDelivery(n)
        if (!applyPreferences && !n.closed) {
          setRecipients(n, state.mail)
          if (['pending', 'failed'].includes(n.flashduty?.status)) n.flashduty.status = 'cancelled'
        }
        state.notices.push(n)
      }
      state.notices.sort((a, b) => b.at - a.at)
    }
  })
  return { added, skipped: prepared.length - added }
}
