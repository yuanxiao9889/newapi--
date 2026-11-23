import { api, message } from './native'
import { useState } from 'react'
import {
  Bell,
  Check,
  Clock3,
  KeyRound,
  Pause,
  Play,
  RefreshCw,
  Settings2,
  Wallet,
} from 'lucide-react'
import { balanceLabels, balanceText, customBalanceLabel, estimateLabel, fullTime, money, deliveryLabel, periodAvailable, series, unitName, unitSymbol, walletKeyHint, type Notice, type Site, type UsageRow } from './model'
import { SiteMark, Status, Surface, Trend } from './visuals'

function KeyCosts({ site }: { site: Site }) {
  const data = site.keyUsage
  const [tab, setTab] = useState<'daily' | 'models'>('daily')
  if (!data) return null
  const rows = tab === 'daily' ? [...(data.daily ?? [])].reverse() : data.models
  const rate = site.autoUsd ? site.usdRate ?? site.fallbackRate : 1
  const fee = (n: number | null) => n == null || rate == null ? '—' : money(n * rate, site.unit)
  const count = (n: number | null) => n?.toLocaleString('zh-CN') ?? '—'
  const cells = (row: UsageRow) => <>
    <td>{fee(row.actual)}</td><td>{fee(row.cost)}</td><td>{count(row.requests)}</td>
    <td>{count(row.input)} / {count(row.output)}</td><td>{count(row.cacheRead)} / {count(row.cacheWrite)}</td>
  </>
  return <section className="key-costs">
    <h3 className="log-heading">Key 费用明细 · 人民币</h3>
    {data.total && <p>累计实扣 <b>{fee(data.total.actual)}</b> · {count(data.total.requests)} 次请求</p>}
    <div className="segmented">
      <button className={tab === 'daily' ? 'selected' : ''} aria-pressed={tab === 'daily'} onClick={() => setTab('daily')}>近 31 天</button>
      <button className={tab === 'models' ? 'selected' : ''} aria-pressed={tab === 'models'} onClick={() => setTab('models')}>{data.month} 按模型</button>
    </div>
    {rows.length ? <div className="table-scroll">
      <table><thead><tr><th>{tab === 'daily' ? '日期' : '模型'}</th><th>实扣</th><th>标准费用</th><th>请求数</th>
        <th>输入 / 输出 Token</th><th>缓存读 / 写 Token</th>
      </tr></thead><tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td>{cells(r)}</tr>)}</tbody></table>
    </div> : <p className="note">{tab === 'daily' ? '暂无每日明细' : '暂无本月模型明细'}</p>}
    {data.limits.length > 0 && <div className="log-list">{data.limits.map((l) =>
      <div key={l.label}><span>{l.label}已用 / 上限</span><b>{fee(l.used)} / {fee(l.limit)}</b></div>)}</div>}
  </section>
}

