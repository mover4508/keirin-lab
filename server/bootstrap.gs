// 競輪3連単ラボ 共有学習サーバー（起動用 v2）
// 開発者が承認したコードだけを動かす。GitHubのコードが書き換えられても、承認するまでは動かない。
var CODE_URL = "https://mover4508.github.io/keirin-lab/server/bundle.gs";
var CHUNK = 2000;

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, "0"); }).join("");
}
function approved_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var n = Number(all.CODE_N || 0);
  if (!n) return null;
  var parts = [];
  for (var i = 0; i < n; i++) parts.push(all["CODE_" + i] || "");
  var src = parts.join("");
  return hash_(src) === all.CODE_HASH ? src : null;
}
function lib_() {
  var src = approved_();
  if (!src) throw new Error("NOT_APPROVED");
  return new Function(src + "\nreturn {doGet:doGet, doPost:doPost, rebuild:rebuild};")();
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(err) { return out_({ ok: false, reason: String(err && err.message) === "NOT_APPROVED" ? "サーバーのコードが承認されていません" : "サーバーでエラーが起きました" }); }

function doGet(e) {
  if (e && e.parameter && e.parameter.action === "code") {
    var p = PropertiesService.getScriptProperties();
    return out_({ ok: true, hash: p.getProperty("CODE_HASH"), approvedAt: p.getProperty("CODE_AT") });
  }
  try { return lib_().doGet(e); } catch (err) { return fail_(err); }
}
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (x) {}
  if (body.action === "approveCode") return approve_(body);
  try { return lib_().doPost(e); } catch (err) { return fail_(err); }
}
function rebuild() { return lib_().rebuild(); }

// 開発者の合言葉があるときだけ、GitHubの最新コードを承認して保存する
function approve_(body) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty("OWNER_TOKEN");
  if (!token || body.ownerToken !== token) return out_({ ok: false, reason: "開発者だけが実行できます" });
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var src = UrlFetchApp.fetch(CODE_URL).getContentText();
    var h = hash_(src);
    if (body.expectHash && body.expectHash !== h) return out_({ ok: false, reason: "サーバーが受け取ったコードが、確認した内容と違います。数分待ってからやり直してください" });
    var old = Number(props.getProperty("CODE_N") || 0), map = {}, n = Math.ceil(src.length / CHUNK);
    for (var i = 0; i < n; i++) map["CODE_" + i] = src.slice(i * CHUNK, (i + 1) * CHUNK);
    map.CODE_N = String(n); map.CODE_HASH = h; map.CODE_AT = new Date().toISOString();
    props.setProperties(map);
    for (var j = n; j < old; j++) props.deleteProperty("CODE_" + j);
    return out_({ ok: true, hash: h, chars: src.length });
  } finally {
    lock.releaseLock();
  }
}
