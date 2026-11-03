// 競輪3連単ラボ 共有学習サーバー（Google Apps Script）
// 役割：みんなの照合済みレースを受け付け、検証し、時系列順に学習し直して、共有モデルを配る。
// このサーバーもWeb検索やほかのサイトの閲覧はしない。受け取るのは、利用者が貼った表から読み取ったデータと結果だけ。
// 同じプロジェクトに refdata.gs と engine.gs（GitHubの refdata.js・engine.js と同じ中身）を入れて使う。

var FOLDER_NAME = "競輪予想システム";
var SHEET_NAME = "競輪3連単ラボ 共有データ";
var MODEL_FILE = "shared_model.json";
var MAX_PER_DAY = 200;   // 1人1日に送れるレース数の上限

/* ========== 準備（初回のアクセスで自動的に行う） ========== */
function ensureSetup_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty("READY") === "1") return;
  setup();
  props.setProperty("READY", "1");
}
function setup() {
  var props = PropertiesService.getScriptProperties();
  var folder = getFolder_();
  if (!props.getProperty("SHEET_ID")) {
    var ss = SpreadsheetApp.create(SHEET_NAME);
    var sh = ss.getSheets()[0]; sh.setName("submissions");
    sh.appendRow(["受信日時", "レース", "送信者", "開発者", "結果の指紋", "データ"]);
    sh.setFrozenRows(1);
    var log = ss.insertSheet("log"); log.appendRow(["日時", "内容"]);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
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

function getFolder_() {
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
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
    var it = getFolder_().getFilesByName(MODEL_FILE);
    if (!it.hasNext()) return json_({ ok: false, reason: "まだ共有モデルがありません" });
    return ContentService.createTextOutput(it.next().getBlob().getDataAsString()).setMimeType(ContentService.MimeType.JSON);
  }
  if (action === "status") {
    var it2 = getFolder_().getFilesByName(MODEL_FILE);
    var m = it2.hasNext() ? JSON.parse(it2.next().getBlob().getDataAsString()) : null;
    return json_({ ok: true, builtAt: m && m.builtAt, races: m && m.stats && m.stats.races, ver: m && m.model && m.model.ver });
  }
  return json_({ ok: false, reason: "不明な操作" });
}

/* ========== 照合済みレースを受け付ける ========== */
function doPost(e) {
  ensureSetup_();
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    var isOwner = !!(body.ownerToken && body.ownerToken === props.getProperty("OWNER_TOKEN"));
    if (body.action === "rebuild") {
      if (!isOwner) return json_({ ok: false, reason: "開発者だけが実行できます" });
      var r = rebuild_();
      return json_({ ok: true, rebuilt: r });
    }
    if (body.action !== "submit") return json_({ ok: false, reason: "不明な操作" });
    var clientId = String(body.clientId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    if (!clientId) return json_({ ok: false, reason: "送信者の識別子がありません" });
    var items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    var sh = sheet_();
    // 1日の上限
    var today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");
    var cache = CacheService.getScriptCache(), ck = "n_" + clientId + "_" + today;
    var sent = Number(cache.get(ck) || 0);
    var accepted = 0, rejected = [];
    items.forEach(function (it) {
      if (!isOwner && sent >= MAX_PER_DAY) { rejected.push({ key: it && it.raceKey, reason: "1日の上限に達しました" }); return; }
      var v = validate_(it);
      if (!v.ok) { rejected.push({ key: it && it.raceKey, reason: v.reason }); return; }
      sh.appendRow([new Date(), v.item.raceKey, clientId, isOwner, v.sig, JSON.stringify(v.item)]);
      accepted++; sent++;
    });
    cache.put(ck, String(sent), 21600);
    return json_({ ok: true, accepted: accepted, rejected: rejected });
  } catch (err) {
    return json_({ ok: false, reason: "受け付けできませんでした：" + err });
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
  var finishers = (res.finishers || []).slice(0, 9).map(function (f) { return { rank: typeof f.rank === "number" ? f.rank : str_(f.rank, 1), no: num_(f.no), kimarite: f.kimarite ? str_(f.kimarite, 4) : null }; });
  var cond = it.cond || {};
  var item = {
    raceKey: m.date + "|" + m.venue + "|" + raceNo,
    oddsType: it.oddsType === "確定" ? "確定" : "締め切り前",
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
function rebuild_() {
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
  // 採用の決まり：開発者が照合したレース、または2人以上の結果が一致したレース。食い違いがあるレースは使わない
  var acceptedRaces = [], conflicts = 0;
  Object.keys(groups).forEach(function (key) {
    var g = groups[key], sigs = Object.keys(g.bySig);
    if (g.owner) { if (sigs.length > 1 && sigs.some(function (s) { return s !== g.owner.sig && Object.keys(g.bySig[s].clients).length >= 2; })) { conflicts++; return; } acceptedRaces.push(g.owner.item); return; }
    if (sigs.length > 1) { conflicts++; return; }
    var s = g.bySig[sigs[0]];
    if (Object.keys(s.clients).length >= 2) acceptedRaces.push(s.item);
  });
  // 時系列順（開催日・場・レース番号）
  acceptedRaces.sort(function (a, b) { return a.meta.date < b.meta.date ? -1 : a.meta.date > b.meta.date ? 1 : a.meta.raceNo - b.meta.raceNo; });
  var model = KEngine.freshModel(), acc = KEngine.freshAcc(), stats = { races: 0, hits: 0, invested: 0, returned: 0, lossStreak: 0 };
  var done = [], metaLog = [];
  acceptedRaces.forEach(function (it) {
    var race = { id: it.raceKey, meta: it.meta, riders: it.riders, lineup: it.lineup, odds: it.odds, cond: it.cond, oddsType: it.oddsType };
    KEngine.predict(race, model, acc, { mode: "past" });   // 共有の学習は、その時点までのデータだけで予想してから学習する
    var res = { order: it.result.order, trifecta: it.result.pays, finishers: it.result.finishers };
    var j = KEngine.judge(race, res);
    race.result = j; race.status = "done";
    stats.races++; stats.invested += j.inv; stats.returned += j.ret;
    if (j.hit) { stats.hits++; stats.lossStreak = 0; } else stats.lossStreak++;
    KEngine.learn(race, res, model, acc, stats);
    done.unshift(race);
    if (stats.races % 10 === 0) { var m = KEngine.metaLoop(done, model, stats); if (m) metaLog.unshift(m); }
    if (done.length > 60) done.length = 60;
  });
  var out = { app: "競輪3連単ラボ", kind: "shared", builtAt: new Date().toISOString(), engineVer: 2,
    stats: stats, conflicts: conflicts, model: model, acc: acc, metaLog: metaLog.slice(0, 20) };
  var folder = getFolder_(), it = folder.getFilesByName(MODEL_FILE);
  if (it.hasNext()) it.next().setContent(JSON.stringify(out)); else folder.createFile(MODEL_FILE, JSON.stringify(out), MimeType.PLAIN_TEXT);
  log_("学習し直し：採用 " + acceptedRaces.length + "R、食い違い " + conflicts + "R");
  return { races: acceptedRaces.length, conflicts: conflicts };
}
