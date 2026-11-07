import { useEffect, useState } from 'react';
import type { UiBridge } from '../shared/settings';
import { type UsageRecord } from '../shared/usage';
import s from './ui.module.css';
const number = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });

export function Usage({ bridge, current }: { bridge: UiBridge; current?: import('../shared/engine').PageUsage }) {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(bridge.getUsage));
  useEffect(() => {
    let active = true;
    void bridge.getUsage?.().then(value => { if (active) setRecords(value); }).catch(error => { if (active) setError(error instanceof Error ? error.message : '消耗记录读取失败。'); }).finally(() => { if (active) setLoading(false); });
    const stop = bridge.watchUsage?.(value => { if (active) setRecords(value); });
    return () => { active = false; stop?.(); };
  }, [bridge]);
  function sum(key: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens' | 'cacheMissTokens') {
    const known = records.flatMap(record => record[key] === null ? [] : [record[key]]);
    return known.length ? number(known.reduce((a, b) => a + b, 0)) + (known.length < records.length ? '+' : '') : '—';
  }
  return <details className={s.usage}>
    <summary>消耗记录<span>{error ? '读取失败' : loading ? '读取中…' : current ? `本页 ${current.requests} 次 · ${number(current.input+current.output)}${current.unknown ? '+' : ''} token` : records.length ? `近 ${records.length} 次 · ${sum('totalTokens')} token` : '暂无记录'}</span></summary>
    {error ? <p className={s.error}>{error}</p> :
    <div className={s.usageBody}>
      {current && <p>本页输入 {number(current.input)} · 输出 {number(current.output)} · 命中 {number(current.hit)}{current.unknown ? ` · ${current.unknown} 次用量未知` : ''}</p>}
      <div className={s.usageTotals}><span>输入 <strong>{sum('inputTokens')}</strong></span><span>输出 <strong>{sum('outputTokens')}</strong></span><span>缓存命中 <strong>{sum('cacheReadTokens')}</strong></span><span>未命中 <strong>{sum('cacheMissTokens')}</strong></span></div>
      <p>所有页面最近 {records.length} 次请求 · 仅本机保存<br />平均 TPS = 输出 token ÷ 请求总秒数</p>
      {!!records.length && <div className={s.usageRows}><table><thead><tr><th>请求</th><th>输入/输出</th><th>命中</th><th>均 TPS</th></tr></thead><tbody>{[...records].reverse().map(record => <tr key={record.id}>
        <td>{new Date(record.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}<small>{record.kind === 'connection' ? '连接测试' : '翻译'} · {(record.durationMs / 1000).toFixed(2)}s{record.firstContentMs != null ? ` · 首字 ${(record.firstContentMs/1000).toFixed(2)}s` : ''}{record.status !== 'ok' ? record.status === 'cancelled' ? ' · 已取消' : ' · 失败' : ''}</small></td>
        <td>{number(record.inputTokens)}/{number(record.outputTokens)}</td><td>{number(record.cacheReadTokens)}</td><td>{record.averageTps === null ? '—' : record.averageTps.toFixed(1)}</td>
      </tr>)}</tbody></table></div>}
      <p>最多保留 100 次，含重试与连接测试；“—”为接口未返回，“+”表示仅统计已知用量。</p>
    </div>}
  </details>;
}
