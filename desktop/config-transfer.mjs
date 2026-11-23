import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { integrationAddress } from './flashduty.mjs'
import { mailConfig } from './mail.mjs'
import { siteAddress } from './new-api.mjs'
import { customConfig } from './custom-balance.mjs'

const derive = promisify(scrypt)
const header = Buffer.from('QuotaDesk config v1\n')
const limit = 16 * 1024 * 1024
const overhead = header.length + 16 + 12 + 16 // salt, nonce and authentication tag

async function keyFor(password, salt) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024)
    throw Error('配置文件密码应为 8 至 1024 个字符。')
  return derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

async function seal(data, password) {
  const plain = Buffer.from(JSON.stringify(data))
  try {
    if (plain.length + overhead > limit) throw Error('配置文件超过 16 MB。')
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
  if (!Buffer.isBuffer(file) || file.length <= overhead || file.length > limit || !file.subarray(0, header.length).equals(header))
    throw Error('请选择受支持的 QuotaDesk 配置文件（.qdconfig）。')
  const start = header.length, key = await keyFor(password, file.subarray(start, start + 16))
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, file.subarray(start + 16, start + 28))
    cipher.setAAD(header)
    cipher.setAuthTag(file.subarray(start + 28, overhead))
    const plain = cipher.update(file.subarray(overhead))
    try {
      cipher.final()
      return JSON.parse(plain.toString('utf8'))
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
    if (size <= overhead || size > limit) throw Error('配置文件大小无效，最大支持 16 MB。')
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

// Explicitly select transferable fields. Keep the last wallet reading for paused/offline sites.
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
  const { sites, theme, minutes, globalThreshold, followSystemProxy, flashduty, mail } = monitor.state
  // Start all local secret reads against the same in-memory snapshot before awaiting decryption.
  const [entries, mailSecret, flashdutyAddress] = await Promise.all([
    Promise.all(sites.map(async (s) => {
      const token = await monitor.secret(s.id)
      if (!token) throw Error('站点「' + s.name + '」缺少凭据，请重新填写后导出。')
      return { site: siteConfig(s), token }
    })),
    monitor.secret('mail'), monitor.secret('flashduty'),
  ])
  return { bytes: await seal({ entries, theme, minutes, globalThreshold, followSystemProxy, mail, mailSecret,
    flashduty: { enabled: flashduty.enabled, address: flashdutyAddress } }, password), count: entries.length }
}

export function siteIdentity(s) {
  const provider = s.provider ?? 'new-api'
  return JSON.stringify([s.origin, provider, provider === 'new-api' ? s.accountId : s.keyFingerprint])
}

export async function importConfig(monitor, bytes, password, applyPreferences) {
  const data = await unseal(bytes, password)
  requireField(data && Array.isArray(data.entries) && typeof applyPreferences === 'boolean')
  const { theme, minutes, globalThreshold, mailSecret } = data
  requireField(data.followSystemProxy === undefined || typeof data.followSystemProxy === 'boolean')
  requireField(['system', 'light', 'dark'].includes(theme) && [5, 15, 30, 60].includes(minutes) &&
    (globalThreshold === null || (Number.isFinite(globalThreshold) && globalThreshold >= 0)) &&
    typeof mailSecret === 'string' && data.mail && typeof data.mail.enabled === 'boolean')
  const mail = mailConfig(data.mail)
  requireField(!mail.enabled || !(mail.provider === 'resend' || mail.account) || mailSecret.length > 0)
  const prepared = []
  for (const entry of data.entries) {
    requireField(entry && entry.site && typeof entry.token === 'string' && entry.token.trim() &&
      entry.token.length <= 8192 && !/[\r\n]/.test(entry.token))
    const site = siteConfig(entry.site)
    if (site.provider !== 'new-api') site.keyFingerprint = createHash('sha256').update(entry.token).digest('hex')
    prepared.push({ site, cipher: await monitor.crypto.encryptStringAsync(entry.token) })
  }
  const mailCipher = applyPreferences && mailSecret ? await monitor.crypto.encryptStringAsync(mailSecret) : null
  const fd = data.flashduty
  if (fd !== undefined) requireField(fd && typeof fd.enabled === 'boolean' && typeof fd.address === 'string' && (!fd.enabled || fd.address))
  const fdCipher = applyPreferences && fd?.address ? await monitor.crypto.encryptStringAsync(integrationAddress(fd.address)) : null
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
    for (const { site, cipher } of prepared) {
      const key = siteIdentity(site)
      if (known.has(key)) continue
      known.add(key)
      const id = randomUUID()
      state.sites.push({ ...site, id, icon: state.sites.length % 8, revision: 1, tried: 0, health: 'pending',
        low: false, usage: false, todayValue: null, monthValue: null, periodDay: '', history: [], historyAt: 0,
        usageNote: '', logs: [{ at: Date.now(), text: '已导入站点配置。' }] })
      monitor.putSecret(id, cipher)
      added++
    }
  })
  return { added, skipped: prepared.length - added }
}
