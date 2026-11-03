// 競輪3連単ラボ 読み取りプログラム
// チャリロトの「出走表詳細＋オッズ表詳細」を1回で貼り付けたテキストを読む。
// AI・Web検索は使わない。同じテキストからは必ず同じ結果を返す。
"use strict";

/* ---------- 正規化 ---------- */
function norm(t) {
  return String(t || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[０-９Ａ-Ｚａ-ｚ．，：／]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[－―−–]/g, "-");
}
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
const isInt1to9 = s => /^[1-9]$/.test(s);

/* ---------- 結果の混入チェック（先読み防止） ---------- */
// サイトのメニューや注意書き（「レース結果」「払戻金を受けた方へ」）は結果ではないので無視する。
// 結果だと判断するのは、表として結果が載っている形だけ。
function resultLeak(text) {
  const t = norm(text);
  const hits = [];
  if (/[1-9]\s*[-=]\s*[1-9]\s*[-=]\s*[1-9][^\n]{0,24}?[\d,]{3,}\s*円/.test(t)) hits.push("組番と払戻金額");
  if (/払戻金?\s*[\t ]*[\d,]{3,}\s*円/.test(t)) hits.push("払戻金額");
  if (/(着順|到達順|確定順位)[\t ]*\n?[\t ]*1[\t ]/.test(t) && /着差/.test(t)) hits.push("着順表");
  if (/上り\s*(タイム)?[\t ]*\d{2}\.\d/.test(t)) hits.push("上りタイム");
  if (/結果詳細|レース結果詳細/.test(t)) hits.push("結果ページ");
  return [...new Set(hits)];
}

/* ---------- 全体の切り分け ---------- */
function split(text) {
  const t = norm(text);
  const iEntry0 = t.search(/出走表詳細/);
  const iEntry = iEntry0 >= 0 ? t.lastIndexOf("\n", iEntry0) + 1 : -1;   // 「青森競輪 出走表詳細」の行頭から
  const iOdds = t.search(/オッズ表詳細/);
  return {
    entry: iEntry >= 0 ? t.slice(iEntry, iOdds > iEntry ? iOdds : undefined) : (iOdds >= 0 ? t.slice(0, iOdds) : t),
    odds: iOdds >= 0 ? t.slice(iOdds) : ""
  };
}

/* ---------- レース情報 ---------- */
function parseMeta(entry, odds) {
  const meta = { venue: null, date: null, day: null, raceNo: null, grade: null, kind: null, title: null };
  // 例: 青森競輪 出走表詳細（1R 2026年11月3日 初日）
  let m = entry.match(/(\S+?)競輪\s*出走表詳細[(（]\s*(\d{1,2})R\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\S+?)[)）]/);
  if (m) {
    meta.venue = m[1]; meta.raceNo = +m[2];
    meta.date = `${m[3]}-${String(m[4]).padStart(2, "0")}-${String(m[5]).padStart(2, "0")}`; meta.day = m[6];
  }
  // 例: 青森 2026年11月3日 初日 予　選 F1 スポニチ杯　ウィンチケット杯 1R
  m = odds.match(/\n(\S+)\s+(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\S+)\s+(.+?)\s+(GP|GI{1,3}|G[1-3]|F1|F2|FI{1,2})\s+(.*?)\s*(\d{1,2})R\s*\n/);
  if (m) {
    meta.venue = meta.venue || m[1];
    meta.kind = m[6].replace(/[\s　]/g, "");
    meta.grade = { G1: "GI", G2: "GII", G3: "GIII", F1: "FI", F2: "FII", FI: "FI", FII: "FII" }[m[7]] || m[7];
    meta.title = m[8].replace(/　/g, " ").trim();
  }
  const g = entry.match(/\s(GP|G[1-3]|F[12])\s/); if (!meta.grade && g) meta.grade = { G1: "GI", G2: "GII", G3: "GIII", F1: "FI", F2: "FII" }[g[1]] || g[1];
  const mm = odds.match(/発売票数[:：]\s*([\d,]+)票/); meta.votes = mm ? num(mm[1]) : null;
  return meta;
}

