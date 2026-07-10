/*
 * 酒クエストの自動テスト
 *   node tests/app.test.js で実行(依存なし・Node標準のみ)
 *   - データ検査: 問題形式・重複・カテゴリ/難易度の妥当性
 *   - ロジック検査: デイリー・ストリーク・認定試験・スピードボーナス・画面描画
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
let script = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* 起動処理の直前にテスト用フックを注入 */
const anchor = "renderHome();\n\n/* Service Worker";
if (!script.includes(anchor)) throw new Error("注入位置(起動処理)が見つかりません");
script = script.replace(anchor, `
globalThis.__T = {
  QUESTIONS, CATS, DIFFS, GLOSSARY, BADGES,
  examQuestions, dailyQuestions, examRank, sessionReviewHTML,
  renderHome, renderStats, renderSettings, renderBadges, renderZukan, renderResult,
  startExam, startSession, answer, qById, questionsOf,
  completeDaily, currentStreak, playSound, haptic,
  getState: () => state, getSession: () => session,
  setSession: s => { session = s; },
  setDateFns: (t, y) => { todayStr = () => t; yesterdayStr = () => y; },
  EXAM_SIZE, EXAM_PASS, DAILY_SIZE, SPEED_THRESHOLD,
};
` + anchor);

/* 最小 DOM/Audio スタブ */
const elStub = () => ({
  innerHTML: "", textContent: "", value: "", style: {}, dataset: {},
  addEventListener() {}, removeEventListener() {},
  querySelectorAll() { return []; }, querySelector() { return null; },
  appendChild() {}, remove() {}, focus() {},
  classList: { add() {}, remove() {}, contains() { return false; } },
});
const store = {};
const oscStub = () => ({ type: "sine", frequency: { value: 0 }, connect() {}, start() {}, stop() {} });
const gainStub = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} });
const ctx = {
  document: {
    getElementById: () => elStub(), createElement: () => elStub(),
    addEventListener() {}, body: elStub(), querySelectorAll() { return []; },
  },
  window: {
    addEventListener() {},
    AudioContext: function () { return { state: "running", currentTime: 0, destination: {}, resume() {}, createOscillator: oscStub, createGain: gainStub }; },
  },
  navigator: { vibrate() { return true; }, clipboard: { writeText: async () => {} } },
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  Math, JSON, Date, console, RegExp, Object, Array, String, Number, Set, Map,
};
ctx.window.webkitAudioContext = ctx.window.AudioContext;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(script, ctx);
const T = ctx.__T;

let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n + (e ? " → " + e : "")); } };
const noThrow = (n, fn) => { try { fn(); pass++; console.log("  ✅ " + n); } catch (e) { fail++; console.log("  ❌ " + n + " → " + e.message); } };

/* ============ データ検査 ============ */
console.log("— データ検査 —");
const cats = Object.keys(T.CATS);
const seenQ = new Set(); let dupQ = 0, badChoice = 0, badMeta = 0;
T.QUESTIONS.forEach(q => {
  if (seenQ.has(q.q)) { dupQ++; console.log("     重複問題:", q.q); }
  seenQ.add(q.q);
  if (!Array.isArray(q.c) || q.c.length !== 4 || new Set(q.c).size !== 4) { badChoice++; console.log("     選択肢不正:", q.q); }
  if (!cats.includes(q.cat) || ![1, 2, 3, 4].includes(q.d) || !q.exp) { badMeta++; console.log("     属性不正:", q.q); }
});
check("問題文の重複なし", dupQ === 0, dupQ + "件");
check("全問4択・選択肢の重複なし", badChoice === 0, badChoice + "件");
check("カテゴリ/難易度/解説が妥当", badMeta === 0, badMeta + "件");
check("IDがユニーク", new Set(T.QUESTIONS.map(q => q.id)).size === T.QUESTIONS.length);
let poolOk = true;
cats.forEach(c => [1, 2, 3, 4].forEach(d => {
  const n = T.questionsOf(c, d).length;
  if (n < 5) { poolOk = false; console.log(`     プール不足: ${c} d${d} = ${n}問`); }
}));
check("全カテゴリ×難易度で5問以上(難易度ボタンが有効)", poolOk);
check("初級プールは8問以上(繰り返しプレイ対策)", cats.every(c => T.questionsOf(c, 1).length >= 8),
  cats.map(c => c + ":" + T.questionsOf(c, 1).length).join(" "));
