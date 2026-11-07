export interface PageState {
  enabled: boolean;
  scope?: import('./engine').Scope;
  paused?: boolean;
  usage?: import('./engine').PageUsage;
  completed: number;
  pending: number;
  failed: number;
  error: string;
}
export const IDLE_STATE: PageState = { enabled: false, completed: 0, pending: 0, failed: 0, error: '' };
export const SESSION_KEY = 'pagelet.sessions';
export interface PageSession extends LanguagePair { id: string; documentId: string; url: string; enabled: boolean }
import type { LanguagePair } from './languages';
