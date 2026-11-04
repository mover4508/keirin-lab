// 競輪3連単ラボ 共有学習サーバー本体（起動用の bootstrap.gs が、開発者の承認後に動かす）
// 中身：Code.gs（受け付け・学習・配布）＋ refdata.js（参照データ）＋ engine.js（予想エンジン）

// 競輪3連単ラボ 共有学習サーバー（Google Apps Script）
// 役割：みんなの照合済みレースを受け付け、検証し、時系列順に学習し直して、共有モデルを配る。
// このサーバーもWeb検索やほかのサイトの閲覧はしない。受け取るのは、利用者が貼った表から読み取ったデータと結果だけ。
// 起動用スクリプト（bootstrap.gs）が、開発者の承認したこのコードだけを動かす。
// ドライブには触らない（スプレッドシートだけを使う）。

var SHEET_NAME = "競輪3連単ラボ 共有データ";
var MODEL_SHEET = "model";      // 共有モデルはスプレッドシートに保存する（ドライブへの書き込み権限が要らない）
var CHUNK = 45000;               // 1つのセルに入れる文字数（上限は5万字）
var MAX_PER_DAY = 200;           // 1人1日に送れるレース数の上限
var MAX_PER_HOUR_ALL = 600;      // 開発者以外の全員で、1時間に受け付けるレース数の上限（大量送信への対策）
var MAX_BODY = 512 * 1024;       // 1回の送信の大きさの上限（文字数）
var MAX_ROWS = 100000;           // 受け付けたレースを保存する行数の上限
var TRUST_MIN = 3;               // 信頼できる送信者になるのに必要な「開発者と一致したレース数」

/* ========== 準備（初回のアクセスで自動的に行う） ========== */
function ensureSetup_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("READY") === "1") return;
  setup();
  props.setProperty("READY", "1");
}
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty("SHEET_ID")) {
    var ss = SpreadsheetApp.create(SHEET_NAME);
    var sh = ss.getSheets()[0]; sh.setName("submissions");
    sh.appendRow(["受信日時", "レース", "送信者", "開発者", "結果の指紋", "データ"]);
    sh.setFrozenRows(1);
    var log = ss.insertSheet("log"); log.appendRow(["日時", "内容"]);
    ss.insertSheet(MODEL_SHEET);
    props.setProperty("SHEET_ID", ss.getId());
  }
  if (!props.getProperty("OWNER_TOKEN")) {
    props.setProperty("OWNER_TOKEN", Utilities.getUuid().replace(/-/g, ""));
  }
  // 1時間ごとに学習し直す
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "rebuild") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("rebuild").timeBased().everyHours(1).create();
  rebuild_();
  Logger.log("準備完了");
}

