// node tests/engine_run.js site/ → 엔진 결과를 JSON 으로 출력 (Python 기준값과 비교용)
const fs = require("fs"), path = require("path");
const E = require("../app/engine.js");
const dir = process.argv[2] || "site";
const market = JSON.parse(fs.readFileSync(path.join(dir, "market.json")));
const returns = JSON.parse(fs.readFileSync(path.join(dir, "returns.json")));
const t0 = Date.now();
const ctx = E.load(market, returns);
const w = { SPMO: 0.4, GLD: 0.3, SOXX: 0.2, "BRK-B": 0.1 };
const V = E.var(ctx, w, 1e8, {});
const C = E.contrib(ctx, w, 0.94);
const S = E.stress(ctx, w);
const tk = ["SPMO", "GLD", "SOXX", "BRK-B", "SGOV", "XLE"];
const M = E.monthly(ctx, tk, 5, "USD"); // 파이썬 기준 구현과 비교하는 달러 경로
const ex = E.expected(M, "hist", 0.045);
const fr = E.frontier(ex.mu, ex.S, { maxW: 1, rf: ex.rf });
const exs = E.expected(M, "shrink", 0.045), exc = E.expected(M, "capm", 0.045);
const t1 = Date.now();
const D = E.diagnose(ctx, w, 1e8, {});
const t2 = Date.now();
const Rc = E.recommend(ctx, w, 1e8, D, {});
const t3 = Date.now();
const out = {
  timing: { core: t1 - t0, diag: t2 - t1, rec: t3 - t2 },
  sigma_ann: V.sigma_ann, boot: V.boot, ewma: V.ewma, hs250: V.hs250, years: V.years,
  contrib: C, stress: S.map(s => [s.name, s.krw, s.usd, s.spy]),
  monthly_n: M.rows.length, monthly_first: M.labels[0], monthly_last: M.labels[M.labels.length - 1],
  lw_shrink: ex.shrink, mu_hist: ex.mu, mu_shrink: exs.mu, phi: exs.phi, mu_capm: exc.mu, S: ex.S, rf: ex.rf,
  frontier: fr.pts.map(p => [p.vol, p.ret]), maxSharpe: fr.maxSharpe, minVar: fr.minVar,
  verdict: D.verdict, items: D.items.map(i => [i.label, i.level, i.text]), recent: D.recent,
  actions: Rc.actions.map(a => ({ title: a.title, why: a.why, dVolEwma: a.dVolEwma, dVol3y: a.dVol3y, var1y0: a.var1y0, var1y1: a.var1y1, dSharpe: a.dSharpe, robust: a.robust, worst0: a.worst0, worst1: a.worst1 })),
  pairs_top: Rc.pairs.slice(0, 8).map(p => [p.t, p.c63, p.c126, p.c252, p.dn252, p.dvol_ewma, p.dvol_y3, p.tags]),
  alerts: E.alerts(ctx, w, 1e8, D, {}).map(a => [a.level, a.label, a.text, a.dist]),
};
fs.writeFileSync(process.argv[3] || "/dev/stdout", JSON.stringify(out, null, 1));
