import nodemailer from 'nodemailer'
import { fetchHttp } from './http.mjs'

const addressPattern = /^[^\s\x00-\x1f\x7f@,;，；<>()"\\:]+@[^\s\x00-\x1f\x7f@,;，；<>()"\\:]+\.[^\s\x00-\x1f\x7f@,;，；<>()"\\:]+$/u

export function recipients(value) {
  const unique = new Map()
  for (const token of value.split(/[,;，；]/u)) {
    const address = token.trim()
    if (!address) continue
    if (!addressPattern.test(address)) throw Error('收件邮箱格式有误：' + address)
    const key = address.toLowerCase()
    if (!unique.has(key)) unique.set(key, address)
  }
  if (!unique.size) throw Error('请至少填写一个收件邮箱。')
  return [...unique.values()]
}

export const emptyMail = {
  enabled: false,
  provider: 'smtp',
  host: '',
  port: '587',
  from: '',
  account: '',
  to: '',
  tls: 'STARTTLS',
}
export function mailConfig(input) {
  const cfg = {}
  for (const key of Object.keys(emptyMail))
    cfg[key] = key === 'enabled' ? input[key] === true : String(input[key] ?? '').trim()
  if (!['smtp', 'resend'].includes(cfg.provider)) throw Error('请选择 SMTP 或 Resend。')
  if (!cfg.enabled) return cfg
  if (!addressPattern.test(cfg.from)) throw Error('请填写一个有效的发件邮箱。')
  cfg.to = recipients(cfg.to).join(', ')
  if (
    cfg.provider === 'smtp' &&
    (!/^[a-zA-Z0-9.:[\]-]+$/.test(cfg.host) ||
      !/^\d+$/.test(cfg.port) ||
      +cfg.port < 1 ||
      +cfg.port > 65535 ||
      !['TLS', 'STARTTLS'].includes(cfg.tls))
  )
    throw Error('请检查 SMTP 主机、端口和加密方式。')
  return cfg
}
// A saved password is valid only for the same provider and SMTP identity.
export const mailIdentity = (m) =>
  JSON.stringify(m.provider === 'resend' ? ['resend'] : ['smtp', m.host.toLowerCase(), m.account])
export async function deliver(cfg, secret, message) {
  const { subject, text, id, to } = message
  if (cfg.provider === 'resend') {
    if (!secret) throw Error('请输入 Resend API Key。')
    let res
    try {
      res = await fetchHttp('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: 'Bearer ' + secret,
          'Content-Type': 'application/json',
          'Idempotency-Key': id,
        },
        body: JSON.stringify({ from: cfg.from, to: [to], subject, text }),
      })
    } catch {
      throw Error('连接 Resend 超时或失败。')
    }
    if (!res.ok) throw Error('Resend 未接受邮件（HTTP ' + res.status + '）。')
    return
  }
  const smtp = nodemailer.createTransport({
    host: cfg.host,
    port: +cfg.port,
    secure: cfg.tls === 'TLS',
    requireTLS: cfg.tls === 'STARTTLS',
    auth: cfg.account ? { user: cfg.account, pass: secret } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  try {
    const info = await smtp.sendMail({
      from: cfg.from,
      to,
      subject,
      text,
      messageId: '<' + id + '@quotadesk.local>',
    })
    if (!info.accepted?.length) throw Error('Rejected')
  } catch (error) {
    const uncertain =
      ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(error.code) &&
      ['DATA', 'CONN'].includes(error.command) &&
      error.code !== 'ECONNECTION'
    const reason =
      error.code === 'EAUTH'
        ? 'SMTP 认证失败，请检查账号和授权码。'
        : uncertain
          ? 'SMTP 连接中断，投递结果待确认。'
          : 'SMTP 未确认接收，请检查服务器、证书、发件人及收件人。'
    const clean = Error(reason)
    clean.uncertain = uncertain
    throw clean
  } finally {
    smtp.close()
  }
}
