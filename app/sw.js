// 앱 화면은 캐시 우선, 데이터(market.json/returns.json)는 네트워크 우선
const V = "pr-v1";
const SHELL = ["./", "index.html", "ui.js", "engine.js", "worker.js", "kakao.html", "vendor/plotly-cartesian.min.js", "manifest.webmanifest", "icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;
  if (/\.json$/.test(u.pathname)) {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(V).then(x => x.put(u.pathname, c)); return r; }).catch(() => caches.match(u.pathname)));
  } else {
    // 캐시된 화면을 바로 보여주고, 동시에 새 버전을 받아 다음 실행부터 반영
    e.respondWith(caches.match(e.request).then(m => {
      const net = fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; }).catch(() => m);
      return m || net;
    }));
  }
});
