// 競輪3連単ラボ 共有学習サーバー（起動用）
// 本体はGitHubから読み込む。アプリを直したときも、ここを貼り直す必要はない。
var CODE_URL = "https://mover4508.github.io/keirin-lab/server/bundle.gs";

function lib_() {
  var cache = CacheService.getScriptCache();
  var src = cache.get("code");
  if (!src) {
    src = UrlFetchApp.fetch(CODE_URL).getContentText();
    cache.put("code", src, 600);
  }
  return new Function(src + "\nreturn {doGet:doGet, doPost:doPost, rebuild:rebuild, setup:setup};")();
}
function doGet(e) { return lib_().doGet(e); }
function doPost(e) { return lib_().doPost(e); }
function rebuild() { return lib_().rebuild(); }
function setup() { return lib_().setup(); }

// 使う権限をGoogleに知らせるためのもの（実行はしない）
function permissions_() {
  DriveApp.getRootFolder(); SpreadsheetApp.create; ScriptApp.newTrigger;
  UrlFetchApp.fetch; CacheService.getScriptCache(); LockService.getScriptLock();
  PropertiesService.getScriptProperties(); ContentService.createTextOutput();
}
