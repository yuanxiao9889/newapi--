import { randomUUID } from 'node:crypto'
import { recipients } from './mail.mjs'

export function updateDelivery(notice) {
  const selected = notice.recipients.filter((r) => r.selected)
  const states = new Set(selected.map((r) => r.delivery))
  notice.delivery = ['sending', 'pending', 'uncertain', 'failed', 'cancelled', 'sent']
    .find((status) => states.has(status)) ?? 'off'
  notice.error = selected.find((r) => r.delivery === notice.delivery)?.error || ''
}

export function setRecipients(notice, config, retryUncertain = false) {
  notice.destination = config.to
  notice.recipients ??= []
  const byAddress = new Map(notice.recipients.map((r) => [r.address.toLowerCase(), r]))
  for (const r of notice.recipients) r.selected = false
  for (const address of config.enabled ? recipients(config.to) : []) {
    let r = byAddress.get(address.toLowerCase())
    if (!r) {
      r = { id: randomUUID(), address, delivery: 'pending', attempts: 0, retryAt: 0 }
      notice.recipients.push(r)
    }
    r.selected = true
    if (r.delivery === 'failed' || (retryUncertain && r.delivery === 'uncertain')) {
      Object.assign(r, { delivery: 'pending', attempts: 0, retryAt: 0, error: '' })
    }
  }
  updateDelivery(notice)
}

export function needsDeliveryRecovery(n) {
  if (n.recipients) return n.recipients.some((r) => r.delivery === 'sending')
  return n.delivery === 'sending' || (!n.closed && ['sent', 'pending', 'failed', 'uncertain'].includes(n.delivery))
}

export function recoverDelivery(n) {
  // A pre-upgrade alert used its notice ID as the provider's idempotency key.
  n.recipients ??= [{
    id: n.id, address: n.destination, selected: true, delivery: n.delivery,
    attempts: n.attempts, retryAt: n.retryAt, error: n.error,
  }]
  for (const r of n.recipients) {
    if (r.delivery === 'sending') {
      r.delivery = 'uncertain'
      r.error = '上次退出时正在投递，请核对邮箱后再决定是否重发。'
    }
  }
  updateDelivery(n)
}

export function nextRecipient(notice, now) {
  return notice.recipients?.find((r) => r.selected && (
    r.delivery === 'pending' || (r.delivery === 'failed' && r.attempts < 4 && r.retryAt <= now)
  ))
}
