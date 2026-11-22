import { useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  KeyRound,
  LoaderCircle,
  Mail as MailIcon,
  Send,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@base-ui/react/button'
import { Surface } from './visuals'
import { api, message, type Probe } from './native'
import {
  balanceLabels,
  deliveryLabel,
  fullTime,
  money,
  unitName,
  walletKeyHint,
  type Mail,
  type Site,
  type Notice,
  type Provider,
} from './model'

export function AddSite({
  close,
  saved,
  existing,
  globalThreshold,
}: {
  close: () => void
  saved: (id: string, unit: string) => void
  existing?: Site
  globalThreshold: number | null
}) {
  const [url, setUrl] = useState(existing?.origin || ''),
    [token, setToken] = useState(''),
    [name, setName] = useState(existing?.name || '')
  const [userId, setUserId] = useState(existing?.userId || ''),
    [threshold, setLimit] = useState(String(existing?.threshold ?? 20))
  const [probe, setProbe] = useState<Probe | null>(null),
    [busy, setBusy] = useState(false),
    [err, setErr] = useState(''),
    [guide, setGuide] = useState(false)
  const [autoUsd, setAutoUsd] = useState(existing?.autoUsd ?? false)
  const [provider, setProvider] = useState<Provider>(existing?.provider ?? 'new-api')
  const [walletGroup, setWalletGroup] = useState(existing?.walletGroup ?? '')
  const isSub = provider === 'sub2api'
  const [fallbackRate, setFallbackRate] = useState(String(existing?.fallbackRate ?? ''))
  const rate = probe?.usdRate ?? Number(fallbackRate)
  const usdBalance = probe?.accountBalance != null && probe.usdPerUnit != null ? probe.accountBalance * probe.usdPerUnit : null
  const canConvert = probe?.usdPerUnit != null && rate > 0 && Number.isFinite((usdBalance ?? 1) * rate)
  const displayUnit = autoUsd || isSub ? 'CNY' : existing?.billing?.unit ?? 'CNY'
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setErr('')
    setBusy(true)
    try {
      if (!probe) {
        setProbe(await api.probe({ origin: url, token, userId, provider, id: existing?.id, walletGroup }))
        return
      }
      const value = globalThreshold ?? Number(threshold)
      if (autoUsd && !canConvert) throw Error('请检查美元金额和换算汇率。')
      if (globalThreshold == null && (!threshold.trim() || !Number.isFinite(value) || value < 0))
        throw Error('请输入有效的非负阈值。')
      const id = await api.saveSite({
        id: existing?.id,
        ticket: probe.ticket,
        name,
        threshold: value,
        walletGroup,
        autoUsd,
        fallbackRate: autoUsd && fallbackRate ? Number(fallbackRate) : null,
      })
      setToken('')
      saved(id, displayUnit)
    } catch (e) {
      setErr(message(e))
      if (message(e).includes('过期')) setProbe(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Surface name={existing ? '更换访问令牌' : '添加监控站点'} open close={close}>
      <form className="desktop-site-form" onSubmit={submit}>
        <div className="form-body">
          <fieldset disabled={busy}>
            {!existing && <label className="field">站点类型
              <select value={provider} onChange={(e) => {
                setProvider(e.target.value as Provider)
                setProbe(null)
                setErr('')
              }}>
                <option value="new-api">New API</option>
                <option value="sub2api">SUB2API</option>
              </select>
            </label>}
            <label className="field">
              站点网址
              <input
                autoFocus
                placeholder="https://api.example.com"
                required
                value={url}
                readOnly={!!existing}
                onChange={(e) => {
                  setUrl(e.target.value)
                  setProbe(null)
                }}
              />
            </label>
            {/^http:\/\//i.test(url) && (
              <p className="note">该地址使用 HTTP，访问令牌将通过未加密连接传输。</p>
            )}
            <label className="field">
              {isSub ? 'API Key' : '个人访问令牌'}
              <input
                type="password"
                autoComplete="off"
                required
                value={token}
                placeholder={isSub ? '粘贴 SUB2API 的 Key' : '粘贴 New API 个人访问令牌'}
                onChange={(e) => {
                  setToken(e.target.value)
                  setProbe(null)
                }}
              />
            </label>
            {!isSub && <button
              type="button"
              className="text-action"
              aria-expanded={guide}
              onClick={() => setGuide(!guide)}
            >
              <KeyRound size={13} />
              令牌在哪里创建？
              <ChevronDown size={12} />
            </button>}
            {!isSub && guide && (
              <p className="note">
                在 New API 个人设置中创建访问令牌。「个人资料 → 查看」用于读取余额，「用量 →
                查看」用于读取消费。旧版站点可能还要求控制台中的数字用户 ID。
              </p>
            )}
            <div className="field-pair">
              <label className="field">
                站点备注
                <input
                  value={name}
                  placeholder="默认使用站点域名"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {!isSub && <label className="field">
                用户 ID（旧版站点选填）
                <input
                  inputMode="numeric"
                  value={userId}
                  placeholder="例如 123"
                  onChange={(e) => {
                    setUserId(e.target.value)
                    setProbe(null)
                  }}
                />
              </label>}
              {isSub && <label className="field">账户分组（选填）
                <input value={walletGroup} maxLength={80} placeholder="默认账户" onChange={(e) => {
                  setWalletGroup(e.target.value)
                  setProbe(null)
                }} />
              </label>}
            </div>
            {isSub && <p className="note">每个账户添加一把能查钱包余额的 Key 即可。同一站点有多个账户时，请分别命名分组。</p>}
            <label className="toggle threshold-toggle">
              <input type="checkbox" role="switch" checked={autoUsd} onChange={(e) => setAutoUsd(e.target.checked)} />
              <i /> 美元计费，自动折算人民币
            </label>
            {autoUsd && (
              !probe ? <p className="note">测试连接后读取站点汇率，余额、消费和预警均按人民币计算。</p>
              : probe.usdPerUnit == null ? <p className="feedback error">站点缺少美元额度换算参数。</p>
              : probe.usdRate ? <p className="note">站点汇率：1 美元 = {probe.usdRate} 元，每次查询时更新。</p>
              : <label className="field">站点未提供汇率，请填写 1 美元对应的人民币金额
                  <input type="number" min="0" step="any" required value={fallbackRate}
                    onChange={(e) => setFallbackRate(e.target.value)} />
                </label>
            )}
            {(!probe?.balanceKind || probe.balanceKind === 'wallet') && <label className="field">
              {globalThreshold != null ? '统一预警金额' : '低余额阈值'} · {unitName(displayUnit)}
              <input
                type="number"
                min="0"
                step="any"
                required
                readOnly={globalThreshold != null}
                value={globalThreshold ?? threshold}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>}
          </fieldset>
          {err && (
            <div className="feedback error" role="alert">
              <AlertCircle size={16} />
              {err}
            </div>
          )}
          {probe && (
            <div className="feedback good" role="status">
              <CheckCircle2 size={17} />
              <span>
                {isSub ? '账户钱包余额' : '账户 #' + probe.accountId + ' · 当前余额'} {probe.accountBalance == null
                  ? '暂不可查' : autoUsd
                  ? canConvert ? money(usdBalance! * rate, 'CNY') + '（' + money(usdBalance!, 'USD') + '）' : '待折算'
                  : money(probe.accountBalance, displayUnit)}
                {probe.sharedWalletAt != null && <>（同组钱包于 {fullTime(probe.sharedWalletAt)} 查询）</>}
                {probe.balanceKind && probe.balanceKind !== 'wallet' && <><br />
                  {balanceLabels[probe.balanceKind]} · {probe.balance == null ? (probe.unlimited ? '不限额' : '见 Key 明细')
                    : autoUsd && !canConvert ? '待折算' : money(probe.balance * (autoUsd ? rate : 1), displayUnit)}
                </>}
                {isSub && probe.accountBalance == null && <><br />{walletKeyHint}</>}
                <br />
                {probe.usage ? '已读取消费统计' : '暂无消费统计'}
                {probe.usageNote ? ' · ' + probe.usageNote : ''}
              </span>
            </div>
          )}
        </div>
        <footer className="overlay-foot">
          <Button type="button" className="btn secondary" onClick={close}>
            取消
          </Button>
          <Button type="submit" className="btn primary" disabled={busy || (!!probe && autoUsd && !canConvert)}>
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : probe ? (
              <Check size={15} />
            ) : (
              <ShieldCheck size={15} />
            )}
            {busy ? '处理中…' : probe ? '保存站点' : '测试连接'}
          </Button>
        </footer>
      </form>
    </Surface>
  )
}
export function ThresholdSettings({ current, close, saved }: {
  current: number | null
  close: () => void
  saved: () => void
}) {
  const [enabled, setEnabled] = useState(current != null)
  const [amount, setAmount] = useState(String(current ?? 30))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    const value = Number(amount)
    if (enabled && (!amount.trim() || !Number.isFinite(value) || value < 0)) {
      setError('请输入大于或等于 0 的金额。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.preferences({ globalThreshold: enabled ? value : null })
      saved()
    } catch (err) {
      setError(message(err))
      setBusy(false)
    }
  }
  return (
    <Surface name="统一预警金额" open close={close}>
      <form onSubmit={submit}>
        <div className="form-body">
          <label className="toggle threshold-toggle">
            <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} />
            <i /> 所有站点使用统一预警金额
          </label>
          {enabled ? (
            <>
              <label className="field">
                余额低于此金额时提醒
                <input type="number" step="any" min="0" required value={amount} disabled={busy}
                  onChange={(e) => { setAmount(e.target.value); setError('') }} />
              </label>
              <p className="note">现有和新增站点均按各自单位比较。例如填 30，美元站点按 30 美元，积分站点按 30 积分。填 0 可关闭全部低余额提醒。</p>
            </>
          ) : <p className="note">各站点使用自己的预警金额，可在站点详情中单独修改。</p>}
          {error && <p className="feedback error" role="alert">{error}</p>}
        </div>
        <footer className="overlay-foot">
          <button className="btn secondary" type="button" disabled={busy} onClick={close}>取消</button>
          <button className="btn primary" disabled={busy} type="submit">{busy ? '保存中…' : '保存设置'}</button>
        </footer>
      </form>
    </Surface>
  )
}

