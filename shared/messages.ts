import type { BatchInput, PageUsage, Scope, SegmentResult } from './engine';
import { parseBatch } from './engine';
import { LANGUAGES, type LanguagePair } from './languages';
import type { DisplayMode, Reply } from './settings';
import type { PageState } from './translation';
import { RELOAD_EXTENSION } from './runtime';

export interface PageStartOptions extends LanguagePair { mode: DisplayMode; endpoint: string }
interface PageEnvelope { version: string; sessionId: string }
export type PageRequest =
  | (PageEnvelope & { type: 'pagelet-plan'; jobs: { id: string; priority: number }[] })
  | (PageEnvelope & { type: 'pagelet-translate'; jobId: string; input: BatchInput })
  | (PageEnvelope & { type: 'pagelet-stop' })
  | (PageEnvelope & { type: 'pagelet-state'; state: PageState });
export type UiRequest =
  | { type: 'get-settings' | 'get-usage' | 'pagelet-retry' | 'pagelet-toggle' | 'pagelet-get-state' }
  | { type: 'save-settings' | 'test-connection'; settings: unknown }
  | { type: 'save-languages'; languages: unknown }
  | { type: 'save-mode'; mode: DisplayMode }
  | { type: 'save-scope'; scope: Scope }
  | { type: 'get-auto-site' }
  | { type: 'save-auto-site'; enabled: boolean }
  | { type: 'get-floating-ball' }
  | { type: 'save-floating-ball'; enabled: boolean };
// From the floating ball's page script; only acts on the sender's own tab.
export interface BallPlace { side: 'left' | 'right'; top: number }
export interface BallStatus { enabled: boolean; place: BallPlace }
export type BallAction = { action: 'toggle' | 'status' } | { action: 'place'; place: BallPlace };
export type BallRequest = { type: 'pagelet-ball'; version: string } & BallAction;
export function parseBallPlace(value: unknown): BallPlace {
  const place = value as Partial<BallPlace> | null;
  return place && (place.side === 'left' || place.side === 'right') && typeof place.top === 'number' && Number.isFinite(place.top)
    ? { side: place.side, top: Math.min(1, Math.max(0, place.top)) } : { side: 'right', top: .6 };
}
export type BackgroundRequest = PageRequest | UiRequest | BallRequest;
// To the floating ball: translation turned on or off, or the ball was switched off.
export type BallMessage = { type: 'pagelet-ball-state'; version: string; enabled?: boolean; remove?: true };
export type PageControlCommand = (
  | { action: 'status' | 'stop' | 'reset' | 'retry' | 'route' }
  | ({ action: 'start'; sessionId: string } & PageStartOptions)
  | { action: 'mode'; mode: DisplayMode }
  | { action: 'scope'; scope: Scope }
  | { action: 'pause'; error: string }
  | { action: 'usage'; usage: PageUsage }
);
export type PageControl = { type: 'pagelet-control'; version: string } & PageControlCommand;
export type PageMessage = PageControl | { type: 'pagelet-result'; version: string; jobId: string; result: SegmentResult };
export type MessageReply<T> = Reply<T> & { unsent?: boolean };
export function sendPageRequest<T = null>(request: PageRequest): Promise<MessageReply<T>> {
  // A page script left behind by a reloaded extension has no runtime any more;
  // fail like a lost reply instead of throwing from a scroll handler.
  try {
    if (!chrome.runtime?.id) throw new Error(RELOAD_EXTENSION);
    return chrome.runtime.sendMessage(request);
  } catch { return Promise.reject(new Error(RELOAD_EXTENSION)); }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
function mode(value: unknown): value is DisplayMode { return value === 'bilingual' || value === 'translated'; }
function scope(value: unknown): value is Scope { return value === 'main' || value === 'all'; }
function pair(value: Record<string, unknown>) {
  return typeof value.sourceLanguage === 'string' && (value.sourceLanguage === 'auto' || Object.hasOwn(LANGUAGES, value.sourceLanguage)) && typeof value.targetLanguage === 'string' && Object.hasOwn(LANGUAGES, value.targetLanguage);
}
export function isPageState(value: unknown): value is PageState {
  return object(value) && typeof value.enabled === 'boolean' && ['completed', 'pending', 'failed'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) && typeof value.error === 'string';
}
export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  if (!object(value)) return false;
  switch (value.type) {
    case 'get-settings': case 'get-usage': case 'pagelet-retry': case 'pagelet-toggle': case 'pagelet-get-state': return true;
    case 'save-settings': case 'test-connection': return 'settings' in value;
    case 'save-languages': return 'languages' in value;
    case 'save-mode': return mode(value.mode);
    case 'save-scope': return scope(value.scope);
    case 'get-auto-site': return true;
    case 'save-auto-site': return typeof value.enabled === 'boolean';
    case 'get-floating-ball': return true;
    case 'save-floating-ball': return typeof value.enabled === 'boolean';
    case 'pagelet-ball': return typeof value.version === 'string' && (value.action === 'toggle' || value.action === 'status' || (value.action === 'place' && object(value.place)));
  }
  if (typeof value.sessionId !== 'string' || typeof value.version !== 'string') return false;
  switch (value.type) {
    case 'pagelet-stop': return true;
    case 'pagelet-state': return isPageState(value.state);
    case 'pagelet-plan': return Array.isArray(value.jobs) && value.jobs.length <= 2000 && value.jobs.every(job => object(job) && typeof job.id === 'string' && typeof job.priority === 'number' && Number.isFinite(job.priority));
    case 'pagelet-translate':
      if (typeof value.jobId !== 'string') return false;
      try { parseBatch(value.input); return true; } catch { return false; }
    default: return false;
  }
}
export function isPageMessage(value: unknown): value is PageMessage {
  if (!object(value) || typeof value.version !== 'string') return false;
  if (value.type === 'pagelet-result') {
    return typeof value.jobId === 'string' && object(value.result) && typeof value.result.id === 'string' && (value.result.text === undefined || typeof value.result.text === 'string') && (value.result.error === undefined || typeof value.result.error === 'string');
  }
  if (value.type !== 'pagelet-control') return false;
  switch (value.action) {
    case 'status': case 'stop': case 'reset': case 'retry': case 'route': return true;
    case 'start': return typeof value.sessionId === 'string' && typeof value.endpoint === 'string' && mode(value.mode) && pair(value);
    case 'mode': return mode(value.mode);
    case 'scope': return scope(value.scope);
    case 'pause': return typeof value.error === 'string';
    case 'usage': {
      const usage = value.usage;
      return object(usage) && ['requests', 'input', 'output', 'hit', 'unknown'].every(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]));
    }
    default: return false;
  }
}
