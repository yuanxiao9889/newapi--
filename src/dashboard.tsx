import { useState } from 'react'
import {
  Activity,
  ArrowDown,
  ArrowDownUp,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Filter,
  ExternalLink,
  Globe2,
  Layers3,
  Search,
  TriangleAlert,
  Wallet,
  X,
} from 'lucide-react'
import type { Site, Unit, Wallet as WalletAmount } from './model'
import {
  fullTime,
  money,
  periodAvailable,
  series,
  stateLabel,
  sumPeriod,
  unitSymbol,
  unitName,
  time,
} from './model'
import { Mesh, SiteMark, Status, Trend } from './visuals'

export type FilterKey = 'all' | 'low' | 'issue' | 'paused'
const hasBalanceAlert = (site: Site) => stateLabel(site)[0] === 'low'

export function Overview({
  sites,
  wallets,
  unreadWalletCount,
  unit,
  onLow,
  onDetail,
}: {
  sites: Site[]
  wallets: WalletAmount[]
  unreadWalletCount: number
  unit: Unit
  onLow: () => void
  onDetail: (s: Site) => void
}) {
  const [span, setSpan] = useState<7 | 30>(7)
  const totalRmb = wallets.reduce((sum, w) => sum + w.rmb, 0)
  const unitWallets = wallets.filter((w) => w.unit === unit)
  const unitSites = sites.filter((s) => s.unit === unit)
  const current = unitSites.filter((s) => periodAvailable(s, 'today')),
    monthly = unitSites.filter((s) => periodAvailable(s, 'month'))
  const today = current.reduce((a, s) => a + sumPeriod(s, 'today'), 0)
  const month = monthly.reduce((a, s) => a + sumPeriod(s, 'month'), 0)
  const two = series(current, 2),
    past = two[0].value
  const delta = past ? ((today - past) / past) * 100 : null
  const warn = sites.filter(hasBalanceAlert).length
  const sorted = [...monthly]
    .sort((a, b) => sumPeriod(b, 'month') - sumPeriod(a, 'month'))
    .slice(0, 4)
  const curr = (v: number) => money(v, unit)
  const symbolAmount = (v: number) => (
    <>
      {<small>{unitSymbol(unit)}</small>}
      {v.toLocaleString('en-US', {
        minimumFractionDigits: unit.startsWith('积分@') ? 0 : 2,
        maximumFractionDigits: unit.startsWith('积分@') ? 0 : 2,
      })}
    </>
  )
  return (
    <>
      <div className="stats-grid">
        <section className="stat hero-stat">
          <Mesh />
          <div className="stat-label">
            <Wallet size={17} />
            {unreadWalletCount > 0 && wallets.length > 0 ? '已查到账户的钱包合计' : '账户钱包总余额'}
          </div>
          <strong>
            {wallets.length ? money(totalRmb, 'CNY') : '—'}
          </strong>
          <div className="stat-foot">
            <Layers3 size={12} />
            {wallets.length} 个钱包{wallets.length ? ' · 人民币合计' : ' · 暂无账户余额'}
          </div>
          {unitWallets.length > 0 && unitWallets.length < wallets.length && (
            <div className="stat-foot">
              当前单位小计 {curr(unitWallets.reduce((sum, w) => sum + w.value, 0))}
            </div>
          )}
          {unreadWalletCount > 0 && <div className="stat-foot">{unreadWalletCount} 个账户暂未取得钱包余额</div>}
        </section>
        <section className="stat">
          <div className="stat-label">
            <span className="metric-icon violet">
              <Activity size={16} />
            </span>
            今日消费
          </div>
          <strong>{current.length ? symbolAmount(today) : '—'}</strong>
          <div className="stat-foot">
            {delta !== null && (
              <span className={'delta ' + (delta > 0 ? 'up' : 'down')}>
                {delta > 0 ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
                {Math.abs(delta).toFixed(1)}%
              </span>
            )}
            {delta !== null ? '较昨日' : current.length + ' 个站点提供统计'}
          </div>
        </section>
        <section className="stat">
          <div className="stat-label">
            <span className="metric-icon blue">
              <CalendarDays size={15} />
            </span>
            本月消费
          </div>
          <strong>{monthly.length ? symbolAmount(month) : '—'}</strong>
          <div className="stat-foot">
            <span className="tiny-dot blue-dot" />
            {monthly.length} / {unitSites.length} 个站点提供统计
          </div>
        </section>
        <button className="stat warning-stat" onClick={onLow}>
          <div className="stat-label">
            <span className="metric-icon amber">
              <TriangleAlert size={15} />
            </span>
            低余额站点
          </div>
          <strong>
            {warn}
            <em> 个</em>
          </strong>
          <div className="stat-foot">
            <span className={'tiny-dot ' + (warn ? 'amber-dot' : '')} />
            {warn ? '查看需关注的站点' : '查看阈值筛选'}
            <ArrowRight size={13} />
          </div>
        </button>
      </div>
      <div className="analysis-grid">
        <section className="panel trend-panel">
          <div className="panel-heading">
            <div>
              <h2>消费趋势</h2>
              <p>
                <i className="legend-line" />
                每日消费 <span className="sub-sep">/</span> {unitName(unit)}
              </p>
            </div>
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
          <Trend data={series(unitSites, span)} unit={unit} />
        </section>
        <section className="panel rank-panel">
          <div className="panel-heading">
            <h2>站点消费排行</h2>
            <span className="period-label">本月 · {unitSymbol(unit)}</span>
          </div>
          <div className="rank-list">
            {sorted.length ? (
              sorted.map((s, i) => (
                <button key={s.id} className="rank-row" onClick={() => onDetail(s)}>
                  <span className={'position pos-' + i}>{String(i + 1).padStart(2, '0')}</span>
                  <div className="rank-content">
                    <div>
                      <span>{s.name}</span>
                      <b>{curr(sumPeriod(s, 'month'))}</b>
                    </div>
                    <div className="rank-track">
                      <i
                        style={{
                          width:
                            (100 * sumPeriod(s, 'month')) /
                              Math.max(1, sumPeriod(sorted[0], 'month')) +
                            '%',
                          opacity: 1 - i * 0.14,
                        }}
                      />
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <p className="inline-empty">暂无可排行的消费数据</p>
            )}
          </div>
        </section>
      </div>
    </>
  )
}
const filters: Record<FilterKey, string> = {
  all: '全部状态',
  low: '余额偏低',
  issue: '连接异常',
  paused: '已暂停',
}
export function SiteTable({
  sites,
  open,
  visit,
  filter,
  setFilter,
  manage = false,
  add,
}: {
  sites: Site[]
  open: (s: Site) => void
  visit: (s: Site) => void
  filter: FilterKey
  setFilter: (v: FilterKey) => void
  manage?: boolean
  add: () => void
}) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{
    key: 'name' | 'balance' | 'today' | 'month' | 'time'
    desc: boolean
  } | null>(null)
  function order(key: NonNullable<typeof sort>['key']) {
    setSort((old) => ({ key, desc: old?.key === key ? !old.desc : key !== 'name' }))
  }
  const rows = sites.filter(
    (s) =>
      (s.name + ' ' + s.origin).toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' || (filter === 'issue'
        ? !s.paused && ['retrying', 'invalid', 'offline'].includes(s.health)
        : stateLabel(s)[0] === filter)),
  )
  rows.sort((a, b) => {
    const alertOrder = Number(hasBalanceAlert(b)) - Number(hasBalanceAlert(a))
    if (alertOrder) return alertOrder
    if (!sort) return 0
    const direction = sort.desc ? -1 : 1,
      key = sort.key
    if (key === 'name') return direction * a.name.localeCompare(b.name, 'zh-CN')
    if (key === 'time') return direction * (a.checked - b.checked)
    if (a.unit !== b.unit) return a.unit.localeCompare(b.unit)
    if (key === 'balance') {
      if (a.accountBalance == null || b.accountBalance == null) return Number(a.accountBalance == null) - Number(b.accountBalance == null)
      return direction * (a.accountBalance - b.accountBalance)
    }
    const av = periodAvailable(a, key),
      bv = periodAvailable(b, key)
    return av !== bv ? Number(bv) - Number(av) : direction * (sumPeriod(a, key) - sumPeriod(b, key))
  })
  const heading = (label: string, key: NonNullable<typeof sort>['key']) => (
    <button className="sort-btn" onClick={() => order(key)}>
      {label}
      {sort?.key === key ? (
        sort.desc ? (
          <ArrowDown size={11} />
        ) : (
          <ArrowUp size={11} />
        )
      ) : (
        <ArrowDownUp size={11} />
      )}
    </button>
  )
  return (
    <section className="panel table-panel" id="site-monitor">
      <div className="table-tools">
        <h2>
          {manage ? '全部站点' : '站点监控'} <span className="count">{sites.length}</span>
        </h2>
        <div className="table-actions">
          <label className="search-box">
            <Search size={14} />
            <input
              aria-label="搜索站点"
              placeholder="搜索站点…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button aria-label="清空搜索" onClick={() => setQuery('')}>
                <X size={13} />
              </button>
            )}
          </label>
          <label className="select-wrap">
            <Filter size={13} />
            <select
              aria-label="状态筛选"
              value={filter}
              onChange={(e) => setFilter(e.target.value as FilterKey)}
            >
              {Object.entries(filters).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <ChevronDown size={12} />
          </label>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{heading('站点名称', 'name')}</th>
              <th className="num">{heading('账户钱包余额', 'balance')}</th>
              <th className="num">{heading('今日消费', 'today')}</th>
              <th className="num">{heading('本月消费', 'month')}</th>
              <th>监控状态</th>
              <th>{heading('最近更新', 'time')}</th>
              <th aria-label="详情" />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className={hasBalanceAlert(s) ? 'site-alert-row' : undefined} onClick={() => open(s)}>
                <td>
                  <div className="site-identity">
                    <SiteMark site={s} />
                    <div>
                      <button className="site-name" onClick={(e) => {
                        e.stopPropagation()
                        open(s)
                      }}>{s.name}</button>
                      <a className="site-url" href={s.origin} title={'用默认浏览器打开 ' + s.origin}
                        aria-label={'用默认浏览器打开 ' + s.name + '（' + s.origin + '）'}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          visit(s)
                        }}>
                        {new URL(s.origin).host} <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    </div>
                  </div>
                </td>
                <td className="num balance">
                  {s.accountBalance == null ? '暂不可查' : money(s.accountBalance, s.unit)}
                  {s.provider === 'sub2api' && <small className="balance-kind">{s.walletGroup || '默认账户'}</small>}
                </td>
                {(['today', 'month'] as const).map((k) => (
                  <td key={k} className="num">
                    {periodAvailable(s, k) ? (
                      money(sumPeriod(s, k), s.unit)
                    ) : (
                      <span className="muted" title="暂无统计">
                        —
                      </span>
                    )}
                  </td>
                ))}
                <td>
                  <Status site={s} />
                </td>
                <td className="time" title={fullTime(s.checked)}>
                  {s.health !== 'ok' ? '待更新 · ' : ''}
                  {time(s.checked)}
                </td>
                <td className="row-arrow">
                  <ChevronRight size={15} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <div className="empty-state">
          <Globe2 />
          <h3>{sites.length ? '没有匹配的站点' : '还没有监控站点'}</h3>
          <button
            className="btn secondary"
            onClick={() => {
              if (sites.length) {
                setQuery('')
                setFilter('all')
              } else add()
            }}
          >
            {sites.length ? '清除筛选' : '添加站点'}
          </button>
        </div>
      )}
    </section>
  )
}