export function Detail({
  site,
  editGlobalThreshold,
  notices,
  preview,
  close,
  replace,
  inform,
}: {
  site: Site
  editGlobalThreshold?: () => void
  notices: Notice[]
  preview: (n: Notice) => void
  close: () => void
  replace: () => void
  inform: (s: string) => void
}) {
  const [span, setSpan] = useState<7 | 30>(7),
    [limit, setLimit] = useState(String(site.threshold)),
    [editing, setEditing] = useState(false),
    [err, setErr] = useState('')
  const [billingOpen, setBillingOpen] = useState(false)
  const [billingUnit, setBillingUnit] = useState(site.unit)
  const [rate, setRate] = useState(String(site.billing?.rmbRate ?? ''))
  const [conversionDraft, setConversionDraft] = useState<boolean | null>(null)
  const [fallback, setFallback] = useState(String(site.fallbackRate ?? ''))
  const [group, setGroup] = useState<string | null>(null)
  const isSub = site.provider === 'sub2api'
  const isCustom = site.provider === 'custom'
  const autoUsd = conversionDraft ?? !!site.autoUsd
  const unitChoices = [...new Set(['CNY', 'USD', site.sourceUnit ?? site.unit, site.unit])]
  const [busy, setBusy] = useState(false),
    [removing, setRemoving] = useState(false)
  async function action(work: () => Promise<unknown>, done: string) {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      await work()
      inform(done)
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }
  function save() {
    const value = Number(limit)
    if (!limit.trim() || !Number.isFinite(value) || value < 0) {
      setErr('请输入有效的非负阈值')
      return
    }
    void action(async () => {
      await api.updateSite({ id: site.id, threshold: value })
      setEditing(false)
    }, '提醒阈值已保存')
  }
  return (
    <Surface name="站点详情" open close={close} drawer>
      <div className="drawer-content">
        <div className="detail-id">
          <SiteMark site={site} />
          <div>
            <h2>{site.name}</h2>
            <p>{site.origin}</p>
          </div>
          <Status site={site} />
        </div>
        <div className="detail-balance">
          <div className="stat-label">
            <Wallet size={16} />
            {isCustom ? customBalanceLabel(site.balanceScope) : '账户钱包余额'}
          </div>
          <strong>{site.accountBalance == null ? '暂不可查' : money(site.accountBalance, site.unit)}</strong>
          {site.walletChecked != null
            ? <p>{site.walletSourceId === site.id ? '钱包上次更新' : '同组钱包上次更新'} · {fullTime(site.walletChecked)}</p>
            : <p>{walletKeyHint}</p>}
          {site.balanceKind && site.balanceKind !== 'wallet' &&
            <p>{balanceLabels[site.balanceKind]} · {balanceText(site)}</p>}
        </div>
        {isSub && <div className="billing-editor">
          <div className="detail-rule"><div><small>共享钱包分组</small><b>{site.walletGroup || '默认账户'}</b></div>
            <button className="btn secondary" onClick={() => setGroup(group === null ? site.walletGroup || '' : null)}>修改分组</button>
          </div>
          {group !== null && <form onSubmit={(e) => {
            e.preventDefault()
            void action(async () => { await api.updateSite({ id: site.id, walletGroup: group }); setGroup(null) }, '钱包分组已保存')
          }}>
            <label className="field">同站点属于同一账户的 Key 填相同分组
              <input value={group} maxLength={80} placeholder="默认账户" onChange={(e) => setGroup(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy}>保存分组</button>
          </form>}
        </div>}
        {(!isSub || site.balanceKind === 'wallet') && <div className="detail-rule">
          <div>
            <small>{editGlobalThreshold ? '统一预警金额' : '低余额提醒阈值'}</small>
            <b>{site.threshold > 0 ? money(site.threshold, site.unit) : '未启用'}</b>
          </div>
          <button
            className="btn secondary"
            onClick={editGlobalThreshold ?? (() => {
              setLimit(String(site.threshold))
              setErr('')
              setEditing(!editing)
            })}
          >
            <Settings2 size={14} />
            {editGlobalThreshold ? '统一设置' : '修改阈值'}
          </button>
        </div>}
        {editing && !editGlobalThreshold && (!isSub || site.balanceKind === 'wallet') && (
          <div className="inline-edit">
            <label className="field">
              新的阈值
              <input
                type="number"
                step="any"
                min="0"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>
            <button className="btn primary" onClick={save}>
              <Check size={14} />
              保存阈值
            </button>
          </div>
        )}
        <div className="detail-rule">
          <div>
            <small>站点计价单位</small>
            <b>{site.autoUsd ? '美元自动折算人民币' : site.billing ? unitName(site.unit) : '人民币（默认）'}</b>
            {site.autoUsd && <small>1 美元 = {site.usdRate ?? site.fallbackRate} 元</small>}
            {site.billing && <small>1 {unitSymbol(site.unit)} = {site.billing.rmbRate} 元</small>}
          </div>
          {!isSub && !isCustom && !site.autoUsd && conversionDraft === null && <button className="btn secondary" aria-expanded={billingOpen} onClick={() => {
            setBillingUnit(site.unit)
            setRate(String(site.billing?.rmbRate ?? ''))
            setErr('')
            setBillingOpen(!billingOpen)
          }}>设置单位</button>}
        </div>
        {!isCustom && <form className="billing-editor" onSubmit={(e) => {
          e.preventDefault()
          void action(async () => {
            await api.setAutoUsd({ id: site.id, enabled: autoUsd,
              fallbackRate: autoUsd && fallback.trim() ? Number(fallback) : null })
            setConversionDraft(null)
          }, '换算设置已保存，总余额已更新')
        }}>
          <label className="toggle threshold-toggle">
            <input type="checkbox" role="switch" checked={autoUsd} disabled={busy} onChange={(e) => {
              setConversionDraft(e.target.checked === !!site.autoUsd ? null : e.target.checked)
              setFallback(String(site.fallbackRate ?? ''))
              setBillingOpen(false)
              setErr('')
            }} />
            <i /> 美元计费，自动折算人民币
          </label>
          {conversionDraft !== null && <>
            {autoUsd && (site.usdRate
              ? <p className="note">站点汇率：1 美元 = {site.usdRate} 元。</p>
              : <label className="field">备用汇率（1 美元对应的人民币金额）
                  <input type="number" min="0" step="any" value={fallback} disabled={busy}
                    placeholder="站点未提供汇率时使用" onChange={(e) => setFallback(e.target.value)} />
                </label>)}
            {!autoUsd && <p className="note">保存后，余额和消费按站点原数值计为人民币。</p>}
            <button className="btn primary" disabled={busy || (autoUsd && !!fallback && !(Number(fallback) > 0))}>
              保存换算设置
            </button>
          </>}
        </form>}
        {billingOpen && (
          <form className="billing-editor" onSubmit={(e) => {
            e.preventDefault()
            void action(async () => {
              await api.updateSite({ id: site.id, billing: billingUnit === 'CNY' ? null :
                { unit: billingUnit, rmbRate: Number(rate) } })
              setBillingOpen(false)
            }, '计价单位已保存，总余额已更新')
          }}>
            <label className="field">金额显示单位
              <select value={billingUnit} onChange={(e) => {
                setBillingUnit(e.target.value)
                setRate(e.target.value === site.billing?.unit ? String(site.billing.rmbRate) : '')
              }}>
                {unitChoices.map((key) => <option key={key} value={key}>
                  {key === 'CNY' ? '人民币（默认，按原数值计入）' : unitName(key)}
                </option>)}
              </select>
            </label>
            {billingUnit !== 'CNY' && <label className="field">
              1 {unitSymbol(billingUnit)} 计入总余额的人民币金额
              <input type="number" step="any" min="0" required value={rate}
                onChange={(e) => setRate(e.target.value)} />
            </label>}
            <button className="btn primary" disabled={busy || (billingUnit !== 'CNY' && !(Number(rate) > 0))}>
              保存计价设置
            </button>
          </form>
        )}
        <section className="detail-chart">
          <div className="panel-heading">
            <h2>消费趋势</h2>
            <div className="segmented">
              {([7, 30] as const).map((n) => (
                <button
                  key={n}
                  className={span === n ? 'selected' : ''}
                  aria-pressed={span === n}
                  onClick={() => setSpan(n)}
                >
                  近 {n} 天
                </button>
              ))}
            </div>
          </div>
          <Trend data={series([site], span)} unit={site.unit} />
          {periodAvailable(site, 'today') ? <p className="note">今日消费 {money(site.todayValue!, site.unit)} · {estimateLabel(site) || '平台统计'}</p>
            : isCustom && <p className="note">等待可比较的余额记录后估算今日消费。</p>}
          {site.usageNote && <p className="note">{site.usageNote}</p>}
        </section>
        {isSub && <KeyCosts site={site} />}
        <div className="detail-actions">
          <button
            className="btn secondary"
            disabled={site.paused || busy}
            onClick={() =>
              action(() => api.refresh({ id: site.id }), '本次查询已结束，结果见查询记录')
            }
          >
            <RefreshCw size={14} />
            刷新
          </button>
          <button className="btn secondary" onClick={replace}>
            <KeyRound size={14} />
            {isCustom ? '编辑余额接口' : '更换令牌'}
          </button>
          <button
            className="btn secondary"
            disabled={busy}
            onClick={() =>
              action(
                () => api.updateSite({ id: site.id, paused: !site.paused }),
                site.paused ? '已恢复监控' : '已暂停监控',
              )
            }
          >
            {site.paused ? <Play size={14} /> : <Pause size={14} />}{' '}
            {site.paused ? '恢复监控' : '暂停监控'}
          </button>
        </div>
        {err && (
          <p className="feedback error" role="alert">
            {err}
          </p>
        )}
        <div className="form-buttons">
          {removing ? (
            <>
              <span>从本机移除站点、令牌及提醒记录？</span>
              <button className="btn secondary" onClick={() => setRemoving(false)}>
                取消
              </button>
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await api.updateSite({ id: site.id, remove: true })
                    close()
                  }, '站点已移除')
                }
              >
                确认移除
              </button>
            </>
          ) : (
            <button className="text-action" onClick={() => setRemoving(true)}>
              移除站点
            </button>
          )}
        </div>
        <h3 className="log-heading">查询记录</h3>
        <div className="log-list">
          {site.logs.slice(0, 6).map((l, i) => (
            <div key={l.at + '-' + i}>
              <Clock3 size={13} />
              <span>{l.text}</span>
              <time>{fullTime(l.at)}</time>
            </div>
          ))}
        </div>
        <h3 className="log-heading">余额提醒</h3>
        <div className="log-list">
          {notices.length ? (
            notices.map((n) => (
              <div key={n.id}>
                <Bell size={13} />
                <span>
                  {n.closed ? '已恢复' : '低余额'} · {money(n.balance, n.unit)}
                </span>
                <time>{fullTime(n.at)}</time>
                {n.flashduty && <small title={n.flashduty.error}>Flashduty · {deliveryLabel[n.flashduty.status]}</small>}
                {n.delivery !== 'off' && (
                  <button className="log-link" onClick={() => preview(n)}>
                    {deliveryLabel[n.delivery]}
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="note">该站点还没有触发过提醒。</p>
          )}
        </div>
      </div>
    </Surface>
  )
}
