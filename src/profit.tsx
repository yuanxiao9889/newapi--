import { useState, type FormEvent } from 'react'
import { CalendarDays, Database, KeyRound, RefreshCw, TrendingUp } from 'lucide-react'
import { dayKey, fullTime, money, type ProfitBook, type ProfitDay } from './model'
import { api, message } from './native'
import { Surface } from './visuals'

const rmb = (value: number | null) => value == null ? '—' : money(value, 'CNY')

function totals(rows: ProfitDay[]) {
  const ready = rows.filter(r => r.profit !== null)
  const pending = rows.length - ready.length
  return {
    revenue: ready.length ? ready.reduce((sum, r) => sum + r.revenue!, 0) : null,
    cost: ready.length ? ready.reduce((sum, r) => sum + r.cost, 0) : null,
    profit: ready.length ? ready.reduce((sum, r) => sum + r.profit!, 0) : null,
    note: [ready.length + ' 天已计入', pending ? pending + ' 天待补收入' : '',
      ready.some(r => r.missing.length) ? '已跳过缺失成本' : '', ready.some(r => r.estimated) ? '含估算' : ''].filter(Boolean).join(' · '),
  }
}

function SourceForm({ book, close }: { book: ProfitBook | null; close: () => void }) {
  const [origin, setOrigin] = useState(book?.origin ?? '')
  const [userId, setUserId] = useState(book?.userId ?? '')
  const [token, setToken] = useState('')
  const [rate, setRate] = useState(book?.rate?.toString() ?? '')
  const latestStart = book?.start ?? dayKey(new Date())
  const [start, setStart] = useState(latestStart)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api.saveProfitSource({ origin, userId, token, rate: rate.trim() ? Number(rate) : null, start })
      close()
    } catch (e) { setError(message(e)) } finally { setBusy(false) }
  }
  return <Surface name={book ? '收入站设置' : '接入全站用量'} open close={() => { if (!busy) close() }}>
    <form onSubmit={submit}>
      <div className="form-body">
        <label className="field">New API 收入站地址
          <input autoFocus={!book} required readOnly={!!book} value={origin} onChange={e => setOrigin(e.target.value)} placeholder="https://api.example.com" />
        </label>
        <label className="field">管理员访问令牌
          <input type="password" autoComplete="off" autoFocus={!!book} required={!book} value={token} onChange={e => setToken(e.target.value)}
            placeholder={book ? '留空沿用已保存的令牌' : '在收入站创建访问令牌'} />
        </label>
        <p className="note">创建令牌时勾选「管理 → 日志 → 查看」，即可读取所有用户的消费汇总。</p>
        <label className="field">管理员用户 ID
          <input inputMode="numeric" pattern="[1-9][0-9]*" value={userId} onChange={e => setUserId(e.target.value)} placeholder="站点要求时填写数字 ID" />
        </label>
        <label className="field">收入折算比例（元 / 站点显示单位）
          <input type="number" step="any" min="0" value={rate} onChange={e => setRate(e.target.value)} placeholder="留空使用收入站公布的汇率" />
        </label>
        <label className="field">利润起算日期
          <input type="date" required min="1970-01-01" max={latestStart} value={start} onChange={e => setStart(e.target.value)} />
        </label>
        {start < latestStart && <p className="note">将按当前成本站点清单逐日补查。缺少成本的站点会暂时跳过，读到用量后再扣除。</p>}
        {error && <p className="feedback error" role="alert">{error}</p>}
      </div>
      <footer className="overlay-foot">
        <button type="button" className="btn secondary" disabled={busy} onClick={close}>取消</button>
        <button className="btn primary" disabled={busy}>{busy ? '正在读取全站用量…' : '验证并保存'}</button>
      </footer>
    </form>
  </Surface>
}

