/* Portfolio Risk Monitor — 계산 엔진 (브라우저 + Node 공용)
 *
 * 보유내역은 이 엔진에서만 쓰이며 서버로 보내지지 않습니다.
 * 입력: market.json(시장 신호) + returns.json(일간 수익률, 2006~)
 */
(function (root) {
  "use strict";
  const E = {};
  const CASH = "현금(원)";
  E.CASH = CASH;

  // ───────────────────────── 기본 수학 ─────────────────────────
  const Z = { 0.95: [1.6448536, 0.1031356], 0.975: [1.959964, 0.0584409], 0.99: [2.3263479, 0.0266521] };
  function quantile(sorted, q) {
    const n = sorted.length; if (!n) return NaN;
    const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function mean(a) { let s = 0; for (const x of a) s += x; return s / a.length; }
  function std(a) { const m = mean(a); let s = 0; for (const x of a) s += (x - m) ** 2; return Math.sqrt(s / (a.length - 1)); }
  function pearson(a, b) {
    const n = a.length; if (n < 3) return NaN;
    let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return sab / Math.sqrt(saa * sbb);
  }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function matVec(M, v) { const n = v.length, o = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += M[i][j] * v[j]; o[i] = s; } return o; }
  function quad(M, v) { const t = matVec(M, v); let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * t[i]; return s; }
  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function solve(A, b) { // 가우스 소거 (작은 행렬)
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c]; if (Math.abs(d) < 1e-14) return null;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / d; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  E.math = { quantile, mean, std, pearson, quad, solve };

  // ───────────────────────── 데이터 적재 ─────────────────────────
  E.load = function (market, returns) {
    const n = returns.dates.length, R = {}, u = returns.unit;
    for (const t of Object.keys(returns.r)) {
      const src = returns.r[t], a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = src[i] === null ? NaN : src[i] * u;
      R[t] = a;
    }
    const rf = new Float64Array(n), fx = new Float64Array(n), fxr = new Float64Array(n);
    let last = NaN;
    for (let i = 0; i < n; i++) {
      rf[i] = returns.rf[i] * returns.rf_unit;
      const v = returns.fx[i]; if (v !== null && v > 0) last = v; fx[i] = last;
    }
    for (let i = 1; i < n; i++) fxr[i] = (fx[i] > 0 && fx[i - 1] > 0) ? fx[i] / fx[i - 1] - 1 : 0;
    R[CASH] = new Float64Array(n); // 원화 현금: 원화 기준 수익 0
    return { market, dates: returns.dates, n, R, rf, fx, fxr, _krw: {} };
  };
  E.tickers = ctx => Object.keys(ctx.R).filter(t => t !== CASH);

  // 원화 기준 수익률
  E.krw = function (ctx, t) {
    if (t === CASH) return ctx.R[CASH];
    if (ctx._krw[t]) return ctx._krw[t];
    const r = ctx.R[t], o = new Float64Array(ctx.n);
    for (let i = 0; i < ctx.n; i++) o[i] = (1 + r[i]) * (1 + ctx.fxr[i]) - 1;
    return (ctx._krw[t] = o);
  };
  E.usd = function (ctx, t) { return t === CASH ? ctx.rf : ctx.R[t]; };
  function series(ctx, t, base) { return base === "KRW" ? E.krw(ctx, t) : E.usd(ctx, t); }

  // 공통 유효 구간의 행렬
  function panel(ctx, tickers, base, from) {
    const cols = tickers.map(t => series(ctx, t, base)), idx = [];
    for (let i = Math.max(1, from || 0); i < ctx.n; i++) {
      let ok = true; for (const c of cols) if (!Number.isFinite(c[i])) { ok = false; break; }
      if (ok) idx.push(i);
    }
    return { idx, cols };
  }
  E.panel = panel;

  // ───────────────────────── 보유내역 → 비중 ─────────────────────────
  E.weights = function (ctx, holdings, cashKRW) {
    const lp = ctx.market.last_px, fxNow = ctx.market.meta.fx_now;
    const values = {}, missing = [];
    let nav = 0;
    for (const h of holdings) {
      const p = lp[h.t];
      if (!p || !ctx.R[h.t]) { missing.push(h.t); continue; }
      const v = h.shares * p * fxNow;
      values[h.t] = (values[h.t] || 0) + v; nav += v;
    }
    if (cashKRW > 0) { values[CASH] = cashKRW; nav += cashKRW; }
    const w = {}; for (const t in values) w[t] = values[t] / nav;
    return { w, values, nav, missing };
  };

  function wvec(w) { const t = Object.keys(w).filter(k => w[k] > 1e-9); return { t, v: t.map(k => w[k]) }; }

  // 일간 포트폴리오 수익률 (매일 리밸런싱 가정 — 현재 비중 고정)
  E.portReturns = function (ctx, w, base, from) {
    const { t, v } = wvec(w); const { idx, cols } = panel(ctx, t, base, from);
    const r = new Float64Array(idx.length);
    for (let k = 0; k < idx.length; k++) { let s = 0; for (let j = 0; j < cols.length; j++) s += v[j] * cols[j][idx[k]]; r[k] = s; }
    return { idx, r };
  };

  // ───────────────────────── 공분산 ─────────────────────────
  E.ewmaCov = function (ctx, tickers, base, lam) {
    const { idx, cols } = panel(ctx, tickers, base);
    const use = idx.slice(-1000), n = use.length, p = tickers.length;
    const S = Array.from({ length: p }, () => new Float64Array(p));
    let wsum = 0;
    for (let k = 0; k < n; k++) {
      const wt = (1 - lam) * Math.pow(lam, n - 1 - k); wsum += wt;
      const i = use[k];
      for (let a = 0; a < p; a++) { const xa = cols[a][i]; for (let b = a; b < p; b++) S[a][b] += wt * xa * cols[b][i]; }
    }
    for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { S[a][b] /= wsum; S[b][a] = S[a][b]; }
    return S;
  };
  E.sampleCov = function (ctx, tickers, base, days) {
    const { idx, cols } = panel(ctx, tickers, base);
    const use = idx.slice(-days), n = use.length, p = tickers.length;
    const m = cols.map(c => { let s = 0; for (const i of use) s += c[i]; return s / n; });
    const S = Array.from({ length: p }, () => new Float64Array(p));
    for (const i of use) for (let a = 0; a < p; a++) { const xa = cols[a][i] - m[a]; for (let b = a; b < p; b++) S[a][b] += xa * (cols[b][i] - m[b]); }
    for (let a = 0; a < p; a++) for (let b = a; b < p; b++) { S[a][b] /= (n - 1); S[b][a] = S[a][b]; }
    return { S, n };
  };

  // Ledoit-Wolf(2004) 축소를 상관행렬에 적용 (표준화 → 축소 → 원래 표준편차로 복원)
  E.ledoitWolf = function (X) { // X: 관측 n × 변수 p (배열의 배열)
    const n = X.length, p = X[0].length;
    const m = new Float64Array(p), sd = new Float64Array(p);
    for (const r of X) for (let j = 0; j < p; j++) m[j] += r[j] / n;
    for (const r of X) for (let j = 0; j < p; j++) sd[j] += (r[j] - m[j]) ** 2;
    for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j] / (n - 1)) || 1e-12;
    const Y = X.map(r => r.map((x, j) => (x - m[j]) / sd[j]));
    const S = Array.from({ length: p }, () => new Float64Array(p));
    for (const y of Y) for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) S[a][b] += y[a] * y[b] / n;
    let mu = 0; for (let j = 0; j < p; j++) mu += S[j][j] / p;
    let d2 = 0; for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) d2 += (S[a][b] - (a === b ? mu : 0)) ** 2;
    d2 /= p;
    let bb = 0;
    for (const y of Y) { let s = 0; for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) s += (y[a] * y[b] - S[a][b]) ** 2; bb += s; }
    bb = bb / (n * n) / p;
    const b2 = Math.min(bb, d2), sh = d2 > 0 ? b2 / d2 : 0;
    const C = Array.from({ length: p }, (_, a) => new Float64Array(p));
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) C[a][b] = (1 - sh) * S[a][b] + (a === b ? sh * mu : 0);
    const dg = Array.from({ length: p }, (_, j) => Math.sqrt(C[j][j]));
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) C[a][b] = C[a][b] / (dg[a] * dg[b]) * sd[a] * sd[b];
    return { S: C, shrink: sh, mean: m };
  };

  // ───────────────────────── VaR ─────────────────────────
  E.HORIZONS = [[1, "1일"], [10, "10일"], [21, "1개월"], [63, "3개월"], [252, "1년"]];
  // 위험한도 기준 (설정의 기간·신뢰수준). 모든 한도 계산은 이 값을 따른다
  E.limHC = L => ({ h: (L && L.h) || 252, c: (L && L.c) || 0.95 });
  E.limLabel = L => { const { h, c } = E.limHC(L); const n = (E.HORIZONS.find(x => x[0] === h) || [h, h + "일"])[1]; return `${n} ${Math.round(c * 100)}% VaR`; };
  E.var = function (ctx, w, nav, opt) {
    opt = Object.assign({ lam: 0.94, years: 10, block: 21, paths: 10000, seed: 42 }, opt || {});
    const pr = E.portReturns(ctx, w, "KRW", opt.from);
    const all = pr.r, idxAll = pr.idx;
    const L = Math.min(all.length, Math.round(252 * opt.years));
    const x = all.slice(all.length - L), ix = idxAll.slice(idxAll.length - L);
    // 기대 초과수익 0 가정: 초과수익 평균 제거
    let exm = 0, rfm = 0; for (let k = 0; k < L; k++) { exm += x[k] - ctx.rf[ix[k]]; rfm += ctx.rf[ix[k]]; } exm /= L; rfm /= L;
    const xd = new Float64Array(L); for (let k = 0; k < L; k++) xd[k] = x[k] - ctx.rf[ix[k]] - exm + rfm;
    const lx = xd.map(v => Math.log1p(v));
    const rng = mulberry32(opt.seed), H = 252, B = opt.block, nb = Math.ceil(H / B);
    const marks = E.HORIZONS.map(h => h[0]).filter(h => h > 1);
    const cum = {}; for (const h of marks) cum[h] = new Float64Array(opt.paths);
    for (let p = 0; p < opt.paths; p++) {
      let s = 0, d = 0;
      for (let b = 0; b < nb && d < H; b++) {
        const st = Math.floor(rng() * (L - B));
        for (let j = 0; j < B && d < H; j++) { s += lx[st + j]; d++; if (cum[d]) cum[d][p] = s; }
      }
    }
    const out = { boot: {}, ewma: {}, hs250: {}, years: +(L / 252).toFixed(1) };
    function tail(losses, c) { const srt = Float64Array.from(losses).sort(); const v = quantile(srt, c); let s = 0, k = 0; for (let i = srt.length - 1; i >= 0 && srt[i] >= v; i--) { s += srt[i]; k++; } return [v, s / k]; }
    for (const [h] of E.HORIZONS) {
      out.boot[h] = {};
      const losses = h === 1 ? xd.map(v => -v) : cum[h].map(v => 1 - Math.exp(v));
      for (const c of [0.95, 0.99]) { const [v, es] = tail(losses, c); out.boot[h][c] = { pct: v, amt: v * nav, es_pct: es, es_amt: es * nav }; }
    }
    const { t, v } = wvec(w);
    const S = E.ewmaCov(ctx, t, "KRW", opt.lam), sd = Math.sqrt(quad(S, v));
    out.sigma_d = sd; out.sigma_ann = sd * Math.sqrt(252);
    for (const [h] of E.HORIZONS) {
      out.ewma[h] = {}; const s = sd * Math.sqrt(h);
      for (const c of [0.95, 0.99]) {
        const [z, pdf] = Z[c];
        const vv = 1 - Math.exp(-z * s - s * s / 2), es = 1 - Math.exp(-s * pdf / (1 - c) - s * s / 2);
        out.ewma[h][c] = { pct: vv, amt: vv * nav, es_pct: es, es_amt: es * nav };
      }
    }
    const last = Float64Array.from(all.slice(-250)).sort();
    for (const h of [1, 10]) {
      out.hs250[h] = {};
      for (const c of [0.95, 0.99]) {
        const v1 = -quantile(last, 1 - c) * Math.sqrt(h);
        let s = 0, k = 0; const q = quantile(last, 1 - c); for (const y of last) if (y <= q) { s += -y; k++; }
        out.hs250[h][c] = { pct: v1, amt: v1 * nav, es_pct: s / k * Math.sqrt(h), es_amt: s / k * Math.sqrt(h) * nav };
      }
    }
    return out;
  };

  // 1일 99% VaR 백테스트 (최근 250일)
  E.backtest = function (ctx, w, lam) {
    const { r } = E.portReturns(ctx, w, "KRW"); const n = r.length; let s2 = 0;
    for (let i = n - 1000; i < n - 1000 + 60; i++) s2 += r[i] * r[i] / 60;
    let exHS = 0, exEW = 0;
    for (let i = n - 1000 + 60; i < n; i++) {
      if (i >= n - 250) {
        const win = Float64Array.from(r.slice(i - 250, i)).sort(); const v = -quantile(win, 0.01);
        if (r[i] < -v) exHS++;
        if (r[i] < -2.3263479 * Math.sqrt(s2)) exEW++;
      }
      s2 = lam * s2 + (1 - lam) * r[i] * r[i];
    }
    const zone = k => k <= 4 ? "green" : k <= 9 ? "yellow" : "red";
    return { exHS, exEW, zoneHS: zone(exHS), zoneEW: zone(exEW), expected: 2.5 };
  };

  // ───────────────────────── 위험기여 · 스트레스 · 낙폭 ─────────────────────────
  E.contrib = function (ctx, w, lam) {
    const { t, v } = wvec(w), out = {};
    for (const [key, S] of [["ewma", E.ewmaCov(ctx, t, "KRW", lam)], ["y3", E.sampleCov(ctx, t, "KRW", 756).S]]) {
      const tot = quad(S, v), mv = matVec(S, v);
      t.forEach((k, i) => { (out[k] = out[k] || { w: v[i] })[key] = v[i] * mv[i] / tot; out[k][key + "_vol"] = Math.sqrt(S[i][i] * 252); });
      out._vol = out._vol || {}; out._vol[key] = Math.sqrt(tot * 252);
    }
    return out;
  };
  E.stress = function (ctx, w) {
    const { t, v } = wvec(w), d = ctx.dates;
    return ctx.market.stress.map(s => {
      const a = d.findIndex(x => x > s.start), b = d.findLastIndex ? d.findLastIndex(x => x <= s.end) : (() => { let k = -1; d.forEach((x, i) => { if (x <= s.end) k = i; }); return k; })();
      if (a < 1 || b <= a) return Object.assign({}, s, { krw: null, usd: null });
      const res = {};
      for (const base of ["KRW", "USD"]) {
        let g = 1, ok = true;
        for (let i = a; i <= b; i++) { let r = 0; for (let j = 0; j < t.length; j++) { const x = series(ctx, t[j], base)[i]; if (!Number.isFinite(x)) { ok = false; break; } r += v[j] * x; } if (!ok) break; g *= 1 + r; }
        res[base] = ok ? g - 1 : null;
      }
      let gs = 1; for (let i = a; i <= b; i++) gs *= 1 + ctx.R.SPY[i];
      return Object.assign({}, s, { krw: res.KRW, usd: res.USD, spy: gs - 1 });
    });
  };
  E.drawdown = function (ctx, w, days) {
    const { idx, r } = E.portReturns(ctx, w, "KRW"); const k0 = Math.max(0, r.length - days);
    let v = 1, pk = 1, mdd = 0; const dd = [], ds = [];
    for (let k = k0; k < r.length; k++) { v *= 1 + r[k]; pk = Math.max(pk, v); const x = v / pk - 1; mdd = Math.min(mdd, x); if ((k - k0) % 5 === 0 || k === r.length - 1) { dd.push(x); ds.push(ctx.dates[idx[k]]); } }
    return { now: dd[dd.length - 1], mdd, d: ds, v: dd };
  };

  // ───────────────────────── 상관 ─────────────────────────
  // a, b: 수익률 배열(같은 인덱스), days: 최근 n일, down: a가 하락한 날만
  E.corrWin = function (ctx, ra, rb, days, down) {
    const xa = [], xb = [];
    for (let i = ctx.n - 1; i >= 1 && xa.length < days; i--) {
      const a = ra[i], b = rb[i]; if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      xa.push(a); xb.push(b);
    }
    if (!down) return xa.length >= days * 0.8 ? pearson(xa, xb) : NaN;
    const da = [], db = []; xa.forEach((a, i) => { if (a < 0) { da.push(a); db.push(xb[i]); } });
    return da.length >= 30 ? pearson(da, db) : NaN;
  };
  // 포트폴리오(또는 바스켓) 일간 수익률을 전체 인덱스 길이 배열로
  E.basketSeries = function (ctx, w, base) {
    const { idx, r } = E.portReturns(ctx, w, base || "USD"); const o = new Float64Array(ctx.n).fill(NaN);
    idx.forEach((i, k) => { o[i] = r[k]; }); return o;
  };
  E.WIN = [[21, "1개월"], [63, "3개월"], [126, "6개월"], [252, "12개월"]];

  // 짝 찾기: 바스켓(달리는 말 또는 내 포트의 위험자산)과 후보 ETF
  E.pairs = function (ctx, basketW, candidates, opt) {
    opt = Object.assign({ add: 0.10, lam: 0.94, low: 0.3, drop: 0.2 }, opt || {});
    const bs = E.basketSeries(ctx, basketW, "USD");
    const held = Object.keys(basketW);
    const out = [];
    for (const c of candidates) {
      if (held.includes(c) || !ctx.R[c]) continue;
      const rc = ctx.R[c], row = { t: c, name: ctx.market.names[c] || c };
      for (const [d] of E.WIN) row["c" + d] = E.corrWin(ctx, bs, rc, d);
      row.dn252 = E.corrWin(ctx, bs, rc, 252, true);
      row.dn756 = E.corrWin(ctx, bs, rc, 756, true);
      if (!Number.isFinite(row.c252)) continue;
      row.trend = row.c126 - row.c252;
      // 10% 편입 시 변동성 변화 (바스켓에서 비례 차감) — EWMA 와 3년 표본 두 가지
      const tk = [...held, c], w0 = held.map(k => basketW[k]), s0 = w0.reduce((a, b) => a + b, 0);
      const v0 = [...w0.map(x => x / s0), 0], v1 = [...w0.map(x => x / s0 * (1 - opt.add)), opt.add];
      for (const [key, S] of [["ewma", E.ewmaCov(ctx, tk, "USD", opt.lam)], ["y3", E.sampleCov(ctx, tk, "USD", 756).S]]) {
        row["dvol_" + key] = Math.sqrt(quad(S, v1) * 252) - Math.sqrt(quad(S, v0) * 252);
      }
      row.vol = Math.sqrt(E.sampleCov(ctx, [c], "USD", 252).S[0][0] * 252);
      const fr = ctx.market.first_real[c]; row.years = fr ? (Date.parse(ctx.dates[ctx.n - 1]) - Date.parse(fr)) / 3.156e10 : 0;
      row.proxy = ctx.market.proxy[c] || null;
      const lowNow = row.c126 < opt.low, falling = row.trend < -opt.drop, lowDn = row.dn252 < opt.low;
      row.tags = [];
      if (lowNow) row.tags.push("상관 낮음");
      if (falling) row.tags.push("상관 낮아지는 중");
      if (lowDn) row.tags.push("하락장 상관 낮음");
      if (row.c126 > 0.8) row.tags.push("중복 노출");
      if (row.years < 5 && !row.proxy) row.tags.push(`이력 ${row.years.toFixed(1)}년`);
      row.score = (row.dvol_ewma + row.dvol_y3) / 2;
      out.push(row);
    }
    return out.sort((a, b) => a.score - b.score);
  };

  // 보유 위험자산 간 중복 노출
  E.dup = function (ctx, w, th) {
    const risky = Object.keys(w).filter(t => t !== CASH && t !== "SGOV" && w[t] > 0.02), out = [];
    for (let i = 0; i < risky.length; i++) for (let j = i + 1; j < risky.length; j++) {
      const a = risky[i], b = risky[j];
      const c126 = E.corrWin(ctx, ctx.R[a], ctx.R[b], 126), c63 = E.corrWin(ctx, ctx.R[a], ctx.R[b], 63), c252 = E.corrWin(ctx, ctx.R[a], ctx.R[b], 252);
      out.push({ a, b, c63, c126, c252, flag: c126 > th, w: w[a] + w[b] });
    }
    return out.sort((x, y) => y.c126 - x.c126);
  };

  // ───────────────────────── 월간 데이터 · 기대수익 · 투자선 ─────────────────────────
  E.monthly = function (ctx, tickers, years) {
    const d = ctx.dates, ends = [];
    for (let i = 1; i < ctx.n; i++) if (i === ctx.n - 1 || d[i].slice(0, 7) !== d[i + 1].slice(0, 7)) ends.push(i);
    // 마지막 달이 미완(거래일 15일 미만)이면 제외
    const lastM = d[ctx.n - 1].slice(0, 7); let cnt = 0; for (let i = ctx.n - 1; i >= 0 && d[i].slice(0, 7) === lastM; i--) cnt++;
    if (cnt < 15) ends.pop();
    const use = ends.slice(-(years * 12 + 1));
    const cols = [...tickers, "SPY"].map(t => series(ctx, t, "USD"));
    const rows = [], rfm = [], spy = [], labels = [];
    for (let k = 1; k < use.length; k++) {
      const a = use[k - 1] + 1, b = use[k]; const g = new Float64Array(cols.length).fill(1); let rg = 1, ok = true;
      for (let i = a; i <= b; i++) { rg *= 1 + ctx.rf[i]; for (let j = 0; j < cols.length; j++) { const x = cols[j][i]; if (!Number.isFinite(x)) ok = false; g[j] *= 1 + x; } }
      if (!ok) continue;
      rows.push(Array.from(g.slice(0, tickers.length), x => x - 1)); spy.push(g[tickers.length] - 1); rfm.push(rg - 1); labels.push(d[b].slice(0, 7));
    }
    return { rows, rfm, spy, labels, tickers };
  };

  E.expected = function (M, method, erp) {
    const T = M.rows.length, p = M.tickers.length;
    const lw = E.ledoitWolf(M.rows), Sm = lw.S, mu = Array.from(lw.mean);
    const rfA = mean(M.rfm) * 12;
    let out;
    if (method === "hist") out = mu.map(x => x * 12);
    else if (method === "shrink") { // Jorion(1986) Bayes-Stein: 최소분산 포트폴리오 평균 쪽으로 축소
      const one = new Array(p).fill(1), Si1 = solve(Sm.map(r => Array.from(r)), one) || one;
      const mg = dot(Si1, mu) / dot(Si1, one), dmu = mu.map(x => x - mg);
      const Sid = solve(Sm.map(r => Array.from(r)), dmu) || dmu;
      const phi = (p + 2) / ((p + 2) + T * dot(dmu, Sid));
      out = mu.map(x => ((1 - phi) * x + phi * mg) * 12); out._phi = phi;
    } else { // CAPM 균형: rf + β·ERP (β는 S&P500 대비, 월간)
      const sp = M.spy, ms = mean(sp); let vs = 0; for (const x of sp) vs += (x - ms) ** 2;
      out = M.tickers.map((_, j) => { let c = 0; const mj = mean(M.rows.map(r => r[j])); M.rows.forEach((r, k) => { c += (r[j] - mj) * (sp[k] - ms); }); return rfA + (c / vs) * erp; });
    }
    return { mu: out, S: Sm.map(r => Array.from(r, x => x * 12)), shrink: lw.shrink, rf: rfA, T, phi: out._phi };
  };

  function projCapped(v, u) { // {0≤w≤u, Σw=1} 위로 사영
    let lo = Math.min(...v) - u - 1, hi = Math.max(...v) + 1;
    for (let it = 0; it < 80; it++) { const t = (lo + hi) / 2; let s = 0; for (const x of v) s += Math.min(u, Math.max(0, x - t)); if (s > 1) lo = t; else hi = t; }
    const t = (lo + hi) / 2; return v.map(x => Math.min(u, Math.max(0, x - t)));
  }
  function maxEig(S) { let v = new Float64Array(S.length).fill(1), l = 0; for (let k = 0; k < 100; k++) { const m = matVec(S, v); l = Math.hypot(...m); v = m.map(x => x / l); } return l; }
  // max μ'w − γ/2 w'Σw  (가속 사영경사법)
  function solveMV(mu, S, gamma, u, w0) {
    const p = mu.length, Lc = gamma * maxEig(S) + 1e-12, step = 1 / Lc;
    let w = w0 ? w0.slice() : projCapped(new Array(p).fill(1 / p), u), y = w.slice(), t = 1;
    for (let it = 0; it < 4000; it++) {
      const g = matVec(S, y), nx = projCapped(y.map((yi, i) => yi + step * (mu[i] - gamma * g[i])), u);
      const tn = (1 + Math.sqrt(1 + 4 * t * t)) / 2; let diff = 0;
      y = nx.map((x, i) => { diff = Math.max(diff, Math.abs(x - w[i])); return x + (t - 1) / tn * (x - w[i]); });
      w = nx; t = tn; if (diff < 1e-9) break;
    }
    return w;
  }
  E.frontier = function (mu, S, opt) {
    opt = Object.assign({ maxW: 1, n: 70, rf: 0 }, opt || {});
    const p = mu.length, u = Math.max(opt.maxW, 1 / p + 1e-9), pts = [];
    let prev = null;
    const gammas = []; for (let k = 0; k < opt.n; k++) gammas.push(Math.pow(10, -1 + 5.5 * k / (opt.n - 1)));
    for (const g of gammas.reverse()) { prev = solveMV(mu, S, g, u, prev); pts.push(prev.slice()); }
    const mv = solveMV(new Array(p).fill(0), S, 1, u, prev && pts[0]);
    pts.unshift(mv);
    let res = pts.map(w => ({ w, vol: Math.sqrt(quad(S, w)), ret: dot(mu, w) }));
    res.sort((a, b) => a.vol - b.vol);
    const eff = []; let best = -Infinity;
    for (const r of res) if (r.ret > best + 1e-7) { eff.push(r); best = r.ret; }
    let ms = eff[0]; for (const r of eff) if ((r.ret - opt.rf) / r.vol > (ms.ret - opt.rf) / ms.vol) ms = r;
    return { pts: eff, minVar: eff[0], maxSharpe: ms };
  };
  E.retAtVol = function (fr, vol) {
    const P = fr.pts; if (vol <= P[0].vol) return P[0].ret; if (vol >= P[P.length - 1].vol) return P[P.length - 1].ret;
    for (let i = 1; i < P.length; i++) if (P[i].vol >= vol) { const a = P[i - 1], b = P[i]; return a.ret + (b.ret - a.ret) * (vol - a.vol) / (b.vol - a.vol); }
  };
  E.point = function (ex, tickers, w) { const v = tickers.map(t => w[t] || 0); return { vol: Math.sqrt(quad(ex.S, v)), ret: dot(ex.mu, v), v }; };
  E.METHODS = [["hist", "과거 평균"], ["shrink", "축소 추정"], ["capm", "시장 균형"]];

  // ───────────────────────── 진단 · 추천 ─────────────────────────
  function frontierTickers(w, extra) {
    const s = new Set(Object.keys(w).filter(t => w[t] > 1e-9).map(t => t === CASH ? "SGOV" : t));
    s.add("SGOV"); (extra || []).forEach(t => s.add(t)); return [...s];
  }
  function mapCash(w) { const o = {}; for (const k in w) { const t = k === CASH ? "SGOV" : k; o[t] = (o[t] || 0) + w[k]; } return o; }
  E.efficiency = function (ctx, w, opt) {
    opt = Object.assign({ years: 5, erp: 0.045, maxW: 1, extra: [] }, opt || {});
    const tk = frontierTickers(w, opt.extra), M = E.monthly(ctx, tk, opt.years), wm = mapCash(w);
    const res = {};
    for (const [m] of E.METHODS) {
      const ex = E.expected(M, m, opt.erp), fr = E.frontier(ex.mu, ex.S, { maxW: opt.maxW, rf: ex.rf }), pt = E.point(ex, tk, wm);
      res[m] = { gap: E.retAtVol(fr, pt.vol) - pt.ret, vol: pt.vol, ret: pt.ret, sharpe: (pt.ret - ex.rf) / pt.vol };
    }
    return { tickers: tk, months: M.rows.length, res };
  };

  function scenarioWeights(w, from, to, amt) { // from 비중 일부를 to 로
    const o = Object.assign({}, w);
    if (from === "*risky") {
      const r = Object.keys(o).filter(t => t !== CASH && t !== "SGOV" && t !== to); const s = r.reduce((a, t) => a + o[t], 0);
      r.forEach(t => { o[t] -= amt * o[t] / s; });
    } else o[from] = Math.max(0, (o[from] || 0) - amt);
    o[to] = (o[to] || 0) + amt;
    for (const k in o) if (o[k] < 1e-9) delete o[k];
    return o;
  }
  E.firstCommon = function (ctx, tickers) { return panel(ctx, tickers, "USD").idx[0] || 0; };
  E.evaluate = function (ctx, w0, w1, nav, set) {
    const lam = set.lam || 0.94;
    const from = E.firstCommon(ctx, [...new Set([...Object.keys(w0), ...Object.keys(w1)])]);
    const v0 = E.var(ctx, w0, nav, { paths: 3000, from }), v1 = E.var(ctx, w1, nav, { paths: 3000, from });
    const s0 = E.stress(ctx, w0), s1 = E.stress(ctx, w1);
    const extra = Object.keys(w1).filter(t => !(t in w0));
    const e0 = E.efficiency(ctx, w0, { erp: set.erp, extra }), e1 = E.efficiency(ctx, w1, { erp: set.erp, extra });
    const dSharpe = {}; let better = 0;
    for (const [m] of E.METHODS) { dSharpe[m] = e1.res[m].sharpe - e0.res[m].sharpe; if (dSharpe[m] > 0.005) better++; }
    const both = s0.map((s, i) => [s.krw, s1[i].krw]).filter(([a, b]) => a !== null && b !== null);
    const worst0 = both.length ? Math.min(...both.map(x => x[0])) : null, worst1 = both.length ? Math.min(...both.map(x => x[1])) : null;
    const c0 = E.contrib(ctx, w0, lam), c1 = E.contrib(ctx, w1, lam);
    return {
      w1, dVolEwma: v1.sigma_ann - v0.sigma_ann, volEwma0: v0.sigma_ann, volEwma1: v1.sigma_ann,
      dVol3y: c1._vol.y3 - c0._vol.y3, vol3y0: c0._vol.y3, vol3y1: c1._vol.y3,
      var1y0: v0.boot[252][0.95].amt, var1y1: v1.boot[252][0.95].amt, varL0: v0.boot[E.limHC(set.limit).h][E.limHC(set.limit).c].amt, varL1: v1.boot[E.limHC(set.limit).h][E.limHC(set.limit).c].amt, varYears: v1.years, nStress: both.length,
      stress: s0.map((s, i) => ({ name: s.name, type: s.type, a: s.krw, b: s1[i].krw })),
      worst0, worst1, dSharpe, robust: better === 3, better, eff0: e0, eff1: e1,
    };
  };

  // ───────────────────────── 위험한도 (B 방식: 분기초 평가액 기준 + 위험자산 크기 조절) ─────────────────────────
  E.SAFE = ["SGOV", "BIL", "SHV", "TBILL", CASH];
  const isSafe = t => E.SAFE.indexOf(t) >= 0;
  E.isSafe = isSafe;
  E.riskyShare = w => Object.keys(w).filter(t => !isSafe(t)).reduce((a, t) => a + w[t], 0);
  E.quarterOf = d => d.slice(0, 4) + "Q" + Math.floor((+d.slice(5, 7) - 1) / 3);
  // 지금 보유 수량을 직전 분기 마지막 거래일 종가(원화)로 평가 — 분기 중 매매는 무시하는 근사
  E.quarterStart = function (ctx, w, nav) {
    const d = ctx.dates, q = E.quarterOf(d[ctx.n - 1]); let qi = ctx.n - 1;
    while (qi > 0 && E.quarterOf(d[qi]) === q) qi--;
    let v = 0;
    for (const t in w) {
      let g = 1; if (t !== CASH) { const r = E.krw(ctx, t); for (let i = qi + 1; i < ctx.n; i++) if (Number.isFinite(r[i])) g *= 1 + r[i]; }
      v += w[t] * nav / g;
    }
    return { date: d[qi], value: v, chg: nav / v - 1 };
  };
  E.limitAmount = function (ctx, w, nav, L) {
    if (L && L.mode === "pct") { const q = E.quarterStart(ctx, w, nav); return { amt: (L.pct || 0.2) * q.value, q }; }
    return { amt: L.amount, q: null };
  };
  // 위험자산 크기 x 와 그 안의 비율 sleeve 로 만든 비중. 나머지 안전자산 몫은 dest(SGOV 또는 원화 현금)로
  E.riskyMix = function (w, sleeve, x, dest) {
    const o = {}; for (const t in w) if (isSafe(t)) o[t] = w[t];
    const safeNow = Object.keys(o).reduce((a, t) => a + o[t], 0); dest = dest || "SGOV";
    o[dest] = (o[dest] || 0) + (1 - x - safeNow); for (const t in sleeve) o[t] = (o[t] || 0) + sleeve[t] * x;
    if (o[dest] < 0) { // 안전자산을 줄여야 하는 경우: SGOV → 현금 순으로 차감
      let need = -o[dest]; o[dest] = 0;
      for (const t of ["SGOV", CASH, "BIL", "SHV"]) if (o[t] > 0 && need > 0) { const d = Math.min(o[t], need); o[t] -= d; need -= d; }
    }
    for (const t in o) if (o[t] < 1e-12) delete o[t];
    return o;
  };
  // VaR(실제 부트스트랩) ≤ vStar 를 만족하는 위험자산 크기를 [lo, hi] 안에서 찾음.
  // SGOV 도 원화 기준으론 환율 위험이 있어 VaR 가 위험자산 크기에 비례하지 않고 바닥이 있으므로 먼저 바닥을 찾는다.
  E.sizeRisky = function (ctx, w, sleeve, vStar, opt) {
    opt = Object.assign({ dest: "SGOV", lo: 0, hi: E.riskyShare(w), f: null, h: 252, c: 0.95 }, opt || {});
    const tk = [...new Set([...Object.keys(w), ...Object.keys(sleeve), opt.dest])];
    const f = opt.f || E.fastVar(ctx, tk, { h: opt.h, c: opt.c }), g = x => f(E.riskyMix(w, sleeve, x, opt.dest));
    let xm = opt.lo, vm = Infinity;
    for (let k = 0; k <= 20; k++) { const x = opt.lo + (opt.hi - opt.lo) * k / 20, v = g(x); if (v < vm) { vm = v; xm = x; } }
    if (g(opt.hi) <= vStar) return { k: opt.hi, reachable: true, kFloor: xm, vFloor: vm, f };
    if (vm > vStar) return { k: xm, reachable: false, kFloor: xm, vFloor: vm, f };
    const x = Math.max(xm, bisect(y => g(y) > vStar, xm, opt.hi) - 1e-4);
    return { k: x, reachable: true, kFloor: xm, vFloor: vm, f };
  };
  // B 규칙: 사용률 105% 초과 → 사용률 90%가 되는 크기까지 위험자산 축소(목표 비율 유지, 재편안 ①과 같은 계산).
  // 사용률 70% 미만이고 위험자산이 기본 비중보다 작으면 → 90%까지 다시 늘릴 여유.
  E.limitAction = function (ctx, w, nav, util, limAmt, k0, sleeve, hc) {
    hc = hc || { h: 252, c: 0.95 };
    const k = E.riskyShare(w); if (!(k > 0.01) || !Number.isFinite(util)) return null;
    const sl = sleeve || (() => { const o = {}; for (const t in w) if (!isSafe(t)) o[t] = w[t] / k; return o; })();
    const mk = (kind, r) => {
      const w1 = E.riskyMix(w, sl, r.k, "SGOV"), trades = {};
      for (const t of new Set([...Object.keys(w), ...Object.keys(w1)])) { const d = ((w1[t] || 0) - (w[t] || 0)) * nav; if (Math.abs(d) > 1) trades[t] = d; }
      return { kind, k, kNew: r.k, amt: Math.abs(k - r.k) * nav, trades, reachable: r.reachable, vFloor: r.vFloor * nav, kFloor: r.kFloor };
    };
    if (util > 1.05) return mk("cut", E.sizeRisky(ctx, w, sl, 0.9 * limAmt / nav, { hi: k, h: hc.h, c: hc.c }));
    if (util < 0.7 && k0 && k < k0 - 0.02) { const r = E.sizeRisky(ctx, w, sl, 0.9 * limAmt / nav, { lo: k, hi: Math.min(k0, 1 - (w[CASH] || 0)), h: hc.h, c: hc.c }); return r.k > k + 0.005 ? mk("add", r) : null; }
    return null;
  };
  // 목표비중(전체 기준) → 위험자산 안 비율과 기본 위험자산 비중
  E.sleeveOf = function (targets) {
    if (!targets) return { sleeve: null, k0: null };
    const k0 = E.riskyShare(targets), sleeve = {};
    for (const t in targets) if (!isSafe(t) && targets[t] > 0) sleeve[t] = targets[t] / k0;
    return { sleeve, k0 };
  };

  E.diagnose = function (ctx, w, nav, set) {
    set = Object.assign({ lam: 0.94, limit: { amount: 2e7, h: 252, c: 0.95, warn: 0.8 }, dupTh: 0.9, erp: 0.045, targets: null }, set || {});
    const mk = ctx.market, items = [];
    const V = E.var(ctx, w, nav, { lam: set.lam });
    const LA = E.limitAmount(ctx, w, nav, set.limit), lim = V.boot[set.limit.h][set.limit.c].amt, util = lim / LA.amt;
    const SL = E.sleeveOf(set.targets), act = E.limitAction(ctx, w, nav, util, LA.amt, SL.k0 || E.riskyShare(w), SL.sleeve, E.limHC(set.limit));
    items.push({ key: "limit", label: "위험한도", level: util > 1 ? 2 : util > set.limit.warn ? 1 : 0,
      text: `${E.limLabel(set.limit)} ${fmtW(lim)} = 한도 ${fmtW(LA.amt)}${LA.q ? `(분기초 ${fmtW(LA.q.value)}의 ${pct(set.limit.pct, 0)})` : ""}의 ${pct(util, 0)}`
        + (act ? (act.kind === "cut" ? (act.reachable ? ` → 위험자산 ${fmtW(act.amt)}어치 줄여 SGOV로 (재편안 ①)` : ` → SGOV로만은 한도에 못 맞춤 (재편안 참고)`) : ` → 위험자산 ${fmtW(act.amt)} 다시 늘릴 여유`) : ""), value: util, th: 1 });
    const C = E.contrib(ctx, w, set.lam); let top = null;
    for (const t in C) if (t[0] !== "_" && (!top || C[t].ewma > C[top].ewma)) top = t;
    const tc = C[top].ewma;
    items.push({ key: "conc", label: "위험 집중", level: tc > 0.5 ? 2 : tc > 0.35 ? 1 : 0,
      text: `${top}가 변동성의 ${pct(tc, 0)} (비중 ${pct(w[top], 0)})`, value: tc, th: 0.5 });
    const D = E.dup(ctx, w, set.dupTh), d0 = D[0];
    if (d0) items.push({ key: "dup", label: "중복 노출", level: d0.c126 > set.dupTh ? 2 : d0.c126 > 0.8 ? 1 : 0,
      text: `${d0.a}–${d0.b} 6개월 상관 ${d0.c126.toFixed(2)} (합산 비중 ${pct(d0.w, 0)})`, value: d0.c126, th: set.dupTh });
    const S = E.stress(ctx, w), worst = S.filter(s => s.krw !== null).sort((a, b) => a.krw - b.krw)[0];
    items.push({ key: "stress", label: "위기 방어", level: worst && worst.krw < worst.spy - 0.05 ? 2 : worst && worst.krw < worst.spy ? 1 : 0,
      text: worst ? `가장 나쁜 위기: ${worst.name} ${pct(worst.krw, 1)} (같은 기간 S&P500 ${pct(worst.spy, 1)})` : "–", value: worst && worst.krw });
    const Ef = E.efficiency(ctx, w, { erp: set.erp });
    const gaps = E.METHODS.map(([m]) => Ef.res[m].gap), nBad = gaps.filter(g => g > 0.01).length;
    items.push({ key: "eff", label: "투자선 효율", level: nBad === 3 ? 2 : nBad >= 2 ? 1 : 0,
      text: `같은 변동성에서 비중만 바꿔 얻을 수 있는 추가 기대수익: ${E.METHODS.map(([m, l], i) => `${l} ${pp(gaps[i])}`).join(" · ")}`, value: Math.min(...gaps) });
    // 최근 작동 (설명용 — 예측력 없음)
    const pr = E.basketSeries(ctx, w, "USD"), recent = {};
    for (const [d, lab] of [[63, "3개월"], [126, "6개월"]]) {
      let gp = 1, gs = 1, g6 = 1;
      for (let i = ctx.n - d; i < ctx.n; i++) { if (Number.isFinite(pr[i])) gp *= 1 + pr[i]; gs *= 1 + ctx.R.SPY[i]; g6 *= 1 + 0.6 * ctx.R.SPY[i] + 0.4 * (ctx.R.AGG ? ctx.R.AGG[i] : 0); }
      recent[lab] = { port: gp - 1, spy: gs - 1, b6040: g6 - 1 };
    }
    const held = Object.keys(w).filter(t => mk.rs[t]);
    const weak = held.filter(t => mk.rs[t].state === "약세" || mk.rs[t].state === "약화 조짐");
    const weakW = weak.reduce((a, t) => a + w[t], 0);
    const lv = items.reduce((a, x) => a + x.level, 0), nRed = items.filter(x => x.level === 2).length;
    const verdict = nRed >= 2 || lv >= 5 ? "점검 필요" : lv >= 2 ? "보통" : "양호";
    return { verdict, items, V, util, limAmt: LA.amt, qStart: LA.q, limAct: act, riskyK: E.riskyShare(w), k0: SL.k0, C, D, S, Ef, recent, weak, weakW };
  };

  E.recommend = function (ctx, w, nav, diag, set) {
    set = Object.assign({ lam: 0.94, erp: 0.045, step: 0.10, dupTh: 0.9 }, set || {});
    const mk = ctx.market, risky = Object.keys(w).filter(t => t !== CASH && t !== "SGOV");
    const basket = {}; risky.forEach(t => { basket[t] = w[t]; });
    const cands = [...new Set([...mk.groups.candidates, ...mk.groups.runners])].filter(t => ctx.R[t] && !(t in w));
    const P = risky.length ? E.pairs(ctx, basket, cands, { lam: set.lam }) : [];
    const goodPairs = P.filter(p => p.dvol_ewma < 0 && p.dvol_y3 < 0 && p.dn252 < 0.5 && (p.years >= 5 || p.proxy)).slice(0, 4);
    const acts = [];
    // (1) 중복 노출 축소: 상관 높은 쌍 중 변동성 큰 쪽을 줄여 최적 짝 또는 SGOV 로
    const dup = diag.D.filter(d => d.flag)[0];
    let topRisk = null; for (const t in diag.C) if (t[0] !== "_" && t !== CASH && (!topRisk || diag.C[t].ewma > diag.C[topRisk].ewma)) topRisk = t;
    const cutT = dup ? (diag.C[dup.a].ewma_vol > diag.C[dup.b].ewma_vol ? dup.a : dup.b) : topRisk;
    const amt = Math.min(set.step * 2, w[cutT] / 2);
    if (cutT && amt > 0.02) {
      for (const to of [goodPairs[0] && goodPairs[0].t, "SGOV"].filter(Boolean)) {
        acts.push({ kind: "swap", from: cutT, to, amt, why: dup ? `${dup.a}–${dup.b} 중복 노출(6개월 상관 ${dup.c126.toFixed(2)})` : `${cutT} 위험 집중(${pct(diag.C[cutT].ewma, 0)})` });
      }
    }
    // (2) 분산 후보 편입: 위험자산에서 비례 차감
    for (const p of goodPairs.slice(0, 3)) acts.push({ kind: "add", from: "*risky", to: p.t, amt: set.step, why: `${p.tags.join(", ") || "변동성 감소"} (6개월 상관 ${p.c126.toFixed(2)}, 하락장 상관 ${Number.isFinite(p.dn252) ? p.dn252.toFixed(2) : "–"})` });
    // (3) 위험한도 초과 시 SGOV 로 축소
    if (diag.util > 1) { const k = 0.9 / diag.util; const a = risky.reduce((s, t) => s + w[t], 0) * (1 - k); acts.push({ kind: "derisk", from: "*risky", to: "SGOV", amt: a, why: `위험한도 사용률 ${pct(diag.util, 0)} → 90%` }); }
    const seen = new Set(), out = [];
    for (const a of acts) {
      const key = a.from + ">" + a.to; if (seen.has(key)) continue; seen.add(key);
      const w1 = scenarioWeights(w, a.from, a.to, a.amt);
      const ev = E.evaluate(ctx, w, w1, nav, set);
      out.push(Object.assign(a, ev, { title: a.kind === "add" ? `${a.to} ${pct(a.amt, 0)} 편입` : a.kind === "derisk" ? `위험자산 ${pct(a.amt, 0)} → SGOV` : `${a.from} ${pct(a.amt, 0)} → ${a.to}` }));
    }
    out.forEach(o => { o.rank = (o.dVolEwma / o.volEwma0 + o.dVol3y / o.vol3y0) / 2 - 0.02 * o.better; });
    out.sort((a, b) => a.rank - b.rank);
    return { actions: out.slice(0, 4), pairs: P };
  };

  // ───────────────────────── 한도 맞춤 재편안 · 재편 시뮬레이션 ─────────────────────────
  // E.var 의 1년 부트스트랩과 같은 난수열·같은 창을 쓰되, 누적합으로 블록 합을 O(1)에 계산 (비중만 바꿔 수백 번 계산하기 위함)
  E.fastVar = function (ctx, tickers, opt) {
    opt = Object.assign({ years: 10, block: 21, paths: 10000, seed: 42, c: 0.95, h: 252 }, opt || {});
    const from = opt.from !== undefined ? opt.from : E.firstCommon(ctx, tickers);
    const { idx, cols } = panel(ctx, tickers, "KRW", from), L = Math.min(idx.length, Math.round(252 * opt.years));
    const ix = idx.slice(idx.length - L), B = opt.block, H = 252, nb = Math.ceil(H / B), h = opt.h;
    // E.var 와 같은 난수열: 경로마다 1년치 블록 시작점을 뽑고, 기간 h 는 그 앞부분을 쓴다
    const rng = mulberry32(opt.seed), starts = new Int32Array(opt.paths * nb);
    for (let k = 0; k < starts.length; k++) starts[k] = Math.floor(rng() * (L - B));
    const lens = []; { let d = 0; for (let b = 0; b < nb && d < h; b++) { lens.push(Math.min(B, h - d)); d += B; } }
    const P = new Float64Array(L + 1), loss = new Float64Array(h === 1 ? L : opt.paths), xd = new Float64Array(L);
    const f = function (w) {
      const v = tickers.map(t => w[t] || 0); let exm = 0, rfm = 0;
      for (let k = 0; k < L; k++) { const i = ix[k]; let r = 0; for (let j = 0; j < v.length; j++) if (v[j]) r += v[j] * cols[j][i]; xd[k] = r; exm += r - ctx.rf[i]; rfm += ctx.rf[i]; }
      exm /= L; rfm /= L;
      if (h === 1) { for (let k = 0; k < L; k++) loss[k] = -(xd[k] - ctx.rf[ix[k]] - exm + rfm); return quantile(Float64Array.from(loss).sort(), opt.c); }
      for (let k = 0; k < L; k++) P[k + 1] = P[k] + Math.log1p(xd[k] - ctx.rf[ix[k]] - exm + rfm);
      for (let p = 0; p < opt.paths; p++) { let s = 0; for (let b = 0; b < lens.length; b++) { const st = starts[p * nb + b]; s += P[st + lens[b]] - P[st]; } loss[p] = 1 - Math.exp(s); }
      return quantile(Float64Array.from(loss).sort(), opt.c);
    };
    f.years = +(L / 252).toFixed(1); f.from = from; f.h = h; f.c = opt.c;
    return f;
  };
  // 시장 균형 기대수익 (rf + β×ERP, 최근 5년 월간, 달러) — 수익 예측이 아니라 '위험에 걸맞은 보상' 기준
  E.capmER = function (ctx, tickers, erp) {
    const o = {};
    for (const t of tickers) { if (t === CASH || isSafe(t)) { o[t] = null; continue; } try { o[t] = E.expected(E.monthly(ctx, [t], 5), "capm", erp).mu[0]; } catch (e) { o[t] = null; } }
    let rf = 0; try { rf = E.expected(E.monthly(ctx, ["SPY"], 5), "capm", erp).rf; } catch (e) { }
    for (const t in o) if (o[t] === null || !Number.isFinite(o[t])) o[t] = rf;
    o._rf = rf; return o;
  };
  const sumBy = (o, f) => Object.keys(o).filter(f).reduce((a, t) => a + o[t], 0);
  function bisect(g, lo, hi, it) { for (let k = 0; k < (it || 30); k++) { const m = (lo + hi) / 2; if (g(m)) hi = m; else lo = m; } return hi; } // g 가 참이 되는 최소값
  // 비중 → 정수 주수 (SGOV 로 잔액 정리, 남는 돈은 원화 현금)
  E.toShares = function (ctx, w1, nav, H0, cash0) {
    const lp = ctx.market.last_px, fx = ctx.market.meta.fx_now, cur = {};
    for (const h of H0) cur[h.t] = (cur[h.t] || 0) + h.shares;
    const H1 = {}; let spent = 0;
    for (const t in w1) { if (t === CASH || t === "SGOV" || !lp[t]) continue; const sh = Math.max(0, Math.round(w1[t] * nav / (lp[t] * fx))); if (sh > 0) H1[t] = sh; spent += sh * lp[t] * fx; }
    for (const t in cur) if (!(t in w1) && t !== "SGOV" && !lp[t]) H1[t] = cur[t];
    let rest = nav - spent - (w1[CASH] || 0) * nav;
    if (lp.SGOV) {
      // 원화 현금으로 옮기는 안이면 SGOV 는 목표 주수 그대로(반올림 차액은 현금), 아니면 남는 돈을 SGOV 로
      const sh = (w1[CASH] || 0) > 0.001 ? Math.max(0, Math.round((w1.SGOV || 0) * nav / (lp.SGOV * fx))) : Math.max(0, Math.floor(rest / (lp.SGOV * fx)));
      if (sh > 0) H1.SGOV = sh; rest -= sh * lp.SGOV * fx;
    }
    return { holdings: Object.entries(H1).map(([t, shares]) => ({ t, shares })), cash: Math.max(0, (w1[CASH] || 0) * nav + rest) };
  };
  E.tradeList = function (ctx, H0, H1) {
    const lp = ctx.market.last_px, fx = ctx.market.meta.fx_now, a = {}, b = {};
    for (const h of H0) a[h.t] = (a[h.t] || 0) + h.shares; for (const h of H1) b[h.t] = (b[h.t] || 0) + h.shares;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].map(t => { const d = (b[t] || 0) - (a[t] || 0); return { t, from: a[t] || 0, to: b[t] || 0, d, amt: lp[t] ? d * lp[t] * fx : null }; })
      .filter(x => Math.abs(x.d) > 1e-9).sort((x, y) => Math.abs(y.amt || 0) - Math.abs(x.amt || 0));
  };
  // 보유내역 두 개를 같은 창·같은 한도로 비교
  E.compareHoldings = function (ctx, H0, cash0, H1, cash1, set) {
    set = Object.assign({ erp: 0.045, limAmt: null, h: 252, c: 0.95 }, set || {});
    const W0 = E.weights(ctx, H0, cash0), W1 = E.weights(ctx, H1, cash1);
    const tk = [...new Set([...Object.keys(W0.w), ...Object.keys(W1.w)])];
    const from = E.firstCommon(ctx, tk), ER = E.capmER(ctx, tk, set.erp);
    const one = W => {
      if (!Object.keys(W.w).length) return null;
      const V = E.var(ctx, W.w, W.nav, { from }), S = E.stress(ctx, W.w).filter(x => x.krw !== null).sort((a, b) => a.krw - b.krw)[0];
      const C = E.contrib(ctx, W.w, 0.94), er = Object.keys(W.w).reduce((a, t) => a + W.w[t] * (t === CASH ? ER._rf : ER[t]), 0);
      return { nav: W.nav, w: W.w, k: E.riskyShare(W.w), var1y: V.boot[252][0.95].amt, var1yPct: V.boot[252][0.95].pct, var1d99: V.boot[1][0.99].amt, var1m: V.boot[21][0.95].amt, var10d: V.boot[10][0.95].amt, var3m: V.boot[63][0.95].amt, es1y: V.boot[252][0.95].es_amt, varL: V.boot[set.h][set.c].amt, esL: V.boot[set.h][set.c].es_amt,
        util: set.limAmt ? V.boot[set.h][set.c].amt / set.limAmt : null, volNow: V.sigma_ann, vol3y: C._vol ? C._vol.y3 : null, worst: S || null, er, years: V.years, missing: W.missing };
    };
    return { a: one(W0), b: one(W1), trades: E.tradeList(ctx, H0, H1), from: ctx.dates[from] };
  };
  // 한도(사용률 target)에 맞추는 재편안: ① 목표 비율 유지하며 위험자산 축소 ② 위험기여 큰 종목부터 축소 ③ 다른 ETF로 일부 교체
  E.limitPlans = function (ctx, H0, cash0, limAmt, set) {
    set = Object.assign({ target: 0.9, targets: null, erp: 0.045, nCand: 3, h: 252, c: 0.95 }, set || {});
    const HC = { h: set.h, c: set.c };
    const W = E.weights(ctx, H0, cash0), w = W.w, nav = W.nav, vStar = set.target * limAmt / nav;
    const held = Object.keys(w), risky = held.filter(t => !isSafe(t)), k = E.riskyShare(w);
    const base = [...new Set([...held.filter(t => t !== CASH), "SGOV"])];
    const fv = E.fastVar(ctx, base, HC), v0 = fv(w);
    const out = { util0: v0 * nav / limAmt, var0: v0 * nav, target: set.target, years: fv.years, plans: [], need: v0 > vStar, h: set.h, c: set.c };
    if (!(k > 0.01)) return out;
    const SL = E.sleeveOf(set.targets), sleeve = (SL.sleeve && Object.keys(SL.sleeve).every(t => ctx.R[t])) ? SL.sleeve : Object.fromEntries(risky.map(t => [t, w[t] / k]));
    const ER = E.capmER(ctx, [...new Set([...base, ...Object.keys(sleeve)])], set.erp);
    const erOf = x => Object.keys(x).reduce((a, t) => a + x[t] * (t === CASH ? ER._rf : (ER[t] !== undefined ? ER[t] : ER._rf)), 0);
    const safeBase = () => { const o = {}; for (const t of held) if (isSafe(t)) o[t] = w[t]; return o; };
    const withRisky = (kk, sl) => E.riskyMix(w, sl, kk, "SGOV");
    const plans = [];
    const finish = (key, title, why, w1, extra) => {
      const r = E.toShares(ctx, w1, nav, H0, cash0);
      plans.push(Object.assign({ key, title, why, w1, holdings: r.holdings, cash: r.cash, trades: E.tradeList(ctx, H0, r.holdings), k1: E.riskyShare(w1), er0: erOf(w), er1: erOf(w1) }, extra || {}));
    };
    const fvS = Object.keys(sleeve).some(t => base.indexOf(t) < 0) ? E.fastVar(ctx, [...new Set([...base, ...Object.keys(sleeve)])], HC) : fv;
    if (v0 > vStar) {
      // ① 목표 비율 유지 — 줄인 돈을 SGOV 로 / 원화 현금으로
      const rS = E.sizeRisky(ctx, w, sleeve, vStar, { hi: k, f: fvS });
      out.floorSGOV = { reachable: rS.reachable, k: rS.kFloor, var: rS.vFloor * nav };
      if (rS.reachable) finish("keep", "목표 비율 그대로 줄이고 SGOV로", `위험자산 ${pct(k, 0)} → ${pct(rS.k, 0)}, 판 돈 ${fmtW((k - rS.k) * nav)}으로 SGOV 매수`, withRisky(rS.k, sleeve));
      const rC = E.sizeRisky(ctx, w, sleeve, vStar, { hi: k, dest: CASH, h: set.h, c: set.c });
      if (rC.reachable) finish("keepKRW", "목표 비율 그대로 줄이고 원화 현금으로", `위험자산 ${pct(k, 0)} → ${pct(rC.k, 0)}, 판 돈 ${fmtW((k - rC.k) * nav)}을 원화(CMA·파킹통장 등)로 — 환율 위험까지 같이 줄어 SGOV보다 덜 팔아도 됨`, E.riskyMix(w, sleeve, rC.k, CASH));
      // ② 위험기여 큰 종목부터 (한계 VaR: 1%p 를 SGOV 로 옮겼을 때 VaR 감소폭)
      let cur = Object.assign({}, w); const order = [], used = [];
      for (let step = 0; step < risky.length && fv(cur) > vStar; step++) {
        const base0 = fv(cur); let best = null, bd = 0;
        for (const t of risky) { if (used.indexOf(t) >= 0 || !(cur[t] > 1e-4)) continue; const e = Math.min(0.01, cur[t]); const x = Object.assign({}, cur); x[t] -= e; x.SGOV = (x.SGOV || 0) + e; const dv = (base0 - fv(x)) / e; if (dv > bd) { bd = dv; best = t; } }
        if (!best) break; used.push(best);
        const mv = a => { const x = Object.assign({}, cur); x[best] -= a; x.SGOV = (x.SGOV || 0) + a; return x; };
        const amt = fv(mv(cur[best])) > vStar ? cur[best] : bisect(a => fv(mv(a)) <= vStar, 0, cur[best]);
        cur = mv(amt); order.push([best, amt]);
      }
      if (fv(cur) <= vStar * 1.001) finish("top", "위험기여 큰 종목 위주로 줄이기", order.map(([t, a]) => `${t} ${pct(a / w[t], 0)} 매도`).join(" → ") + " (VaR를 가장 많이 줄이는 순서)", cur);
      // ③ 다른 ETF 일부 편입 + 나머지 초과분은 SGOV: 같은 한도에서 시장 균형 기대수익이 가장 높게 남는 조합
      const mk = ctx.market, fr = mk.first_real || {};
      const cands = [...new Set([...mk.groups.candidates, ...mk.groups.runners])].filter(t => ctx.R[t] && !(t in w) && !isSafe(t) && t !== "SPY"
        && ((mk.proxy && mk.proxy[t]) || !fr[t] || (Date.parse(ctx.dates[ctx.n - 1]) - Date.parse(fr[t])) / 864e5 / 365.25 >= 5));
      const ERc = E.capmER(ctx, cands, set.erp), rf = ER._rf, safeOther = sumBy(w, t => isSafe(t) && t !== "SGOV");
      const erMix = (o, c) => Object.keys(o).reduce((s2, t) => s2 + o[t] * (t === c ? ERc[c] : t === CASH ? rf : (ER[t] !== undefined ? ER[t] : rf)), 0);
      const mixOf = (c, a, kk) => { const o = withRisky(kk, sleeve); o[c] = a; o.SGOV = 1 - safeOther - kk - a; return o; };
      // 1차: 지금 포트에서 위험자산 5%p를 후보로 옮길 때 VaR 감소 대비 기대수익 손실이 적은 후보만 추림
      const pre = [];
      for (const c of cands) {
        const f = E.fastVar(ctx, [...new Set([...base, ...Object.keys(sleeve), c])], { paths: 3000, h: set.h, c: set.c });
        if (f.years < 5) continue;
        const a = Math.min(0.05, k), x0 = withRisky(k, sleeve), x1 = mixOf(c, a, k - a), xs = withRisky(k - a, sleeve);
        const dvC = f(x0) - f(x1), dvS = f(x0) - f(xs); if (!(dvC > 0)) continue;
        pre.push({ c, f, score: (ERc[c] - rf) / Math.max(1e-6, 1 - dvC / dvS), dvC, dvS });
      }
      pre.sort((x, y) => y.score - x.score);
      const res = [];
      for (const { c } of pre.slice(0, 8)) {
        const f = E.fastVar(ctx, [...new Set([...base, ...Object.keys(sleeve), c])], HC);
        let best = null;
        for (const a of [0.1, 0.2, 0.3]) {
          if (a > 1 - safeOther) continue;
          const cap = Math.min(k, 1 - safeOther - a);
          if (f(mixOf(c, a, 0)) > vStar) continue;
          const kk = Math.max(0, bisect(x => f(mixOf(c, a, x)) > vStar, 0, cap, 16) - 1e-4);
          const o = mixOf(c, a, kk), er = erMix(o, c);
          if (!best || er > best.er) best = { c, a, kk, w1: o, er };
        }
        if (best) res.push(best);
      }
      res.sort((x, y) => y.er - x.er);
      const keepER = plans[0] ? plans[0].er1 : -1;
      for (const r of res.filter(r => r.er > keepER + 0.002).slice(0, set.nCand)) {
        finish("swap:" + r.c, `${r.c} ${pct(r.a, 0)} 새로 편입`, `${r.c}(${(mk.names && mk.names[r.c]) || ""}) ${pct(r.a, 0)} 편입, 위험자산 ${pct(k, 0)} → ${pct(r.kk, 0)} — ①보다 위험자산을 덜 줄여도 한도 안`, r.w1, { cand: r.c });
        plans[plans.length - 1].er1 = r.er;
      }
    }
    // 정수 주수로 만든 결과를 실제 VaR 로 다시 계산
    for (const p of plans) { const c = E.compareHoldings(ctx, H0, cash0, p.holdings, p.cash, { limAmt, erp: set.erp, h: set.h, c: set.c }); p.check = c.b; }
    out.plans = plans;
    return out;
  };

  // ───────────────────────── 리밸런싱 규칙 시뮬레이션 ─────────────────────────
  // rule = { mode: "none"|"calendar"|"band"|"both", freq: "M"|"Q"|"S"|"A", abs: 0.05, rel: 0.25 }
  //  calendar: 주기 말마다 무조건 목표로 / band: 허용범위를 벗어나는 날 즉시 / both: 주기 말에 확인해서 벗어났을 때만
  E.RULES = { none: "안 함 (바이앤홀드)", calendar: "정기", band: "허용범위 이탈 시", both: "정기 점검 + 허용범위" };
  E.FREQ = { M: "매월", Q: "분기", S: "반기", A: "매년" };
  E.bands = function (w, rule) { const o = {}; for (const t in w) o[t] = rule.rel > 0 ? Math.min(rule.abs, w[t] * rule.rel) : rule.abs; return o; };
  function periodEnd(d0, d1, freq) { // d0 날이 기간의 마지막 거래일인가 (다음 거래일 d1 과 비교)
    if (!d1) return false; const m0 = +d0.slice(5, 7), m1 = +d1.slice(5, 7); if (m0 === m1) return false;
    return freq === "M" || (freq === "Q" && m0 % 3 === 0) || (freq === "S" && m0 % 6 === 0) || (freq === "A" && m0 === 12);
  }
  E.simulate = function (ctx, w, rule, opt) {
    opt = Object.assign({ base: "KRW", days: 2520 }, opt || {});
    const { t, v } = wvec(w), { idx, cols } = panel(ctx, t, opt.base);
    const use = idx.slice(-opt.days), bd = E.bands(w, rule), sbd = rule.basis === "sleeve" ? E.bands(E.sleeveOf(w).sleeve || {}, rule) : null;
    let h = v.slice(), nav = 1, peak = 1, mdd = 0, nReb = 0, turn = 0;
    const r = new Float64Array(use.length);
    for (let k = 0; k < use.length; k++) {
      const i = use[k]; let tot = 0;
      for (let j = 0; j < t.length; j++) { h[j] *= 1 + cols[j][i]; tot += h[j]; }
      r[k] = tot / nav - 1; nav = tot; peak = Math.max(peak, nav); mdd = Math.min(mdd, nav / peak - 1);
      let out = false;
      if (rule.basis === "sleeve") { let hr = 0, vr = 0; for (let j = 0; j < t.length; j++) if (!isSafe(t[j])) { hr += h[j]; vr += v[j]; }
        for (let j = 0; j < t.length; j++) if (!isSafe(t[j]) && Math.abs(h[j] / hr - v[j] / vr) > sbd[t[j]] + 1e-12) { out = true; break; } }
      else for (let j = 0; j < t.length; j++) if (Math.abs(h[j] / tot - v[j]) > bd[t[j]] + 1e-12) { out = true; break; }
      const pe = periodEnd(ctx.dates[i], ctx.dates[use[k + 1]] || ctx.dates[i + 1], rule.freq);
      const go = rule.mode === "calendar" ? pe : rule.mode === "band" ? out : rule.mode === "both" ? (pe && out) : false;
      if (go) { let tv = 0; for (let j = 0; j < t.length; j++) { tv += Math.abs(h[j] / tot - v[j]); h[j] = tot * v[j]; } turn += tv / 2; nReb++; }
    }
    const yrs = use.length / 252, cagr = Math.pow(nav, 1 / yrs) - 1;
    const curW = {}; let tot = h.reduce((a, b) => a + b, 0); t.forEach((k, j) => { curW[k] = h[j] / tot; });
    return { cagr, vol: std(Array.from(r)) * Math.sqrt(252), mdd, nReb, rebPerYear: nReb / yrs, turnPerYear: turn / yrs, years: yrs, from: ctx.dates[use[0]], driftW: curW };
  };
  E.ruleCompare = function (ctx, w, rule) {
    const variants = [["none", "안 함 (바이앤홀드)", { mode: "none" }], ["cal", `정기 (${E.FREQ[rule.freq]})`, { mode: "calendar", freq: rule.freq }],
      ["band", `허용범위 ±${(rule.abs * 100).toFixed(0)}%p${rule.rel > 0 ? "/" + (rule.rel * 100).toFixed(0) + "%" : ""}`, { mode: "band", abs: rule.abs, rel: rule.rel, basis: rule.basis }],
      ["both", `정기 점검(${E.FREQ[rule.freq]}) + 허용범위`, { mode: "both", freq: rule.freq, abs: rule.abs, rel: rule.rel, basis: rule.basis }]];
    return variants.map(([k, l, r]) => Object.assign({ key: k, label: l, mine: r.mode === rule.mode }, E.simulate(ctx, w, Object.assign({ freq: "Q", abs: 0.05, rel: 0.25 }, r))));
  };
  E.calendarDue = function (ctx, rule) {
    if (rule.mode !== "calendar" && rule.mode !== "both") return null;
    const d = ctx.dates; let last = null;
    for (let i = d.length - 2; i >= 0; i--) if (periodEnd(d[i], d[i + 1], rule.freq)) { last = d[i]; break; }
    const days = last ? (Date.parse(d[d.length - 1]) - Date.parse(last)) / 864e5 : null;
    return { last, due: days !== null && days <= 7 };
  };

  // ───────────────────────── 알림 조건 (앱 홈 + 텔레그램 공용) ─────────────────────────
  E.alerts = function (ctx, w, nav, diag, set) {
    set = Object.assign({ limit: { amount: 2e7, warn: 0.8 }, dupTh: 0.9, ddWarn: [0.10, 0.20], moveTh: 0.03, targets: null, band: [0.05, 0.25] }, set || {});
    const mk = ctx.market, A = [];
    const add = (key, level, label, text, dist, short) => A.push({ key, level, label, text, dist, short: short || label });
    if (diag) {
      const u = diag.util;
      add("util:" + (u > 1 ? "over" : u > set.limit.warn ? "warn" : "ok"), u > 1 ? "critical" : u > set.limit.warn ? "warning" : "ok",
        "위험한도", `${E.limLabel(set.limit)} 사용률 ${pct(u, 0)} (한도 ${fmtW(diag.limAmt || set.limit.amount)})`, u > 1 ? "한도 초과 중" : `한도까지 ${pct(1 - u, 0)}p 여유`, `위험한도 ${pct(u, 0)}`);
      const la = diag.limAct;
      if (la) add(`lim:${la.kind}`, la.kind === "cut" ? "critical" : "info", la.kind === "cut" ? "한도 축소" : "다시 늘리기",
        la.kind === "cut" ? (la.reachable ? `위험자산 ${pct(la.k, 0)} → ${pct(la.kNew, 0)} (목표 비율대로 팔아 SGOV로)` : `SGOV로 옮겨도 VaR가 ${fmtW(la.vFloor)} 아래로 안 내려감 — 원화 현금 또는 다른 ETF 필요`) : `사용률 ${pct(u, 0)} — 위험자산 ${pct(la.k, 0)} → ${pct(la.kNew, 0)}까지 늘려도 한도 90% 안`,
        Object.entries(la.trades).filter(([, v]) => Math.abs(v) >= 1e4).map(([t, v]) => `${t} ${v > 0 ? "+" : "−"}${fmtW(Math.abs(v))}`).join(", "),
        la.kind === "cut" ? `한도 초과 → 위험자산 ${fmtW(la.amt)} SGOV로` : `위험자산 ${fmtW(la.amt)} 늘릴 여유`);
      const pr = E.basketSeries(ctx, w, "KRW"), today = pr[ctx.n - 1];
      if (Number.isFinite(today)) add("move:" + (today <= -set.moveTh ? ctx.dates[ctx.n - 1] : "ok"), today <= -set.moveTh ? "warning" : "ok",
        "하루 변동", `${mk.meta.provisional ? "오늘(장중)" : ctx.dates[ctx.n - 1]} 포트폴리오 ${pct(today, 1)}`, `급락 기준 ${pct(-set.moveTh, 0)}까지 ${pp(today + set.moveTh)}`, `하루 ${pct(today, 1)}`);
      const dd = E.drawdown(ctx, w, 756).now, band = dd <= -set.ddWarn[1] ? 2 : dd <= -set.ddWarn[0] ? 1 : 0;
      add("dd:" + band, band === 2 ? "critical" : band ? "warning" : "ok", "고점 대비 낙폭", `${pct(dd, 1)} (현재 비중, 3년 기준)`, band ? "경고 구간" : `경고(-${pct(set.ddWarn[0], 0)})까지 ${pp(dd + set.ddWarn[0])}`, `낙폭 ${pct(dd, 0)}`);
      for (const d of diag.D.slice(0, 3)) add(`dup:${d.a}-${d.b}:${d.flag ? 1 : 0}`, d.flag ? "warning" : "ok", "중복 노출",
        `${d.a}–${d.b} 6개월 상관 ${d.c126.toFixed(2)}`, d.flag ? `기준(${set.dupTh}) 초과` : `기준까지 ${(set.dupTh - d.c126).toFixed(2)}`, `중복 ${d.a}·${d.b} ${d.c126.toFixed(2)}`);
      const rule = set.rule || { mode: "band", abs: set.band[0], rel: set.band[1], freq: "Q" };
      if (set.targets && rule.mode !== "none") {
        const cal = E.calendarDue(ctx, rule);
        if (cal) add(`cal:${cal.due ? cal.last : "no"}`, cal.due ? "info" : "ok", "정기 리밸런싱", cal.due ? `${E.FREQ[rule.freq]} 점검 시기 (기준일 ${cal.last})` : `최근 기준일 ${cal.last || "–"}`, cal.due ? "이번 주 점검" : "다음 기간 말에 점검", "정기 리밸런싱 시기");
        const sl = rule.basis === "sleeve" ? E.sleeveOf(set.targets).sleeve : null, k = E.riskyShare(w);
        const TG = sl || set.targets, BD = E.bands(TG, rule), base = sl ? k * nav : nav, lab = sl ? " (위험자산 안)" : "";
        for (const t of Object.keys(TG)) {
          const tg = TG[t], cur = sl ? (k > 0 ? (w[t] || 0) / k : 0) : (w[t] || 0), bd = BD[t], dv = cur - tg;
          add(`band:${t}:${Math.abs(dv) > bd ? 1 : 0}`, Math.abs(dv) > bd ? "warning" : "ok", "리밸런싱",
            `${t} ${pct(cur, 1)}${lab} (목표 ${pct(tg, 0)} ±${pct(bd, 1)})`, Math.abs(dv) > bd ? `${dv > 0 ? "매도" : "매수"} ${fmtW(Math.abs(dv) * base)}` : `허용범위까지 ${pp(bd - Math.abs(dv))}`, `${t} ${dv > 0 ? "매도" : "매수"} ${fmtW(Math.abs(dv) * base)}`);
        }
      }
      for (const t of Object.keys(w)) {
        const r = mk.rs[t]; if (!r) continue;
        add(`rs:${t}:${r.state}`, r.state === "약세" ? "info" : "ok", "상대강도(참고)", `${t} ${r.state} (${r.since}~)`,
          `추세선 대비 ${pct(r.gap, 1)}${r.gap > 0 ? " 위" : " 아래"}`, `${t} ${r.state}(참고)`);
      }
    }
    return A;
  };

  // ───────────────────────── 암호화 (보유내역 동기화) ─────────────────────────
  const subtle = () => (root.crypto && root.crypto.subtle) || (typeof require !== "undefined" ? require("crypto").webcrypto.subtle : null);
  const b64 = { enc: u => (typeof btoa !== "undefined" ? btoa(String.fromCharCode(...u)) : Buffer.from(u).toString("base64")),
    dec: s => (typeof atob !== "undefined" ? Uint8Array.from(atob(s), c => c.charCodeAt(0)) : new Uint8Array(Buffer.from(s, "base64"))) };
  async function keyFrom(pw, salt) {
    const s = subtle(), base = await s.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
    return s.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const rnd = n => { const a = new Uint8Array(n); (root.crypto || require("crypto").webcrypto).getRandomValues(a); return a; };
  E.encrypt = async function (obj, pw) {
    const salt = rnd(16), iv = rnd(12), k = await keyFrom(pw, salt);
    const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(obj))));
    return { v: 1, salt: b64.enc(salt), iv: b64.enc(iv), ct: b64.enc(ct) };
  };
  E.decrypt = async function (box, pw) {
    const k = await keyFrom(pw, b64.dec(box.salt));
    const pt = await subtle().decrypt({ name: "AES-GCM", iv: b64.dec(box.iv) }, k, b64.dec(box.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  };

  // ───────────────────────── 표기 ─────────────────────────
  function pct(x, d) { return x === null || x === undefined || !Number.isFinite(x) ? "–" : (x * 100).toFixed(d === undefined ? 1 : d) + "%"; }
  function pp(x) { return !Number.isFinite(x) ? "–" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%p"; }
  function fmtW(x) { if (!Number.isFinite(x)) return "–"; const m = x / 1e4; return (Math.abs(m) >= 10000 ? (m / 1e4).toFixed(2) + "억" : Math.round(m).toLocaleString("ko-KR") + "만") + "원"; }
  E.fmt = { pct, pp, won: fmtW };

  if (typeof module !== "undefined" && module.exports) module.exports = E; else root.PRE = E;
})(typeof globalThis !== "undefined" ? globalThis : this);
