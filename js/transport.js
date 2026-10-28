// One shared scheduler: starting something in one tab stops whatever else is playing.
import { Scheduler, keepAwake } from './audio.js';
import { state } from './store.js';

export const scheduler = new Scheduler();
let owner = null;
let ownerStopped = null;

export function claim(name, onStopped) {
  if (owner && owner !== name) {
    const cb = ownerStopped;
    owner = null;
    scheduler.stop();
    cb?.();
  }
  owner = name;
  ownerStopped = onStopped;
  if (state.prefs.keepAwake) keepAwake(true);
}

export function release(name) {
  if (owner !== name) return;
  owner = null;
  ownerStopped = null;
  keepAwake(false);
}

export function isOwner(name) {
  return owner === name;
}

// Wake locks are dropped when the page is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && owner && state.prefs.keepAwake) keepAwake(true);
});
