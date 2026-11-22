import { useId, useState } from 'react'
import {
  Activity,
  AudioWaveform,
  Boxes,
  Cloud,
  Command,
  Hexagon,
  Layers3,
  Orbit,
  Satellite,
  Sparkles,
  TriangleAlert,
} from 'lucide-react'
import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { money, stateLabel, type Site, type Unit } from './model'

const marks = [Layers3, Orbit, Cloud, AudioWaveform, Boxes, Sparkles, Hexagon, Satellite]
export function SiteMark({ site, small = false }: { site: Site; small?: boolean }) {
  const Icon = marks[site.icon % marks.length] || Command
  return (
    <span className={'site-mark mark-' + (site.icon % 8) + (small ? ' small' : '')}>
      <Icon size={small ? 14 : 19} strokeWidth={2.1} />
    </span>
  )
}
export function Status({ site }: { site: Site }) {
  const [kind, label] = stateLabel(site)
  let title = label
  if (kind === 'low') title = '低于阈值 ' + money(site.threshold, site.unit)
  if (!site.paused && site.issue) {
    const { detail, count, retryAt } = site.issue
    title = detail
    if (count) title += ' 连续失败 ' + count + ' 次。'
    if (retryAt > Date.now()) title += ' 最早重试时间 ' + new Date(retryAt).toLocaleString('zh-CN', { hour12: false })
  }
  return (
    <span
      className={'status ' + kind}
      title={title}
    >
      {kind === 'low' ? <TriangleAlert size={11} /> : <i />}
      <span>{label}</span>
    </span>
  )
}
export function Surface({
  name,
  open,
  close,
  children,
  drawer = false,
}: {
  name: string
  open: boolean
  close: () => void
  children: ReactNode
  drawer?: boolean
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="scrim" />
        <Dialog.Popup
          className={drawer ? 'overlay drawer' : 'overlay modal'}
          aria-describedby={undefined}
        >
          <header className="overlay-head">
            <Dialog.Title>{name}</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="关闭">
              <X size={18} />
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
export function Mesh() {
  const project = (x: number, y: number) => {
    const h =
      Math.sin(x * 0.13 + y * 0.08) * 6 +
      Math.sin(x * 0.087 - y * 0.13) * 4 +
      Math.cos(x * 0.067 + y * 0.03) * 4
    return [x * 3.4 + y * 1.6, 30 + y * 1.5 - x * 0.35 + h * 2.7].join(',')
  }
  return (
    <svg className="mesh" viewBox="0 0 210 96" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth=".6">
        {Array.from({ length: 25 }, (_, y) => (
          <polyline
            key={y}
            points={Array.from({ length: 72 }, (_, x) => project(x - 4, y * 1.5)).join(' ')}
          />
        ))}
        {Array.from({ length: 40 }, (_, x) => (
          <polyline
            key={'x' + x}
            points={Array.from({ length: 37 }, (_, y) => project(x * 1.8 - 4, y)).join(' ')}
          />
        ))}
      </g>
    </svg>
  )
}
type Point = { day: string; value: number | null }
export function Trend({ data, unit }: { data: Point[]; unit: Unit }) {
  const gid = useId().replace(/:/g, '')
  const [pick, setPick] = useState<number | null>(null)
  const [w, h] = [600, 135],
    top = 8,
    floor = h - 2
  const available = data.filter((p) => p.value != null)
  if (!available.length)
    return (
      <div className="chart-empty">
        <Activity size={23} />
        <span>暂无消费统计</span>
      </div>
    )
  const max = Math.max(1, ...available.map((p) => p.value!))
  const base = 10 ** Math.floor(Math.log10(max / 3))
  const step = Math.ceil(max / 3 / base) * base
  const low = Math.min(0, ...available.map((p) => p.value!))
  const bottom = Math.floor(low / step) * step
  const hi = step * 3
  const ticksY = [3, 2, 1, 0].map((k) => bottom + ((hi - bottom) * k) / 3)
  const y = (v: number) => floor - ((v - bottom) / (hi - bottom)) * (floor - top)
  const x = (i: number) => 2 + (i * (w - 4)) / Math.max(1, data.length - 1)
  const segments: number[][] = []
  data.forEach((p, i) => {
    if (p.value === null) return
    if (i === 0 || data[i - 1].value === null) segments.push([])
    segments[segments.length - 1].push(i)
  })
  const line = (seg: number[]) =>
    seg.reduce((d, i, k) => {
      const cy = y(data[i].value!)
      if (!k) return 'M' + x(i) + ' ' + cy
      const prev = seg[k - 1],
        mid = (x(prev) + x(i)) / 2
      return (
        d + ' C' + mid + ' ' + y(data[prev].value!) + ' ' + mid + ' ' + cy + ' ' + x(i) + ' ' + cy
      )
    }, '')
  const ticks = [
    ...new Set(Array.from({ length: 7 }, (_, i) => Math.round(((data.length - 1) * i) / 6))),
  ]
  const last = data.findLastIndex((p) => p.value != null)
  const active = pick === null ? last : Math.min(pick, data.length - 1)
  const point = data[active]
  return (
    <div className="graph">
      <div className="axis-y">
        {ticksY.map((k) => (
          <span key={k}>{k.toLocaleString('en-US', { maximumFractionDigits: 3 })}</span>
        ))}
      </div>
      <div
        className="graph-body"
        role="slider"
        aria-label="按日期查看消费"
        aria-valuemin={1}
        aria-valuemax={data.length}
        aria-valuenow={active + 1}
        aria-valuetext={
          point.day + ' ' + (point.value == null ? '暂无统计' : money(point.value, unit))
        }
        tabIndex={0}
        onPointerMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect()
          setPick(
            Math.max(
              0,
              Math.min(
                data.length - 1,
                Math.round(((e.clientX - b.left) / b.width) * (data.length - 1)),
              ),
            ),
          )
        }}
        onPointerLeave={() => setPick(null)}
        onBlur={() => setPick(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            setPick(
              Math.min(data.length - 1, Math.max(0, active + (e.key === 'ArrowLeft' ? -1 : 1))),
            )
          }
        }}
      >
        <svg viewBox={'0 0 ' + w + ' ' + h} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--line)" stopOpacity=".23" />
              <stop offset="100%" stopColor="var(--line)" stopOpacity=".015" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3].map((k) => (
            <line
              key={k}
              x1="0"
              x2={w}
              y1={y(k)}
              y2={y(k)}
              stroke="var(--grid)"
              strokeDasharray="3 4"
            />
          ))}
          {segments.map((seg) => (
            <g key={seg[0]}>
              <path
                d={
                  line(seg) +
                  ' L' +
                  x(seg.at(-1)!) +
                  ' ' +
                  floor +
                  ' L' +
                  x(seg[0]) +
                  ' ' +
                  floor +
                  ' Z'
                }
                fill={'url(#' + gid + ')'}
              />
              <path
                d={line(seg)}
                stroke="var(--line)"
                strokeWidth="2.7"
                vectorEffect="non-scaling-stroke"
                fill="none"
                strokeLinecap="round"
              />
            </g>
          ))}
          {pick !== null && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={top}
              y2={floor}
              stroke="var(--line)"
              strokeDasharray="3 4"
              opacity=".45"
            />
          )}
        </svg>
        {point.value !== null && (
          <i
            className="chart-dot"
            style={{ left: (x(active) / w) * 100 + '%', top: (y(point.value) / h) * 100 + '%' }}
          />
        )}
        {pick !== null && (
          <span
            className="graph-tip"
            style={{ left: Math.min(85, Math.max(15, (x(active) / w) * 100)) + '%' }}
          >
            {point.day.slice(5).replace('-', '/')} ·{' '}
            {point.value == null ? '暂无统计' : money(point.value, unit)}
          </span>
        )}
      </div>
      <div className="axis-x">
        {ticks.map((i) => (
          <span key={i}>{data[i].day.slice(5).replace('-', '/')}</span>
        ))}
      </div>
    </div>
  )
}
