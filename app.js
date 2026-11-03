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
function fresh() { return { schema: 1, model: K.freshModel(), acc: K.freshAcc(), races: [], stats: { races: 0, hits: 0, invested: 0, returned: 0, lossStreak: 0 }, metaLog: [] }; }
function load() {
  try { const o = JSON.parse(localStorage.getItem(KEY) || "null"); S = o && o.schema === 1 ? Object.assign(fresh(), o) : fresh(); }
  catch (e) { S = fresh(); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); $("sync").textContent = `この端末に保存 ・ ${S.races.length}レース`; }
  catch (e) { $("sync").textContent = "保存できませんでした（容量不足の可能性）。「全データを保存」でファイルに残してください"; }
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
  if (meta.date >= todayStr()) return "過去レース検証は、今日より前のレースだけが対象です";
  if (S.races.some(r => r.mode === "past" && r.status === "pending")) return "照合していない過去レースがあります。時系列を守るため、先にそのレースの結果を照合してください";
  const last = S.races.filter(r => r.mode === "past").map(r => r.meta.date).sort().pop();
  if (last && meta.date < last) return `時系列が逆になります。過去レースは古い順に入れてください（最後に入れたのは ${last}）`;
  return null;
}
function modeNote() {
  $("mode-note").textContent = $("in-mode").value === "past"
    ? "古い順に1レースずつ進めます。確定オッズを含めて貼り、予想を確定してから結果を照合します。結果のページは、予想を確定するまで開かないでください。"
    : "発走前の出走表と、その時点のオッズを貼ってください。オッズを貼った時刻を記録します。";
}

