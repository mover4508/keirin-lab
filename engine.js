// 競輪3連単ラボ 予想エンジン（36エンジン・区分・買い目・照合・学習・メタループ）
// 使うのは、貼られた出走表・オッズ、自前の蓄積データ、参照データ（refdata.js）だけ。
"use strict";
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
function freshModel() {
  const w = Object.fromEntries(PER.map(e => [e, 1]));
  return {
    ver: 1, beta: 1.2, alpha: 0.5, syn: 0.15, lr: 0.05,
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
function shares(r) {
  const t = (r.nige || 0) + (r.makuri || 0) + (r.sashi || 0) + (r.mark2 || 0);
  if (t > 0) return { nige: (r.nige || 0) / t, makuri: (r.makuri || 0) / t, sashi: (r.sashi || 0) / t, mark: (r.mark2 || 0) / t };
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
  const sh = R.map(shares);
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
      const pairBonus = mates.reduce((t, m) => { const p = A.pairs[[id, riderId(m)].sort().join(">")]; return t + (p ? Math.min(1, p.n / 5) * 0.3 : 0); }, 0);
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
function cellKey(race) { return `${race.meta.grade || "?"}|${race.riders.length}|${race.cls || "std"}`; }
function effWeights(key, model) {
  const k3 = key.split("|")[2], glob = model.cells["*|*|*"];
  const out = {};
  PER.forEach(e => {
    let w = glob.w[e] ?? 1;
    for (const lv of [`*|*|${k3}`, key]) {
      const c = model.cells[lv];
      if (c && c.w[e] != null) { const a = c.n / (c.n + 30); w = a * c.w[e] + (1 - a) * w; }
    }
    out[e] = w;
  });
  return out;
}
function combine(Z, w, n) {
  const tot = PER.reduce((a, e) => a + w[e], 0) || 1;
  return zscore(Array.from({ length: n }, (_, i) => PER.reduce((a, e) => a + w[e] * (Z[e][i] || 0), 0) / tot));
}

/* ========== E28 勝ち上がり条件・E29 開催種別：集中度への効き ========== */
function kindFactor(race) {
  const k = race.meta.kind || "";
  let f = 1;
  if (/準決|決勝/.test(k)) f *= 1.1;            // 着順条件が厳しい：実力どおりになりやすい
  if (/初日特選|初特選|特選/.test(k)) f *= 0.9; // 無事故完走で上がれる：無理をしないので荒れやすい
  if (/一般|選抜/.test(k)) f *= 0.95;
  if (race.riders.length <= 7) f *= 1.05;       // 7車立ては堅め（競輪ブラザー）
  const c = race.cond || {};
  if (c.weather === "雨") f *= 1.05;            // 雨は堅め
  if (c.windStr === "強") f *= 1.05;            // 強風は堅め
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
function perms(race, comb, model, LI) {
  const R = race.riders, beta = model.beta * kindFactor(race);
  const s = comb.map(z => Math.exp(beta * z)), S0 = s.reduce((a, b) => a + b, 0);
  const out = [];
  for (let a = 0; a < R.length; a++) for (let b = 0; b < R.length; b++) {
    if (b === a) continue;
    for (let c = 0; c < R.length; c++) {
      if (c === a || c === b) continue;
      let p = s[a] / S0 * s[b] / (S0 - s[a]) * s[c] / (S0 - s[a] - s[b]);
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
  const kf = kindFactor(race);
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
    if (has) picks.sort((a, b) => b.ev - a.ev);
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
  race.cls = "std";
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
  race.modelVer = model.ver; race.kindFactor = kindFactor(race);
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
function learn(race, result, model, acc, stats) {
  const order = result.order, n = race.riders.length;
  const t = race.riders.map(r => r.no === order[0] ? 1 : r.no === order[1] ? 0.7 : r.no === order[2] ? 0.5 : 0);
  const lr = model.lr / (1 + 0.2 * (stats.lossStreak || 0));   // 連敗中は学習率を下げる
  const levels = [race.key, `*|*|${race.cls}`, "*|*|*"], moved = [];
  for (const lv of levels) {
    if (!model.cells[lv]) model.cells[lv] = { w: { ...effWeights(lv === "*|*|*" ? "*|*|*" : race.key, model) }, n: 0 };
    const c = model.cells[lv];
    PER.forEach(e => {
      const sig = corr(race.Z[e], t), f = clamp(lr * sig * 2, -0.1, 0.1), old = c.w[e];   // 1回の変化は±10%まで
      c.w[e] = clamp(old * (1 + f), 0.05, 3);
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
    a.n++; a.t3 += top3; a.lastScore = r.score; a.lastGear = r.gear; a.lastDate = race.meta.date;
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
  // 再実装：悪化していたら最良版へ戻す
  if (model.best && cur < model.best.ll - 0.05) {
    model.cells = JSON.parse(JSON.stringify(model.best.cells));
    ["beta", "alpha", "syn"].forEach(k => model[k] = model.best[k]);
    lines.push(`直すべきもの：予測力が下がった（${cur.toFixed(3)} < ${model.best.ll.toFixed(3)}）ため最良版 v${model.best.ver} に戻した`);
    cur = avg(model);
  }
  // 調整：集中度β・市場の比重α・スジ補正を少しずつ探る
  const tune = (k, steps, lo, hi, label) => {
    let bestV = model[k], bestL = cur;
    for (const d of steps) { const val = clamp(model[k] + d, lo, hi); const L = avg({ ...model, [k]: val }); if (L > bestL + 0.002) { bestL = L; bestV = val; } }
    if (bestV !== model[k]) { lines.push(`調整すべきもの：${label} ${model[k].toFixed(2)} → ${bestV.toFixed(2)}`); model[k] = bestV; cur = bestL; }
  };
  tune("beta", [-0.15, 0.15], 0.5, 2.5, "集中度β");
  if (done.some(r => r.hasOdds)) tune("alpha", [-0.1, 0.1], 0.1, 0.9, "市場の比重α");
  tune("syn", [-0.05, 0.05], 0, 0.5, "スジ決着の補正");
  if (!model.best || cur >= model.best.ll) model.best = { ver: model.ver, ll: cur, beta: model.beta, alpha: model.alpha, syn: model.syn, cells: JSON.parse(JSON.stringify(model.cells)) };
  // 区分しきい値
  const by = {}; done.forEach(r => { const o = by[r.cls] || (by[r.cls] = { n: 0, h: 0, inv: 0, ret: 0 }); o.n++; o.h += r.result.hit ? 1 : 0; o.inv += r.result.inv; o.ret += r.result.ret; });
  const hr = k => by[k] && by[k].n ? by[k].h / by[k].n : null;
  if (by.kata && by.kata.n >= 10 && by.std && hr("kata") < hr("std")) { model.th.kataRatio = Math.max(0.3, model.th.kataRatio - 0.05); lines.push(`調整すべきもの：堅めの判定を厳しく（基準比 ${model.th.kataRatio.toFixed(2)} 以下）`); }
  if (by.are && by.are.n >= 15 && hr("are") < 0.03) { model.th.areRatio = Math.min(3, model.th.areRatio + 0.1); lines.push(`調整すべきもの：荒れの判定を厳しく（基準比 ${model.th.areRatio.toFixed(2)} 以上）`); }
  const g = model.cells["*|*|*"].w, sorted = [...PER].sort((a, b) => g[b] - g[a]);
  lines.push(`増やすべきもの：${sorted.slice(0, 3).map(e => NAME[e]).join("・")}（重み上位）`);
  const floor = PER.filter(e => g[e] <= 0.15);
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

const API = { ENGINES, PER, NAME, CLS_LABEL, catName, freshModel, freshAcc, category, lineInfo, posLabel, riderId,
  computeEngines, effWeights, combine, perms, classify, chooseBets, predict, judge, learn, metaLoop, kindFactor };
if (typeof module !== "undefined") module.exports = API; else root.KEngine = API;
})(typeof window !== "undefined" ? window : globalThis);
