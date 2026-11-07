import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, THINKING_LEVELS, type ApiFormat, type Settings as SettingsValue, type Thinking, type UiBridge, parseSettings } from '../shared/settings';
import { CUSTOM_PROVIDER, PROVIDERS, providerById, resolveProvider } from '../shared/providers';
import { Brand } from './Brand';
import { Icon } from './Icons';
import s from './ui.module.css';
import { BUILD_VERSION, ExtensionUpdateError } from '../shared/runtime';

const THINKING_NAMES: Record<Thinking, string> = { default: '默认', off: '关闭', low: '低', medium: '中', high: '高' };
const FORMATS: [ApiFormat, string][] = [['openai', 'OpenAI 兼容'], ['anthropic', 'Anthropic 兼容']];

export function Settings({ bridge }: { bridge: UiBridge }) {
  const [value, setValue] = useState<SettingsValue>(DEFAULT_SETTINGS);
  const [showKey, setShowKey] = useState(false);
  const [customEndpoint, setCustomEndpoint] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [shortcut, setShortcut] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([bridge.getSettings(), bridge.getShortcut()]).then(([settings, key]) => {
      if (!active) return;
      const provider = resolveProvider(settings);
      setValue({ ...settings, provider }); setCustomEndpoint(provider === CUSTOM_PROVIDER); setShortcut(key); setReady(true);
    }).catch(error => { if (active) { setStatus({ type: 'error', text: error instanceof Error ? error.message : '读取设置失败，请重新打开。' }); setNeedsReload(error instanceof ExtensionUpdateError); } });
    return () => { active = false; };
  }, [bridge]);

  const preset = providerById(value.provider);
  function update(patch: Partial<SettingsValue>) {
    // A hand-edited address or format no longer is the preset it came from.
    const custom = 'endpoint' in patch || 'format' in patch;
    setValue(previous => ({ ...previous, ...patch, ...(custom ? { provider: CUSTOM_PROVIDER } : {}), testedAt: null })); setStatus(null);
  }
  function choose(id: string) {
    const next = providerById(id);
    setStatus(null);
    if (!next) { setValue(previous => ({ ...previous, provider: CUSTOM_PROVIDER })); setCustomEndpoint(true); return; }
    // The old Key belongs to the old service; never carry it over to a new host.
    setValue(previous => ({ ...previous, provider: next.id, format: next.format, endpoint: next.endpoint, model: next.models[0] ?? '', thinking: next.thinking, apiKey: '', testedAt: null }));
  }
  async function act(action: 'test' | 'save') {
    setStatus(null);
    try {
      const settings = parseSettings(value);
      setBusy(action);
      if (action === 'test') {
        const result = await bridge.testConnection(settings);
        setValue({ ...settings, testedAt: result.testedAt });
        setStatus({ type: 'success', text: `连接成功，${settings.model} 已返回文字。点击保存即可保留配置。` });
      } else {
        await bridge.saveSettings(settings);
        setStatus({ type: 'success', text: '设置已保存到本机。' });
      }
    } catch (error) { setStatus({ type: 'error', text: error instanceof Error ? error.message : '操作失败，请重试。' }); }
    finally { setBusy(null); }
  }
  const locked = !ready || !!busy;
  const host = (() => { try { return new URL(value.endpoint).host; } catch { return value.endpoint; } })();

  return <div className={s.settingsPage}>
    <header className={s.settingsHeader}><Brand compact /><span className={s.version}>设置 · {BUILD_VERSION}</span></header>
    <main className={s.settingsMain}>
      <h1 className={s.settingsTitle}>设置</h1>
      <p className={s.settingsIntro}>配置翻译接口和快捷键。</p>
      <form className={s.settingsCard} onSubmit={event => { event.preventDefault(); void act('save'); }}>
        <div className={s.fieldRow}>
          <div><label className={s.label} htmlFor="provider">服务商</label><div className={s.selectWrap}><select id="provider" className={s.textInput} value={value.provider} onChange={event => choose(event.target.value)} disabled={locked}>{PROVIDERS.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}<option value={CUSTOM_PROVIDER}>自定义</option></select><Icon name="chevron" size={13} /></div></div>
          <div><span className={s.label} id="format-label">接口格式</span><div className={`${s.segmented} ${s.formatSwitch}`} role="group" aria-labelledby="format-label">{FORMATS.map(([format, name]) => <button key={format} type="button" aria-pressed={value.format === format} onClick={() => value.format !== format && update({ format })} disabled={locked}>{name}</button>)}</div></div>
        </div>
        <div className={s.field}>
          <div className={s.labelRow}><label className={s.label} htmlFor="api-key">API Key</label>{preset?.keyUrl && <a href={preset.keyUrl} target="_blank" rel="noreferrer">获取 Key<Icon name="external" size={11} /></a>}</div>
          <div className={s.inputWrap}><Icon name="key" size={17} /><input id="api-key" type={showKey ? 'text' : 'password'} value={value.apiKey} onChange={event => update({ apiKey: event.target.value })} placeholder="粘贴你的 API Key" autoComplete="off" spellCheck={false} disabled={locked} aria-describedby="key-help" /><button type="button" className={s.iconButton} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowKey(previous => !previous)}><Icon name={showKey ? 'eyeOff' : 'eye'} size={18} /></button></div>
          <p className={s.fieldHint} id="key-help">仅保存在本机，用于连接你指定的模型服务。{preset?.note && <><br />{preset.note}</>}</p>
        </div>
        <div className={`${s.fieldRow} ${s.field}`}>
          <div><label className={s.label} htmlFor="model">模型 ID</label><input className={s.textInput} id="model" list="model-options" value={value.model} onChange={event => update({ model: event.target.value })} placeholder="填写模型 ID" autoComplete="off" spellCheck={false} disabled={locked} aria-required="true" /><datalist id="model-options">{preset?.models.map(model => <option key={model} value={model} />)}</datalist></div>
          <div><label className={s.label} htmlFor="thinking">思考强度</label><div className={s.selectWrap}><select id="thinking" className={s.textInput} value={value.thinking} onChange={event => update({ thinking: event.target.value as Thinking })} disabled={locked} aria-describedby="thinking-help">{THINKING_LEVELS.map(level => <option key={level} value={level}>{THINKING_NAMES[level]}</option>)}</select><Icon name="chevron" size={13} /></div></div>
        </div>
        <p className={s.fieldHint} id="thinking-help">翻译建议关闭；关闭不被支持时选低。</p>
        <button type="button" className={s.endpointToggle} aria-expanded={customEndpoint} aria-controls="endpoint-panel" onClick={() => setCustomEndpoint(previous => !previous)} disabled={!!busy}><span>服务地址</span><span>{customEndpoint ? '收起' : `${host} · 更改`}<Icon name="chevron" size={13} style={{ transform: customEndpoint ? 'rotate(90deg)' : undefined }} /></span></button>
        {customEndpoint && <div className={s.endpointPanel} id="endpoint-panel"><label className={s.label} htmlFor="endpoint">API 服务地址</label><input className={s.textInput} id="endpoint" type="url" value={value.endpoint} onChange={event => update({ endpoint: event.target.value })} placeholder={value.format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com'} disabled={!!busy} spellCheck={false} /><p className={s.fieldHint}>{value.format === 'anthropic' ? '填写根地址，请求时添加 /v1/messages；以 /v1 结尾时添加 /messages。' : '填写根地址，请求时添加 /chat/completions，可包含 /v1。'}</p></div>}
        <div className={s.formActions}><button type="button" className={s.secondaryButton} disabled={locked} onClick={() => void act('test')}>{busy === 'test' ? '正在连接…' : '测试连接'}</button><button type="submit" className={s.primaryButton} disabled={locked}><span>{busy === 'save' ? '正在保存…' : '保存设置'}</span><Icon name="arrow" size={17} /></button></div>
        <p className={s.testHint}>测试连接会向所填服务发送一句简短测试文字。</p>
        {status && <div className={status.type === 'error' ? s.errorBox : s.successBox} role={status.type === 'error' ? 'alert' : 'status'}>{status.type === 'success' && <Icon name="check" size={17} />}<span>{status.text}</span></div>}
        {needsReload && bridge.reloadExtension && <button type="button" className={s.secondaryButton} onClick={() => bridge.reloadExtension?.()}>重新加载扩展</button>}
      </form>
      <div className={s.shortcutCard}><div><strong>翻译 / 恢复原文</strong><p>可在 Chrome 中修改快捷键。</p></div><button className={s.shortcutButton} onClick={() => bridge.openShortcuts()} aria-label="更改快捷键"><kbd>{shortcut ? shortcut.replace('Alt', /Mac/.test(navigator.platform) ? '⌥' : 'Alt').replaceAll('+', ' ') : '未设置'}</kbd><Icon name="external" size={13} /></button></div>
      <p className={s.privacyLine}><Icon name="shield" size={15} />网页文字只发往你配置的模型服务。</p>
    </main>
  </div>;
}
