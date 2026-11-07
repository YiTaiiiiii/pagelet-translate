import type { CSSProperties } from 'react';

type Name = 'translate' | 'settings' | 'arrow' | 'chevron' | 'check' | 'key' | 'eye' | 'eyeOff' | 'external' | 'undo' | 'shield';
const paths: Record<Name, React.ReactNode> = {
  translate: <><path d="m4 5 10 0M9 3v2M6 5c0 5 6 9 6 9M12 5c0 5-6 9-6 9m7 6 4-10 4 10m-6.5-3h5" /></>,
  settings: <><path d="m9.5 4 .7-2h3.6l.7 2 2 .9 2.1-.4 1.8 3.1-1.4 1.6v2.4l1.4 1.6-1.8 3.1-2.1-.4-2 .9-.7 2h-3.6l-.7-2-2-.9-2.1.4-1.8-3.1 1.4-1.6V9.2L3.1 7.6l1.8-3.1 2.1.4z" transform="translate(0 1)" /><circle cx="12" cy="11.5" r="3" /></>,
  arrow: <path d="M4 12h16m-5-5 5 5-5 5" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  key: <><circle cx="8" cy="9" r="5" /><path d="m12 13 8 8m-4-4 3-3m-6 0 3-3" /></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="m3 3 18 18M10 5a10 10 0 0 1 12 7 18 18 0 0 1-3 4M6 6a21 21 0 0 0-4 6s4 7 10 7a11 11 0 0 0 4-1" /></>,
  external: <><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
  undo: <path d="M4 10h10a6 6 0 0 1 0 12M4 10l5-5m-5 5 5 5" transform="translate(0 -2)" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
};
export function Icon({ name, size = 20, style }: { name: Name; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, ...style }}>{paths[name]}</svg>;
}
