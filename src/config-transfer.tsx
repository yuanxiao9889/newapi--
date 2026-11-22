import { useState, type FormEvent } from 'react'
import { Download, Upload } from 'lucide-react'
import { api, message } from './native'
import { Surface } from './visuals'

export function ConfigTransfer({ empty }: { empty: boolean }) {
  const [mode, setMode] = useState<'export' | 'import' | null>(null)
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('')
  const [applyPreferences, setApplyPreferences] = useState(empty)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState('')
  const exporting = mode === 'export'
  function open(next: 'export' | 'import' | null) {
    setMode(next)
    setPassword('')
    setConfirmation('')
    setError('')
    setApplyPreferences(empty)
    if (next) setResult('')
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
        setResult('已导出配置，包含 ' + saved.count + ' 个站点。')
      } else {
        const imported = await api.importConfig({ password, applyPreferences })
        if (!imported) return
        setResult('已导入 ' + imported.added + ' 个站点，跳过 ' + imported.skipped + ' 个重复站点。' +
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
    <hr />
    <h3>配置迁移</h3>
    <p className="note">将站点、凭据和设置导出为加密文件，可在另一台电脑上导入。</p>
    <div className="form-buttons">
      <button className="btn secondary" onClick={() => open('export')}><Download size={15} />导出配置</button>
      <button className="btn secondary" onClick={() => open('import')}><Upload size={15} />导入配置</button>
    </div>
    {result && <p className="feedback good" role="status">{result}</p>}
    {mode && <Surface name={exporting ? '导出配置' : '导入配置'} open close={() => { if (!busy) open(null) }}>
      <form onSubmit={submit}>
        <div className="form-body">
          <p className="note">{exporting
            ? '文件包含站点令牌、邮件凭据和偏好设置。请记住密码，换机导入时需要输入。'
            : '输入导出时设置的密码，然后选择 .qdconfig 文件。同一站点已有的账户或 Key 会自动跳过。'}</p>
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
            使用文件中的主题、查询频率、统一预警金额和邮件通知设置
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