export function ProfitPage({ book, refresh, loading }: { book: ProfitBook | null; refresh: () => void; loading: boolean }) {
  const [editing, setEditing] = useState(false), [monthly, setMonthly] = useState(false)
  const today = dayKey(new Date()), days = book?.days ?? []
  const current = days.find(r => r.day === today)
  const months = new Map<string, ProfitDay[]>()
  for (const row of days) {
    const month = row.day.slice(0, 7)
    if (!months.has(month)) months.set(month, [])
    months.get(month)!.push(row)
  }
  const thisMonth = totals(months.get(today.slice(0, 7)) ?? []), all = totals(days)
  const dailyNote = (r: ProfitDay) => [
    r.profit == null ? '待补全站用量' : '',
    r.missing.length ? '已跳过 ' + [...new Set(r.missing)].join('、') : '',
    r.estimated ? '含估算成本' : '',
  ].filter(Boolean).join(' · ') || (r.day === today ? '截至最近查询' : '已汇总')
  const rows = monthly ? [...months].map(([day, entries]) => ({ day, ...totals(entries) })) :
    days.map(r => ({ ...r, note: dailyNote(r) }))
  return <>
    {!book ? <section className="panel first-run">
      <div className="welcome-mark"><TrendingUp size={30} /></div>
      <h2>接入你的 New API 收入站</h2>
      <p>使用管理员访问令牌读取全站消费，可选择从哪一天开始统计利润。</p>
      <button className="btn primary" onClick={() => setEditing(true)}><KeyRound size={16} />录入超管收入站</button>
    </section> : <div className="profit-page">
      <div className="profit-stats">
        {[
          { label: '今日利润', value: current?.profit ?? null, note: current ? dailyNote(current) : '等待今日用量', icon: TrendingUp },
          { label: '本月利润', value: thisMonth.profit, note: thisMonth.note, icon: CalendarDays },
          { label: '累计利润', value: all.profit, note: all.note, icon: Database },
        ].map(({ label, value, note, icon: Icon }, i) => <section className={'stat' + (i === 0 ? ' hero-stat' : '')} key={label}>
          <span className="stat-label"><Icon size={15} />{label}</span><strong>{rmb(value)}</strong><span className="stat-foot" title={note}>{note}</span>
        </section>)}
      </div>
      <section className="panel profit-source">
        <div><h2>收入站</h2><b>{book.origin}</b>
          <p className="note">从 {book.start} 开始记录 · 上次读取全站用量 {fullTime(book.checked)}</p></div>
        <div className="heading-actions">
          <button className="btn secondary" onClick={() => setEditing(true)}>收入站设置</button>
          <button className="btn secondary" disabled={loading} onClick={refresh}><RefreshCw size={14} className={loading ? 'spin' : ''} />刷新用量</button>
        </div>
        {book.error && <p className="feedback error" role="alert">{book.error} 当前保留上次成功读取的数据。</p>}
      </section>
      <section className="panel table-panel">
        <div className="table-tools"><h2>利润明细</h2><div className="heading-actions">
          {[false, true].map(m => <button className={'btn ' + (monthly === m ? 'primary' : 'secondary')} key={String(m)} aria-pressed={monthly === m} onClick={() => setMonthly(m)}>{m ? '按月' : '按日'}</button>)}
        </div></div>
        <div className="table-scroll"><table><thead><tr>
          <th>{monthly ? '月份' : '日期'}</th><th className="num">全站净消费</th><th className="num">其他站成本</th><th className="num">利润</th><th>统计状态</th>
        </tr></thead><tbody>{rows.map(r => <tr key={r.day}><td>{r.day}</td><td className="num">{rmb(r.revenue)}</td>
          <td className="num">{rmb(r.cost)}</td><td className="num balance">{rmb(r.profit)}</td><td className="profit-note">{r.note}</td></tr>)}</tbody></table></div>
      </section>
    </div>}
    {editing && <SourceForm book={book} close={() => setEditing(false)} />}
  </>
}
