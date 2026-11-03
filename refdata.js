// 競輪3連単ラボ 参照データ（開発時に調べて固定した値）
// 運用中はこの値だけを使い、Webは見ない。値を見直すときは開発作業として行い、出典と日付を更新する。
"use strict";

const REF = {
  checkedAt: "2026-11-03",
  sources: {
    bank: "競輪予想サイト解体新書「全国のバンクデータ一覧」https://www.centresource.com/column/keirinjo-bank-ichiran/",
    nigeRate: "kouei-lab「競輪全41場 バンク別データ一覧」（KEIRIN.JP公表データをもとに集計、原則直近3年）https://kouei-lab.com/keirin-venues.html",
    kimarite: "競輪予想サイト解体新書「競輪の決まり手」https://www.centresource.com/column/keirin-kimarite/",
    position: "ケイリンログ「ライン番手理論は本当か」https://note.com/keirinlogs/n/n206dfe0dcd31",
    popular: "競輪データ解析「1番人気を買い続けた場合の回収率と的中率（3連単）」2012年〜2023年12月 https://ai-keirin.hatenablog.com/entry/2019/05/18/112019",
    area: "ニコニコ大百科「競輪」（新潟・長野・山梨は関東、南関東は千葉・神奈川・静岡、福井は近畿）",
    wind: "競輪ブラザー「競輪の天気の影響」https://keirin-brother.com/method/weather/"
  },

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
