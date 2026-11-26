import { useState, type FormEvent } from 'react'
import { Download, Upload } from 'lucide-react'
import { api, message } from './native'
import { Surface } from './visuals'

export function ConfigTransfer({ empty, inform }: { empty: boolean; inform: (message: string) => void }) {
  const [mode, setMode] = useState<'export' | 'import' | null>(null)
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [applyPreferences, setApplyPreferences] = useState(empty)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const exporting = mode === 'export'
  function open(next: 'export' | 'import' | null) {
    setMode(next)
    setPassword('')
    setConfirmation('')
    setError('')
    setApplyPreferences(empty)
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (exporting && password !== confirmation) {
      setError('两次输入的密码不一致。')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (exporting) {
        const saved = await api.exportConfig({ password })
        if (!saved) return
        inform('已导出完整备份，包含 ' + saved.count + ' 个站点、监控记录和通知设置。')
      } else {
        const imported = await api.importConfig({ password, applyPreferences })
        if (!imported) return
        inform('已导入 ' + imported.added + ' 个站点，跳过 ' + imported.skipped + ' 个重复站点。' +
          (applyPreferences ? ' 已应用偏好和通知设置。' : ''))
      }
      open(null)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  return <>
    <button className="btn secondary" onClick={() => open('import')}><Upload size={15} />导入配置</button>
    <button className="btn secondary" onClick={() => open('export')}><Download size={15} />导出配置</button>
    {mode && <Surface name={exporting ? '导出配置' : '导入配置'} open close={() => { if (!busy) open(null) }}>
      <form onSubmit={submit}>
        <div className="form-body">
          <p className="note">{exporting
            ? '加密备份包含站点及凭据、消费历史、查询日志、利润账本及管理员令牌、提醒和投递记录、通知配置与个人偏好。换机恢复时需要此密码。'
            : '输入密码并选择 .qdconfig 文件。新站点及其记录会一起恢复。已有账户或 Key 会跳过，利润账本仅在本机尚未接入收入站时恢复。也支持旧版配置文件。'}</p>
          <label className="field">文件密码
            <input type="password" required autoFocus minLength={8} maxLength={1024} disabled={busy}
              autoComplete={exporting ? 'new-password' : 'off'} placeholder={exporting ? '至少 8 个字符' : '输入导出密码'}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {exporting ? <label className="field">确认密码
            <input type="password" required autoComplete="new-password" disabled={busy}
              value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
          </label> : <label className="toggle">
            <input type="checkbox" checked={applyPreferences} disabled={busy}
              onChange={(e) => setApplyPreferences(e.target.checked)} /><i />
            使用备份中的个人偏好、统一预警金额、邮件和 Flashduty 短信配置
          </label>}
          {error && <p className="feedback error" role="alert">{error}</p>}
        </div>
        <footer className="overlay-foot">
          <button type="button" className="btn secondary" disabled={busy} onClick={() => open(null)}>取消</button>
          <button className="btn primary" disabled={busy}>{busy ? '处理中…' : exporting ? '选择保存位置' : '选择文件并导入'}</button>
        </footer>
      </form>
    </Surface>}
  </>
}