check("バッジIDがユニーク", new Set(T.BADGES.map(b => b.id)).size === T.BADGES.length);

/* ============ ロジック検査 ============ */
console.log("— 認定試験 —");
const ex = T.examQuestions();
check("20問ちょうど・重複なし", ex.length === T.EXAM_SIZE && new Set(ex.map(q => q.id)).size === T.EXAM_SIZE);
check("上級・達人を含む", ex.some(q => q.d === 3) && ex.some(q => q.d === 4));
check("合否判定(16=合格/15=不合格/20=最上位)",
  T.examRank(16).pass && !T.examRank(15).pass && T.examRank(20).grade === "S");

console.log("— デイリー/ストリーク —");
T.setDateFns("2026-07-09", "2026-07-08");
check("同日は同じ問題(決定的)", JSON.stringify(T.dailyQuestions().map(q => q.id)) === JSON.stringify(T.dailyQuestions().map(q => q.id)));
const st = T.getState();
st.streak = 0; st.bestStreak = 0; st.lastDailyDate = null; st.dailyDoneDate = null;
T.completeDaily(); T.completeDaily();
check("初達成でstreak=1、同日2回目は加算なし", st.streak === 1);
T.setDateFns("2026-07-10", "2026-07-09"); T.completeDaily();
check("翌日達成でstreak=2", st.streak === 2);
T.setDateFns("2026-07-12", "2026-07-11"); T.completeDaily();
check("1日空くとリセット、bestStreakは維持", st.streak === 1 && st.bestStreak === 2);

console.log("— スピードボーナス(用語ポップアップで無効化) —");
st.speedBonusCount = 0;
T.startExam();
let sess = T.getSession();
let q = T.qById(sess.qIds[sess.cur]);
sess.remain = T.SPEED_THRESHOLD + 5;
sess.glossaryUsed = true; // 出題中に用語解説を開いた
const fakeBtn = () => ({ dataset: { correct: "1" }, classList: { add() {} }, disabled: false });
let b = fakeBtn();
T.answer(b, [b], q);
check("用語を開いた問題はスピードボーナスなし", st.speedBonusCount === 0, "count=" + st.speedBonusCount);
sess = T.getSession(); sess.cur++;
q = T.qById(sess.qIds[sess.cur]);
sess.remain = T.SPEED_THRESHOLD + 5;
sess.glossaryUsed = false;
b = fakeBtn();
T.answer(b, [b], q);
check("開いていなければスピードボーナスあり", st.speedBonusCount === 1, "count=" + st.speedBonusCount);

console.log("— 振り返り(結果画面) —");
sess = T.getSession();
check("回答結果が記録される", sess.results.length === 2 && sess.results[0].correct === true);
const reviewHtml = T.sessionReviewHTML();
check("振り返りHTMLに問題と解説を含む", reviewHtml.includes("今回の振り返り") && reviewHtml.includes("rv-exp"));

console.log("— じっくりモード(タイマーなし) —");
st.noTimer = true;
st.speedBonusCount = 0;
T.startSession("basic", 1);
sess = T.getSession();
check("セッションにnoTimerが伝わる", sess.noTimer === true);
check("remainが0(スピードボーナス対象外)", sess.remain === 0);
q = T.qById(sess.qIds[sess.cur]);
b = fakeBtn();
T.answer(b, [b], q);
check("じっくりモードではスピードボーナスなし", st.speedBonusCount === 0);
st.noTimer = false;

console.log("— 画面描画(例外なし) —");
noThrow("renderResult(振り返り含む)", () => { T.getSession().cur = 999; T.renderResult(); });
noThrow("renderHome", () => T.renderHome());
noThrow("renderStats", () => T.renderStats());
noThrow("renderSettings", () => T.renderSettings());
noThrow("renderBadges", () => T.renderBadges());
noThrow("renderZukan", () => T.renderZukan());

console.log("\n結果: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
