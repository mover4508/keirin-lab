// 競輪3連単ラボ 画面と保存
"use strict";
(function () {
const K = window.KEngine;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const car = n => `<span class="car c${n}">${n}</span>`;
const comboHtml = c => `<span class="combo">${car(c[0])}<i>→</i>${car(c[1])}<i>→</i>${car(c[2])}</span>`;
const pct = x => (x * 100).toFixed(1) + "%";
const yen = x => Math.round(x).toLocaleString("ja-JP") + "円";
const clsPill = c => `<span class="pill ${c}">${K.CLS_LABEL[c]}</span>`;
function msg(id, text, kind) { $(id).innerHTML = text ? `<p class="msg ${kind || "ok"}">${text}</p>` : ""; }
function todayStr() { const d = new Date(), p = x => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function stamp() { const d = new Date(), p = x => String(x).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }

/* ========== 保存（この端末のブラウザ） ========== */
const KEY = "keirin-lab-v1";
let S;
function fresh() { return { schema: 1, model: K.freshModel(), acc: K.freshAcc(), races: [], stats: { races: 0, hits: 0, invested: 0, returned: 0, lossStreak: 0 }, metaLog: [],
  clientId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)), join: null, outbox: [], shared: null, ownerToken: "" }; }
/* 保存場所：大きく保存できる IndexedDB を使う。使えないときだけ、小さな localStorage を使う */
let idb = null, useIDB = false;
function idbOpen() {
  return new Promise(res => {
    try {
      const rq = indexedDB.open("keirin-lab", 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); rq.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
}
function idbGet(k) { return new Promise(res => { try { const rq = idb.transaction("kv").objectStore("kv").get(k); rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => res(null); } catch (e) { res(null); } }); }
function idbPut(k, v) { return new Promise((res, rej) => { try { const tx = idb.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); } catch (e) { rej(e); } }); }
async function readStore() {
  idb = await idbOpen(); useIDB = !!idb;
  let text = useIDB ? await idbGet(KEY) : null, moved = false;
  if (text == null) { try { text = localStorage.getItem(KEY); moved = text != null && useIDB; } catch (e) { text = null; } }   // 以前の保存場所から引っ越す
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}                 // ブラウザに消されにくくする
  return { text, moved };
}
function load(text) {
  try { const o = JSON.parse(text || "null"); S = o && o.schema === 1 ? Object.assign(fresh(), o) : fresh(); }
  catch (e) { S = fresh(); }
  if (typeof S.dev !== "boolean") S.dev = !!S.ownerToken;   // 開発者の端末は開発者向けの表示から始める
  S.races.forEach(r => { delete r.pasted; });                // 貼り付けた原文は保存しない（容量の節約。読み取った中身は残る）
  // エンジンが新しくなったら、この端末の学習を、照合済みのレースから時系列順に作り直す
  if (!S.model.engineVer || S.model.engineVer < K.ENGINE_VER) {
    const st = K.replay(doneItems(S.races));
    S.model = st.model; S.acc = st.acc; S.metaLog = st.metaLog.concat([{ at: new Date().toISOString(), race: st.stats.races, ver: st.model.ver, ll: 0, lines: [`エンジンを v${K.ENGINE_VER} に更新し、照合済みの${st.stats.races}Rで時系列順に学習し直した`] }]).slice(0, 50);
  }
}
function doneItems(races) { return races.filter(r => r.status === "done").map(r => learningItem(r)).sort(K.chrono); }
// 過去レース検証用：そのレースより前のレースだけで学習した状態（先読み防止）
// 前の日までのレースと、同じ日・同じ場の前のレースだけを使う。続きから計算できるときは続きから計算する
let pastCache = null;
function beforeRace(a, t) { return a.date < t.date || (a.date === t.date && a.venue === t.venue && Number(a.raceNo) < Number(t.raceNo)); }
function pastState(meta) {
  const hist = S.races.filter(r => r.status === "done" && beforeRace(r.meta, meta)).map(r => learningItem(r)).sort(K.chrono);
  const ids = hist.map(h => h.raceKey);
  if (pastCache && pastCache.ids.length <= ids.length && pastCache.ids.every((id, i) => ids[i] === id)) {
    K.replay(hist.slice(pastCache.ids.length), pastCache.state);
    pastCache.ids = ids;
  } else pastCache = { ids, state: K.replay(hist) };
  return pastCache.state;
}
function applyDev() { document.body.classList.toggle("simple", !S.dev); $("in-dev").value = S.dev ? "1" : "0"; if (!S.dev && view === "learn") view = "pred"; }
function headerText() {
  const sh = S.shared && S.shared.stats ? `みんなの学習 ${S.shared.stats.races}R` : "この端末の学習";
  return `${sh} ・ 自分 ${S.races.length}レース`;
}
let saveChain = Promise.resolve();
function saveFailed() { $("sync").textContent = "保存できませんでした（容量不足の可能性）。「全データを保存」でファイルに残してください"; msg("backup-note", "この端末に保存できませんでした。容量が足りない可能性があります。「保存・説明」の「全データを保存」で、すぐにファイルに残してください。", "err"); }
function save() {
  const text = JSON.stringify(S);
  $("sync").textContent = headerText();
  if (useIDB) saveChain = saveChain.then(() => idbPut(KEY, text)).catch(saveFailed);   // 順番どおりに書く
  else { try { localStorage.setItem(KEY, text); } catch (e) { saveFailed(); } }
  renderBackup();
}
// A4：20レース照合するごとに、ファイルへの保存をすすめる
function renderBackup() {
  const done = S.races.filter(r => r.status === "done").length, since = done - (S.exportedDone || 0);
  if (since >= 20) $("backup-note").innerHTML = `<div class="msg warn">前回ファイルに保存してから、${since}レース照合しました。機種変更やデータ削除に備えて、ファイルに保存しておきましょう。<div class="btns"><button class="btn sub" id="b-export2">今すぐ全データを保存</button></div></div>`;
  else if (!$("backup-note").querySelector(".err")) $("backup-note").innerHTML = "";
  const b2 = $("b-export2"); if (b2) b2.onclick = exportAll;
}

/* ========== 予想の固定（指紋） ========== */
function fingerprint(r) {
  const src = JSON.stringify({ id: r.id, at: r.lockedAt, bets: r.bets.map(b => b.c.join("-")) });
  let h = 2166136261; for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
const raceKey = m => `${m.date}|${m.venue}|${m.raceNo}`;

/* ========== 過去レース検証の時系列チェック ========== */
function pastOrderError(meta) {
  if (!meta.date) return "開催日を読み取れませんでした。出走表の見出し（例「青森競輪 出走表詳細（1R 2026年11月3日 初日）」）も含めて貼り付けてください";
  if (meta.date > todayStr()) return "まだ開催されていないレースは、過去レース検証にできません。「リアルタイム予想」を選んでください";
  return null;
}
function modeNote() {
  $("mode-note").textContent = $("in-mode").value === "past"
    ? "終了したレースを検証します（今日の終了レースも入れられます）。予想には、そのレースより前のレースで学習した結果だけを使います。確定オッズを含めて貼り、予想を確定してから結果を照合します。結果のページは、予想を確定するまで開かないでください。"
    : "これから走るレースです。発走前の出走表と、その時点のオッズを貼ってください。オッズを貼った時刻を記録します。今日のレースでも、もう終わったレースなら「過去レース検証」を選んでください。";
}

/* ========== 予想タブ ========== */
let draft = null;
// 入力欄を空にする（予想を確定したあと自動で。ボタンでもできる）
function clearInputs(all) {
  $("in-paste").value = "";
  ["in-weather", "in-winddir", "in-windstr", "in-posttime"].forEach(id => $(id).value = "");
  wx = null; wxSeq++; msg("wx-msg", "");
  if (all) { draft = null; $("check-card").classList.add("hide"); msg("parse-msg", ""); $("pred-out").innerHTML = ""; }
}
$("b-parse").onclick = () => {
  const text = $("in-paste").value;
  if (!text.trim()) { msg("parse-msg", "出走表とオッズを貼り付けてください", "err"); return; }
  const r = parsePaste(text);
  $("check-card").classList.add("hide"); $("pred-out").innerHTML = "";
  if (!r.ok) { msg("parse-msg", `結果の情報（${r.leak.join("・")}）が含まれているため、読み取りを止めました。発走前の出走表とオッズだけを貼り付けてください。`, "err"); return; }
  if (r.riders.length < 5) { msg("parse-msg", "選手を5人以上読み取れませんでした。チャリロトの「出走表詳細」のページを、上から下まで選んで貼り付けてください。", "err"); return; }
  let note = "";
  if (r.meta.date && r.meta.date < todayStr() && $("in-mode").value === "live") {
    $("in-mode").value = "past"; modeNote();
    note = `<br>${esc(r.meta.date)} のレースなので、「過去レース検証」に切り替えました。`;
  }
  if (r.meta.date && r.meta.date > todayStr() && $("in-mode").value === "past") {
    $("in-mode").value = "live"; modeNote();
    note = `<br>${esc(r.meta.date)} のレースなので、「リアルタイム予想」に切り替えました。`;
  }
  if (r.meta.date === todayStr()) note = `<br>今日のレースです。いまの種類は「${$("in-mode").value === "past" ? "過去レース検証（終了したレース）" : "リアルタイム予想（これから走るレース）"}」です。違っていれば、上の「レースの種類」を変えてから確定してください。`;
  const mode = $("in-mode").value;
  if (mode === "past") { const er = pastOrderError(r.meta); if (er) { msg("parse-msg", er, "err"); return; } }
  if (!REF.venues[r.meta.venue]) r.warnings.push(`場「${r.meta.venue || "不明"}」の参照データがありません。バンクの条件を使わずに予想します`);
  const key = raceKey(r.meta);
  if (S.races.some(x => x.rkey === key)) { msg("parse-msg", "このレースの予想はすでに確定しています。予想は1レース1回だけです。", "err"); return; }
  draft = { mode, parsed: r, oddsAt: new Date().toISOString() };
  const nOdds = Object.keys(r.odds).length, nR = r.riders.length, need = nR * (nR - 1) * (nR - 2);
  if (nOdds === 0) { msg("parse-msg", `3連単オッズを読み取れませんでした（選手${nR}人は読み取れています）。チャリロトの「オッズ表詳細」のページも、出走表と一緒に貼り付けてください。オッズがないと正しく予想できないため、ここで止めます。`, "err"); return; }
  if (nOdds < need * 0.5) note += `<br>3連単オッズが${nOdds}通りしか読めていません（${nR}車立てなら${need}通り）。オッズ表を最後まで選んで貼り付けたか確かめてください。`;
  msg("parse-msg", `読み取りました：選手${nR}人・3連単オッズ${nOdds}通り${note}`, nOdds < need * 0.5 ? "warn" : "ok");
  renderCheck();
  const pt = (text.match(/発走(?:予定)?(?:時刻)?\s*[：:]?\s*(\d{1,2})[:：](\d{2})/) || []);
  $("in-posttime").value = pt[1] ? `${pt[1].padStart(2, "0")}:${pt[2]}` : "";
  const band = (S.timeBand || {})[r.meta.venue];
  if (band && REF.timeBand[band]) $("in-band").value = band;
  fetchWeather();
};

/* ========== 天気の自動取得（例外として、気象データだけ外から取る） ========== */
let wx = null, wxSeq = 0;
const WX_DIR = { homeHead: "ホーム向かい風", backHead: "ホーム追い風", crossHB: "横風（ホーム→バック）", crossBH: "横風（バック→ホーム）" };
function addDays(dateStr, n) { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); const p = x => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
// 発走時刻：入力があればそれ、なければ時間帯とレース番号から見積もる
function postTime(meta) {
  const v = $("in-posttime").value;
  if (/^\d{2}:\d{2}$/.test(v)) return { hm: v, est: false };
  const b = REF.timeBand[$("in-band").value] || REF.timeBand.day;
  const [h, m] = b.start.split(":").map(Number), t = h * 60 + m + (Math.max(1, Number(meta.raceNo) || 1) - 1) * b.step;
  return { hm: `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`, est: true, band: b.label, nextDay: t >= 1440 };
}
// 風の方角（風が吹いてくる方角、度）を、その場のバンクの向きで言い換える
function windToBank(fromDeg, headDeg) {
  const d = ((fromDeg - headDeg + 540) % 360) - 180;
  if (Math.abs(d) <= 45) return "homeHead";
  if (Math.abs(d) >= 135) return "backHead";
  return d > 0 ? "crossHB" : "crossBH";
}
function wxJudge(h) {
  const R = REF.weatherRule, c = h.code;
  const rainCode = c != null && ((c >= 51 && c <= 67) || (c >= 71 && c <= 77) || (c >= 80 && c <= 86) || c >= 95);
  return {
    weather: (h.precip != null && h.precip >= R.rainMm) || rainCode ? "雨" : (h.cloud != null && h.cloud >= R.cloudPct ? "曇" : "晴"),
    windDir: h.ws != null && h.ws >= R.calmMs && h.wd != null && h.head != null ? windToBank(h.wd, h.head) : "",
    windStr: h.ws != null && h.ws >= R.strongMs ? "強" : ""
  };
}
async function fetchWeather() {
  if (!draft) return;
  const seq = ++wxSeq, m = draft.parsed.meta, v = REF.venues[m.venue], geo = (REF.geo || {})[m.venue];
  wx = null; $("cond-box").open = true;
  if (v && v.dome) { msg("wx-msg", `${esc(m.venue)}はドーム（屋内）なので、天気と風は使いません。`, "ok"); return; }
  if (!m.date || !geo) { msg("wx-msg", "開催日か場が分からないため、天気を取れませんでした。分かれば手で選んでください。", "warn"); return; }
  const pt = postTime(m), date = pt.nextDay ? addDays(m.date, 1) : m.date, hour = Math.round((Number(pt.hm.slice(0, 2)) * 60 + Number(pt.hm.slice(3))) / 60) % 24;
  const today = todayStr();
  if (date > addDays(today, 15)) { msg("wx-msg", "まだ先のレースなので、天気予報がありません。近くなったら「天気を取り直す」を押してください。", "warn"); return; }
  const FC = "https://api.open-meteo.com/v1/forecast", AR = "https://archive-api.open-meteo.com/v1/archive";
  // 古い日付は過去データ（再解析）、それ以外は予報。取れなければ、過去の日付に限ってもう片方も試す
  const bases = date < addDays(today, -80) ? [AR, FC] : date < addDays(today, -6) ? [FC, AR] : [FC];
  const q = new URLSearchParams({ latitude: geo[0], longitude: geo[1], start_date: date, end_date: date, timezone: "Asia/Tokyo", wind_speed_unit: "ms",
    hourly: "precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m" });
  msg("wx-msg", "天気を取得しています…", "ok");
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
  try {
    let H = null, idx = -1, useArchive = false;
    for (const base of bases) {
      try {
        const res = await fetch(`${base}?${q}`, { signal: ctl.signal, referrerPolicy: "no-referrer", credentials: "omit" });
        if (!res.ok) continue;
        const j = await res.json(), h = j && j.hourly;
        const i = h && Array.isArray(h.time) ? h.time.findIndex(t => t === `${date}T${String(hour).padStart(2, "0")}:00`) : -1;
        if (i >= 0 && h.wind_speed_10m && h.wind_speed_10m[i] != null) { H = h; idx = i; useArchive = base === AR; break; }
      } catch (x) { if (ctl.signal.aborted) break; }
    }
    if (seq !== wxSeq || !draft) return;
    if (!H) throw new Error("no data");
    const num = a => (Array.isArray(a) && Number.isFinite(Number(a[idx])) && a[idx] !== null ? Number(a[idx]) : null);
    const h = { precip: num(H.precipitation), code: num(H.weather_code), cloud: num(H.cloud_cover), ws: num(H.wind_speed_10m), wd: num(H.wind_direction_10m), head: (REF.homeHead || {})[m.venue] ?? null };
    const c = wxJudge(h);
    $("in-weather").value = c.weather; $("in-winddir").value = c.windDir; $("in-windstr").value = c.windStr;
    wx = { source: useArchive ? "Open-Meteo（過去の観測・再解析）" : "Open-Meteo（予報・直近の解析）", at: new Date().toISOString(), date, hour, postTime: pt.hm, estimated: pt.est, band: pt.band || null, raw: h, auto: c };
    const dirs = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"], from = h.wd == null ? "" : dirs[Math.round(h.wd / 45) % 8];
    msg("wx-msg", `${esc(date)} ${String(hour).padStart(2, "0")}時ごろ（${pt.est ? `${esc(pt.band)}の${Number(m.raceNo) || "?"}Rとして見積もった発走 ${esc(pt.hm)}` : `発走 ${esc(pt.hm)}`}）の天気：${c.weather}・${from ? from + "の風" : "風向き不明"} ${h.ws ?? "-"}m/s ・ 降水 ${h.precip ?? "-"}mm ・ 雲 ${h.cloud ?? "-"}%<br>→ ${c.windDir ? WX_DIR[c.windDir] : "風は弱いので向きは使いません"}${c.windStr ? "（強い）" : ""}。下の欄に入れました。違っていれば直してください。`, "ok");
  } catch (e) {
    if (seq !== wxSeq) return;
    msg("wx-msg", "天気を取れませんでした（通信できないか、気象データが混み合っています）。分かれば手で選ぶか、「天気を取り直す」を押してください。", "warn");
  } finally { clearTimeout(timer); }
}
$("b-wx").onclick = () => { if (!draft) { msg("wx-msg", "先に出走表を読み取ってください", "warn"); return; } fetchWeather(); };
$("in-band").onchange = () => {
  if (draft && draft.parsed.meta.venue) { S.timeBand = S.timeBand || {}; S.timeBand[draft.parsed.meta.venue] = $("in-band").value; save(); }
  if (draft && !$("in-posttime").value) fetchWeather();
};
$("in-posttime").onchange = () => { if (draft) fetchWeather(); };
function renderCheck() {
  const r = draft.parsed, m = r.meta;
  $("check-card").classList.remove("hide");
  $("check-title").textContent = `${m.venue || "場不明"} ${m.raceNo || "?"}R ・ ${m.date || ""} ${m.day || ""} ・ ${m.kind || ""} ${m.grade || ""} ・ ${r.riders.length}車`;
  $("check-table").innerHTML = `<table><thead><tr><th>車</th><th>選手</th><th>府県</th><th>級</th><th>脚質</th><th class="n">得点</th><th class="n">S</th><th class="n">B</th><th>コメント</th></tr></thead><tbody>${r.riders.map(x => `<tr><td>${car(x.no)}</td><td>${esc(x.name)}</td><td>${esc(x.pref)}</td><td>${esc(x.cls)}</td><td>${esc(x.style)}</td><td class="n">${x.score ?? "-"}</td><td class="n">${x.s ?? "-"}</td><td class="n">${x.b ?? "-"}</td><td class="wrap">${esc(x.comment || "")}</td></tr>`).join("")}</tbody></table>`;
  $("in-lineup").value = r.lineup.map(l => l.join("-")).join(" / ");
  $("check-warn").innerHTML = r.warnings.length ? `<p class="msg warn">${r.warnings.map(esc).join("<br>")}</p>` : "";
  $("b-predict").disabled = false;
}
$("b-predict").onclick = () => {
  if (!draft) return;
  const r = draft.parsed;
  draft.mode = $("in-mode").value;
  if (draft.mode === "past") { const er = pastOrderError(r.meta); if (er) { msg("parse-msg", er, "err"); return; } }
  if (draft.mode === "live" && r.meta.date && r.meta.date < todayStr()) { msg("parse-msg", "前日以前のレースは「リアルタイム予想」にできません。「過去レース検証」を選んでください", "err"); return; }
  const key = raceKey(r.meta);
  if (S.races.some(x => x.rkey === key)) { msg("parse-msg", "このレースの予想はすでに確定しています。", "err"); return; }
  const lineup = $("in-lineup").value.split(/[\/／|｜]/).map(g => (g.match(/[1-9]/g) || []).map(Number)).filter(g => g.length);
  const race = {
    id: "r" + Date.now(), mode: draft.mode, rkey: key, at: new Date().toISOString(),
    meta: r.meta, riders: r.riders, lineup, odds: r.odds,
    oddsType: draft.mode === "past" ? "確定" : "締め切り前", oddsAt: draft.oddsAt,
    cond: { weather: $("in-weather").value || null, windDir: $("in-winddir").value || null, windStr: $("in-windstr").value || null },
    condSrc: wx ? { ...wx, edited: $("in-weather").value !== wx.auto.weather || $("in-winddir").value !== wx.auto.windDir || $("in-windstr").value !== wx.auto.windStr } : { source: "手入力" },
    marks: r.riders.map(x => ({ no: x.no, mark: x.mark })),   // 予想印は記録だけ（予想には使わない）
    status: "pending"
  };
  if (race.mode === "past") {
    // 過去レース検証：みんなの学習は使わない（そのレースより後のデータが入っているため）
    const st = pastState(race.meta);
    K.predict(race, st.model, st.acc, { mode: "past" });
    race.modelSource = `過去レース用の学習（このレースより前の${st.stats.races}Rだけ）`;
  } else {
    const useShared = !!(S.shared && S.shared.model);
    K.predict(race, useShared ? S.shared.model : S.model, useShared ? S.shared.acc : S.acc, { mode: race.mode });
    race.modelSource = useShared ? `みんなの学習 v${Number(S.shared.model.ver) || 0}（${Number(S.shared.stats.races) || 0}R・${new Date(S.shared.builtAt).toLocaleString("ja-JP")}時点）` : "この端末の学習";
  }
  race.lockedAt = new Date().toISOString(); race.fp = fingerprint(race);
  S.races.unshift(race); save();
  $("b-predict").disabled = true; draft = null;
  clearInputs(false);
  $("pred-out").innerHTML = predCard(race);
  $("pred-out").scrollIntoView({ behavior: "smooth", block: "start" });
};
/* ========== かんたん表示の言い換え ========== */
const PLAIN = {
  "級班": "クラス", "2連対率": "2着以内の率", "3連対率": "3着以内の率",
  "ライン位置の基本力": "並びの位置", "主導権(S・B)": "レースを引っ張る力", "先行争い": "先行争いの影響",
  "選手コメント": "コメントの意気込み", "競り": "位置の競り合い", "先頭の強さ": "前を走る選手の強さ", "ライン結束": "ラインのまとまり",
  "車番・枠": "車番", "近況着順": "最近の着順", "調子の流れ": "調子", "年齢・期別": "若さ", "ギヤと変更": "ギヤ", "明け・間隔": "レースの間隔",
  "周長×決まり手": "このバンクと戦法の相性", "みなし直線": "直線の長さとの相性", "カント": "バンクの傾きとの相性",
  "場の先行有利度": "この場の逃げやすさ", "当場・周長の成績": "この場での成績", "天候": "天気・風との相性",
  "グレード適性": "このグレードでの成績", "選手別の蓄積補正": "これまでの成績", "条件別の蓄積補正": "同じ条件での成績"
};
const PLAIN_KEYS = Object.keys(PLAIN).sort((a, b) => b.length - a.length);
function plain(s) {
  if (S.dev) return s;
  let t = String(s)
    .replace(/モデルの見立てが市場より高い（モデル [\d.]+%・市場 [\d.]+%）/, "オッズの人気よりも、このアプリの評価が高い（狙い目）")
    .replace(/（総合評価(\d+)位）/g, "（このアプリの評価で$1位）")
    .replace(/が高かったが、重みが足りなかった/, "が良かった。この点を学習に生かします")
    .replace(/敗因なし。同じ条件で再現できるかを引き続き確かめる/, "予想どおりの決着");
  // 長い言葉から順に、一度だけ言い換える（言い換えた言葉をもう一度言い換えない）
  const marks = [];
  PLAIN_KEYS.forEach((k, i) => { if (t.includes(k)) { t = t.split(k).join(`\u0000${i}\u0000`); marks.push(i); } });
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => PLAIN[PLAIN_KEYS[i]]);
}
function predCard(r) {
  const m = r.meta;
  return `<div class="card"><div class="bethead"><h2>${esc(m.venue || "")} ${m.raceNo || ""}R ・ ${esc(m.grade || "")} ・ ${r.riders.length}車</h2>${clsPill(r.cls)}</div>
  <p class="note dev">区分の根拠：${esc(r.clsWhy)}</p>
  <p class="note dev">${r.mode === "past" ? "過去レース検証" : "リアルタイム予想"} ・ オッズ：${r.hasOdds ? esc(r.oddsType) : "なし"} ・ 使ったモデル：${esc(r.modelSource || ("v" + r.modelVer))}</p>
  <p class="note">予想確定 ${new Date(r.lockedAt).toLocaleString("ja-JP")}<span class="dev"> ・ 指紋 ${r.fp}</span>（あとから変更できません）</p>
  <h3>買い目 ${r.bets.length}点（${r.bets.length * 100}円）</h3>
  ${r.bets.map(b => `<div class="bet"><div class="bethead">${comboHtml(b.c)}<span class="prob"><span class="dev">推定 ${pct(b.p)} ・ </span>${b.odds ? `${b.odds}倍` : ""}<span class="dev">${b.ev != null ? ` ・ 期待値 ${b.ev.toFixed(2)}` : ""}</span></span></div>
    <div class="why">${b.win.map(x => `<b class="w">勝因</b><span>${esc(plain(x))}</span>`).join("")}${b.risk.map(x => `<b class="l">敗因</b><span>${esc(plain(x))}</span>`).join("")}</div></div>`).join("")}
  <details class="dev"><summary>総合評価の順位</summary><div class="tbl">${rankTable(r)}</div></details></div>`;
}
function rankTable(r) {
  const LI = K.lineInfo(r);
  const rows = r.riders.map((x, i) => ({ x, z: r.comb[i] })).sort((a, b) => b.z - a.z);
  return `<table><thead><tr><th>順</th><th>車</th><th>選手</th><th>位置</th><th class="n">総合</th><th class="n">得点</th></tr></thead><tbody>${rows.map((o, i) => `<tr><td class="n">${i + 1}</td><td>${car(o.x.no)}</td><td>${esc(o.x.name)}</td><td>${K.posLabel(LI[o.x.no])}</td><td class="n">${o.z.toFixed(2)}</td><td class="n">${o.x.score ?? "-"}</td></tr>`).join("")}</tbody></table>`;
}

/* ========== 照合タブ ========== */
let sel = null, readRes = null;
function renderPending() {
  const pend = S.races.filter(r => r.status === "pending");
  $("pending-list").innerHTML = pend.length ? pend.map(r => `<button class="item" data-id="${r.id}" aria-pressed="${sel && sel.id === r.id}"><span>${esc(r.meta.date)} ${esc(r.meta.venue)} ${r.meta.raceNo}R ${clsPill(r.cls)}</span><span>${r.bets.map(b => b.c.join("")).join(" ・ ")}</span></button>`).join("")
    : `<p class="note">照合を待っているレースはありません。「予想」タブで予想を確定すると、ここに並びます。</p>`;
  document.querySelectorAll("#pending-list .item").forEach(b => b.onclick = () => { sel = S.races.find(r => r.id === b.dataset.id); readRes = null; renderPending(); openRes(); });
  if (!pend.length) $("res-card").classList.add("hide");
  else if ($("res-card").classList.contains("hide")) openRes();     // レースを選ばなくても、結果を貼れば自動で選ぶ
}
let cancelArmed = false;
$("b-cancel").onclick = () => {
  if (!sel) return;
  if (!cancelArmed) { cancelArmed = true; $("b-cancel").textContent = "もう一度押すと取り消します（元に戻せません）"; setTimeout(() => { cancelArmed = false; $("b-cancel").textContent = "この予想を取り消す"; }, 8000); return; }
  cancelArmed = false; $("b-cancel").textContent = "この予想を取り消す";
  sel.status = "cancelled"; sel.cancelledAt = new Date().toISOString(); save();
  msg("res-msg", "");
  $("res-out").innerHTML = `<div class="card"><p class="msg ok">${esc(sel.meta.venue)} ${Number(sel.meta.raceNo)}R の予想を取り消しました。成績と学習には入りません。取り消した件数は「成績」に表示されます。</p></div>`;
  sel = null; readRes = null; $("res-card").classList.add("hide"); renderPending();
};
function resTitle() {
  $("res-title").textContent = sel ? `${sel.meta.venue} ${sel.meta.raceNo}R（${sel.meta.date}）の結果` : "結果を貼り付け（どのレースかは自動で選びます）";
  $("b-cancel").classList.toggle("hide", !sel); $("cancel-note").classList.toggle("hide", !sel);
}
function openRes() {
  $("res-card").classList.remove("hide"); $("b-judge").classList.add("hide"); msg("res-msg", "");
  $("in-result").value = "";
  resTitle();
}
$("b-readres").onclick = () => {
  const t = $("in-result").value; if (!t.trim()) { msg("res-msg", "結果ページを貼り付けてください", "err"); return; }
  const r = parseResult(t);
  if (!sel) {
    const same = (a, b) => a && b && (a.includes(b) || b.includes(a));
    const cand = S.races.filter(x => x.status === "pending" && same(x.meta.venue, r.venue) && Number(x.meta.raceNo) === Number(r.raceNo));
    if (!r.venue || !r.raceNo) { msg("res-msg", "どの場・何レースの結果か読み取れませんでした。結果ページを上から貼り付けるか、上の一覧からレースを選んでください。", "err"); return; }
    if (cand.length === 0) { msg("res-msg", `照合を待っている予想の中に、${esc(r.venue)} ${Number(r.raceNo)}R がありません。`, "err"); return; }
    if (cand.length > 1) { msg("res-msg", `${esc(r.venue)} ${Number(r.raceNo)}R の予想が${cand.length}つあります（日付違い）。上の一覧から、どの日のレースかを選んでください。`, "warn"); return; }
    sel = cand[0]; resTitle();
    document.querySelectorAll("#pending-list .item").forEach(b => b.setAttribute("aria-pressed", b.dataset.id === sel.id));
  }
  if (r.venue && sel.meta.venue && !sel.meta.venue.includes(r.venue) && !r.venue.includes(sel.meta.venue)) { msg("res-msg", `貼られた結果は「${esc(r.venue)}」のものです。選んだレース（${esc(sel.meta.venue)}）と違います。`, "err"); return; }
  if (r.raceNo && sel.meta.raceNo && r.raceNo !== sel.meta.raceNo) { msg("res-msg", `貼られた結果は${Number(r.raceNo)}Rのものです。選んだレース（${Number(sel.meta.raceNo)}R）と違います。`, "err"); return; }
  if (!r.order.length) { msg("res-msg", "着順を読み取れませんでした。KEIRIN.JPの結果ページの「着順」の部分を含めて貼り付けてください。", "err"); return; }
  if (!r.trifecta.length && !r.refund) { msg("res-msg", "3連単の払戻金を読み取れませんでした。「払戻金」の部分を含めて貼り付けてください。", "err"); return; }
  readRes = r;
  msg("res-msg", `読み取りました：着順 ${r.order.join("-")} ・ 3連単 ${r.trifecta.map(x => `${x.combo.join("-")} ${yen(x.pay)}（${x.popular}番人気）`).join("、") || "返還"}${r.warnings.length ? "<br>" + r.warnings.map(esc).join("<br>") : ""}`, r.warnings.length ? "warn" : "ok");
  $("b-judge").classList.remove("hide");
};
$("b-judge").onclick = () => {
  if (!sel || !readRes) return;
  if (sel.fp && fingerprint(sel) !== sel.fp) { msg("res-msg", "この予想は確定後に変更された形跡があるため、照合できません。", "err"); return; }
  const r = sel, res = readRes;
  const j = K.judge(r, res);
  r.result = { ...j, finishers: res.finishers, popular: res.trifectaPopular, at: new Date().toISOString() };
  S.stats.races++; S.stats.invested += j.inv; S.stats.returned += j.ret;
  if (j.hit) { S.stats.hits++; S.stats.lossStreak = 0; } else S.stats.lossStreak++;
  r.result.learn = K.learn(r, res, S.model, S.acc, S.stats);
  r.status = "done";
  let meta = null;
  if (S.stats.races % 10 === 0) { meta = K.metaLoop(S.races, S.model, S.stats); if (meta) { S.metaLog.unshift(meta); S.metaLog = S.metaLog.slice(0, 50); } }
  enqueue(r);
  save();
  $("res-out").innerHTML = resultCard(r, meta);
  if (window.KEIRIN_SHARED_URL && S.join === null) $("join-card").classList.remove("hide");
  flush();
  sel = null; readRes = null; $("res-card").classList.add("hide"); renderPending();
  $("res-out").scrollIntoView({ behavior: "smooth", block: "start" });
};
function resultCard(r, meta) {
  const R = r.result, bal = R.ret - R.inv;
  return `<div class="card"><div class="verdict ${R.hit ? "hit" : "miss"}"><span class="big">${R.hit ? "的中" : "不的中"}</span>
    <div><div>${esc(r.meta.venue)} ${r.meta.raceNo}R ${clsPill(r.cls)}</div><div class="note">結果 ${comboHtml(R.order)}${R.popular ? `（${R.popular}番人気）` : ""}</div></div></div>
    <div class="kpis"><div class="kpi"><div class="k">払戻</div><div class="v">${yen(R.ret)}</div></div><div class="kpi"><div class="k">収支</div><div class="v" style="color:${bal >= 0 ? "var(--good)" : "var(--bad)"}">${bal >= 0 ? "+" : ""}${yen(bal)}</div></div></div>
    ${R.analysis.map(a => `<div class="bet"><div class="bethead">${comboHtml(a.c)}<span class="pill ${a.hit ? "kata" : "are"}">${a.hit ? "的中" : "外れ"}</span></div>
      <div class="why">${a.win.map(x => `<b class="w">勝因</b><span>${esc(plain(x))}</span>`).join("")}${a.lose.map(x => `<b class="l">敗因</b><span>${esc(plain(x))}</span>`).join("")}</div></div>`).join("")}
    <p class="note dev">学習に反映：${R.learn.map(esc).join(" ／ ")} ・ モデル v${S.model.ver}</p>
    ${meta ? `<div class="msg warn dev"><b>全体の見直し（${meta.race}R時点）</b><ul class="log">${meta.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul></div>` : ""}</div>`;
}

/* ========== 成績タブ ========== */
function sum(list) {
  const inv = list.reduce((a, r) => a + r.result.inv, 0), ret = list.reduce((a, r) => a + r.result.ret, 0), h = list.filter(r => r.result.hit).length;
  return { n: list.length, h, inv, ret };
}
function renderStats() {
  const done = S.races.filter(r => r.status === "done");
  const live = sum(done.filter(r => r.mode !== "past")), past = sum(done.filter(r => r.mode === "past")), all = sum(done);
  const row = (label, o) => `<tr><td>${label}</td><td class="n">${o.n}</td><td class="n">${o.n ? pct(o.h / o.n) : "-"}</td><td class="n">${o.inv ? pct(o.ret / o.inv) : "-"}</td><td class="n">${(o.ret - o.inv).toLocaleString()}</td></tr>`;
  const by = {};
  done.forEach(r => { const k = `${r.cls}|${r.meta.grade}|${r.riders.length}`; (by[k] = by[k] || []).push(r); });
  const rows = Object.entries(by).map(([k, l]) => ({ k: k.split("|"), o: sum(l) })).sort((a, b) => b.o.n - a.o.n);
  // 人気順3点を買った場合の基準
  const base = done.filter(r => r.hasOdds).map(r => {
    const top3 = Object.entries(r.odds).sort((a, b) => a[1] - b[1]).slice(0, 3).map(x => x[0]);
    const hit = top3.includes(r.result.order.join("-"));
    const p = (r.result.pays || []).find(x => x.combo.join("-") === r.result.order.join("-"));
    return { hit, ret: hit && p ? p.pay : 0 };
  });
  const bh = base.filter(x => x.hit).length, bret = base.reduce((a, x) => a + x.ret, 0);
  const cancelled = S.races.filter(r => r.status === "cancelled").length;
  $("v-stats").innerHTML = `<div class="kpis">
    <div class="kpi"><div class="k">レース数</div><div class="v">${all.n}</div></div>
    <div class="kpi"><div class="k">的中率</div><div class="v">${all.n ? pct(all.h / all.n) : "-"}</div></div>
    <div class="kpi"><div class="k">回収率</div><div class="v">${all.inv ? pct(all.ret / all.inv) : "-"}</div></div>
    <div class="kpi"><div class="k">収支</div><div class="v">${(all.ret - all.inv).toLocaleString()}円</div></div></div>
  <div class="card"><h2>種類別</h2><p class="note">オッズの種類が違うので、リアルタイムと過去レース検証は分けて見ます。</p>
    <div class="tbl"><table><thead><tr><th>種類</th><th class="n">R</th><th class="n">的中率</th><th class="n">回収率</th><th class="n">収支</th></tr></thead><tbody>${row("リアルタイム", live)}${row("過去レース検証", past)}</tbody></table></div></div>
  <div class="card dev"><h2>超えるべき基準</h2><p class="note">同じレースで、オッズの人気順に3点買った場合です。システムはこれを上回る必要があります。</p>
    <div class="tbl"><table><thead><tr><th></th><th class="n">R</th><th class="n">的中率</th><th class="n">回収率</th></tr></thead><tbody>
    <tr><td>人気順3点</td><td class="n">${base.length}</td><td class="n">${base.length ? pct(bh / base.length) : "-"}</td><td class="n">${base.length ? pct(bret / (base.length * 300)) : "-"}</td></tr></tbody></table></div></div>
  <div class="card dev"><h2>区分・グレード・車立別</h2>${rows.length ? `<div class="tbl"><table><thead><tr><th>区分</th><th>グレード</th><th class="n">車立</th><th class="n">R</th><th class="n">的中率</th><th class="n">回収率</th></tr></thead><tbody>${rows.map(x => `<tr><td>${clsPill(x.k[0])}</td><td>${esc(x.k[1])}</td><td class="n">${x.k[2]}</td><td class="n">${x.o.n}</td><td class="n">${pct(x.o.h / x.o.n)}</td><td class="n">${pct(x.o.ret / x.o.inv)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note">結果を照合すると、ここに集計されます。</p>`}</div>
  ${cancelled ? `<p class="note">取り消した予想：${cancelled}件（成績と学習には入っていません）</p>` : ""}
  <div class="card dev"><h2>予想確率の当たり具合</h2><p class="note">買い目に付けた確率どおりに当たっているかを見ます。「予想の合計」と「実際の的中」が近いほど、確率が正確です。</p>${calib(done)}</div>
  <div class="card"><h2>最近の結果</h2>${done.length ? `<div class="tbl"><table><thead><tr><th>レース</th><th>結果</th><th></th><th class="n">収支</th></tr></thead><tbody>${done.slice(0, 30).map(r => `<tr><td>${esc(r.meta.date.slice(5))} ${esc(r.meta.venue)}${r.meta.raceNo}R</td><td>${comboHtml(r.result.order)}</td><td><span class="pill ${r.result.hit ? "kata" : "are"}">${r.result.hit ? "的中" : "外れ"}</span></td><td class="n">${(r.result.ret - r.result.inv).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note">まだありません。</p>`}</div>`;
}

function calib(done) {
  const bins = [[0, 0.02, "2%未満"], [0.02, 0.05, "2〜5%"], [0.05, 0.1, "5〜10%"], [0.1, 0.2, "10〜20%"], [0.2, 1.01, "20%以上"]];
  const rows = bins.map(([lo, hi, lab]) => {
    const bs = done.flatMap(r => r.bets.filter(b => b.p >= lo && b.p < hi).map(b => ({ p: b.p, hit: b.c.join("-") === r.result.order.join("-") })));
    return { lab, n: bs.length, exp: bs.reduce((a, b) => a + b.p, 0), hit: bs.filter(b => b.hit).length };
  }).filter(x => x.n);
  if (!rows.length) return `<p class="note">結果を照合すると、ここに集計されます。</p>`;
  return `<div class="tbl"><table><thead><tr><th>付けた確率</th><th class="n">買い目</th><th class="n">予想の合計</th><th class="n">実際の的中</th></tr></thead><tbody>${rows.map(x => `<tr><td>${x.lab}</td><td class="n">${x.n}</td><td class="n">${x.exp.toFixed(1)}</td><td class="n">${x.hit}</td></tr>`).join("")}</tbody></table></div>`;
}

/* ========== 学習タブ ========== */
function renderLearn() {
  const shared = !!(S.shared && S.shared.model);
  const m = shared ? S.shared.model : S.model, g = m.cells["*|*|*"].w, mx = Math.max(...K.PER.map(e => Math.abs(g[e])), 0.01);
  const logs = shared ? (S.shared.metaLog || []) : S.metaLog;
  const groups = [...new Set(K.ENGINES.map(e => e[2]))];
  $("v-learn").innerHTML = `<div class="card"><h2>${shared ? "みんなの学習" : "この端末の学習"} ・ モデル v${Number(m.ver) || 0}</h2>
    ${shared ? `<p class="note">${Number(S.shared.stats.races) || 0}レースから学習（${new Date(S.shared.builtAt).toLocaleString("ja-JP")}に作成）。見直しはサーバーが1時間ごとに行います。</p>` : ""}
    <p class="note">集中度β ${m.beta.toFixed(2)} ・ 市場の比重α ${m.alpha.toFixed(2)} ・ スジ決着の補正 ${m.syn.toFixed(2)} ・ 2着の補正 ${Number(m.lam2 ?? 1).toFixed(2)} ・ 3着の補正 ${Number(m.lam3 ?? 1).toFixed(2)} ・ 学習率 ${Number(m.lr)}（いま${S.stats.lossStreak}連敗。連敗中は自動で下げます）</p>
    <p class="note">番組・条件の集中度：${m.kf ? Object.entries({ final: "準決・決勝", tokusen: "特選", ippan: "一般・選抜", seven: "7車立て", rain: "雨", wind: "強風" }).map(([k, l]) => `${l} ${Number(m.kf[k]).toFixed(2)}`).join(" ・ ") : "初期値"}</p>
    <p class="note">区分：1番人気オッズが基準の ${m.th.kataRatio.toFixed(2)} 倍以下で堅め、${m.th.areRatio.toFixed(2)} 倍以上で荒れ</p>
    <p class="note">偶然に振り回されない仕組み：1回の変化は0.02まで ・ 最初の見立て（事前の重み）へ少しずつ引き戻す ・ データが少ない条件は上の条件の重みと混ぜる ・ 10Rごとに直近30Rで今と最良版を比べ、悪くなっていたら最良版に戻す</p>
    <p class="note">過去レース検証は、この学習ではなく、そのレースより前のレースだけで毎回学習し直した結果で予想します（先読み防止）。</p>
    ${m.best ? `<p class="note">最良版：v${Number(m.best.ver) || 0}（平均対数尤度 ${m.best.ll.toFixed(3)}）</p>` : ""}
    <div class="btns${shared ? " hide" : ""}"><button class="btn sub" id="b-meta">今すぐ見直す</button><button class="btn sub" id="b-rollback"${m.best ? "" : " disabled"}>最良版に戻す</button></div><div id="learn-msg"></div></div>
  <div class="card"><h2>36エンジンの重み（全体）</h2><p class="note">「race」はレース全体に効くエンジンで、重みではなく上の集中度・市場の比重・スジ補正で効きます。赤い棒は、逆向き（値が高いほど不利）に学習されたエンジンです。</p>
    ${groups.map(gp => `<h3>${gp}</h3><div class="tbl"><table><tbody>${K.ENGINES.filter(e => e[2] === gp).map(e => `<tr><td>${e[0]}</td><td>${e[1]}</td><td style="width:38%">${e[3] === "per" ? `<div class="bar"><span style="width:${(Math.abs(g[e[0]]) / mx * 100).toFixed(0)}%${g[e[0]] < 0 ? ";background:var(--bad)" : ""}"></span></div>` : `<span class="note">race</span>`}</td><td class="n">${e[3] === "per" ? g[e[0]].toFixed(2) : ""}</td></tr>`).join("")}</tbody></table></div>`).join("")}</div>
  <div class="card"><h2>見直しの記録</h2>${logs.length ? logs.slice(0, 10).map(e => `<details><summary>${Number(e.race) || 0}R時点 ・ v${Number(e.ver) || 0}</summary><ul class="log">${e.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul></details>`).join("") : `<p class="note">10レース照合するごとに自動で見直します（5R以上あれば手動でもできます）。</p>`}</div>`;
  $("b-meta").onclick = () => { const e = K.metaLoop(S.races, S.model, S.stats); if (!e) { msg("learn-msg", "照合済みのレースが5R以上必要です", "warn"); return; } S.metaLog.unshift(e); save(); renderLearn(); msg("learn-msg", "見直しました", "ok"); };
  $("b-rollback").onclick = () => { if (!m.best) return; m.cells = JSON.parse(JSON.stringify(m.best.cells)); ["beta", "alpha", "syn"].forEach(k => m[k] = m.best[k]); m.ver++; S.metaLog.unshift({ at: new Date().toISOString(), race: S.stats.races, ver: m.ver, ll: m.best.ll, lines: [`手動で最良版 v${m.best.ver} に戻した`] }); save(); renderLearn(); msg("learn-msg", "最良版に戻しました", "ok"); };
}

/* ========== 保存・説明タブ ========== */
function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportAll() {
  S.exportedDone = S.races.filter(r => r.status === "done").length; S.exportedAt = new Date().toISOString();
  download(`keirin_lab_${stamp()}.json`, { app: "競輪3連単ラボ", exportedAt: S.exportedAt, data: S });
  save(); msg("io-msg", "ファイルに保存しました（スマホの「ダウンロード」フォルダ）", "ok");
}
$("b-export").onclick = exportAll;
$("b-learnexport").onclick = () => {
  const items = S.races.filter(r => r.status === "done").map(r => ({ mode: r.mode, oddsType: r.oddsType, meta: r.meta, riders: r.riders, lineup: r.lineup, odds: r.odds, cond: r.cond, result: { order: r.result.order, pays: r.result.pays, finishers: r.result.finishers } }));
  download(`keirin_lab_learning_${stamp()}.json`, { app: "競輪3連単ラボ", kind: "learning", exportedAt: new Date().toISOString(), items });
  msg("io-msg", `学習用データ（${items.length}レース）を保存しました`, "ok");
};
$("in-import").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try { const o = JSON.parse(rd.result); if (!o.data || o.data.schema !== 1) throw 0; S = Object.assign(fresh(), o.data); save(); render(); msg("io-msg", `復元しました（${S.races.length}レース）`, "ok"); }
    catch (err) { msg("io-msg", "このファイルは読み込めません。「全データを保存」で作ったファイルを選んでください", "err"); }
  };
  rd.readAsText(f);
};
$("b-reset").onclick = () => $("reset-confirm").classList.remove("hide");
$("b-reset-no").onclick = () => $("reset-confirm").classList.add("hide");
$("b-reset-yes").onclick = () => { S = fresh(); save(); $("reset-confirm").classList.add("hide"); render(); };
async function renderUsage() {
  try {
    const e = await navigator.storage.estimate();
    $("usage").textContent = `この端末で使っている容量：約${(e.usage / 1048576).toFixed(1)}MB（${useIDB ? "大きな保存場所" : "小さな保存場所"}を使用中）`;
  } catch (x) { $("usage").textContent = ""; }
}
function renderSet() {
  renderUsage();
  $("engine-list").innerHTML = `<table><tbody>${K.ENGINES.map(e => `<tr><td>${e[0]}</td><td>${e[2]}</td><td>${e[1]}</td></tr>`).join("")}</tbody></table>`;
}

/* ========== みんなの学習（共有学習サーバー） ========== */
const URL_ = () => window.KEIRIN_SHARED_URL || "";
function learningItem(r) {
  return { raceKey: r.rkey, oddsType: r.oddsType, meta: r.meta, riders: r.riders, lineup: r.lineup, odds: r.odds, cond: r.cond,
    result: { order: r.result.order, pays: r.result.pays, finishers: r.result.finishers } };
}
function enqueue(r) { if (!S.outbox.some(x => x.raceKey === r.rkey)) S.outbox.push(learningItem(r)); }
async function post(body) {
  const res = await fetch(URL_(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
  return res.json();
}
async function flush() {
  if (!URL_() || S.join !== true || !S.outbox.length) return null;
  try {
    const items = S.outbox.slice(0, 50);
    const j = await post({ action: "submit", clientId: S.clientId, ownerToken: S.ownerToken || undefined, items });
    if (j.ok) { S.outbox = S.outbox.slice(items.length); save(); }
    return j;
  } catch (e) { return { ok: false, reason: "通信できませんでした。次に開いたときに、もう一度送ります" }; }
}
// 共有モデルの形の確認（数字であるべきところが数字か、重みがそろっているか）
function validShared(j) {
  try {
    const m = j.model, w = m.cells["*|*|*"].w;
    if (![m.ver, m.beta, m.alpha, m.syn, m.lr, j.stats.races].every(x => typeof x === "number" && isFinite(x))) return false;
    if (!K.PER.every(e => typeof w[e] === "number" && isFinite(w[e]) && w[e] >= -5 && w[e] <= 10)) return false;
    if (["lam2", "lam3"].some(k => m[k] != null && !(typeof m[k] === "number" && m[k] > 0 && m[k] <= 1.5))) return false;
    if (m.kf && !Object.values(m.kf).every(x => typeof x === "number" && x > 0.5 && x < 2)) return false;
    if (m.beta < 0 || m.beta > 5 || m.alpha < 0 || m.alpha > 1) return false;
    if (![m.th.kataRatio, m.th.areRatio, m.th.floor.kata, m.th.floor.std, m.th.floor.are].every(x => typeof x === "number" && isFinite(x))) return false;
    if (m.best && !(typeof m.best.ll === "number" && isFinite(m.best.ll))) return false;
    if (!Array.isArray(j.metaLog || [])) return false;
    return !!(j.acc && j.acc.riders && j.acc.resid);
  } catch (e) { return false; }
}
async function pullShared() {
  if (!URL_()) return { ok: false, reason: "共有学習のサーバーがまだ設定されていません" };
  try {
    const res = await fetch(URL_() + "?action=model", { cache: "no-store" });
    const j = await res.json();
    if (!j || j.kind !== "shared" || !validShared(j)) return { ok: false, reason: j && j.reason ? String(j.reason).slice(0, 80) : "共有モデルを読み込めませんでした" };
    S.shared = { model: j.model, acc: j.acc, stats: j.stats, builtAt: j.builtAt, conflicts: j.conflicts, metaLog: j.metaLog || [] };
    save();
    return { ok: true };
  } catch (e) { return { ok: false, reason: "通信できませんでした。この端末の学習で予想します" }; }
}
function renderShare() {
  const st = S.shared;
  $("share-status").innerHTML = !URL_() ? "共有学習のサーバーは準備中です。いまは、この端末の学習だけで予想します。"
    : st ? `みんなの学習：${Number(st.stats.races) || 0}レース分<span class="dev">・モデル v${Number(st.model.ver) || 0}（${esc(new Date(st.builtAt).toLocaleString("ja-JP"))}に作成）</span>。予想にはこの学習結果を使います。${S.outbox.length ? `<br>送信待ち：${S.outbox.length}レース` : ""}`
    : "まだ共有モデルを読み込んでいません。「今すぐ同期する」を押してください。";
  $("in-join").value = S.join === true ? "1" : S.join === false ? "0" : "";
  $("in-owner").value = S.ownerToken || "";
}
$("b-join-yes").onclick = () => { S.join = true; save(); $("join-card").classList.add("hide"); flush(); };
$("b-join-no").onclick = () => { S.join = false; S.outbox = []; save(); $("join-card").classList.add("hide"); };
$("in-join").onchange = () => { const v = $("in-join").value; S.join = v === "1" ? true : v === "0" ? false : null; if (S.join === false) S.outbox = []; save(); renderShare(); };
$("in-owner").onchange = () => { S.ownerToken = $("in-owner").value.trim(); save(); };
$("b-sync").onclick = async () => {
  msg("sync-msg", "同期しています…", "warn");
  const a = await flush(), b = await pullShared();
  msg("sync-msg", [a && (a.ok ? `送信：${a.accepted}レース受け付け${a.rejected && a.rejected.length ? `、${a.rejected.length}レースは受け付けられませんでした（${esc(String(a.rejected[0].reason).slice(0, 60))}）` : ""}` : esc(a.reason)), b.ok ? "みんなの学習を読み込みました" : esc(b.reason)].filter(Boolean).join("<br>"), b.ok ? "ok" : "err");
  renderShare(); save();
};
$("b-claim").onclick = async () => {
  if (!URL_()) { msg("owner-msg", "共有学習のサーバーがまだ設定されていません", "err"); return; }
  if (S.ownerToken) { msg("owner-msg", "この端末には、すでに合言葉が入っています", "warn"); return; }
  msg("owner-msg", "受け取っています…（初回はサーバーの準備で30秒ほどかかります）", "warn");
  try {
    const res = await fetch(URL_() + "?action=claim", { cache: "no-store" }); const j = await res.json();
    if (j.ok && j.ownerToken) { S.ownerToken = j.ownerToken; S.join = true; save(); renderShare(); msg("owner-msg", "合言葉を受け取り、この端末に保存しました。あなたの照合結果は1人分でも学習に使われます。合言葉は「全データを保存」のファイルにも入るので、ファイルは人に渡さないでください。", "ok"); await pullShared(); renderShare(); }
    else msg("owner-msg", esc(j.reason || "受け取れませんでした"), "err");
  } catch (e) { msg("owner-msg", "通信できませんでした。少し待ってから、もう一度押してください", "err"); }
};
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
let latestHash = null;
$("b-code-check").onclick = async () => {
  if (!URL_()) return;
  $("code-status").textContent = "確認しています…";
  try {
    const src = await (await fetch("server/bundle.gs", { cache: "no-store" })).text();
    latestHash = await sha256(src);
    const cur = await (await fetch(URL_() + "?action=code", { cache: "no-store" })).json();
    const same = cur.hash === latestHash;
    $("code-status").innerHTML = `サーバーで動いているコード：${cur.hash ? esc(String(cur.hash).slice(0, 12)) + "…（" + esc(new Date(cur.approvedAt).toLocaleString("ja-JP")) + "に承認）" : "まだ承認されていません"}<br>GitHubの最新：${esc(latestHash.slice(0, 12))}…<br>${same ? "同じです。承認は不要です。" : "違います。開発者（Claude）が更新を伝えたときだけ、承認してください。覚えのない更新なら、承認しないでください。"}`;
    $("b-code-approve").disabled = same;
  } catch (e) { $("code-status").textContent = "確認できませんでした。通信状態を確かめてください"; }
};
$("b-code-approve").onclick = async () => {
  if (!latestHash || !S.ownerToken) { msg("owner-msg", "先に「確認する」を押してください（合言葉も必要です）", "err"); return; }
  msg("owner-msg", "承認しています…", "warn");
  try {
    const j = await post({ action: "approveCode", ownerToken: S.ownerToken, expectHash: latestHash });
    msg("owner-msg", j.ok ? `承認しました（${esc(String(j.hash).slice(0, 12))}…）。サーバーは今後このコードで動きます。` : esc(j.reason), j.ok ? "ok" : "err");
    if (j.ok) { $("b-code-approve").disabled = true; await pullShared(); renderShare(); }
  } catch (e) { msg("owner-msg", "通信できませんでした", "err"); }
};
$("b-admin").onclick = async () => {
  if (!S.ownerToken) { msg("owner-msg", "合言葉が必要です", "err"); return; }
  try {
    const j = await post({ action: "adminStats", ownerToken: S.ownerToken });
    if (!j.ok) { msg("owner-msg", esc(j.reason), "err"); return; }
    const t = j.stats || {};
    msg("owner-msg", `最後の学習し直し：${esc(t.at ? new Date(t.at).toLocaleString("ja-JP") : "-")}<br>採用：開発者 ${Number(t.owner) || 0}R ・ みんな ${Number(t.public) || 0}R<br>確認待ち（信頼できる送信者が2人そろっていない）：${Number(t.waiting) || 0}R<br>食い違いで不採用：${Number(t.conflicts) || 0}R<br>送信者：${Number(t.clients) || 0}人（信頼 ${Number(t.trusted) || 0}人・食い違いで除外 ${Number(t.excluded) || 0}人・手動ブロック ${Number(j.blocked) || 0}人）`, "ok");
  } catch (e) { msg("owner-msg", "通信できませんでした", "err"); }
};
let rotateArmed = false;
$("b-rotate").onclick = async () => {
  if (!S.ownerToken) { msg("owner-msg", "合言葉が必要です", "err"); return; }
  if (!rotateArmed) { rotateArmed = true; $("b-rotate").textContent = "もう一度押すと、合言葉を新しくします"; setTimeout(() => { rotateArmed = false; $("b-rotate").textContent = "合言葉を新しくする"; }, 8000); return; }
  rotateArmed = false; $("b-rotate").textContent = "合言葉を新しくする";
  try {
    const j = await post({ action: "rotateToken", ownerToken: S.ownerToken });
    if (j.ok && j.ownerToken) { S.ownerToken = j.ownerToken; save(); renderShare(); msg("owner-msg", "合言葉を新しくして、この端末に保存しました。古い合言葉はもう使えません。保存したファイルも作り直してください。", "ok"); }
    else msg("owner-msg", esc(j.reason || "できませんでした"), "err");
  } catch (e) { msg("owner-msg", "通信できませんでした", "err"); }
};
$("b-rebuild").onclick = async () => {
  if (!URL_()) { msg("owner-msg", "共有学習のサーバーがまだ設定されていません", "err"); return; }
  msg("owner-msg", "作り直しています…（1分ほどかかることがあります）", "warn");
  try { const j = await post({ action: "rebuild", ownerToken: S.ownerToken, full: true }); msg("owner-msg", j.ok ? `作り直しました：採用 ${Number(j.rebuilt.races) || 0}レース（開発者 ${Number(j.rebuilt.owner) || 0}・みんな ${Number(j.rebuilt.public) || 0}）・確認待ち ${Number(j.rebuilt.waiting) || 0}・食い違い ${Number(j.rebuilt.conflicts) || 0}` : esc(j.reason), j.ok ? "ok" : "err"); if (j.ok) await pullShared(); renderShare(); }
  catch (e) { msg("owner-msg", "通信できませんでした", "err"); }
};

/* ========== タブ ========== */
let view = "pred";
document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => { view = b.dataset.v; render(); });
function render() {
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.v === view));
  ["pred", "res", "stats", "learn", "set"].forEach(v => $("v-" + v).classList.toggle("hide", v !== view));
  if (view === "res") renderPending(); if (view === "stats") renderStats(); if (view === "learn") renderLearn(); if (view === "set") { renderSet(); renderShare(); }
}
$("in-mode").onchange = modeNote;
$("in-dev").onchange = () => { S.dev = $("in-dev").value === "1"; save(); applyDev(); render(); };
$("b-clear").onclick = () => clearInputs(true);
(async () => {
  const { text, moved } = await readStore();
  load(text); applyDev(); modeNote(); save(); render();
  if (moved) { await saveChain; try { localStorage.removeItem(KEY); } catch (e) {} }   // 引っ越しが終わったら、古い場所のデータを消す
  if (URL_()) { flush(); pullShared().then(() => { $("sync").textContent = headerText(); }); }
  // A5：一度開いたら、電波が弱くてもスマホの中から開けるようにする
  if ("serviceWorker" in navigator) { try { navigator.serviceWorker.register("sw.js"); } catch (e) {} }
})();
})();