const VENUE_ALIAS = { "平": "いわき平", "いわき": "いわき平", "伊東温泉": "伊東", "大宮": "大宮" };
const venueName = v => VENUE_ALIAS[v] || v;

/* ---------- 近況の成績文字列（例: 予5般2特7 / 予落 / 予2準1決1） ---------- */
function parseRecent(s) {
  const out = [];
  if (!s) return out;
  const re = /([予準決般特抜選初優一順特秀ガ選]?)([1-9]|落|失|欠|棄|故)/g; let m;
  while ((m = re.exec(s))) out.push({ type: m[1] || null, res: /[1-9]/.test(m[2]) ? +m[2] : m[2] });
  return out;
}

/* ---------- 出走表 ---------- */
const MARKS = ["◎", "○", "▲", "△", "×", "注", "☆", "★", "穴"];
function parseEntry(entry) {
  const lines = entry.split("\n");
  const riders = [];
  let lineup = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split("\t").map(c => c.trim());
    // 選手の行：選手名の後ろに 年齢・府県・期別・級班・脚質・ギア・得点 が並ぶ
    const ni = cols.findIndex((c, k) => k > 0 && /[぀-ヿ一-鿿]/.test(c) && /^\d{2}$/.test(cols[k + 1] || "") && /^\d{2,3}$/.test(cols[k + 3] || "") && /^(S[12]|A[1-3]|L1|SS)$/.test(cols[k + 4] || ""));
    if (ni > 0) {
      const head = cols.slice(0, ni).filter(Boolean);
      const mark = MARKS.includes(head[0]) ? head.shift() : null;
      const nums = head.filter(x => /^\d$/.test(x)).map(Number);
      const no = nums[nums.length - 1];               // 車番（枠番が空欄のことがある）
      const frame = nums.length >= 2 ? nums[0] : null;
      const c = cols.slice(ni);
      const r = {
        no, frame, mark,
        name: c[0].replace(/[\s　]+/g, ""), age: num(c[1]), pref: c[2], ki: num(c[3]), cls: c[4], style: c[5],
        gear: num(c[6]), score: num(c[7]),
        n1: num(c[8]), n2: num(c[9]), n3: num(c[10]), nOut: num(c[11]),
        win: num(c[12]), ren2: num(c[13]), ren3: num(c[14]),
        nige: num(c[15]), makuri: num(c[16]), sashi: num(c[17]), mark2: num(c[18]),
        s: num(c[19]), b: num(c[20]),
        meets: [], recent: [], comment: null
      };
      // 今回開催・前回開催：同じ行の残り（場, 日付, 成績, 場, 日付, …）
      const rest = c.slice(21);
      const meets = [];
      for (let k = 0; k + 1 < rest.length; k++) {
        if (/^\d{1,2}\/\d{1,2}$/.test(rest[k + 1]) && rest[k]) { meets.push({ venue: venueName(rest[k].replace(/[\s　]/g, "")), date: rest[k + 1], res: rest[k + 2] && !/^\d{1,2}\/\d{1,2}$/.test(rest[k + 3] || "") ? rest[k + 2] : "" }); k++; }
      }
      // 続く行：前回の成績 → 前々回の場と日付 → 前々回の成績 → コメント
      let j = i + 1; const extra = [];
      while (j < lines.length && extra.length < 4) {
        const L = lines[j].trim();
        if (!L) { j++; continue; }
        const nc = lines[j].split("\t").map(x => x.trim());
        if (nc.findIndex((x, k) => k > 0 && /^(S[12]|A[1-3]|L1|SS)$/.test(nc[k] || "")) > 0 || /^周回予想/.test(L)) break;
        extra.push(lines[j]); j++;
      }
      let ex = 0;
      if (meets.length && !meets[meets.length - 1].res && extra[ex] && !/\t/.test(extra[ex]) && parseRecent(extra[ex]).length) meets[meets.length - 1].res = extra[ex++].trim();
      if (extra[ex] && /\t\d{1,2}\/\d{1,2}/.test(extra[ex])) { const p = extra[ex++].split("\t").map(x => x.trim()); meets.push({ venue: venueName(p[0].replace(/[\s　]/g, "")), date: p[1], res: "" }); }
      if (extra[ex] && parseRecent(extra[ex]).length && !/[。、]/.test(extra[ex])) meets[meets.length - 1].res = extra[ex++].trim();
      if (extra[ex]) r.comment = extra[ex++].trim();
      r.meets = meets;
      r.recent = meets.flatMap(mt => parseRecent(mt.res).map(x => ({ ...x, venue: mt.venue, date: mt.date })));
      r.style = { "逃": "逃", "両": "両", "追": "追", "自": "両" }[r.style] || r.style;
      if (r.frame == null) r.frame = r.no;           // 7車立ては枠番と車番が同じ（コピーでは空欄になる）
      riders.push(r);
      i = j - 1;
      continue;
    }
    // 周回予想（並び）：空欄でラインを区切る。例 1 5 _ 7 2 4 _ 6 3
    if (/^周回予想/.test(lines[i].trim())) {
      const row = (lines[i + 1] || "").split("\t");
      let cur = [];
      for (const cell of row) {
        const v = cell.trim();
        if (isInt1to9(v)) cur.push(+v);
        else { if (cur.length) lineup.push(cur); cur = []; }
      }
      if (cur.length) lineup.push(cur);
    }
  }
  riders.sort((a, b) => a.no - b.no);
  return { riders, lineup };
}

