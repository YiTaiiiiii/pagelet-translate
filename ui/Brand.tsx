import s from './ui.module.css';
// Same drawing as public/icon.svg: original lines in white, translations in amber.
export function Logo({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" style={{ display: 'block', flex: 'none' }}><rect x="1" y="1" width="126" height="126" rx="30" fill="#3346c9" /><g strokeLinecap="round" strokeWidth="14"><path d="M29 36h70M29 76h70" stroke="#fff" /><path d="M29 56h44M29 96h34" stroke="#ffb547" /></g></svg>;
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={s.brand}><span className={s.mark}><Logo size={compact ? 33 : 39} /></span><div><span className={s.brandName}>原页</span>{!compact && <span className={s.brandSub}>PAGELET</span>}</div></div>;
}
