import { writable } from 'svelte/store';

/** True once a newer version of the app has taken over this tab and a reload is needed. */
export const updateReady = writable(false);

/** How often an open till asks whether a new version was deployed. */
export const updateCheckMs = 5 * 60_000;

/**
 * A till can stay open for days without navigating, so the browser never looks for a new
 * service worker on its own. Ask regularly; when a new version takes control, the old code in
 * this tab no longer has its files cached (the PDF library loads on demand), so ask for a reload.
 * The first install on a fresh device also changes the controller, and that one is not an update.
 */
export function watchForUpdates(container: ServiceWorkerContainer | undefined = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker, intervalMs = updateCheckMs): () => void {
  if (!container) return () => {};
  const hadController = !!container.controller;
  const onControllerChange = () => { if (hadController) updateReady.set(true); };
  const check = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    void container.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
  };
  const onVisible = () => { if (document.visibilityState === 'visible') check(); };
  container.addEventListener('controllerchange', onControllerChange);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', onVisible);
  const timer = window.setInterval(check, intervalMs);
  return () => {
    container.removeEventListener('controllerchange', onControllerChange);
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', onVisible);
    window.clearInterval(timer);
  };
}