/* ---------- 3連単オッズ ---------- */
// 1着ごとのブロック：「1 選手名 （府県 期）」→ 1着の車番 → 2着の車番 → (3着の車番, オッズ) が続く。
// 2着が変わるときは「車番」の行が2つ続く。
function parseOdds(odds) {
  const out = {};
  const lines = odds.split("\n").map(x => x.trim());
  let first = null, second = null, third = null, prevInt = null, seenFirst = false;
  for (const raw of lines) {
    const L = raw.replace(/\t+$/, "");
    const h = L.match(/^([1-9])\s+\S.*[(（].*期[)）]$/);
    if (h) { first = +h[1]; second = third = prevInt = null; seenFirst = false; continue; }
    if (first == null) continue;
    if (isInt1to9(L)) {
      const v = +L;
      if (!seenFirst && v === first) { seenFirst = true; continue; }
      if (prevInt != null) second = prevInt;   // 車番が2つ続いた → 前の車番は2着
      prevInt = v; third = v;
      continue;
    }
    if (/^[\d,]+\.\d$/.test(L) || /^(欠|-|取消|---)$/.test(L)) {
      if (second != null && third != null) {
        const o = num(L);
        if (o) out[`${first}-${second}-${third}`] = o;
      }
      prevInt = null;
      continue;
    }
    if (/^競輪場一覧/.test(L)) break;
  }
  return out;
}