export function MessagePreview({ notice, close }: { notice: Notice; close: () => void }) {
  const deliveries = notice.recipients?.filter((r) => r.selected || ['sent', 'sending', 'uncertain'].includes(r.delivery))
  return (
    <Surface name="告警邮件详情" open close={close}>
      <div className="form-body">
        <div className="mail-meta">
          <span>收件人</span>
          {deliveries?.length ? (
            <div className="mail-recipients">
              {deliveries.map((r) => (
                <div key={r.id}><b>{r.address}</b><small>{deliveryLabel[r.delivery]}{r.error && ' · ' + r.error}</small></div>
              ))}
            </div>
          ) : <b>{notice.destination || '尚未填写'}</b>}
          <span>主题</span>
          <b>{notice.site} · 钱包余额提醒</b>
        </div>
        <article className="email">
          <div className="mail-brand">
            <MailIcon size={17} />
            QuotaDesk
          </div>
          <h2>站点余额低于提醒阈值</h2>
          <p>
            {notice.site} 在 {fullTime(notice.at)} 触发了余额提醒。
          </p>
          <div className="email-amount">{money(notice.balance, notice.unit)}</div>
          <p>提醒阈值为 {money(notice.threshold, notice.unit)}。</p>
        </article>
        <div className="note">
          {deliveryLabel[notice.delivery]}
          {!deliveries?.length && notice.error ? ' · ' + notice.error : ''}
        </div>
      </div>
      <footer className="overlay-foot">
        <button className="btn primary" onClick={close}>
          完成
        </button>
      </footer>
    </Surface>
  )
}
export function MailSettings({ mail, inform }: { mail: Mail; inform: (s: string) => void }) {
  const [form, setForm] = useState<Mail>({ ...mail }),
    [err, setErr] = useState(''),
    [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState('')
  function field<K extends keyof Mail>(k: K, v: Mail[K]) {
    setForm({ ...form, [k]: v })
    setErr('')
  }
  function validate() {
    if (
      form.provider === 'smtp' &&
      (!form.host.trim() ||
        !Number.isInteger(Number(form.port)) ||
        +form.port <= 0 ||
        +form.port > 65535)
    ) {
      setErr('请检查 SMTP 主机和端口。')
      return false
    }
    return true
  }
  async function submit(test: boolean) {
    if (busy || ((test || form.enabled) && !validate())) return
    setBusy(true)
    setErr('')
    try {
      if (test) {
        const count = await api.testMail({ config: form, secret })
        inform(`发件服务已接收全部 ${count} 封测试邮件`)
      } else {
        await api.saveMail({ config: form, secret })
        setSecret('')
        inform('通知设置已保存')
      }
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel settings-card">
      <div className="panel-heading">
        <h2>
          <MailIcon size={18} /> 邮件通知
        </h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => field('enabled', e.target.checked)}
          />
          <i />
          {form.enabled ? '已启用' : '已关闭'}
        </label>
      </div>
      <div className="settings-content">
        <label className="field">发件服务</label>
        <div className="provider-picker">
          {(['smtp', 'resend'] as const).map((v) => (
            <button
              className={form.provider === v ? 'active' : ''}
              key={v}
              onClick={() => {
                field('provider', v)
                setSecret('')
              }}
            >
              {v === 'smtp' ? 'SMTP' : 'Resend'}
              {form.provider === v && <Check size={14} />}
            </button>
          ))}
        </div>
        {form.provider === 'smtp' && (
          <>
            <div className="field-pair">
              <label className="field">
                SMTP 主机
                <input value={form.host} onChange={(e) => field('host', e.target.value)} />
              </label>
              <label className="field">
                端口
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => field('port', e.target.value)}
                />
              </label>
            </div>
            <div className="field-pair">
              <label className="field">
                加密方式
                <select
                  value={form.tls}
                  onChange={(e) => field('tls', e.target.value as Mail['tls'])}
                >
                  <option>STARTTLS</option>
                  <option>TLS</option>
                </select>
              </label>
              <label className="field">
                发件账号
                <input value={form.account} onChange={(e) => field('account', e.target.value)} />
              </label>
            </div>
          </>
        )}
        <label className="field">
          {form.provider === 'smtp' ? 'SMTP 授权码' : 'Resend API Key'}
          <input
            type="password"
            value={secret}
            autoComplete="off"
            placeholder="输入新凭据，留空沿用同一服务已保存的凭据"
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <label className="field">
          发件邮箱
          <input type="email" value={form.from} onChange={(e) => field('from', e.target.value)} />
        </label>
        <label className="field">
          收件邮箱
          <input type="text" inputMode="email" spellCheck={false} aria-describedby="recipients-help"
            placeholder="me@example.com, team@example.com" value={form.to}
            onChange={(e) => field('to', e.target.value)} />
          <small id="recipients-help">多个地址用逗号或分号隔开，支持中文标点。每个邮箱会单独收到一封邮件。</small>
        </label>
        {err && (
          <p className="feedback error" role="alert">
            {err}
          </p>
        )}
        <div className="form-buttons">
          <button disabled={busy} className="btn secondary" onClick={() => submit(true)}>
            <Send size={14} />
            发送测试邮件
          </button>
          <button disabled={busy} className="btn primary" onClick={() => submit(false)}>
            {busy ? '处理中…' : '保存设置'}
          </button>
        </div>
      </div>
    </section>
  )
}
