/* 무거운 계산(진단·추천·재편안·시뮬레이션)을 화면과 분리해 돌린다 — 계산 중에도 터치·입력이 바로 되도록 */
importScripts("engine.js");
const E = self.PRE;
let ctx = null;
self.onmessage = e => {
  const { id, kind, a } = e.data;
  try {
    let r;
    if (kind === "init") { ctx = E.load(a.market, a.returns); r = true; }
    else { if (!ctx) throw new Error("데이터가 아직 준비되지 않음"); r = E.runJob(ctx, kind, a); }
    self.postMessage({ id, ok: true, r });
  } catch (err) { self.postMessage({ id, ok: false, err: String((err && err.stack) || err) }); }
};
