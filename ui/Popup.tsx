import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type AutoSite, type DisplayMode, type UiBridge } from '../shared/settings';
import { IDLE_STATE } from '../shared/translation';
import { Icon } from './Icons';
import { Logo } from './Brand';
import s from './ui.module.css';
import { LANGUAGES, parseLanguages, type LanguagePair } from '../shared/languages';
import { Usage } from './Usage';
import { ExtensionUpdateError } from '../shared/runtime';

export function Popup({ bridge }: { bridge: UiBridge }) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [host, setHost] = useState('当前网页');
  const [shortcut, setShortcut] = useState('');
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [pageState, setPageState] = useState(IDLE_STATE);
  const [changing, setChanging] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [autoSite, setAutoSite] = useState<AutoSite>({ site: null, enabled: false });
  useEffect(() => {
    let active = true;
    Promise.all([bridge.getSettings(), bridge.getPageHost(), bridge.getShortcut()]).then(([value, pageHost, key]) => {
      if (active) { setSettings({ ...value, ...parseLanguages(value) }); setHost(pageHost); setShortcut(key); setReady(true); }
    }).catch(error => { if (active) { setError(error instanceof Error ? error.message : '无法读取配置，请重新打开面板。'); setNeedsReload(error instanceof ExtensionUpdateError); } });
    return () => { active = false; };
  }, [bridge]);
  useEffect(() => {
    let active = true;
    bridge.getPageState?.().then(value => { if (active) setPageState(value); }).catch(() => {});
    const unwatch = bridge.watchPageState?.(value => { if (active) setPageState(value); });
    return () => { active = false; unwatch?.(); };
  }, [bridge]);
  useEffect(() => {
    let active = true;
    bridge.getAutoSite?.().then(value => { if (active) setAutoSite(value); }).catch(() => {});
    return () => { active = false; };
  }, [bridge]);
  async function changeAutoSite(enabled: boolean) {
    if (!autoSite.site || !bridge.saveAutoSite) return;
    setChanging(true); setError('');
    try { setPageState(await bridge.saveAutoSite(autoSite.site, enabled)); setAutoSite({ site: autoSite.site, enabled }); }
    catch (error) { setError(error instanceof Error ? error.message : '自动翻译设置未能保存，请重试。'); }
    finally { setChanging(false); }
  }

  async function toggle() {
    setChanging(true); setError('');
    try { if (bridge.toggleTranslation) setPageState(await bridge.toggleTranslation(settings.endpoint)); }
    catch (error) { setError(error instanceof Error ? error.message : '翻译未能开始，请重试。'); setNeedsReload(error instanceof ExtensionUpdateError); }
    finally { setChanging(false); }
  }

  async function changeMode(mode: DisplayMode) {
    try { await bridge.saveMode(mode); setSettings(value => ({ ...value, mode })); setError(''); }
    catch { setError('显示方式未能保存，请重试。'); }
  }
  const hasKey = Boolean(settings.apiKey);
  async function changeLanguages(pair: LanguagePair) {
    setChanging(true); setError('');
    try {
      const state = await bridge.saveLanguages(pair);
      setSettings(value => ({ ...value, ...pair }));
      if (state) setPageState(state);
    } catch (error) { setError(error instanceof Error ? error.message : '语言未能保存，请重试。'); }
    finally { setChanging(false); }
  }
  const enabled = pageState.enabled;
  const total = pageState.completed + pageState.pending + pageState.failed;
  const keyLabel = shortcut.replace('Alt', /Mac/.test(navigator.platform) ? '⌥' : 'Alt').replaceAll('+', ' ');
  return <section className={s.popup} aria-label="原页翻译面板">
    <header className={s.popupHeader}><span className={s.popupTitle}><Logo size={18} />原页</span><button className={s.iconButton} aria-label="打开设置" onClick={() => bridge.openSettings()}><Icon name="settings" size={17} /></button></header>
    <div className={s.pageContext}><span className={s.host} title={host}>{host}</span>{autoSite.enabled && <span className={s.autoChip}>自动翻译</span>}</div>
    <div className={s.languages}><span>从</span><select aria-label="源语言" value={settings.sourceLanguage} disabled={!ready || changing} onChange={event => void changeLanguages({ sourceLanguage: event.target.value as LanguagePair['sourceLanguage'], targetLanguage: settings.targetLanguage })}><option value="auto">自动检测</option>{Object.entries(LANGUAGES).map(([code, language]) => <option key={code} value={code}>{language.label}</option>)}</select><Icon name="arrow" size={14} /><select aria-label="目标语言" value={settings.targetLanguage} disabled={!ready || changing} onChange={event => void changeLanguages({ sourceLanguage: settings.sourceLanguage, targetLanguage: event.target.value as LanguagePair['targetLanguage'] })}>{Object.entries(LANGUAGES).map(([code, language]) => <option key={code} value={code}>{language.label}</option>)}</select></div>
    <div className={s.segmented} role="group" aria-label="译文显示方式">
      <button disabled={!ready || changing || needsReload} aria-pressed={settings.mode === 'bilingual'} onClick={() => void changeMode('bilingual')}>双语对照</button>
      <button disabled={!ready || changing || needsReload} aria-pressed={settings.mode === 'translated'} onClick={() => void changeMode('translated')}>仅看译文</button>
    </div>
    <button className={`${s.primaryButton} ${enabled ? s.restoreButton : ""}`} disabled={!ready || changing || needsReload || (hasKey && !enabled && settings.sourceLanguage === settings.targetLanguage)} onClick={() => hasKey ? void toggle() : bridge.openSettings()}>
      <Icon name={hasKey ? enabled ? 'undo' : 'translate' : 'key'} size={16} />
      <span>{!ready ? error ? '翻译不可用' : '正在读取配置…' : !hasKey ? '配置模型服务' : enabled ? '恢复原文' : '翻译此页'}</span>
      {hasKey && shortcut && <kbd>{keyLabel}</kbd>}
    </button>
    {hasKey && autoSite.site && bridge.saveAutoSite && <label className={`${s.scopeOption} ${s.autoSite}`}><input type="checkbox" checked={autoSite.enabled} disabled={!ready || changing || needsReload} onChange={event => void changeAutoSite(event.target.checked)} />总是翻译此网站</label>}
    {(error || pageState.error) && <p className={s.error} role="alert">{error || pageState.error}</p>}
    {needsReload && bridge.reloadExtension && <button className={s.secondaryButton} onClick={() => bridge.reloadExtension?.()}>重新加载扩展</button>}
    {settings.sourceLanguage === settings.targetLanguage && <p className={s.shortcutHint}>源语言与目标语言相同。</p>}
    {enabled && <div className={s.translationControls}>
      <div className={s.shortcutHint} role="status">{`已翻译 ${pageState.completed} 段${pageState.pending ? ` · 处理中 ${pageState.pending}` : ''}${pageState.failed ? ` · 失败 ${pageState.failed}` : ''}`}</div>
      {total > 0 && <div className={`${s.progress} ${pageState.failed && !pageState.pending ? s.progressFailed : ''}`} role="progressbar" aria-label="本页翻译进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={pageState.completed}><i style={{ width: `${Math.round(100 * pageState.completed / total)}%` }} /></div>}
      {bridge.saveScope && <label className={s.scopeOption}><input type="checkbox" checked={pageState.scope === 'all'} onChange={event => void bridge.saveScope?.(event.target.checked ? 'all' : 'main').then(setPageState).catch(error=>setError(error.message))} />包括导航等其他区域</label>}
      {(pageState.failed > 0 || pageState.paused) && <button className={`${s.secondaryButton} ${s.retryButton}`} onClick={()=>void bridge.retryTranslation?.().then(setPageState).catch(error=>setError(error.message))}>{pageState.paused ? '继续' : '重试失败段落'}</button>}
    </div>}
    <Usage bridge={bridge} current={pageState.usage} />
    <footer className={s.popupFooter}><span><i className={hasKey && settings.testedAt ? s.statusDot : s.offDot} />{settings.model}</span><button className={s.textButton} onClick={() => bridge.openSettings()}>{!ready ? error ? '状态未知' : '读取中…' : !hasKey ? '未配置' : settings.testedAt ? '已连接' : '尚未测试'}<Icon name="chevron" size={13} /></button></footer>
  </section>;
}