function modelSheet_() {
  var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID"));
  return ss.getSheetByName(MODEL_SHEET) || ss.insertSheet(MODEL_SHEET);
}
function readModel_() {
  var cache = CacheService.getScriptCache(), c = cache.get("model");
  if (c) return c;
  var sh = modelSheet_(), n = sh.getLastRow();
  if (!n) return null;
  var text = sh.getRange(1, 1, n, 1).getValues().map(function (r) { return r[0]; }).join("");
  if (text.length < 100000) cache.put("model", text, 3600);
  return text;
}
function writeModel_(text) {
  var sh = modelSheet_(); sh.clear();
  var rows = [];
  for (var i = 0; i < text.length; i += CHUNK) rows.push([text.slice(i, i + CHUNK)]);
  if (rows.length) sh.getRange(1, 1, rows.length, 1).setNumberFormat("@").setValues(rows);
  var cache = CacheService.getScriptCache();
  if (text.length < 100000) cache.put("model", text, 3600); else cache.remove("model");
}
function sheet_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID")).getSheetByName("submissions"); }
function log_(text) { try { SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID")).getSheetByName("log").appendRow([new Date(), text]); } catch (e) {} }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/* ========== 共有モデルを配る ========== */
function doGet(e) {
  ensureSetup_();
  var action = (e && e.parameter && e.parameter.action) || "model";
  if (action === "claim") {
    // 開発者用の合言葉は、最初の1回だけ表示する
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty("CLAIMED") === "1") return json_({ ok: false, reason: "合言葉はすでに受け取り済みです" });
    props.setProperty("CLAIMED", "1");
    return json_({ ok: true, ownerToken: props.getProperty("OWNER_TOKEN"), note: "この合言葉をアプリの「保存・説明」→「開発者向け」に入れてください。二度と表示されません。" });
  }
  if (action === "model") {
    var text = readModel_();
    if (!text) return json_({ ok: false, reason: "まだ共有モデルがありません" });
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  }
  if (action === "status") {
    var t2 = readModel_();
    var m = t2 ? JSON.parse(t2) : null;
    return json_({ ok: true, builtAt: m && m.builtAt, races: m && m.stats && m.stats.races, ver: m && m.model && m.model.ver });
  }
  // それ以外の操作は受け付けない（情報を出しすぎない）
  return json_({ ok: false, reason: "不明な操作" });
}

/* ========== 照合済みレースを受け付ける ========== */
function doPost(e) {
  ensureSetup_();
  if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > MAX_BODY) return json_({ ok: false, reason: "送信が大きすぎます" });
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    var isOwner = !!(body.ownerToken && body.ownerToken === props.getProperty("OWNER_TOKEN"));
    // ----- 開発者だけの操作 -----
    if (body.action === "rebuild" || body.action === "rotateToken" || body.action === "adminStats" || body.action === "block") {
      if (!isOwner) { log_("開発者専用の操作が合言葉なしで試された：" + String(body.action).slice(0, 20)); return json_({ ok: false, reason: "開発者だけが実行できます" }); }
      if (body.action === "rebuild") return json_({ ok: true, rebuilt: rebuild_(!!body.full) });
      if (body.action === "rotateToken") {
        var nt = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
        props.setProperty("OWNER_TOKEN", nt);
        log_("合言葉を新しくした");
        return json_({ ok: true, ownerToken: nt });
      }
      if (body.action === "block") {
        var id = String(body.clientId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
        var bl = JSON.parse(props.getProperty("BLOCKED") || "[]");
        if (id && bl.indexOf(id) < 0) bl.push(id);
        props.setProperty("BLOCKED", JSON.stringify(bl.slice(-500)));
        log_("送信者をブロック：" + id);
        return json_({ ok: true, blocked: bl.length });
      }
      if (body.action === "adminStats") return json_({ ok: true, stats: JSON.parse(props.getProperty("LAST_STATS") || "{}"), blocked: JSON.parse(props.getProperty("BLOCKED") || "[]").length });
    }
    if (body.action !== "submit") return json_({ ok: false, reason: "不明な操作" });
    // ----- 送信の受け付け -----
    var clientId = String(body.clientId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    if (!clientId) return json_({ ok: false, reason: "送信者の識別子がありません" });
    var blocked = JSON.parse(props.getProperty("BLOCKED") || "[]");
    if (!isOwner && blocked.indexOf(clientId) >= 0) return json_({ ok: true, accepted: 0, rejected: [] });   // ブロック中の送信者には理由を教えない
    var items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    var sh = sheet_();
    if (!isOwner && sh.getLastRow() >= MAX_ROWS) return json_({ ok: false, reason: "受け付けを一時停止しています" });
    var now = new Date(), today = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd"), hour = Utilities.formatDate(now, "Asia/Tokyo", "yyyyMMddHH");
    var cache = CacheService.getScriptCache(), ck = "n_" + clientId + "_" + today, hk = "h_" + hour;
    var sent = Number(cache.get(ck) || 0), hourAll = Number(cache.get(hk) || 0);
    var accepted = 0, rejected = [], rows = [];
    items.forEach(function (it) {
      if (!isOwner && sent >= MAX_PER_DAY) { rejected.push({ key: it && it.raceKey, reason: "1日の上限に達しました" }); return; }
      if (!isOwner && hourAll >= MAX_PER_HOUR_ALL) { rejected.push({ key: it && it.raceKey, reason: "混み合っています。時間をおいて送ってください" }); return; }
      var v = validate_(it);
      if (!v.ok) { rejected.push({ key: it && it.raceKey, reason: v.reason }); return; }
      rows.push([now, v.item.raceKey, clientId, isOwner, v.sig, JSON.stringify(v.item)]);
      accepted++; sent++; if (!isOwner) hourAll++;
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
    cache.put(ck, String(sent), 21600); cache.put(hk, String(hourAll), 7200);
    return json_({ ok: true, accepted: accepted, rejected: rejected });
  } catch (err) {
    return json_({ ok: false, reason: "受け付けできませんでした" });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/* ========== 受け付けたデータの検証（決まった形だけを取り出す） ========== */
function validate_(it) {
  if (!it || typeof it !== "object") return { ok: false, reason: "形が正しくありません" };
  var m = it.meta || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date || "")) return { ok: false, reason: "開催日がありません" };
  if (!REF.venues[m.venue]) return { ok: false, reason: "場が分かりません" };
  var raceNo = Number(m.raceNo); if (!(raceNo >= 1 && raceNo <= 12)) return { ok: false, reason: "レース番号が正しくありません" };
  var today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
  if (m.date > today) return { ok: false, reason: "未来のレースは受け付けません" };
  var riders = (it.riders || []).map(function (r) {
    return { no: num_(r.no), frame: num_(r.frame), name: str_(r.name, 12), age: num_(r.age), pref: str_(r.pref, 4), ki: num_(r.ki), cls: str_(r.cls, 2), style: str_(r.style, 1),
      gear: num_(r.gear), score: num_(r.score), n1: num_(r.n1), n2: num_(r.n2), n3: num_(r.n3), nOut: num_(r.nOut), win: num_(r.win), ren2: num_(r.ren2), ren3: num_(r.ren3),
      nige: num_(r.nige), makuri: num_(r.makuri), sashi: num_(r.sashi), mark2: num_(r.mark2), s: num_(r.s), b: num_(r.b), comment: str_(r.comment, 40),
      meets: (r.meets || []).slice(0, 3).map(function (x) { return { venue: str_(x.venue, 6), date: str_(x.date, 5), res: str_(x.res, 12) }; }),
      recent: (r.recent || []).slice(0, 12).map(function (x) { return { type: x.type ? str_(x.type, 1) : null, res: typeof x.res === "number" ? x.res : str_(x.res, 1) }; }) };
  });
  var n = riders.length;
  if (n < 5 || n > 9) return { ok: false, reason: "選手の人数が正しくありません" };
  var nos = riders.map(function (r) { return r.no; });
  if (nos.some(function (x) { return !(x >= 1 && x <= n); }) || unique_(nos).length !== n) return { ok: false, reason: "車番が正しくありません" };
  var lineup = (it.lineup || []).map(function (l) { return (l || []).map(Number).filter(function (x) { return nos.indexOf(x) >= 0; }); }).filter(function (l) { return l.length; });
  var odds = {};
  Object.keys(it.odds || {}).forEach(function (k) { var o = Number(it.odds[k]); if (/^[1-9]-[1-9]-[1-9]$/.test(k) && o >= 1 && o < 100000) odds[k] = o; });
  var res = it.result || {};
  var order = (res.order || []).map(Number);
  if (order.length !== 3 || unique_(order).length !== 3 || order.some(function (x) { return nos.indexOf(x) < 0; })) return { ok: false, reason: "着順が正しくありません" };
  var pays = (res.pays || []).map(function (p) { return { combo: (p.combo || []).map(Number), pay: Number(p.pay), popular: Number(p.popular) || null }; })
    .filter(function (p) { return p.combo.length === 3 && p.pay >= 100 && p.pay < 100000000; });
  if (!pays.length) return { ok: false, reason: "3連単の払戻がありません" };
  if (!pays.some(function (p) { return p.combo.join("-") === order.join("-"); })) return { ok: false, reason: "着順と払戻の組番が合いません" };
  // 払戻とオッズの整合：確定オッズなら払戻はほぼオッズ×100円、締め切り前なら大きくは離れない
  var oddsN = Object.keys(odds).length, need = n * (n - 1) * (n - 2);
  if (oddsN && oddsN !== need) return { ok: false, reason: "オッズの組み合わせ数が正しくありません" };
  var oddsType = it.oddsType === "確定" ? "確定" : "締め切り前";
  for (var q = 0; q < pays.length; q++) {
    var o = odds[pays[q].combo.join("-")];
    if (!o) continue;
    var ratio = pays[q].pay / (o * 100);
    if (oddsType === "確定" ? (ratio < 0.85 || ratio > 1.15) : (ratio < 0.25 || ratio > 4)) return { ok: false, reason: "払戻とオッズが合いません" };
  }
  var finishers = (res.finishers || []).slice(0, 9).map(function (f) { return { rank: typeof f.rank === "number" ? f.rank : str_(f.rank, 1), no: num_(f.no), kimarite: f.kimarite ? str_(f.kimarite, 4) : null }; });
  var cond = it.cond || {};
  var item = {
    raceKey: m.date + "|" + m.venue + "|" + raceNo,
    oddsType: oddsType,
    meta: { date: m.date, venue: m.venue, raceNo: raceNo, day: str_(m.day, 4), grade: str_(m.grade, 4), kind: str_(m.kind, 10), cars: n },
    riders: riders, lineup: lineup, odds: odds,
    cond: { weather: ["晴", "曇", "雨"].indexOf(cond.weather) >= 0 ? cond.weather : null, windDir: REF.wind[cond.windDir] ? cond.windDir : null, windStr: cond.windStr === "強" ? "強" : null },
    result: { order: order, pays: pays, finishers: finishers }
  };
  // 結果の指紋：着順と3連単の払戻が同じなら同じ指紋になる
  var sig = order.join("-") + "/" + pays.map(function (p) { return p.combo.join("-") + ":" + p.pay; }).sort().join(",");
  return { ok: true, item: item, sig: sig };
}
function num_(v) { var n = Number(v); return isFinite(n) && v !== null && v !== "" ? n : null; }
function str_(v, max) { return v == null ? null : String(v).replace(/[\u0000-\u001f<>]/g, "").slice(0, max); }
function unique_(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }

/* ========== 学習し直す（時系列順に、最初から） ========== */
function rebuild() { ensureSetup_(); return rebuild_(); }
// 続きから学習するための途中の状態（checkpoint シート）
function readCheckpoint_() {
  try {
    var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID")), sh = ss.getSheetByName("checkpoint");
    if (!sh || !sh.getLastRow()) return null;
    var cp = JSON.parse(sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return r[0]; }).join(""));
    return cp && cp.keys && cp.state ? cp : null;
  } catch (e) { return null; }
}
function writeCheckpoint_(cp) {
  try {
    var ss = SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID")), sh = ss.getSheetByName("checkpoint") || ss.insertSheet("checkpoint");
    var text = JSON.stringify(cp), rows = [];
    for (var i = 0; i < text.length; i += CHUNK) rows.push([text.slice(i, i + CHUNK)]);
    sh.clear(); if (rows.length) sh.getRange(1, 1, rows.length, 1).setNumberFormat("@").setValues(rows);
  } catch (e) { log_("途中の状態を保存できませんでした（次は最初から学習します）"); }
}
function rebuild_(full) {
  var sh = sheet_(), rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues() : [];
  // レースごとにまとめる
  var groups = {};
  rows.forEach(function (r) {
    var key = r[1]; if (!key) return;
    var g = groups[key] || (groups[key] = { owner: null, bySig: {} });
    var item; try { item = JSON.parse(r[5]); } catch (e) { return; }
    var sig = r[4], client = r[2];
    if (r[3] === true || r[3] === "TRUE") { if (!g.owner) g.owner = { sig: sig, item: item }; }
    var s = g.bySig[sig] || (g.bySig[sig] = { clients: {}, item: item });
    s.clients[client] = true;
  });
  // 送信者の信頼度：開発者が照合した同じレースと結果が一致すると+1。1回でも食い違えば、その送信者のデータは使わない
  var props = PropertiesService.getScriptProperties();
  var blocked = {}; JSON.parse(props.getProperty("BLOCKED") || "[]").forEach(function (b) { blocked[b] = true; });
  var trust = {}, bad = {};
  Object.keys(groups).forEach(function (key) {
    var g = groups[key]; if (!g.owner) return;
    Object.keys(g.bySig).forEach(function (sig) {
      Object.keys(g.bySig[sig].clients).forEach(function (c) {
        if (sig === g.owner.sig) trust[c] = (trust[c] || 0) + 1; else bad[c] = true;
      });
    });
  });
  var usable = function (c) { return !blocked[c] && !bad[c]; };
  var trusted = function (c) { return usable(c) && (trust[c] || 0) >= TRUST_MIN; };
  // 採用の決まり：
  //  ・開発者が照合したレースは採用（開発者の結果を正とする）
  //  ・それ以外は、信頼できる送信者2人以上の結果が一致し、使える送信者の中に食い違いがないレースだけ採用
  var acceptedRaces = [], conflicts = 0, waiting = 0, ownerN = 0, publicN = 0;
  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    if (g.owner) { acceptedRaces.push(g.owner.item); ownerN++; return; }
    var sigs = Object.keys(g.bySig).filter(function (sig) { return Object.keys(g.bySig[sig].clients).some(usable); });
    if (!sigs.length) return;
    if (sigs.length > 1) { conflicts++; return; }
    var s = g.bySig[sigs[0]];
    if (Object.keys(s.clients).filter(trusted).length >= 2) { acceptedRaces.push(s.item); publicN++; } else waiting++;
  });
  // 時系列順（開催日・場・レース番号）
  acceptedRaces.sort(function (a, b) { return a.meta.date < b.meta.date ? -1 : a.meta.date > b.meta.date ? 1 : a.meta.raceNo - b.meta.raceNo; });
  // 続きから学習する：前回までに学習したレースの並びが、今回の並びの先頭とそのまま同じなら、増えた分だけ学習する。
  // 並びが変わった（古い日付のレースが増えた、採用が変わった、エンジンが変わった）ときは、最初から学習し直す。
  var keys = acceptedRaces.map(function (it) { return it.raceKey; });
  var cp = full ? null : readCheckpoint_(), st0 = null, from = 0, mode = "最初から";
  if (cp && cp.engineVer === KEngine.ENGINE_VER && cp.keys.length <= keys.length && cp.keys.every(function (k, i) { return keys[i] === k; })) {
    st0 = cp.state; from = cp.keys.length; mode = "続きから（" + (keys.length - from) + "R）";
  }
  var state = KEngine.replay(acceptedRaces.slice(from), st0);   // 共有の学習は、その時点までのデータだけで予想してから学習する
  state.metaLog = state.metaLog.slice(0, 50);
  writeCheckpoint_({ engineVer: KEngine.ENGINE_VER, keys: keys, state: state });
  var out = { app: "競輪3連単ラボ", kind: "shared", builtAt: new Date().toISOString(), engineVer: KEngine.ENGINE_VER,
    stats: state.stats, conflicts: conflicts, model: state.model, acc: state.acc, metaLog: state.metaLog.slice(0, 20) };
  writeModel_(JSON.stringify(out));
  var st = { at: new Date().toISOString(), owner: ownerN, public: publicN, waiting: waiting, conflicts: conflicts,
    clients: Object.keys(trust).length + Object.keys(bad).length, trusted: Object.keys(trust).filter(trusted).length, excluded: Object.keys(bad).length };
  props.setProperty("LAST_STATS", JSON.stringify(st));
  log_("学習し直し（" + mode + "）：開発者 " + ownerN + "R・みんな " + publicN + "R・確認待ち " + waiting + "R・食い違い " + conflicts + "R・除外した送信者 " + st.excluded);
  return { races: acceptedRaces.length, conflicts: conflicts, owner: ownerN, public: publicN, waiting: waiting };
}

/* ===== refdata.js ===== */
// 競輪3連単ラボ 参照データ（開発時に調べて固定した値）
// 運用中はこの値だけを使い、Webは見ない。値を見直すときは開発作業として行い、出典と日付を更新する。


