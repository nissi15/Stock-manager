/// <reference lib="webworker" />

import { assets, immutable } from '$app/manifest';
import { version } from '$app/env';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = `stock-manager-shell-${version}`;
const appUrl = new URL('./', worker.registration.scope).toString();
const shellFiles = [...immutable, ...assets].map(({ path }) => new URL(path, worker.registration.scope).toString());

worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll([...shellFiles, appUrl])));
  worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('stock-manager-shell-') && name !== cacheName) await caches.delete(name);
    await worker.clients.claim();
  })());
});

worker.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin) return; // Never cache Supabase requests or auth tokens.

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () => {
      const cached = await caches.match(appUrl);
      return cached ?? Response.error();
    }));
    return;
  }

  if (shellFiles.includes(event.request.url)) {
    event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
  }
});