/* ---------- KEIRIN.JPの結果 ---------- */
// 照合と学習にだけ使う。予想には絶対に使わない。
function parseResult(text) {
  const t = norm(text);
  const out = { venue: null, raceNo: null, raceName: null, distance: null, laps: null, weather: null, wind: null,
                order: [], finishers: [], trifecta: [], trifectaPopular: null, refund: false, warnings: [] };
  // レース名：例「1R Ａ級予選　1625m（4周）先固」
  let m = t.match(/(?:^|\n)\s*(\d{1,2})R\s+(\S+?)[\s　]+(\d{3,4})m[(（](\d)周[)）]/);
  if (m) { out.raceNo = +m[1]; out.raceName = m[2]; out.distance = +m[3]; out.laps = +m[4]; }
  m = t.match(/\n\s*(\S+?)競輪場\s/); if (m) out.venue = m[1];
  // 天候：例「晴：風速 1.0ｍ」
  m = t.match(/■\s*天候\s*\n\s*(\S+?)[:：]\s*風速\s*([\d.]+)/); if (m) { out.weather = m[1]; out.wind = +m[2]; }
  // 3連単の払戻：「3連単」の次の行から、組番 金額 (人気) が続く間（同着なら複数）
  const raw = t.split("\n");
  const lines = raw.map(x => x.trim());
  const i3 = lines.findIndex(x => /^3連単$/.test(x.replace(/\s+/g, "")));
  if (i3 >= 0) {
    for (let k = i3 + 1; k < lines.length; k++) {
      const p = lines[k].match(/^([1-9])\s*-\s*([1-9])\s*-\s*([1-9])\s+([\d,]+)円\s*[(（](\d+)[)）]?/);
      if (p) { out.trifecta.push({ combo: [+p[1], +p[2], +p[3]], pay: num(p[4]), popular: +p[5] }); continue; }
      if (/返還|特払/.test(lines[k])) { out.refund = true; continue; }
      break;
    }
  }
  if (out.trifecta.length) out.trifectaPopular = out.trifecta[0].popular;
  // 着順表：「着」の行のあとに「車番 選手名 年齢 府県 期別 級班 着差 上り 決まり手 H/B 個人状況」
  const io = lines.findIndex(x => /^■\s*着順/.test(x));
  if (io >= 0) {
    let rank = null;
    for (let k = io + 1; k < lines.length; k++) {
      const L = lines[k];
      if (!L || /^着\s+車番/.test(L)) continue;
      if (/^(操作ガイド|■)/.test(L)) break;
      if (/^([1-9]|失|落|欠|棄|故)$/.test(L)) { rank = /^[1-9]$/.test(L) ? +L : L; continue; }
      const cols = raw[k].replace(/^\s+/, "").split(/\t/).map(x => x.trim());
      const c = cols.length >= 6 ? cols : L.split(/\s+/);
      const no = num(c[0]);
      if (no && no >= 1 && no <= 9) {
        const f = { rank, no, name: (c[1] || "").replace(/[\s　]+/g, "") };
        if (cols.length >= 9) {          // タブ区切りのまま貼られた場合は列で読む
          // 列：車番 選手名 年齢 府県 期別 級班 着差 上り 決まり手 H/B 個人状況
          f.margin = cols[6] || null; f.last = num(cols[7]); f.kimarite = cols[8] || null; f.hb = cols[9] || null; f.status = cols[10] || null;
        } else {                          // タブが消えた場合は形で拾う
          const km = L.match(/(逃げ|捲り|差し|マーク)/); f.kimarite = km ? km[1] : null;
          const lt = L.match(/\s(\d{2}\.\d)\s/); f.last = lt ? +lt[1] : null;
        }
        out.finishers.push(f); rank = null;
      }
    }
  }
  const top3 = [1, 2, 3].map(r => (out.finishers.find(f => f.rank === r) || {}).no);
  if (top3.every(Boolean)) out.order = top3;
  else if (out.trifecta.length) out.order = out.trifecta[0].combo;
  if (out.trifecta.length && out.order.length && out.trifecta[0].combo.join() !== out.order.join()) out.warnings.push("着順表と3連単の組番が一致しません（同着の可能性）");
  if (out.trifecta.length > 1) out.warnings.push("3連単の払戻が複数あります（同着）");
  if (!out.order.length) out.warnings.push("着順を読み取れませんでした");
  if (!out.trifecta.length && !out.refund) out.warnings.push("3連単の払戻金を読み取れませんでした");
  return out;
}

/* ---------- まとめ ---------- */
function parsePaste(text) {
  const leak = resultLeak(text);
  if (leak.length) return { ok: false, leak };
  const { entry, odds } = split(text);
  const meta = parseMeta(entry, odds);
  const { riders, lineup } = parseEntry(entry);
  const oddsMap = parseOdds(odds);
  meta.cars = riders.length;
  const n = riders.length, need = n * (n - 1) * (n - 2);
  const warnings = [];
  if (n < 5 || n > 9) warnings.push(`選手を${n}名しか読み取れませんでした`);
  if (odds && Object.keys(oddsMap).length !== need) warnings.push(`3連単オッズは${need}通り中${Object.keys(oddsMap).length}通りを読み取りました`);
  const inLine = new Set(lineup.flat());
  riders.forEach(r => { if (!inLine.has(r.no)) warnings.push(`${r.no}番は周回予想に見つかりません（単騎扱い）`); });
  return { ok: true, meta, riders, lineup, odds: oddsMap, warnings };
}

if (typeof module !== "undefined") module.exports = { parsePaste, parseResult, resultLeak, parseRecent, norm };