const REF = {
  checkedAt: "2026-11-03",
  sources: {
    bank: "競輪予想サイト解体新書「全国のバンクデータ一覧」https://www.centresource.com/column/keirinjo-bank-ichiran/",
    nigeRate: "kouei-lab「競輪全41場 バンク別データ一覧」（KEIRIN.JP公表データをもとに集計、原則直近3年）https://kouei-lab.com/keirin-venues.html",
    kimarite: "競輪予想サイト解体新書「競輪の決まり手」https://www.centresource.com/column/keirin-kimarite/",
    position: "ケイリンログ「ライン番手理論は本当か」https://note.com/keirinlogs/n/n206dfe0dcd31",
    popular: "競輪データ解析「1番人気を買い続けた場合の回収率と的中率（3連単）」2012年〜2023年12月 https://ai-keirin.hatenablog.com/entry/2019/05/18/112019",
    area: "ニコニコ大百科「競輪」（新潟・長野・山梨は関東、南関東は千葉・神奈川・静岡、福井は近畿）",
    wind: "競輪ブラザー「競輪の天気の影響」https://keirin-brother.com/method/weather/",
    homeHead: "競輪ブラザー「競輪の天気の影響」の競輪場別の風向き表（2026-11-04確認。41場とも、左回りの幾何と矛盾なし）",
    geo: "競輪場のおおよその位置（市町村レベル。天気の取得にだけ使う）",
    weatherApi: "Open-Meteo（https://open-meteo.com）の気象データ。天気の自動取得にだけ使う"
  },
  // ホームで向かい風になる風の方角（度。北=0、東=90、南=180、西=270）。ドーム（前橋・小倉）は含めない
  homeHead: {
    "函館": 180, "青森": 135, "いわき平": 45, "弥彦": 180, "取手": 225, "宇都宮": 315, "大宮": 90, "西武園": 90,
    "京王閣": 315, "立川": 270, "松戸": 45, "川崎": 270, "平塚": 225, "小田原": 90, "伊東": 270, "静岡": 225,
    "名古屋": 315, "岐阜": 270, "大垣": 225, "豊橋": 180, "富山": 90, "松阪": 225, "四日市": 225, "福井": 180,
    "奈良": 270, "向日町": 90, "和歌山": 45, "岸和田": 315, "玉野": 180, "広島": 135, "防府": 90, "高松": 90,
    "小松島": 135, "高知": 90, "松山": 315, "久留米": 135, "武雄": 225, "佐世保": 225, "別府": 180, "熊本": 225
  },
  // 競輪場のおおよその位置（緯度・経度）
  geo: {
    "函館": [41.787, 140.764], "青森": [40.80, 140.74], "いわき平": [37.064, 140.887], "弥彦": [37.700, 138.818],
    "前橋": [36.401, 139.054], "取手": [35.912, 140.054], "宇都宮": [36.553, 139.881], "大宮": [35.920, 139.635],
    "西武園": [35.770, 139.446], "京王閣": [35.641, 139.565], "立川": [35.704, 139.399], "松戸": [35.783, 139.905],
    "川崎": [35.533, 139.704], "平塚": [35.329, 139.344], "小田原": [35.256, 139.152], "伊東": [34.968, 139.093],
    "静岡": [34.987, 138.392], "名古屋": [35.164, 136.872], "岐阜": [35.420, 136.770], "大垣": [35.369, 136.611],
    "豊橋": [34.759, 137.368], "富山": [36.746, 137.278], "松阪": [34.565, 136.534], "四日市": [34.971, 136.630],
    "福井": [36.069, 136.207], "奈良": [34.668, 135.822], "向日町": [34.940, 135.703], "和歌山": [34.224, 135.181],
    "岸和田": [34.457, 135.385], "玉野": [34.493, 133.946], "広島": [34.364, 132.475], "防府": [34.042, 131.568],
    "高松": [34.326, 134.050], "小松島": [34.006, 134.592], "高知": [33.546, 133.562], "松山": [33.825, 132.734],
    "小倉": [33.874, 130.873], "久留米": [33.316, 130.522], "武雄": [33.188, 130.018], "佐世保": [33.166, 129.728],
    "別府": [33.295, 131.491], "熊本": [32.788, 130.744]
  },
  // 発走時刻の目安（開催の時間帯ごとの1Rの発走と、レースの間隔。仮置き）
  timeBand: {
    morning: { label: "モーニング", start: "08:30", step: 25 },
    day: { label: "デイ", start: "11:00", step: 30 },
    night: { label: "ナイター", start: "15:20", step: 30 },
    midnight: { label: "ミッドナイト", start: "21:00", step: 25 }
  },
  // 天気の判定（仮置き）：降水量0.5mm以上か雨の天気コードで雨、雲量70%以上で曇、風速2m/s未満は風なし、5m/s以上は強風
  weatherRule: { rainMm: 0.5, cloudPct: 70, calmMs: 2, strongMs: 5 },

  // 場：府県、周長(m)、みなし直線(m)、カント(度)、ドーム、逃げ1着率(%)
  venues: {
    "函館":   { pref: "北海道", len: 400, straight: 51.3, cant: 30.61, dome: false, nige: 25.3 },
    "青森":   { pref: "青森",   len: 400, straight: 58.9, cant: 32.25, dome: false, nige: 21.9 },
    "いわき平": { pref: "福島", len: 400, straight: 62.7, cant: 32.91, dome: false, nige: 20.8 },
    "弥彦":   { pref: "新潟",   len: 400, straight: 63.1, cant: 32.41, dome: false, nige: 19.7 },
    "前橋":   { pref: "群馬",   len: 335, straight: 46.7, cant: 36.00, dome: true,  nige: 32.8 },
    "取手":   { pref: "茨城",   len: 400, straight: 54.8, cant: 31.51, dome: false, nige: 25.5 },
    "宇都宮": { pref: "栃木",   len: 500, straight: 63.3, cant: 25.80, dome: false, nige: 23.4 },
    "大宮":   { pref: "埼玉",   len: 500, straight: 66.7, cant: 26.28, dome: false, nige: 20.9 },
    "西武園": { pref: "埼玉",   len: 400, straight: 47.6, cant: 29.45, dome: false, nige: 29.8 },
    "京王閣": { pref: "東京",   len: 400, straight: 51.5, cant: 32.18, dome: false, nige: 23.7 },
    "立川":   { pref: "東京",   len: 400, straight: 58.0, cant: 31.22, dome: false, nige: 24.3 },
    "松戸":   { pref: "千葉",   len: 333, straight: 38.2, cant: 29.75, dome: false, nige: 32.7 },
    "川崎":   { pref: "神奈川", len: 400, straight: 58.0, cant: 32.17, dome: false, nige: 25.8 },
    "平塚":   { pref: "神奈川", len: 400, straight: 54.2, cant: 31.48, dome: false, nige: 23.9 },
    "小田原": { pref: "神奈川", len: 333, straight: 36.1, cant: 35.57, dome: false, nige: 26.0 },
    "伊東":   { pref: "静岡",   len: 333, straight: 46.6, cant: 34.69, dome: false, nige: 28.2 },
    "静岡":   { pref: "静岡",   len: 400, straight: 56.4, cant: 30.72, dome: false, nige: 23.1 },
    "名古屋": { pref: "愛知",   len: 400, straight: 58.8, cant: 34.03, dome: false, nige: 23.0 },
    "岐阜":   { pref: "岐阜",   len: 400, straight: 59.3, cant: 32.25, dome: false, nige: 24.8 },
    "大垣":   { pref: "岐阜",   len: 400, straight: 56.0, cant: 30.62, dome: false, nige: 25.3 },
    "豊橋":   { pref: "愛知",   len: 400, straight: 60.3, cant: 33.84, dome: false, nige: 22.9 },
    "富山":   { pref: "富山",   len: 333, straight: 43.0, cant: 33.69, dome: false, nige: 27.4 },
    "松阪":   { pref: "三重",   len: 400, straight: 61.5, cant: 34.42, dome: false, nige: 22.5 },
    "四日市": { pref: "三重",   len: 400, straight: 62.4, cant: 32.25, dome: false, nige: 21.4 },
    "福井":   { pref: "福井",   len: 400, straight: 52.8, cant: 31.48, dome: false, nige: 27.7 },
    "奈良":   { pref: "奈良",   len: 333, straight: 38.0, cant: 33.43, dome: false, nige: 32.7 },
    "向日町": { pref: "京都",   len: 400, straight: 47.3, cant: 30.48, dome: false, nige: null },
    "和歌山": { pref: "和歌山", len: 400, straight: 59.9, cant: 32.25, dome: false, nige: 22.5 },
    "岸和田": { pref: "大阪",   len: 400, straight: 56.7, cant: 30.93, dome: false, nige: 25.2 },
    "玉野":   { pref: "岡山",   len: 400, straight: 47.9, cant: 30.63, dome: false, nige: 23.2 },
    "広島":   { pref: "広島",   len: 400, straight: 57.9, cant: 32.53, dome: false, nige: 21.3 },
    "防府":   { pref: "山口",   len: 333, straight: 42.5, cant: 34.69, dome: false, nige: 31.9 },
    "高松":   { pref: "香川",   len: 400, straight: 54.8, cant: 33.26, dome: false, nige: 24.6 },
    "小松島": { pref: "徳島",   len: 400, straight: 55.5, cant: 29.77, dome: false, nige: 22.3 },
    "高知":   { pref: "高知",   len: 500, straight: 52.0, cant: 24.50, dome: false, nige: 21.1 },
    "松山":   { pref: "愛媛",   len: 400, straight: 58.6, cant: 34.03, dome: false, nige: 22.2 },
    "小倉":   { pref: "福岡",   len: 400, straight: 56.9, cant: 34.03, dome: true,  nige: 25.5 },
    "久留米": { pref: "福岡",   len: 400, straight: 50.7, cant: 31.48, dome: false, nige: 25.5 },
    "武雄":   { pref: "佐賀",   len: 400, straight: 64.4, cant: 32.01, dome: false, nige: 20.5 },
    "佐世保": { pref: "長崎",   len: 400, straight: 40.2, cant: 31.48, dome: false, nige: 26.2 },
    "別府":   { pref: "大分",   len: 400, straight: 59.9, cant: 33.69, dome: false, nige: 27.8 },
    "熊本":   { pref: "熊本",   len: 400, straight: 60.3, cant: 34.26, dome: false, nige: 24.7 }
  },
  nigeNational: 25.0,

  // 府県→地区（競輪の地区区分）
  area: {
    "北海道": "北日本", "青森": "北日本", "岩手": "北日本", "宮城": "北日本", "秋田": "北日本", "山形": "北日本", "福島": "北日本",
    "茨城": "関東", "栃木": "関東", "群馬": "関東", "埼玉": "関東", "東京": "関東", "新潟": "関東", "長野": "関東", "山梨": "関東",
    "千葉": "南関東", "神奈川": "南関東", "静岡": "南関東",
    "愛知": "中部", "岐阜": "中部", "三重": "中部", "富山": "中部", "石川": "中部",
    "福井": "近畿", "滋賀": "近畿", "京都": "近畿", "大阪": "近畿", "兵庫": "近畿", "奈良": "近畿", "和歌山": "近畿",
    "岡山": "中国", "広島": "中国", "山口": "中国", "鳥取": "中国", "島根": "中国",
    "香川": "四国", "徳島": "四国", "高知": "四国", "愛媛": "四国",
    "福岡": "九州", "佐賀": "九州", "長崎": "九州", "大分": "九州", "熊本": "九州", "宮崎": "九州", "鹿児島": "九州", "沖縄": "九州"
  },
  // 隣り合う地区（ラインを組みやすい組み合わせ）
  areaNear: {
    "北日本": ["関東"], "関東": ["北日本", "南関東"], "南関東": ["関東", "中部"], "中部": ["南関東", "近畿"],
    "近畿": ["中部", "中国"], "中国": ["近畿", "四国", "九州"], "四国": ["中国", "九州"], "九州": ["中国", "四国"]
  },

  // ライン人数×位置ごとの1着率(%)。4人以上は4人の値を使う。
  positionWin: { 2: [15.3, 8.5], 3: [25.7, 22.0, 2.3], 4: [43.9, 26.8, 5.2, 0.6], single: 10.6 },

  // 周長別の1着の決まり手(%)
  kimarite1: { 333: { nige: 33, makuri: 31, sashi: 36 }, 400: { nige: 25, makuri: 30, sashi: 45 }, 500: { nige: 24, makuri: 26, sashi: 50 } },
  kimariteDome1: { nige: 31, makuri: 31, sashi: 38 },

  // 区分ごとの3連単1番人気の基準（的中率%・平均オッズ倍）と、人気順3点の的中率%
  popular: {
    S:  { hit1: 7.5,  avgOdds1: 13.8, hitTop3: 16.6 },
    A:  { hit1: 7.7,  avgOdds1: 12.9, hitTop3: 16.9 },
    CH: { hit1: 13.4, avgOdds1: 7.6,  hitTop3: 28.2 },
    L:  { hit1: 13.9, avgOdds1: 5.7,  hitTop3: 32.7 }
  },

  // 風向き×周長で有利な決まり手（+1有利、0.5やや有利）。ドームは対象外。
  wind: {
    homeHead: { 333: { makuri: 1 }, 400: { nige: 0.5, sashi: 0.5 }, 500: { sashi: 1 } },  // ホーム向かい風・バック追い風
    backHead: { 333: { nige: 1 }, 400: { makuri: 0.5 }, 500: { makuri: 1 } },              // ホーム追い風・バック向かい風
    crossHB: { all: { makuri: 0.5 } },                                                       // ホーム→バックの横風
    crossBH: { all: { nige: 0.5 } }                                                          // バック→ホームの横風
  }
};