/* ========== 予想タブ ========== */
let draft = null;
$("b-parse").onclick = () => {
  const text = $("in-paste").value;
  if (!text.trim()) { msg("parse-msg", "出走表とオッズを貼り付けてください", "err"); return; }
  const r = parsePaste(text);
  $("check-card").classList.add("hide"); $("pred-out").innerHTML = "";
  if (!r.ok) { msg("parse-msg", `結果の情報（${r.leak.join("・")}）が含まれているため、読み取りを止めました。発走前の出走表とオッズだけを貼り付けてください。`, "err"); return; }
  if (r.riders.length < 5) { msg("parse-msg", "選手を5人以上読み取れませんでした。チャリロトの「出走表詳細」のページを、上から下まで選んで貼り付けてください。", "err"); return; }
  const mode = $("in-mode").value;
  if (mode === "live" && r.meta.date && r.meta.date !== todayStr()) { msg("parse-msg", `この出走表は ${r.meta.date} のレースです。リアルタイム予想は今日のレースだけです。過去のレースなら「過去レース検証」を選んでください。`, "err"); return; }
  if (mode === "past") { const er = pastOrderError(r.meta); if (er) { msg("parse-msg", er, "err"); return; } }
  if (!REF.venues[r.meta.venue]) r.warnings.push(`場「${r.meta.venue || "不明"}」の参照データがありません。バンクの条件を使わずに予想します`);
  const key = raceKey(r.meta);
  if (S.races.some(x => x.rkey === key)) { msg("parse-msg", "このレースの予想はすでに確定しています。予想は1レース1回だけです。", "err"); return; }
  draft = { mode, parsed: r, oddsAt: new Date().toISOString() };
  msg("parse-msg", `読み取りました：選手${r.riders.length}人・3連単オッズ${Object.keys(r.odds).length}通り`, "ok");
  renderCheck();
};
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
  if (draft.mode === "past") { const er = pastOrderError(r.meta); if (er) { msg("parse-msg", er, "err"); return; } }
  const key = raceKey(r.meta);
  if (S.races.some(x => x.rkey === key)) { msg("parse-msg", "このレースの予想はすでに確定しています。", "err"); return; }
  const lineup = $("in-lineup").value.split(/[\/／|｜]/).map(g => (g.match(/[1-9]/g) || []).map(Number)).filter(g => g.length);
  const race = {
    id: "r" + Date.now(), mode: draft.mode, rkey: key, at: new Date().toISOString(),
    meta: r.meta, riders: r.riders, lineup, odds: r.odds,
    oddsType: draft.mode === "past" ? "確定" : "締め切り前", oddsAt: draft.oddsAt,
    cond: { weather: $("in-weather").value || null, windDir: $("in-winddir").value || null, windStr: $("in-windstr").value || null },
    marks: r.riders.map(x => ({ no: x.no, mark: x.mark })),   // 予想印は記録だけ（予想には使わない）
    pasted: $("in-paste").value, status: "pending"
  };
  K.predict(race, S.model, S.acc, { mode: race.mode });
  race.lockedAt = new Date().toISOString(); race.fp = fingerprint(race);
  S.races.unshift(race); save();
  $("b-predict").disabled = true; draft = null;
  $("pred-out").innerHTML = predCard(race);
  $("pred-out").scrollIntoView({ behavior: "smooth", block: "start" });
};
function predCard(r) {
  const m = r.meta;
  return `<div class="card"><div class="bethead"><h2>${esc(m.venue || "")} ${m.raceNo || ""}R ・ ${esc(m.grade || "")} ・ ${r.riders.length}車</h2>${clsPill(r.cls)}</div>
  <p class="note">区分の根拠：${esc(r.clsWhy)}</p>
  <p class="note">${r.mode === "past" ? "過去レース検証" : "リアルタイム予想"} ・ オッズ：${r.hasOdds ? esc(r.oddsType) : "なし"} ・ モデル v${r.modelVer}</p>
  <p class="note">予想確定 ${new Date(r.lockedAt).toLocaleString("ja-JP")} ・ 指紋 ${r.fp}（あとから変更できません）</p>
  <h3>買い目 ${r.bets.length}点（${r.bets.length * 100}円）</h3>
  ${r.bets.map(b => `<div class="bet"><div class="bethead">${comboHtml(b.c)}<span class="prob">推定 ${pct(b.p)}${b.odds ? ` ・ ${b.odds}倍` : ""}${b.ev != null ? ` ・ 期待値 ${b.ev.toFixed(2)}` : ""}</span></div>
    <div class="why">${b.win.map(x => `<b class="w">勝因</b><span>${esc(x)}</span>`).join("")}${b.risk.map(x => `<b class="l">敗因</b><span>${esc(x)}</span>`).join("")}</div></div>`).join("")}
  <details><summary>総合評価の順位</summary><div class="tbl">${rankTable(r)}</div></details></div>`;
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
}
function openRes() {
  $("res-card").classList.remove("hide"); $("b-judge").classList.add("hide"); msg("res-msg", "");
  $("in-result").value = "";
  $("res-title").textContent = `${sel.meta.venue} ${sel.meta.raceNo}R（${sel.meta.date}）の結果`;
}
$("b-readres").onclick = () => {
  const t = $("in-result").value; if (!t.trim()) { msg("res-msg", "結果ページを貼り付けてください", "err"); return; }
  const r = parseResult(t);
  if (r.venue && sel.meta.venue && !sel.meta.venue.includes(r.venue) && !r.venue.includes(sel.meta.venue)) { msg("res-msg", `貼られた結果は「${r.venue}」のものです。選んだレース（${sel.meta.venue}）と違います。`, "err"); return; }
  if (r.raceNo && sel.meta.raceNo && r.raceNo !== sel.meta.raceNo) { msg("res-msg", `貼られた結果は${r.raceNo}Rのものです。選んだレース（${sel.meta.raceNo}R）と違います。`, "err"); return; }
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
  save();
  $("res-out").innerHTML = resultCard(r, meta);
  sel = null; readRes = null; $("res-card").classList.add("hide"); renderPending();
  $("res-out").scrollIntoView({ behavior: "smooth", block: "start" });
};
function resultCard(r, meta) {
  const R = r.result, bal = R.ret - R.inv;
  return `<div class="card"><div class="verdict ${R.hit ? "hit" : "miss"}"><span class="big">${R.hit ? "的中" : "不的中"}</span>
    <div><div>${esc(r.meta.venue)} ${r.meta.raceNo}R ${clsPill(r.cls)}</div><div class="note">結果 ${comboHtml(R.order)}${R.popular ? `（${R.popular}番人気）` : ""}</div></div></div>
    <div class="kpis"><div class="kpi"><div class="k">払戻</div><div class="v">${yen(R.ret)}</div></div><div class="kpi"><div class="k">収支</div><div class="v" style="color:${bal >= 0 ? "var(--good)" : "var(--bad)"}">${bal >= 0 ? "+" : ""}${yen(bal)}</div></div></div>
    ${R.analysis.map(a => `<div class="bet"><div class="bethead">${comboHtml(a.c)}<span class="pill ${a.hit ? "kata" : "are"}">${a.hit ? "的中" : "外れ"}</span></div>
      <div class="why">${a.win.map(x => `<b class="w">勝因</b><span>${esc(x)}</span>`).join("")}${a.lose.map(x => `<b class="l">敗因</b><span>${esc(x)}</span>`).join("")}</div></div>`).join("")}
    <p class="note">学習に反映：${R.learn.map(esc).join(" ／ ")} ・ モデル v${S.model.ver}</p>
    ${meta ? `<div class="msg warn"><b>全体の見直し（${meta.race}R時点）</b><ul class="log">${meta.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul></div>` : ""}</div>`;
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
  $("v-stats").innerHTML = `<div class="kpis">
    <div class="kpi"><div class="k">レース数</div><div class="v">${all.n}</div></div>
    <div class="kpi"><div class="k">的中率</div><div class="v">${all.n ? pct(all.h / all.n) : "-"}</div></div>
    <div class="kpi"><div class="k">回収率</div><div class="v">${all.inv ? pct(all.ret / all.inv) : "-"}</div></div>
    <div class="kpi"><div class="k">収支</div><div class="v">${(all.ret - all.inv).toLocaleString()}円</div></div></div>
  <div class="card"><h2>種類別</h2><p class="note">オッズの種類が違うので、リアルタイムと過去レース検証は分けて見ます。</p>
    <div class="tbl"><table><thead><tr><th>種類</th><th class="n">R</th><th class="n">的中率</th><th class="n">回収率</th><th class="n">収支</th></tr></thead><tbody>${row("リアルタイム", live)}${row("過去レース検証", past)}</tbody></table></div></div>
  <div class="card"><h2>超えるべき基準</h2><p class="note">同じレースで、オッズの人気順に3点買った場合です。システムはこれを上回る必要があります。</p>
    <div class="tbl"><table><thead><tr><th></th><th class="n">R</th><th class="n">的中率</th><th class="n">回収率</th></tr></thead><tbody>
    <tr><td>人気順3点</td><td class="n">${base.length}</td><td class="n">${base.length ? pct(bh / base.length) : "-"}</td><td class="n">${base.length ? pct(bret / (base.length * 300)) : "-"}</td></tr></tbody></table></div></div>
  <div class="card"><h2>区分・グレード・車立別</h2>${rows.length ? `<div class="tbl"><table><thead><tr><th>区分</th><th>グレード</th><th class="n">車立</th><th class="n">R</th><th class="n">的中率</th><th class="n">回収率</th></tr></thead><tbody>${rows.map(x => `<tr><td>${clsPill(x.k[0])}</td><td>${esc(x.k[1])}</td><td class="n">${x.k[2]}</td><td class="n">${x.o.n}</td><td class="n">${pct(x.o.h / x.o.n)}</td><td class="n">${pct(x.o.ret / x.o.inv)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note">結果を照合すると、ここに集計されます。</p>`}</div>
  <div class="card"><h2>最近の結果</h2>${done.length ? `<div class="tbl"><table><thead><tr><th>レース</th><th>結果</th><th></th><th class="n">収支</th></tr></thead><tbody>${done.slice(0, 30).map(r => `<tr><td>${esc(r.meta.date.slice(5))} ${esc(r.meta.venue)}${r.meta.raceNo}R</td><td>${comboHtml(r.result.order)}</td><td><span class="pill ${r.result.hit ? "kata" : "are"}">${r.result.hit ? "的中" : "外れ"}</span></td><td class="n">${(r.result.ret - r.result.inv).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>` : `<p class="note">まだありません。</p>`}</div>`;
}

/* ========== 学習タブ ========== */
function renderLearn() {
  const m = S.model, g = m.cells["*|*|*"].w, mx = Math.max(...K.PER.map(e => g[e]), 1);
  const groups = [...new Set(K.ENGINES.map(e => e[2]))];
  $("v-learn").innerHTML = `<div class="card"><h2>モデル v${m.ver}</h2>
    <p class="note">集中度β ${m.beta.toFixed(2)} ・ 市場の比重α ${m.alpha.toFixed(2)} ・ スジ決着の補正 ${m.syn.toFixed(2)} ・ 学習率 ${m.lr}（いま${S.stats.lossStreak}連敗。連敗中は自動で下げます）</p>
    <p class="note">区分：1番人気オッズが基準の ${m.th.kataRatio.toFixed(2)} 倍以下で堅め、${m.th.areRatio.toFixed(2)} 倍以上で荒れ</p>
    <p class="note">偶然に振り回されない仕組み：1回の変化は±10%まで ・ データが少ない条件は上の条件の重みと混ぜる ・ 10Rごとに過去30Rで見直し、悪くなっていたら最良版に戻す</p>
    ${m.best ? `<p class="note">最良版：v${m.best.ver}（平均対数尤度 ${m.best.ll.toFixed(3)}）</p>` : ""}
    <div class="btns"><button class="btn sub" id="b-meta">今すぐ見直す</button><button class="btn sub" id="b-rollback"${m.best ? "" : " disabled"}>最良版に戻す</button></div><div id="learn-msg"></div></div>
  <div class="card"><h2>36エンジンの重み（全体）</h2><p class="note">「race」はレース全体に効くエンジンで、重みではなく上の集中度・市場の比重・スジ補正で効きます。</p>
    ${groups.map(gp => `<h3>${gp}</h3><div class="tbl"><table><tbody>${K.ENGINES.filter(e => e[2] === gp).map(e => `<tr><td>${e[0]}</td><td>${e[1]}</td><td style="width:38%">${e[3] === "per" ? `<div class="bar"><span style="width:${(g[e[0]] / mx * 100).toFixed(0)}%"></span></div>` : `<span class="note">race</span>`}</td><td class="n">${e[3] === "per" ? g[e[0]].toFixed(2) : ""}</td></tr>`).join("")}</tbody></table></div>`).join("")}</div>
  <div class="card"><h2>見直しの記録</h2>${S.metaLog.length ? S.metaLog.slice(0, 10).map(e => `<details><summary>${e.race}R時点 ・ v${e.ver}</summary><ul class="log">${e.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul></details>`).join("") : `<p class="note">10レース照合するごとに自動で見直します（5R以上あれば手動でもできます）。</p>`}</div>`;
  $("b-meta").onclick = () => { const e = K.metaLoop(S.races, S.model, S.stats); if (!e) { msg("learn-msg", "照合済みのレースが5R以上必要です", "warn"); return; } S.metaLog.unshift(e); save(); renderLearn(); msg("learn-msg", "見直しました", "ok"); };
  $("b-rollback").onclick = () => { if (!m.best) return; m.cells = JSON.parse(JSON.stringify(m.best.cells)); ["beta", "alpha", "syn"].forEach(k => m[k] = m.best[k]); m.ver++; S.metaLog.unshift({ at: new Date().toISOString(), race: S.stats.races, ver: m.ver, ll: m.best.ll, lines: [`手動で最良版 v${m.best.ver} に戻した`] }); save(); renderLearn(); msg("learn-msg", "最良版に戻しました", "ok"); };
}

/* ========== 保存・説明タブ ========== */
function download(name, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
$("b-export").onclick = () => { download(`keirin_lab_${stamp()}.json`, { app: "競輪3連単ラボ", exportedAt: new Date().toISOString(), data: S }); msg("io-msg", "ファイルに保存しました", "ok"); };
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
function renderSet() {
  $("engine-list").innerHTML = `<table><tbody>${K.ENGINES.map(e => `<tr><td>${e[0]}</td><td>${e[2]}</td><td>${e[1]}</td></tr>`).join("")}</tbody></table>`;
}

/* ========== タブ ========== */
let view = "pred";
document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => { view = b.dataset.v; render(); });
function render() {
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.v === view));
  ["pred", "res", "stats", "learn", "set"].forEach(v => $("v-" + v).classList.toggle("hide", v !== view));
  if (view === "res") renderPending(); if (view === "stats") renderStats(); if (view === "learn") renderLearn(); if (view === "set") renderSet();
}
$("in-mode").onchange = modeNote;
load(); modeNote(); save(); render();
})();
