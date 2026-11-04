// 競輪3連単ラボ 自己点検（更新のたびに実行する）：node tests/run.js
// 読み取り・予想・学習・見直しの計算が、決まりどおりに動くかを確かめる
const fs = require("fs"), path = require("path");
global.REF = require("../refdata.js").REF;
const P = require("../parser.js"), K = require("../engine.js");
const S = f => fs.readFileSync(path.join(__dirname, "samples", f), "utf8");
let ok = 0, ng = 0;
const check = (name, cond) => { if (cond) { ok++; console.log("合格  " + name); } else { ng++; console.log("不合格 " + name); } };

const txt = S("chariloto_aomori_20261103_1R.txt"), resTxt = S("keirinjp_result_aomori_20261103_1R.txt");
// 読み取り
const r = P.parsePaste(txt);
check("出走表とオッズを読める（7人・210通り）", r.ok && r.riders.length === 7 && Object.keys(r.odds).length === 210);
check("1日目のコメントを正しく読む", r.riders[0].comment === "自力。");
check("結果が混ざった貼り付けは止める", !P.parsePaste(txt + "\n" + resTxt).ok);
const res = P.parseResult(resTxt);
check("結果を読める（着順・3連単の払戻）", res.order.length >= 3 && res.trifecta.length >= 1);
// 2日目以降の形（今回開催の成績が別の行・前々回がもう1つ）
const L = txt.split("\n"), i = L.findIndex(l => l.includes("龍野琳太郎"));
const v = [L[i].replace("青森\t11/03\t\t", "青森\t11/01\t\t"), "初7準5", L[i + 1], L[i + 2], L[i + 3], "川　崎\t10/01\t", "予3特1", L[i + 4]].join("\n");
const r2 = P.parsePaste(L.slice(0, i).join("\n") + "\n" + v + "\n" + L.slice(i + 5).join("\n")).riders[0];
check("2日目以降：コメントを取り違えない", r2.comment === "自力。");
check("2日目以降：開催の成績を順に入れる", r2.meets.length === 4 && r2.meets[0].res === "初7準5" && r2.meets[3].res === "予3特1");
// 予想
const race = { meta: r.meta, riders: r.riders, lineup: r.lineup, odds: r.odds, cond: {} };
K.predict(race, K.freshModel(), K.freshAcc(), { mode: "past" });
check("買い目は1〜3点", race.bets.length >= 1 && race.bets.length <= 3);
const Pall = K.perms(race, race.comb, K.freshModel(), K.lineInfo(race));
check("3連単の確率の合計が1", Math.abs(Pall.reduce((a, x) => a + x.p, 0) - 1) < 1e-9);
// 学習：続きから計算しても、最初からと同じ
const items = [];
for (let k = 0; k < 40; k++) {
  const ord = [[1, 5, 7], [2, 1, 4], [7, 6, 2], [3, 5, 4]][k % 4];
  items.push({ raceKey: "t" + k, meta: { ...r.meta, date: `2026-01-${String(1 + Math.floor(k / 2)).padStart(2, "0")}`, raceNo: 1 + k % 2 }, riders: r.riders, lineup: r.lineup, odds: r.odds, cond: {}, oddsType: "確定",
    result: { order: ord, pays: [{ combo: ord, pay: Math.round((r.odds[ord.join("-")] || 100) * 100), popular: 1 }], finishers: ord.map((no, j) => ({ no, rank: j + 1 })) } });
}
const full = K.replay(JSON.parse(JSON.stringify(items)));
const half = K.replay(JSON.parse(JSON.stringify(items.slice(0, 23))));
const cont = K.replay(JSON.parse(JSON.stringify(items.slice(23))), JSON.parse(JSON.stringify(half)));
check("続きから学習しても、最初からと完全に同じ", JSON.stringify(full.model) === JSON.stringify(cont.model) && JSON.stringify(full.acc) === JSON.stringify(cont.acc));
check("10Rごとの見直しが動く", full.metaLog.length === 4);
check("重みは決まった範囲（−0.5〜1.5）に収まる", K.PER.every(e => { const w = full.model.cells["*|*|*"].w[e]; return w >= -0.5 && w <= 1.5; }));
// 見直しの高速計算が、通常の計算と同じ値を出す
const d0 = full.done[0], P0 = K.perms(d0, K.combine(d0.Z, K.effWeights(d0.key, full.model), d0.riders.length), full.model, K.lineInfo(d0));
const f0 = P0.find(x => x.c.join("-") === d0.result.order.join("-"));
check("見直しの高速計算が通常の計算と一致", Math.abs(Math.exp(K.logLik(d0, full.model)) - f0.p) < 1e-12);
// 先読み防止：過去レース検証は、そのレースより前のデータだけ
check("古いエンジンの形の共有モデルでも予想できる", (() => { const m = K.freshModel(); delete m.lam2; delete m.lam3; delete m.kf; const x = { meta: r.meta, riders: r.riders, lineup: r.lineup, odds: r.odds, cond: {} }; K.predict(x, m, K.freshAcc(), {}); return x.bets.length > 0; })());
// 保存を軽くしても、予想は同じ（近況の一覧は開催の成績から作り直す）
const slim = { meta: r.meta, riders: r.riders.map(({ recent, ...x }) => x), lineup: r.lineup, odds: r.odds, cond: {} };
K.predict(slim, K.freshModel(), K.freshAcc(), { mode: "past" });
check("近況の一覧を保存しなくても、予想は同じ", JSON.stringify(slim.bets.map(b => b.c)) === JSON.stringify(race.bets.map(b => b.c)) && JSON.stringify(slim.Z) === JSON.stringify(race.Z));
// 級の種類ごとの市場の比重が使われる
const mA = K.freshModel(); mA.alphaCat = { [race.cat]: 0.1 };
const xA = { meta: r.meta, riders: r.riders, lineup: r.lineup, odds: r.odds, cond: {} }; K.predict(xA, mA, K.freshAcc(), {});
check("級の種類ごとの市場の比重が使われる", Math.abs(xA.bets[0].p - race.bets[0].p) > 1e-6);
console.log(`\n${ok}件合格・${ng}件不合格`);
process.exit(ng ? 1 : 0);
