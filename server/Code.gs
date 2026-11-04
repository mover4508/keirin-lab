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
