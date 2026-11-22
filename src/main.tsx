import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Select } from '@base-ui/react/select'
import {
  Activity,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Inbox,
  Layers3,
  LayoutDashboard,
  Mail,
  Monitor,
  Moon,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Settings2,
  Sun,
  UserRound,
  Wallet,
} from 'lucide-react'
import { Overview, SiteTable, type FilterKey } from './dashboard'
import { AddSite, MailSettings, MessagePreview, ThresholdSettings } from './forms'
import { Detail } from './detail'
import { ConfigTransfer } from './config-transfer'
import { api, message } from './native'
import {
  fullTime,
  unitName,
  unitParts,
  deliveryLabel,
  money,
  time,
  type Clock,
  type Desk,
  type Site,
  type Unit,
} from './model'
import './styles.css'

type Page = 'home' | 'sites' | 'alerts' | 'mail' | 'settings'
const pageNames: Record<Page, string> = {
  home: '费用总览',
  sites: '站点管理',
  alerts: '提醒记录',
  mail: '通知设置',
  settings: '偏好设置',
}
const navItems = {
  home: LayoutDashboard,
  sites: Layers3,
  alerts: Bell,
  mail: Mail,
  settings: Settings2,
}
function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div>
        <b>QuotaDesk</b>
        <small>API 费用监控</small>
      </div>
    </div>
  )
}
function UnitPicker({ unit, units, onChange }: { unit: Unit; units: Unit[]; onChange: (unit: Unit) => void }) {
  return (
    <Select.Root value={unit} onValueChange={(value) => { if (value !== null) onChange(value) }}>
      <Select.Trigger className="unit-select" aria-label={'汇总单位，' + unitName(unit)} title={unitName(unit)}>
        <Wallet size={14} />
        <span className="unit-value">{unitName(unit)}</span>
        <ChevronDown size={13} />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="unit-positioner" align="end" sideOffset={5} alignItemWithTrigger={false}>
          <Select.Popup className="unit-menu" aria-label="汇总单位">
            {units.map((key) => {
              const { label, host } = unitParts(key)
              return (
                <Select.Item key={key} value={key} label={unitName(key)} className="unit-option">
                  <Select.ItemText>
                    {label}
                    {host && <small className="unit-host">{host}</small>}
                  </Select.ItemText>
                  <Select.ItemIndicator><Check size={14} /></Select.ItemIndicator>
                </Select.Item>
              )
            })}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function App({ desk }: { desk: Desk }) {
  const [page, setPage] = useState<Page>('home'),
    [chosenUnit, setUnit] = useState<Unit>('CNY'),
    [filter, setFilter] = useState<FilterKey>('all')
  const [detail, setDetail] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [thresholdSettings, setThresholdSettings] = useState(false),
    [replacing, setReplacing] = useState<Site | undefined>(),
    [noticeId, setNoticeId] = useState<string | null>(null)
  const notice = desk.notices.find((n) => n.id === noticeId)
  const [collapsed, setCollapsed] = useState(
      () => matchMedia('(min-width:761px) and (max-width:920px)').matches,
    ),
    [mobileOpen, setMobileOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [toast, setToast] = useState(''),
    [alertFilter, setAlertFilter] = useState('all')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function inform(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2400)
  }
  // Every site view (including status tooltips) displays the rule used by the monitor.
  const { globalThreshold } = desk
  const sites = desk.sites.map((s) => ({
    ...s,
    sourceUnit: s.unit,
    unit: s.autoUsd || s.provider === 'sub2api' ? 'CNY' : s.billing?.unit ?? 'CNY',
    threshold: globalThreshold ?? s.threshold,
  }))
  const site = sites.find((s) => s.id === detail)
  const availableUnits = [...new Set(sites.map((s) => s.unit))]
  const unit = availableUnits.includes(chosenUnit) ? chosenUnit : availableUnits[0] || chosenUnit
  const openAlerts = desk.notices.filter((n) => !n.closed).length
  const active = desk.sites.filter((s) => !s.paused).length
  const last = Math.max(0, ...desk.sites.map((s) => s.tried))
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      document.documentElement.dataset.theme =
        desk.theme === 'system' ? (media.matches ? 'dark' : 'light') : desk.theme
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [desk.theme])
  useEffect(() => {
    const menu = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', menu)
    return () => window.removeEventListener('keydown', menu)
  }, [])
  function go(p: Page) {
    setPage(p)
    setFilter('all')
    setMobileOpen(false)
    setDetail(null)
    window.scrollTo({ top: 0 })
  }
  function add() {
    setReplacing(undefined)
    setAdding(true)
  }
  async function refresh() {
    if (loading) return
    setLoading(true)
    try {
      await api.refresh()
      inform('已完成站点查询，请查看监控状态')
    } catch (e) {
      inform(message(e))
    } finally {
      setLoading(false)
    }
  }
  function settings(patch: Partial<Pick<Desk, 'theme' | 'minutes'>>) {
    api.preferences(patch).catch((e) => inform(message(e)))
  }
  const nav = (p: Page) => {
    const Icon = navItems[p]
    return (
      <button
        key={p}
        aria-label={pageNames[p]}
        aria-current={page === p ? 'page' : undefined}
        title={pageNames[p]}
        className={'nav-item ' + (page === p ? 'active' : '')}
        onClick={() => go(p)}
      >
        <Icon size={18} />
        <span>{pageNames[p]}</span>
        {p === 'alerts' && openAlerts > 0 && <b>{openAlerts}</b>}
      </button>
    )
  }
  const now = new Date()
  return (
    <div
      className={'app-shell ' + (collapsed ? 'collapsed ' : '') + (mobileOpen ? 'mobile-open' : '')}
    >
      {mobileOpen && (
        <button
          className="mobile-curtain"
          aria-label="收起导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className="sidebar">
        <Brand />
        <nav>
          <small className="nav-caption">工作空间</small>
          {(['home', 'sites', 'alerts'] as const).map(nav)}
          <small className="nav-caption second">设置</small>
          {(['mail', 'settings'] as const).map(nav)}
        </nav>
        <div className="sidebar-bottom">
          <div className="poll-box">
            <div>
              <span className="signal">
                <Activity size={15} />
              </span>
              <b>本地监控</b>
              <i className={'online-dot ' + (!active ? 'inactive' : '')} />
            </div>
            <p>{active ? '每 ' + desk.minutes + ' 分钟自动查询' : '尚无运行中的站点'}</p>
          </div>
          <div className="profile">
            <span className="avatar">
              <UserRound size={17} />
            </span>
            <div>
              <b>个人工作区</b>
              <small>Windows 桌面版</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn side-toggle"
              aria-label="切换导航"
              onClick={() => {
                if (matchMedia('(max-width: 760px)').matches) setMobileOpen(!mobileOpen)
                else setCollapsed(!collapsed)
              }}
            >
              <PanelLeftClose size={17} />
            </button>
            <i />
            <span>工作空间</span>
            <ChevronRight size={12} />
            <b>{pageNames[page]}</b>
          </div>
          <div className="top-status">
            <span className="online-dot" />
            <b>{active ? '监控运行中' : '监控待机'}</b>
            <i />
            <span className="last-update">{last ? '上次查询 ' + time(last) : '尚无查询'}</span>
            <button
              className="icon-btn"
              disabled={loading || !active}
              onClick={refresh}
              aria-label="立即查询所有站点"
              title="立即查询所有站点"
            >
              <RefreshCw className={loading ? 'spin' : ''} size={15} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <h1>{pageNames[page]}</h1>
              <p>
                {page === 'home' ? (
                  <>
                    <CalendarDays size={14} />
                    {now.toLocaleDateString('zh-CN', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      weekday: 'long',
                    })}
                    <i />
                    已接入 {desk.sites.length} 个站点
                  </>
                ) : page === 'sites' ? (
                  '查看和管理 New API 账户与 SUB2API Key'
                ) : page === 'alerts' ? (
                  '查看各站点的低余额提醒与恢复记录'
                ) : page === 'mail' ? (
                  '为所有站点配置统一的邮件提醒'
                ) : (
                  '设置本机外观与自动查询频率'
                )}
              </p>
            </div>
            {(page === 'home' || page === 'sites') && (
              <div className="heading-actions">
                {page === 'sites' && (
                  <button className="btn secondary" onClick={() => setThresholdSettings(true)}>
                    <Bell size={15} />
                    统一预警金额{desk.globalThreshold != null && ' · ' + desk.globalThreshold}
                  </button>
                )}
                {page === 'home' && (
                  <UnitPicker unit={unit} units={availableUnits.length ? availableUnits : [unit]} onChange={setUnit} />
                )}
                <button className="btn primary" onClick={add}>
                  <Plus size={17} />
                  添加站点
                </button>
              </div>
            )}
          </div>
          {page === 'home' && desk.sites.length === 0 && (
            <section className="panel first-run">
              <div className="welcome-mark">
                <Wallet size={31} />
              </div>
              <h2>添加第一个监控站点</h2>
              <p>使用 New API 个人访问令牌或 SUB2API Key，查看余额、消费和低余额提醒。</p>
              <button className="btn primary" onClick={add}>
                <Plus size={16} />
                连接第一个站点
              </button>
            </section>
          )}
          {page === 'home' && desk.sites.length > 0 && !desk.mail.enabled && (
            <div className="mail-setup-note">
              <Mail size={15} />
              <span>尚未启用低余额邮件提醒</span>
              <button onClick={() => go('mail')}>配置邮件</button>
            </div>
          )}
          {page === 'home' && desk.sites.length > 0 && (
            <Overview
              sites={sites}
              wallets={desk.wallets}
              unreadWalletCount={desk.unreadWalletCount}
              unit={unit}
              onLow={() => {
                setFilter('low')
                document
                  .getElementById('site-monitor')
                  ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
              }}
              onDetail={(s) => setDetail(s.id)}
            />
          )}
          {((page === 'home' && desk.sites.length > 0) || page === 'sites') && (
            <SiteTable
              key={page}
              manage={page === 'sites'}
              sites={sites}
              filter={filter}
              setFilter={setFilter}
              open={(s) => setDetail(s.id)}
              visit={(s) => api.openSite({ id: s.id }).catch((e) => inform('打开站点失败：' + message(e)))}
              add={add}
            />
          )}
          {page === 'alerts' && (
            <section className="panel alerts-panel">
              <div className="table-tools">
                <h2>
                  余额提醒 <span className="count">{desk.notices.length}</span>
                </h2>
                <div className="segmented">
                  {[
                    ['all', '全部'],
                    ['open', '待处理'],
                    ['closed', '已恢复'],
                  ].map(([k, v]) => (
                    <button
                      key={k}
                      className={alertFilter === k ? 'selected' : ''}
                      onClick={() => setAlertFilter(k)}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              {desk.notices
                .filter((n) => alertFilter === 'all' || (alertFilter === 'closed') === !!n.closed)
                .map((n) => (
                  <div key={n.id} className="notice-row">
                    <span className={'notice-icon ' + (n.closed ? 'recovered' : '')}>
                      {n.closed ? <Check size={19} /> : <Bell size={18} />}
                    </span>
                    <div>
                      <h3>
                        {n.site} <small>{n.closed ? '已恢复' : '余额偏低'}</small>
                      </h3>
                      <p>
                        {money(n.balance, n.unit)} <span> / 阈值 </span>
                        {money(n.threshold, n.unit)} · {fullTime(n.at)}
                        {n.closed ? ' · 恢复于 ' + fullTime(n.closed) : ''}
                      </p>
                    </div>
                    {!n.closed &&
                      desk.mail.enabled &&
                      ['failed', 'uncertain'].includes(n.delivery) && (
                        <button
                          className="btn secondary"
                          onClick={() => api.retry({ id: n.id }).catch((e) => inform(message(e)))}
                        >
                          重新发送
                        </button>
                      )}
                    {n.delivery !== 'off' ? (
                      <button className="btn secondary" onClick={() => setNoticeId(n.id)}>
                        <Mail size={14} />
                        {deliveryLabel[n.delivery]}
                      </button>
                    ) : (
                      <small className="muted">邮件已关闭</small>
                    )}
                  </div>
                ))}
              {!desk.notices.some(
                (n) => alertFilter === 'all' || (alertFilter === 'closed') === !!n.closed,
              ) && (
                <div className="empty-state">
                  <Inbox />
                  <h3>暂无提醒记录</h3>
                </div>
              )}
            </section>
          )}
          {page === 'mail' && <MailSettings mail={desk.mail} inform={inform} />}
          {page === 'settings' && (
            <section className="panel settings-card">
              <div className="panel-heading">
                <h2>
                  <Settings2 size={18} />
                  桌面偏好
                </h2>
              </div>
              <div className="settings-content">
                <label className="field">外观主题</label>
                <div className="provider-picker">
                  {(['system', 'light', 'dark'] as const).map((t, i) => {
                    const Icon = [Monitor, Sun, Moon][i]
                    return (
                      <button
                        className={desk.theme === t ? 'active' : ''}
                        key={t}
                        onClick={() => settings({ theme: t })}
                      >
                        <Icon size={16} />
                        {['跟随系统', '浅色', '深色'][i]}
                      </button>
                    )
                  })}
                </div>
                <label className="field">
                  自动查询频率
                  <select
                    value={desk.minutes}
                    onChange={(e) => settings({ minutes: Number(e.target.value) as Clock })}
                  >
                    {[5, 15, 30, 60].map((n) => (
                      <option key={n} value={n}>
                        每 {n} 分钟
                      </option>
                    ))}
                  </select>
                </label>
                <p className="note">
                  关闭窗口后，QuotaDesk
                  会在系统托盘继续查询。电脑从休眠恢复时会补查到期站点；在托盘菜单中选择「退出并停止监控」可完全退出。
                </p>
                <ConfigTransfer empty={desk.sites.length === 0} />
              </div>
            </section>
          )}
        </main>
      </div>
      {site && !adding && !notice && !thresholdSettings && (
        <Detail
          key={site.id}
          site={site}
          editGlobalThreshold={desk.globalThreshold != null ? () => setThresholdSettings(true) : undefined}
          notices={desk.notices.filter((n) => n.siteId === site.id)}
          preview={(n) => setNoticeId(n.id)}
          close={() => setDetail(null)}

          replace={() => {
            setReplacing(site)
            setAdding(true)
          }}
          inform={inform}
        />
      )}
      {adding && (
        <AddSite
          existing={replacing}
          globalThreshold={desk.globalThreshold}

          close={() => setAdding(false)}
          saved={(id, unit) => {
            setAdding(false)
            setUnit(unit)
            setDetail(id)
            inform(replacing ? '令牌已更新' : '站点已保存，监控已启动')
          }}
        />
      )}
      {notice && <MessagePreview notice={notice} close={() => setNoticeId(null)} />}
      {thresholdSettings && (
        <ThresholdSettings current={desk.globalThreshold} close={() => setThresholdSettings(false)}
          saved={() => { setThresholdSettings(false); inform('预警金额设置已保存') }} />
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  )
}
function Desktop() {
  const [desk, setDesk] = useState<Desk | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    if (!api) {
      setError('请打开 Windows 桌面程序 QuotaDesk.exe。')
      return
    }
    let fresh = false
    const stop = api.onChange((state) => {
      fresh = true
      setDesk(state)
    })
    api
      .state()
      .then((state) => {
        if (!fresh) setDesk(state)
      })
      .catch((e) => setError(message(e)))
    return stop
  }, [])
  return desk ? (
    <App desk={desk} />
  ) : (
    <main>
      <h1>QuotaDesk</h1>
      <p>{error || '正在读取本地工作区…'}</p>
    </main>
  )
}
createRoot(document.getElementById('quota-desk-app')!).render(<Desktop />)
