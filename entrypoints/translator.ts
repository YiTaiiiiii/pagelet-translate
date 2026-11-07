import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { PageTranslation } from '../content/session';
import { BUILD_VERSION, RELOAD_EXTENSION } from '../shared/runtime';
import { isPageMessage } from '../shared/messages';
import { IDLE_STATE } from '../shared/translation';
export default defineUnlistedScript(() => {
  const local = globalThis as typeof globalThis & { __pageletInstalled?: boolean };
  if (local.__pageletInstalled) return;
  local.__pageletInstalled = true;
  // After the extension is reloaded, a new script starts in a fresh world while
  // the old one's translations stay in the page. Translating again would stack a
  // second translation under each paragraph, so ask for a refresh instead.
  if (document.querySelector('[data-pagelet-output],[data-pagelet-hint],pagelet-bar,pagelet-progress')) {
    chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
      if (sender.id !== chrome.runtime.id) return;
      respond({ ...IDLE_STATE, enabled: true, version: 'stale-page' });
    });
    return;
  }
  const page = new PageTranslation();
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return;
    // A worker from another build may use another message shape. Report the
    // version mismatch before validating the protocol, without running its command.
    if (!('version' in message) || message.version !== BUILD_VERSION) {
      respond({ ...page.state, error: RELOAD_EXTENSION, version: BUILD_VERSION });
      return;
    }
    if (!isPageMessage(message)) return;
    if (message.type === 'pagelet-result') page.receive(message.jobId,message.result);
    if (message.type === 'pagelet-control') {
      switch (message.action) {
        case 'start': page.start(message.sessionId,message); break;
        case 'stop': page.stop(); break;
        case 'reset': page.reset(); break;
        case 'mode': page.setMode(message.mode); break;
        case 'scope': page.setScope(message.scope); break;
        case 'retry': page.retry(); break;
        case 'pause': page.pause(message.error); break;
        case 'usage': page.usage(message.usage); break;
        case 'route': page.route(); break;
      }
    }
    respond({ ...page.state, version: BUILD_VERSION });
  });
  window.addEventListener('pagehide', () => page.reset());
});
