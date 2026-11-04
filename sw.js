// 競輪3連単ラボ：一度開いたら、電波が弱くてもスマホの中から開けるようにする仕組み
// 方針：まずネットから最新を取りにいき（更新がすぐ届く）、取れないときだけ、スマホに残した写しを使う。
// このアプリのファイルだけを扱う。共有学習のサーバーや天気のデータは扱わない（いつも最新を使う）。
const CACHE = "keirin-lab-v1";
const FILES = ["./", "index.html", "style.css", "config.js", "refdata.js", "parser.js", "engine.js", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;   // ほかのサイトへの通信には関わらない
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match("index.html")))
  );
});
