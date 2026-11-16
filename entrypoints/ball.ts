import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { FloatingBall } from '../content/ball';
// Registered for HTTPS pages only while the floating ball is switched on; also
// run on open tabs when it is switched on, so a second run must be harmless.
export default defineUnlistedScript(() => {
  const local = globalThis as typeof globalThis & { __pageletBall?: FloatingBall };
  // A script started while the extension reloads has no runtime: nothing to talk to.
  if (window.top !== window || !chrome.runtime?.id || local.__pageletBall?.alive()) return;
  local.__pageletBall = new FloatingBall();
});