function bankClass(len) { return len <= 335 ? 333 : len >= 500 ? 500 : 400; }

if (typeof module !== "undefined") module.exports = { REF, bankClass };

/* ===== engine.js ===== */
// 競輪3連単ラボ 予想エンジン（36エンジン・区分・買い目・照合・学習・メタループ）
// 使うのは、貼られた出走表・オッズ、自前の蓄積データ、参照データ（refdata.js）だけ。

(function (root) {
// 参照データは使うときに取りにいく（Google Apps Scriptではファイルの読み込み順が決まらないため）
let __ref = null;
function refd() { if (!__ref) __ref = (typeof REF !== "undefined" ? REF : null) || (typeof require !== "undefined" ? require("./refdata.js").REF : null); return __ref; }
function _bankClass(len) { return len <= 335 ? 333 : len >= 500 ? 500 : 400; }

/* ========== エンジン一覧 ==========
   per: 選手ごとの値を出し、重みを学習するエンジン
   race: レース全体に効くエンジン（集中度・市場との合成・買い目の選び方で使う） */
const ENGINES = [
  ["E01", "競走得点", "能力", "per"], ["E02", "級班", "能力", "per"], ["E03", "勝率", "能力", "per"],
  ["E04", "2連対率", "能力", "per"], ["E05", "3連対率", "能力", "per"],
  ["E06", "ライン位置の基本力", "展開", "per"], ["E07", "主導権(S・B)", "展開", "per"], ["E08", "先行争い", "展開", "per"],
  ["E09", "単騎", "展開", "per"], ["E10", "選手コメント", "展開", "per"], ["E11", "競り", "展開", "per"],
  ["E12", "先頭の強さ", "展開", "per"], ["E13", "ライン結束", "展開", "per"], ["E14", "車番・枠", "展開", "per"],
  ["E15", "近況着順", "状態", "per"], ["E16", "調子の流れ", "状態", "per"], ["E17", "年齢・期別", "状態", "per"],
  ["E18", "ギヤと変更", "状態", "per"], ["E19", "明け・間隔", "状態", "per"],
  ["E20", "周長×決まり手", "環境", "per"], ["E21", "みなし直線", "環境", "per"], ["E22", "カント", "環境", "per"],
  ["E23", "場の先行有利度", "環境", "per"], ["E24", "地元", "環境", "per"], ["E25", "当場・周長の成績", "環境", "per"],
  ["E26", "天候", "環境", "per"], ["E27", "グレード適性", "環境", "per"],
  ["E28", "勝ち上がり条件", "番組", "race"], ["E29", "開催種別", "番組", "race"],
  ["E30", "1着人気", "市場", "race"], ["E31", "3着内人気", "市場", "race"], ["E32", "妙味（確率×オッズ）", "市場", "race"],
  ["E33", "スジ決着の補正", "市場", "race"],
  ["E34", "対戦成績", "学習", "per"], ["E35", "選手別の蓄積補正", "学習", "per"], ["E36", "条件別の蓄積補正", "学習", "per"]
];
const PER = ENGINES.filter(e => e[3] === "per").map(e => e[0]);
const NAME = Object.fromEntries(ENGINES.map(e => [e[0], e[1]]));
const CLSV = { SS: 7, S1: 6, S2: 5, A1: 4, A2: 3, A3: 2, L1: 4 };
const GRADEV = { GP: 6, GI: 5, GII: 4, GIII: 3, FI: 2, FII: 1 };

/* ========== 便利関数 ========== */
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function zscore(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (v.length < 2) return arr.map(() => 0);
  const m = mean(v), sd = Math.sqrt(mean(v.map(x => (x - m) ** 2)));
  return arr.map(x => (x == null || !isFinite(x) || sd < 1e-9) ? 0 : (x - m) / sd);
}
function corr(a, b) {
  const n = a.length; if (n < 3) return 0;
  const ma = mean(a), mb = mean(b); let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return (sa < 1e-9 || sb < 1e-9) ? 0 : sab / Math.sqrt(sa * sb);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const riderId = r => `${r.name}|${r.pref}|${r.ki}`;
const surname = n => (n || "").slice(0, 2);

/* ========== 新しい状態 ========== */
// 最初の重み（事前の見立て）。実力・並びを厚く、根拠の薄い仮置きのエンジンを薄くして始める。
// 学習はこの値から始まり、データが少ないうちはこの値に引き戻される。
const PRIOR = {
  E01: 0.35, E02: 0.10, E03: 0.15, E04: 0.15, E05: 0.10,
  E06: 0.30, E07: 0.20, E08: 0.10, E09: 0.05, E10: 0.05, E11: 0.05, E12: 0.15, E13: 0.10, E14: 0.03,
  E15: 0.10, E16: 0.05, E17: 0.03, E18: 0.02, E19: 0.05,
  E20: 0.10, E21: 0.03, E22: 0.03, E23: 0.03, E24: 0.05, E25: 0.05, E26: 0.05, E27: 0.03,
  E34: 0.05, E35: 0.10, E36: 0.05
};
// 番組・条件による集中度の補正（初期値。見直しで調整する）
const KF0 = { final: 1.1, tokusen: 0.9, ippan: 0.95, seven: 1.05, rain: 1.05, wind: 1.05 };
const ENGINE_VER = 5;
function freshModel() {
  const w = Object.fromEntries(PER.map(e => [e, PRIOR[e]]));
  return {
    // alpha：オッズ（市場）の比重。最初は市場を重く見る（0.8）。モデルの予想力が確かめられたら見直しで下げる
    // evMode：期待値で選ぶか。モデル単独の予想力がオッズを上回ったと確かめられるまでは false（確率の高い順に選ぶ）
    ver: 1, engineVer: ENGINE_VER, beta: 1.2, alpha: 0.8, syn: 0.15, lr: 0.05, evMode: false,
    lam2: 0.85, lam3: 0.7,                 // 2着・3着の補正（人気の選手が2・3着に入りやすく出る偏りを弱める）
    kf: { ...KF0 },
    cells: { "*|*|*": { w, n: 0 } },
    th: { kataRatio: 0.6, areRatio: 1.6, floor: { kata: 0.04, std: 0.02, are: 0.01 } },
    best: null, history: []
  };
}
function freshAcc() { return { riders: {}, pairs: {}, h2h: {}, venues: {}, resid: { rider: {}, cond: {} } }; }

/* ========== レースの区分（カテゴリ） ========== */
function category(race) {
  const cls = race.riders.map(r => r.cls);
  if (cls.every(c => c === "L1")) return "L";
  if (/チャレンジ/.test(race.meta.kind || "") || cls.every(c => c === "A3")) return "CH";
  if (cls.filter(c => /^S/.test(c)).length >= cls.length / 2) return "S";
  return "A";
}

/* ========== ライン ========== */
function lineInfo(race) {
  const info = {};
  (race.lineup || []).forEach((ln, li) => ln.forEach((no, idx) => info[no] = { li, idx, size: ln.length, head: ln[0], line: ln }));
  race.riders.forEach(r => { if (!info[r.no]) info[r.no] = { li: -1 - r.no, idx: 0, size: 1, head: r.no, line: [r.no], single: true }; });
  return info;
}
const posLabel = li => li.size === 1 ? "単騎" : li.idx === 0 ? "先頭" : li.idx === 1 ? "番手" : "3番手以降";

/* ========== 決まり手の割合（選手ごと） ========== */
// ar：この選手の蓄積データ（照合で記録した実際の決まり手。そのレースより前のものだけ）
function shares(r, ar) {
  const k = (ar && ar.kim) || {};
  const nige = (r.nige || 0) + (k["逃げ"] || 0), makuri = (r.makuri || 0) + (k["捲り"] || 0), sashi = (r.sashi || 0) + (k["差し"] || 0), mark = (r.mark2 || 0) + (k["マーク"] || 0);
  const t = nige + makuri + sashi + mark;
  if (t > 0) return { nige: nige / t, makuri: makuri / t, sashi: sashi / t, mark: mark / t };
  return r.style === "逃" ? { nige: .6, makuri: .3, sashi: .1, mark: 0 } : r.style === "両" ? { nige: .3, makuri: .4, sashi: .2, mark: .1 } : { nige: 0, makuri: .1, sashi: .5, mark: .4 };
}

/* ========== 日付 ========== */
function daysBetween(raceDate, mmdd) {
  if (!raceDate || !mmdd) return null;
  const [y, m, d] = raceDate.split("-").map(Number); const [mm, dd] = mmdd.split("/").map(Number);
  let yy = y; if (mm > m) yy = y - 1;
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(yy, mm - 1, dd)) / 864e5);
}

/* ========== 36エンジンの計算 ========== */
function computeEngines(race, acc, opts) {
  const REFD = refd(), R = race.riders, n = R.length, LI = lineInfo(race);
  const v = REFD.venues[race.meta.venue] || null;
  const bc = v ? _bankClass(v.len) : 400;
  const kim = v && v.dome ? REFD.kimariteDome1 : REFD.kimarite1[bc];
  const cond = race.cond || {};
  const raw = Object.fromEntries(PER.map(e => [e, R.map(() => null)]));
  const byNo = Object.fromEntries(R.map(r => [r.no, r]));
  const A0 = acc || freshAcc();
  const sh = R.map(r => shares(r, A0.riders[riderId(r)]));
  const selfHeads = R.filter(r => LI[r.no].idx === 0 && (r.style === "逃" || r.style === "両") && ((r.b || 0) + (r.s || 0)) > 0);
  const zKi = zscore(R.map(r => r.ki)), zAge = zscore(R.map(r => r.age));

  // コメント：誰の後ろにつくか（姓を含む）、自力、自在、単騎、前々、競り
  const follows = R.map(r => { const c = r.comment || ""; return R.find(o => o.no !== r.no && surname(o.name).length === 2 && c.includes(surname(o.name))) || null; });
  const targetCount = {}; follows.forEach(f => { if (f) targetCount[f.no] = (targetCount[f.no] || 0) + 1; });

  // 自前の蓄積データ（そのレースより前の照合結果だけでできている）
  const A = acc || freshAcc();
  const venueNige = (() => {
    if (!opts || opts.mode !== "past") return v && v.nige != null ? v.nige : REFD.nigeNational;
    const s = A.venues[race.meta.venue]; const k = 30;   // 過去レース検証では自前の集計だけを使う（先読み防止）
    return s ? (s.nigeWins / Math.max(1, s.races) * 100 * s.races + REFD.nigeNational * k) / (s.races + k) : REFD.nigeNational;
  })();
  const prior3 = 3 / n;
  const shrink = (o, k = 5) => o ? ((o.t3 || 0) + prior3 * k) / ((o.n || 0) + k) - prior3 : 0;

  R.forEach((r, i) => {
    const li = LI[r.no], s = sh[i], id = riderId(r), ar = A.riders[id] || null;
    const head = byNo[li.head];
    const isHead = li.idx === 0;
    raw.E01[i] = r.score;
    raw.E02[i] = CLSV[r.cls] ?? null;
    raw.E03[i] = r.win; raw.E04[i] = r.ren2; raw.E05[i] = r.ren3;
    // E06 ライン人数×位置の1着率（ケイリンログ）
    if (li.size === 1) raw.E06[i] = REFD.positionWin.single;
    else { const t = REFD.positionWin[Math.min(li.size, 4)]; raw.E06[i] = t[Math.min(li.idx, t.length - 1)]; }
    // E07 主導権：先頭はB＋S/2、それ以外はS×0.3
    raw.E07[i] = isHead ? (r.b || 0) + 0.5 * (r.s || 0) : 0.3 * (r.s || 0);
    // E08 先行争い：先頭は、ほかの自力型の先頭の数だけ不利。番手以降は前の先頭の半分
    const others = selfHeads.filter(o => o.no !== li.head).length;
    raw.E08[i] = isHead ? -others : -others * 0.5;
    // E09 単騎の脚質補正
    raw.E09[i] = li.size === 1 ? ({ "両": 0.5, "逃": 0.2, "追": -0.5 }[r.style] ?? 0) : 0;
    // E10 選手コメント
    const c = r.comment || ""; let cs = 0;
    if (/自力/.test(c) && !/自在/.test(c)) cs += isHead ? 1 : 0.3;
    if (/自在/.test(c)) cs += 0.5;
    if (follows[i] && LI[follows[i].no] && LI[follows[i].no].li === li.li) cs += 0.3;   // コメントどおりの並び
    if (/前々/.test(c)) cs += 0.3;
    if (/単騎/.test(c)) cs -= 0.2;
    raw.E10[i] = cs;
    // E11 競り：同じ選手の後ろを2人以上が狙う、または「競」を含む
    let kr = 0;
    if (/競/.test(c)) kr -= 1;
    if (follows[i] && targetCount[follows[i].no] >= 2) kr -= 1;
    if (targetCount[r.no] >= 2) kr -= 0.5;
    raw.E11[i] = kr;
    // E12 先頭の強さ：番手以降は前の先頭の得点
    raw.E12[i] = head ? head.score : r.score;
    // E13 ライン結束：同県 > 同地区 > 隣接地区 > 混成（＋同じ並びの実績）
    const bond = (a, b) => {
      if (!a || !b) return 0;
      if (a.pref === b.pref) return 1;
      const aa = REFD.area[a.pref], bb = REFD.area[b.pref];
      if (aa && aa === bb) return 0.7;
      if (aa && REFD.areaNear[aa] && REFD.areaNear[aa].includes(bb)) return 0.4;
      return 0.2;
    };
    if (li.size === 1) raw.E13[i] = 0;
    else {
      const mates = li.line.filter(x => x !== r.no).map(x => byNo[x]);
      // 同じ並びの実績：そろって3着内に入った率を、ふつうの率（2人とも3着内に入る確率）に縮めて比べる
      const base2 = (3 / n) * (2 / (n - 1));
      const pairBonus = mates.reduce((t, m) => { const p = A.pairs[[id, riderId(m)].sort().join(">")]; return t + (p ? clamp(((p.both3 || 0) + base2 * 3) / (p.n + 3) - base2, -0.3, 0.3) * 2 : 0); }, 0);
      raw.E13[i] = mean(mates.map(m => bond(r, m))) + pairBonus;
    }
    // E14 車番・枠（番組編成の評価・内枠の有利）
    raw.E14[i] = -r.no;
    // E15 近況着順（落・失は最下位扱い）
    const rec = (r.recent || []).map(x => typeof x.res === "number" ? x.res : n);
    raw.E15[i] = rec.length ? -mean(rec) : null;
    // E16 調子の流れ：前々回より前回が良いか＋前回見たときからの得点の変化
    const done = (r.meets || []).filter(mt => mt.res);
    const avgOf = mt => { const x = (window_parseRecent(mt.res)).map(y => typeof y.res === "number" ? y.res : n); return x.length ? mean(x) : null; };
    const m1 = done[0] ? avgOf(done[0]) : null, m2 = done[1] ? avgOf(done[1]) : null;
    let tr = (m1 != null && m2 != null) ? (m2 - m1) : 0;
    if (ar && ar.lastScore != null && r.score != null) tr += 0.5 * (r.score - ar.lastScore);
    raw.E16[i] = tr;
    // E17 年齢・期別
    raw.E17[i] = zKi[i] - zAge[i];
    // E18 ギヤと変更（仮置き）：先頭はギヤが大きいほど、先頭がギヤを下げたら急加速狙い、単騎が上げたら捲り狙い
    let gs = r.gear != null ? (r.gear - 3.9) * 10 * (isHead ? 1 : 0.3) : 0;
    if (ar && ar.lastGear != null && r.gear != null) {
      const d = r.gear - ar.lastGear;
      if (isHead && li.size > 1 && d < 0) gs += 0.5;
      if (li.size === 1 && d > 0) gs += 0.5;
    }
    raw.E18[i] = gs;
    // E19 明け・間隔：直近の開催で落・失・欠、前走から35日超
    let ak = 0;
    const last = done[0];
    if (last) {
      if (/落|失/.test(last.res)) ak -= 1;
      if (/欠/.test(last.res)) ak -= 0.5;
      const gap = daysBetween(race.meta.date, last.date);
      if (gap != null && gap > 35) ak -= 0.3;
    }
    raw.E19[i] = ak;
    // E20 周長×決まり手：その周長の1着決まり手率と、本人の決まり手の割合
    raw.E20[i] = kim.nige * s.nige + kim.makuri * s.makuri + kim.sashi * (s.sashi + s.mark);
    // E21 みなし直線：長いほど差し、短いほど先行
    raw.E21[i] = v ? (s.sashi + s.mark - s.nige) * (v.straight - 55) / 8 : 0;
    // E22 カント：きついほど差し・捲り、緩いほど逃げ
    raw.E22[i] = v ? (s.sashi + s.makuri - s.nige) * (v.cant - 32) / 3 : 0;
    // E23 場の先行有利度
    raw.E23[i] = (s.nige - s.sashi) * (venueNige - refd().nigeNational) / 5;
    // E24 地元
    const vp = v ? v.pref : null;
    raw.E24[i] = vp && r.pref === vp ? 1 : (vp && REFD.area[r.pref] && REFD.area[r.pref] === REFD.area[vp] ? 0.3 : 0);
    // E25 当場・周長の成績（蓄積）
    raw.E25[i] = ar ? shrink(ar.venue && ar.venue[race.meta.venue]) + 0.5 * shrink(ar.len && ar.len[bc]) : 0;
    // E26 天候：雨は逃げ有利・捲り不利、風は向き×周長の表
    let ws = 0;
    if (!(v && v.dome)) {
      if (cond.weather === "雨") ws += 0.5 * s.nige - 0.5 * s.makuri;
      const tbl = cond.windDir && refd().wind[cond.windDir];
      if (tbl) {
        const f = tbl[bc] || tbl.all || {};
        const strong = cond.windStr === "強" ? 1.5 : 1;
        ws += strong * ((f.nige || 0) * s.nige + (f.makuri || 0) * s.makuri + (f.sashi || 0) * (s.sashi + s.mark));
      }
    }
    raw.E26[i] = ws;
    // E27 グレード適性（蓄積）
    raw.E27[i] = ar ? shrink(ar.grade && ar.grade[race.meta.grade]) : 0;
    // E34 対戦成績（蓄積）
    raw.E34[i] = R.reduce((t, o) => {
      if (o.no === r.no) return t;
      const key = [id, riderId(o)].sort().join("|"), h = A.h2h[key];
      if (!h) return t;
      const mine = key.startsWith(id + "|") ? h.a : h.b, theirs = key.startsWith(id + "|") ? h.b : h.a;
      return t + (mine - theirs) / (mine + theirs + 3);
    }, 0);
    // E35 選手別の蓄積補正、E36 条件別の蓄積補正
    raw.E35[i] = A.resid.rider[id] ? A.resid.rider[id].v : 0;
    const ck = `${race.cls || "std"}|${n}|${posLabel(li)}|${r.style}`;
    raw.E36[i] = A.resid.cond[ck] ? A.resid.cond[ck].v : 0;
  });
  const Z = Object.fromEntries(PER.map(e => [e, zscore(raw[e])]));
  return { Z, raw, LI };
}
// 近況の文字列を読む（parser.js と同じ規則）
function window_parseRecent(s) {
  const out = []; if (!s) return out;
  const re = /([予準決般特抜選初優一順秀ガ]?)([1-9]|落|失|欠|棄|故)/g; let m;
  while ((m = re.exec(s))) out.push({ type: m[1] || null, res: /[1-9]/.test(m[2]) ? +m[2] : m[2] });
  return out;
}

/* ========== 重み（条件別・階層で混ぜる） ========== */
// 重みの条件：級の種類 → 区分 → グレード・車立 の順に細かくなる（例 "C:S|FI|7|std"）
function cellKey(race) { return `C:${race.cat || category(race)}|${race.meta.grade || "?"}|${race.riders.length}|${race.cls || "std"}`; }
// 全体（*|*|*）の下にある、その条件までの段階
function chain(key) {
  if (key === "*|*|*") return [];
  if (key.startsWith("C:")) {
    const p = key.slice(2).split("|");
    if (p.length === 1) return [key];
    if (p.length === 2) return [`C:${p[0]}`, key];
    return [`C:${p[0]}`, `C:${p[0]}|${p[3]}`, key];
  }
  return [`*|*|${key.split("|")[2]}`, key];   // 以前の形（級の種類を分けていなかったころ）
}
function effWeights(key, model) {
  const glob = model.cells["*|*|*"];
  const out = {};
  PER.forEach(e => {
    let w = glob.w[e] ?? 1;
    for (const lv of chain(key)) {
      const c = model.cells[lv];
      if (c && c.w[e] != null) { const a = c.n / (c.n + 30); w = a * c.w[e] + (1 - a) * w; }
    }
    out[e] = w;
  });
  return out;
}
function combine(Z, w, n) {
  return zscore(Array.from({ length: n }, (_, i) => PER.reduce((a, e) => a + w[e] * (Z[e][i] || 0), 0)));
}

/* ========== E28 勝ち上がり条件・E29 開催種別：集中度への効き ========== */
// レースが当てはまる条件（集中度の補正の対象）
function kindFlags(race) {
  const k = race.meta.kind || "", c = race.cond || {};
  return {
    final: /準決|決勝/.test(k),                 // 着順条件が厳しい：実力どおりになりやすい
    tokusen: /初日特選|初特選|特選/.test(k),    // 無事故完走で上がれる：無理をしないので荒れやすい
    ippan: /一般|選抜/.test(k),
    seven: race.riders.length <= 7,             // 7車立ては堅め（競輪ブラザー）
    rain: c.weather === "雨",
    wind: c.windStr === "強"
  };
}
function kindFactor(race, model) {
  const kf = (model && model.kf) || KF0, fl = kindFlags(race);
  let f = 1;
  Object.keys(KF0).forEach(k => { if (fl[k]) f *= (kf[k] ?? KF0[k]); });
  return f;
}

/* ========== 3連単の確率 ========== */
function marketProbs(odds) {
  const keys = Object.keys(odds || {}); if (keys.length < 10) return null;
  let t = 0; const q = {};
  keys.forEach(k => { q[k] = 1 / odds[k]; t += q[k]; });
  keys.forEach(k => q[k] /= t);
  return q;
}
// 着順の確率（2着・3着は強さを弱めて計算する）
function strengths(race, comb, model) {
  const beta = model.beta * kindFactor(race, model), l2 = model.lam2 ?? 1, l3 = model.lam3 ?? 1;
  return { s1: comb.map(z => Math.exp(beta * z)), s2: comb.map(z => Math.exp(l2 * beta * z)), s3: comb.map(z => Math.exp(l3 * beta * z)) };
}
function perms(race, comb, model, LI) {
  const R = race.riders, { s1, s2, s3 } = strengths(race, comb, model);
  const T1 = s1.reduce((a, b) => a + b, 0), T2 = s2.reduce((a, b) => a + b, 0), T3 = s3.reduce((a, b) => a + b, 0);
  const out = [];
  for (let a = 0; a < R.length; a++) for (let b = 0; b < R.length; b++) {
    if (b === a) continue;
    for (let c = 0; c < R.length; c++) {
      if (c === a || c === b) continue;
      let p = s1[a] / T1 * s2[b] / (T2 - s2[a]) * s3[c] / (T3 - s3[a] - s3[b]);
      const la = LI[R[a].no], lb = LI[R[b].no], lc = LI[R[c].no];
      // E33 スジ決着の補正：同じラインの前後がそのまま入る組み合わせ
      if (la.li === lb.li && lb.idx === la.idx + 1) p *= 1 + model.syn;
      if (lb.li === lc.li && lc.idx === lb.idx + 1) p *= 1 + model.syn * 0.6;
      out.push({ c: [R[a].no, R[b].no, R[c].no], m: p });
    }
  }
  const t = out.reduce((a, x) => a + x.m, 0); out.forEach(x => x.m /= t);
  // E30・E31 市場：オッズがあれば市場確率と合成（log p = α log q + (1−α) log m）
  const q = marketProbs(race.odds);
  if (q) {
    let tt = 0;
    out.forEach(x => { const qq = q[x.c.join("-")] || 1e-5; x.q = qq; x.p = Math.exp(model.alpha * Math.log(qq) + (1 - model.alpha) * Math.log(x.m)); tt += x.p; });
    out.forEach(x => x.p /= tt);
  } else out.forEach(x => x.p = x.m);
  out.sort((x, y) => y.p - x.p);
  return out;
}

/* ========== 区分（堅め・標準・荒れ） ========== */
function classify(race, model, P) {
  const cat = category(race), base = refd().popular[cat], th = model.th;
  const odds = Object.values(race.odds || {});
  const kf = kindFactor(race, model);
  let ratio, why;
  if (odds.length >= 10) {
    const fav = Math.min(...odds);
    ratio = fav / base.avgOdds1 / kf;
    why = `3連単1番人気 ${fav}倍（${catName(cat)}の平均 ${base.avgOdds1}倍）`;
  } else {
    const top = P[0].m;
    ratio = (base.hit1 / 100) / top / kf;
    why = `オッズなし：モデルの最有力 ${(top * 100).toFixed(1)}%（${catName(cat)}の1番人気的中率 ${base.hit1}%）`;
  }
  const cls = ratio <= th.kataRatio ? "kata" : ratio >= th.areRatio ? "are" : "std";
  return { cls, why, ratio, cat };
}
const catName = c => ({ S: "S級", A: "A級", CH: "チャレンジ", L: "ガールズ" }[c] || c);
const CLS_LABEL = { kata: "堅め", std: "標準", are: "荒れ" };

/* ========== 買い目（見送りなし、必ず1〜3点） ========== */
function chooseBets(race, P, model) {
  const floor = model.th.floor[race.cls], odds = race.odds || {};
  const has = Object.keys(odds).length >= 10;
  const maxN = race.cls === "kata" ? 2 : 3;
  let cand = P.filter(x => x.p >= floor);
  if (!cand.length) cand = P.slice(0, 3);
  // 区分ごとの選び方：堅め＝確率の高い順、標準・荒れ＝確率が下限以上の中から期待値（確率×オッズ）の高い順
  let picks = cand.map(x => ({ ...x, odds: has ? (odds[x.c.join("-")] || null) : null, ev: has ? x.p * (odds[x.c.join("-")] || 0) : null }));
  if (race.cls === "kata") {
    picks.sort((a, b) => b.p - a.p);
    picks = picks.slice(0, P[1] && P[1].p >= P[0].p * 0.6 ? 2 : 1);
  } else {
    // 期待値で選ぶのは、モデルの予想力がオッズを上回ったと確かめられてから。それまでは確率の高い順
    if (has && model.evMode) picks.sort((a, b) => b.ev - a.ev); else picks.sort((a, b) => b.p - a.p);
    picks = picks.slice(0, maxN);
  }
  if (!picks.length) picks = [{ ...P[0], odds: odds[P[0].c.join("-")] || null, ev: null }];
  return picks.map(x => ({ c: x.c, p: x.p, m: x.m, q: x.q ?? null, odds: x.odds, ev: x.ev }));
}

/* ========== 勝因・敗因（予想時は想定） ========== */
function topEngines(Z, i, w, k, sign) {
  return PER.map(e => ({ e, v: sign * w[e] * (Z[e][i] || 0) })).sort((a, b) => b.v - a.v).slice(0, k).filter(x => x.v > 0.1).map(x => NAME[x.e]);
}
function reasons(race, E, bet) {
  const R = race.riders, idx = no => R.findIndex(r => r.no === no), lab = ["1着", "2着", "3着"];
  const win = [], risk = [];
  bet.c.forEach((no, k) => {
    const i = idx(no), r = R[i], li = E.LI[no], t = topEngines(race.Z, i, race.w, 2, 1);
    win.push(`${lab[k]} ${no}番 ${r.name}：${posLabel(li)}（${r.style || "-"}）${t.length ? "。" + t.join("・") + "が高評価" : ""}`);
  });
  const [a, b] = bet.c, la = E.LI[a], lb = E.LI[b];
  if (la.li === lb.li) win.push(`${a}番→${b}番は同じラインの前後`);
  if (bet.q != null && bet.m > bet.q * 1.2) win.push(`モデルの見立てが市場より高い（モデル ${(bet.m * 100).toFixed(1)}%・市場 ${(bet.q * 100).toFixed(1)}%）`);
  const ia = idx(a), neg = topEngines(race.Z, ia, race.w, 2, -1);
  if (neg.length) risk.push(`${a}番は${neg.join("・")}が弱い`);
  const selfN = R.filter(r => E.LI[r.no].idx === 0 && (r.style === "逃" || r.style === "両")).length;
  if (la.idx === 0 && selfN >= 3) risk.push(`自力型の先頭が${selfN}人。主導権争いで先頭が早めに脚を使う展開`);
  if (la.size === 1) risk.push(`${a}番は単騎。位置取り次第で届かない`);
  if (la.idx >= 1) risk.push(`${a}番は前の${la.head}番の仕掛けしだい`);
  const rival = R.filter(r => E.LI[r.no].li !== la.li && E.LI[r.no].idx === 0 && r.no !== a).sort((x, y) => (y.score || 0) - (x.score || 0))[0];
  if (rival) risk.push(`別線の${rival.no}番（${posLabel(E.LI[rival.no])}）が主導権を取る展開`);
  if (bet.odds && bet.odds < 8) risk.push(`配当${bet.odds}倍で妙味は小さい`);
  if (!risk.length) risk.push("目立つ不安材料はない（落車・失格などの不確定要素は残る）");
  return { win, risk: risk.slice(0, 3) };
}

/* ========== 予想 ========== */
function predict(race, model, acc, opts) {
  const cat = category(race);
  // 区分の前に、仮の重みで確率を出す（オッズなし時の区分判定に使う）
  race.cls = "std"; race.cat = cat;
  let w = effWeights(cellKey(race), model);
  let E = computeEngines(race, acc, opts);
  let comb = combine(E.Z, w, race.riders.length);
  let P = perms(race, comb, model, E.LI);
  const cl = classify(race, model, P);
  race.cls = cl.cls; race.clsWhy = cl.why; race.cat = cat;
  // 区分が決まったら、その条件の重みで計算し直す
  race.key = cellKey(race); race.w = effWeights(race.key, model);
  E = computeEngines(race, acc, opts);
  race.Z = E.Z; race.comb = combine(E.Z, race.w, race.riders.length);
  P = perms(race, race.comb, model, E.LI);
  race.top = P.slice(0, 10).map(x => ({ c: x.c, p: x.p }));
  race.bets = chooseBets(race, P, model).map(b => ({ ...b, ...reasons(race, E, b) }));
  race.hasOdds = Object.keys(race.odds || {}).length >= 10;
  race.modelVer = model.ver; race.kindFactor = kindFactor(race, model);
  return race;
}

/* ========== 照合 ========== */
function judge(race, result) {
  const order = result.order, R = race.riders, idx = no => R.findIndex(r => r.no === no), lab = ["1着", "2着", "3着"];
  const pays = result.trifecta || [];
  const hitBet = race.bets.find(b => pays.some(p => p.combo.join() === b.c.join()));
  const payTot = race.bets.reduce((t, b) => { const p = pays.find(x => x.combo.join() === b.c.join()); return t + (p ? p.pay : 0); }, 0);
  const rank = {}; R.map((r, i) => ({ no: r.no, z: race.comb[i] })).sort((a, b) => b.z - a.z).forEach((x, i) => rank[x.no] = i + 1);
  const analysis = race.bets.map(b => {
    const hit = pays.some(p => p.combo.join() === b.c.join());
    const win = [], lose = [];
    b.c.forEach((no, k) => {
      if (no === order[k]) win.push(`${lab[k]} ${no}番を的中（総合評価${rank[no]}位）`);
      else {
        const act = order[k], ia = idx(act);
        const strong = PER.map(e => ({ e, v: (race.Z[e][ia] || 0) })).sort((x, y) => y.v - x.v).slice(0, 2).map(x => NAME[x.e]).join("・");
        lose.push(`${lab[k]} 予想${no}番 → 実際${act}番（総合評価${rank[act]}位）。${act}番は${strong}が高かったが、重みが足りなかった`);
      }
    });
    const inTop = b.c.filter(no => order.includes(no)).length;
    if (hit) lose.push(b.odds && b.odds < 8 ? `的中したが配当${b.odds}倍で効率は低い` : "敗因なし。同じ条件で再現できるかを引き続き確かめる");
    else if (inTop === 3) win.push("3人とも3着内。着順の並びだけが違った");
    else if (inTop > 0) win.push(`選んだ3人のうち${inTop}人は3着内`);
    else win.push("勝因なし。3着内の選手を1人も選べていない");
    return { c: b.c, hit, win, lose };
  });
  return { order, pays, hit: !!hitBet, inv: race.bets.length * 100, ret: payTot, analysis };
}

/* ========== 学習 ========== */
function ema(map, k, x, a) { const o = map[k] || { v: 0, n: 0 }; o.v = o.v + a * (x - o.v); o.n++; map[k] = o; }
// 実際の着順（1〜3着）が出る確率の対数。重みの学習に使う
function orderLogLik(race, w, model, order) {
  const n = race.riders.length, comb = combine(race.Z, w, n), { s1, s2, s3 } = strengths(race, comb, model);
  const ix = order.slice(0, 3).map(no => race.riders.findIndex(r => r.no === no));
  if (ix.some(i => i < 0)) return null;
  const [a, b, c] = ix, T1 = s1.reduce((x, y) => x + y, 0), T2 = s2.reduce((x, y) => x + y, 0), T3 = s3.reduce((x, y) => x + y, 0);
  return Math.log(s1[a] / T1) + Math.log(s2[b] / (T2 - s2[a])) + Math.log(s3[c] / (T3 - s3[a] - s3[b]));
}
const STEP_MAX = 0.02, PULL = 0.02, W_MIN = -0.5, W_MAX = 1.5;
function learn(race, result, model, acc, stats) {
  const order = result.order, n = race.riders.length;
  const lr = model.lr / (1 + 0.2 * (stats.lossStreak || 0));   // 連敗中は学習率を下げる
  const levels = [...chain(race.key).reverse(), "*|*|*"], moved = [];
  // 予想確率全体が実際の着順に近づく向き（対数尤度の勾配）を、全エンジン同時に求める
  const w0 = effWeights(race.key, model), h = 0.01, grad = {};
  const base = orderLogLik(race, w0, model, order);
  if (base != null) PER.forEach(e => {
    const up = orderLogLik(race, { ...w0, [e]: w0[e] + h }, model, order), dn = orderLogLik(race, { ...w0, [e]: w0[e] - h }, model, order);
    grad[e] = (up - dn) / (2 * h);
  });
  for (const lv of levels) {
    if (!model.cells[lv]) model.cells[lv] = { w: { ...effWeights(lv, model) }, n: 0 };
    const c = model.cells[lv];
    PER.forEach(e => {
      const old = c.w[e], prior = PRIOR[e] ?? old;
      // 1回の変化は0.02まで。事前の見立てへ少しずつ引き戻す（偶然に振り回されない）
      const d = clamp(lr * (grad[e] || 0) - PULL * lr * 10 * (old - prior), -STEP_MAX, STEP_MAX);
      c.w[e] = clamp(old + d, W_MIN, W_MAX);
      if (lv === "*|*|*") moved.push({ e, d: c.w[e] - old });
    });
    c.n++;
  }
  // 蓄積データ（選手・ライン・対戦・場・補正値）
  const LI = lineInfo(race), P = perms(race, race.comb, model, LI), p3 = {};
  P.forEach(x => x.c.forEach(no => p3[no] = (p3[no] || 0) + x.p));
  const v = refd().venues[race.meta.venue], bc = v ? _bankClass(v.len) : 400;
  const fin = Object.fromEntries((result.finishers || []).map(f => [f.no, f]));
  race.riders.forEach(r => {
    const id = riderId(r), top3 = order.includes(r.no) ? 1 : 0;
    const a = acc.riders[id] || (acc.riders[id] = { n: 0, t3: 0, venue: {}, len: {}, grade: {}, kim: {} });
    a.n++; a.t3 += top3;
    // 前回の得点・ギヤは、より新しい日付のレースのときだけ書き換える（古いレースをあとから入れても崩れない）
    if (!a.lastDate || race.meta.date >= a.lastDate) { a.lastScore = r.score; a.lastGear = r.gear; a.lastDate = race.meta.date; }
    const inc = (o, k) => { o[k] = o[k] || { n: 0, t3: 0 }; o[k].n++; o[k].t3 += top3; };
    inc(a.venue, race.meta.venue); inc(a.len, bc); inc(a.grade, race.meta.grade);
    const f = fin[r.no]; if (f && f.kimarite) a.kim[f.kimarite] = (a.kim[f.kimarite] || 0) + 1;
    const res = top3 - (p3[r.no] || 0);
    ema(acc.resid.rider, id, res, 0.2);
    ema(acc.resid.cond, `${race.cls}|${n}|${posLabel(LI[r.no])}|${r.style}`, res, 0.1);
  });
  (race.lineup || []).forEach(ln => {
    for (let i = 0; i + 1 < ln.length; i++) {
      const A1 = race.riders.find(r => r.no === ln[i]), B1 = race.riders.find(r => r.no === ln[i + 1]);
      if (!A1 || !B1) continue;
      const k = [riderId(A1), riderId(B1)].sort().join(">");
      const p = acc.pairs[k] || (acc.pairs[k] = { n: 0, both3: 0 });
      p.n++; if (order.includes(A1.no) && order.includes(B1.no)) p.both3++;
    }
  });
  const place = no => { const f = (result.finishers || []).find(x => x.no === no); return f && typeof f.rank === "number" ? f.rank : 99; };
  for (let i = 0; i < race.riders.length; i++) for (let j = i + 1; j < race.riders.length; j++) {
    const a = race.riders[i], b = race.riders[j], ia = riderId(a), ib = riderId(b);
    const key = [ia, ib].sort().join("|"), h = acc.h2h[key] || (acc.h2h[key] = { a: 0, b: 0 });
    const aFirst = place(a.no) < place(b.no);
    const firstIsA = key.startsWith(ia + "|");
    if (aFirst === firstIsA) h.a++; else h.b++;
  }
  const vs = acc.venues[race.meta.venue] || (acc.venues[race.meta.venue] = { races: 0, nigeWins: 0 });
  vs.races++;
  const w1 = (result.finishers || []).find(f => f.rank === 1);
  if (w1 && /逃/.test(w1.kimarite || "")) vs.nigeWins++;
  model.ver++;
  moved.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  return moved.slice(0, 3).map(x => `${x.e} ${NAME[x.e]} ${x.d >= 0 ? "↑" : "↓"}${Math.abs(x.d).toFixed(3)}`);
}

/* ========== メタループ（10レースごと） ========== */
function logLik(race, model) {
  const w = effWeights(race.key, model), comb = combine(race.Z, w, race.riders.length);
  const P = perms(race, comb, model, lineInfo(race));
  const f = P.find(x => x.c.join() === race.result.order.join());
  return Math.log(f ? f.p : 1e-6);
}
function metaLoop(races, model, stats) {
  const done = races.filter(r => r.status === "done").slice(0, 30);
  if (done.length < 5) return null;
  const avg = m => done.reduce((a, r) => a + logLik(r, m), 0) / done.length;
  const lines = []; let cur = avg(model);
  const KEYS = ["beta", "alpha", "syn", "lam2", "lam3"];
  const snap = () => ({ ver: model.ver, cells: JSON.parse(JSON.stringify(model.cells)), kf: { ...(model.kf || KF0) }, ...Object.fromEntries(KEYS.map(k => [k, model[k]])) });
  // 再実装：最良版と今を「同じ直近のレース」で測り直して比べ、悪化していたら最良版へ戻す
  if (model.best && model.best.cells) {
    const bm = { ...model, ...model.best, kf: model.best.kf || model.kf, th: model.th };
    KEYS.forEach(k => { if (bm[k] == null) bm[k] = model[k]; });
    const bl = avg(bm);
    if (cur < bl - 0.05) {
      model.cells = JSON.parse(JSON.stringify(model.best.cells)); model.kf = { ...bm.kf };
      KEYS.forEach(k => model[k] = bm[k]);
      lines.push(`直すべきもの：同じ${done.length}Rで比べて予測力が下がった（${cur.toFixed(3)} < ${bl.toFixed(3)}）ため最良版 v${model.best.ver} に戻した`);
      cur = avg(model);
    } else model.best.ll = bl;
  }
  // 調整：集中度β・市場の比重α・スジ補正・2着/3着の補正を少しずつ探る
  const tune = (k, steps, lo, hi, label) => {
    const v0 = model[k] ?? (k === "lam2" ? 0.85 : k === "lam3" ? 0.7 : 0);
    let bestV = v0, bestL = cur;
    for (const d of steps) { const val = clamp(v0 + d, lo, hi); const L = avg({ ...model, [k]: val }); if (L > bestL + 0.002) { bestL = L; bestV = val; } }
    if (bestV !== v0) { lines.push(`調整すべきもの：${label} ${v0.toFixed(2)} → ${bestV.toFixed(2)}`); cur = bestL; }
    model[k] = bestV;
  };
  tune("beta", [-0.15, 0.15], 0.5, 2.5, "集中度β");
  if (done.some(r => r.hasOdds)) tune("alpha", [-0.1, 0.1], 0.1, 0.95, "市場の比重α");
  tune("syn", [-0.05, 0.05], 0, 0.5, "スジ決着の補正");
  tune("lam2", [-0.05, 0.05], 0.5, 1, "2着の補正");
  tune("lam3", [-0.05, 0.05], 0.4, 1, "3着の補正");
  // 番組・条件の補正：その条件のレースが3R以上あるときだけ調整する
  model.kf = { ...KF0, ...(model.kf || {}) };
  const KFL = { final: "準決・決勝", tokusen: "特選", ippan: "一般・選抜", seven: "7車立て", rain: "雨", wind: "強風" };
  Object.keys(KF0).forEach(k => {
    if (done.filter(r => kindFlags(r)[k]).length < 3) return;
    const v0 = model.kf[k]; let bestV = v0, bestL = cur;
    for (const d of [-0.05, 0.05]) { const val = clamp(v0 + d, 0.8, 1.25); const L = avg({ ...model, kf: { ...model.kf, [k]: val } }); if (L > bestL + 0.002) { bestL = L; bestV = val; } }
    if (bestV !== v0) { lines.push(`調整すべきもの：${KFL[k]}の集中度 ${v0.toFixed(2)} → ${bestV.toFixed(2)}`); model.kf[k] = bestV; cur = bestL; }
  });
  if (!model.best || !model.best.cells || cur >= model.best.ll) model.best = { ...snap(), ll: cur };
  // モデル単独とオッズ単独の予想力を、同じレースで比べる。モデルが上回ったときだけ期待値で選ぶ
  const withOdds = done.filter(r => r.hasOdds);
  if (withOdds.length >= 10) {
    let lm = 0, lq = 0;
    withOdds.forEach(r => {
      const P = perms(r, combine(r.Z, effWeights(r.key, model), r.riders.length), model, lineInfo(r));
      const f = P.find(x => x.c.join() === r.result.order.join());
      lm += Math.log(f ? f.m : 1e-6); lq += Math.log(f && f.q ? f.q : 1e-6);
    });
    lm /= withOdds.length; lq /= withOdds.length;
    const ev = withOdds.length >= 30 && lm > lq + 0.05;
    lines.push(`予想力の比べ：モデル単独 ${lm.toFixed(2)} ／ オッズ単独 ${lq.toFixed(2)}（${withOdds.length}R）。${ev ? "モデルが上回ったので、標準・荒れは期待値で選ぶ" : "モデルはまだオッズを上回っていないので、確率の高い順に選ぶ"}`);
    if (ev !== !!model.evMode) lines.push(`調整すべきもの：買い目の選び方を「${ev ? "期待値順" : "確率順"}」に切り替えた`);
    model.evMode = ev;
  }
  // 区分しきい値
  const by = {}; done.forEach(r => { const o = by[r.cls] || (by[r.cls] = { n: 0, h: 0, inv: 0, ret: 0 }); o.n++; o.h += r.result.hit ? 1 : 0; o.inv += r.result.inv; o.ret += r.result.ret; });
  const hr = k => by[k] && by[k].n ? by[k].h / by[k].n : null;
  if (by.kata && by.kata.n >= 10 && by.std && hr("kata") < hr("std")) { model.th.kataRatio = Math.max(0.3, model.th.kataRatio - 0.05); lines.push(`調整すべきもの：堅めの判定を厳しく（基準比 ${model.th.kataRatio.toFixed(2)} 以下）`); }
  if (by.are && by.are.n >= 15 && hr("are") < 0.03) { model.th.areRatio = Math.min(3, model.th.areRatio + 0.1); lines.push(`調整すべきもの：荒れの判定を厳しく（基準比 ${model.th.areRatio.toFixed(2)} 以上）`); }
  // 期待値で選ぶ区分（標準・荒れ）：回収率が低いときは、穴に寄りすぎないよう確率の下限を上げる
  [["std", 0.05], ["are", 0.03]].forEach(([k, cap]) => {
    const o = by[k];
    if (o && o.n >= 15 && o.inv && o.ret / o.inv < 0.6 && model.th.floor[k] < cap) {
      model.th.floor[k] = Math.min(cap, +(model.th.floor[k] * 1.25).toFixed(4));
      lines.push(`調整すべきもの：${CLS_LABEL[k]}の回収率 ${(o.ret / o.inv * 100).toFixed(0)}%。穴に寄りすぎないよう、選ぶ確率の下限を ${(model.th.floor[k] * 100).toFixed(1)}% に上げた`);
    }
  });
  const g = model.cells["*|*|*"].w, sorted = [...PER].sort((a, b) => Math.abs(g[b]) - Math.abs(g[a]));
  lines.push(`増やすべきもの：${sorted.slice(0, 3).map(e => NAME[e]).join("・")}（重み上位）`);
  const floor = PER.filter(e => Math.abs(g[e]) < 0.01);
  lines.push(floor.length ? `削除すべきもの：${floor.map(e => NAME[e]).join("・")}は寄与が小さく実質停止中` : "削除すべきもの：該当なし");
  const recent = races.slice(0, 10), miss = [];
  if (!recent.some(r => r.hasOdds)) miss.push("オッズ（市場の合成が休止）");
  if (!recent.some(r => r.cond && (r.cond.weather || r.cond.windDir))) miss.push("天候・風の入力");
  lines.push(miss.length ? `必要なもの：${miss.join("・")}` : "必要なもの：入力データは足りている");
  const worst = Object.entries(by).filter(([, o]) => o.n >= 5).sort((a, b) => (a[1].ret / a[1].inv) - (b[1].ret / b[1].inv))[0];
  if (worst) lines.push(`直すべきもの：${CLS_LABEL[worst[0]]}の回収率 ${(worst[1].ret / worst[1].inv * 100).toFixed(1)}%（${worst[1].n}R）`);
  lines.push(`ループ：次の全体見直しは ${stats.races + 10}R 時点`);
  return { at: new Date().toISOString(), race: stats.races, ver: model.ver, ll: cur, lines };
}

/* ========== 時系列順に最初から学習し直す ==========
   items：照合済みレース（meta, riders, lineup, odds, cond, oddsType, result{order,pays,finishers}）。古い順に並べて渡す */
function chrono(a, b) { return a.meta.date < b.meta.date ? -1 : a.meta.date > b.meta.date ? 1 : (a.meta.raceNo || 0) - (b.meta.raceNo || 0); }
// state を渡すと、その続きから学習する（同じ順番なら、最初からやり直したのと同じ結果になる）
function replay(items, state) {
  const st = state || { model: freshModel(), acc: freshAcc(), stats: { races: 0, hits: 0, invested: 0, returned: 0, lossStreak: 0 }, done: [], metaLog: [] };
  const { model, acc, stats, done, metaLog } = st;
  items.forEach(it => {
    const race = { id: it.raceKey || it.id, meta: it.meta, riders: it.riders, lineup: it.lineup, odds: it.odds, cond: it.cond, oddsType: it.oddsType };
    predict(race, model, acc, { mode: "past" });
    const res = { order: it.result.order, trifecta: it.result.pays, finishers: it.result.finishers };
    const j = judge(race, res);
    race.result = j; race.status = "done";
    stats.races++; stats.invested += j.inv; stats.returned += j.ret;
    if (j.hit) { stats.hits++; stats.lossStreak = 0; } else stats.lossStreak++;
    learn(race, res, model, acc, stats);
    done.unshift(race);
    if (stats.races % 10 === 0) { const m = metaLoop(done, model, stats); if (m) metaLog.unshift(m); }
    if (done.length > 30) done.length = 30;
  });
  return st;
}

const API = { ENGINES, PRIOR, ENGINE_VER, chrono, replay, kindFlags, PER, NAME, CLS_LABEL, catName, freshModel, freshAcc, category, lineInfo, posLabel, riderId,
  computeEngines, effWeights, combine, perms, classify, chooseBets, predict, judge, learn, metaLoop, kindFactor };
if (typeof module !== "undefined") module.exports = API; else root.KEngine = API;
})(typeof window !== "undefined" ? window : globalThis);
