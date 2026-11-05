"""성과지표 (Portfolio Visualizer 관행과 맞춤).

- 월간 수익률 기준 (GIPS: 36개월 월간 수익률로 3년 연환산 표준편차)
- 포트폴리오는 현재 비중 · 매월 리밸런싱 가정의 백테스트
- 무위험수익률: 분석기간 '각 월'의 3개월 T-bill 수익률 → 월 초과수익의 평균/표준편차 (Sharpe 1994 정의)
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.optimize import minimize

from .correlation import lw_cov


def monthly(rets: pd.DataFrame) -> pd.DataFrame:
    return (1 + rets).groupby(rets.index.to_period("M")).prod() - 1


def backtest_monthly_rebal(mret: pd.DataFrame, w: pd.Series) -> pd.Series:
    sub = mret[w.index].dropna()
    return (sub * w.values).sum(axis=1).rename("PORT")


def stats(m: pd.Series, rf_m: pd.Series, bench_m: pd.Series | None, daily: pd.Series | None = None) -> dict:
    m = m.dropna()
    if len(m) < 6:
        return {}
    rf = rf_m.reindex(m.index).fillna(0.0)
    ex = m - rf
    n = len(m)
    growth = float(np.prod(1 + m))
    cagr = growth ** (12 / n) - 1
    vol = float(m.std(ddof=1) * np.sqrt(12))
    ex_mean = float(ex.mean() * 12)
    ex_sd = float(ex.std(ddof=1) * np.sqrt(12))
    sharpe = ex_mean / ex_sd if ex_sd > 1e-4 else np.nan
    dn = ex.clip(upper=0)
    dd_dev = float(np.sqrt((dn**2).mean()) * np.sqrt(12))
    sortino = ex_mean / dd_dev if dd_dev > 1e-4 else np.nan
    if daily is not None:
        v = (1 + daily.loc[str(m.index[0].start_time.date()):].fillna(0)).cumprod()
    else:
        v = (1 + m).cumprod()
    mdd = float((v / v.cummax() - 1).min())
    out = {"cagr": cagr, "mean_ann": float(m.mean() * 12), "vol": vol, "sharpe": sharpe, "sortino": sortino, "mdd": mdd,
           "rf": float((np.prod(1 + rf)) ** (12 / n) - 1), "months": n,
           "best_m": float(m.max()), "worst_m": float(m.min()),
           "pos_m": float((m > 0).mean())}
    if bench_m is not None:
        b = bench_m.reindex(m.index)
        ok = b.notna()
        if ok.sum() > 6:
            bx = b[ok] - rf[ok]
            cov = np.cov(ex[ok], bx)
            beta = cov[0, 1] / cov[1, 1]
            out["beta"] = float(beta)
            out["alpha"] = float((ex[ok].mean() - beta * bx.mean()) * 12)
            out["corr_b"] = float(np.corrcoef(m[ok], b[ok])[0, 1])
            te = (m[ok] - b[ok]).std(ddof=1) * np.sqrt(12)
            out["info_ratio"] = float(((m[ok] - b[ok]).mean() * 12) / te) if te > 0 else np.nan
    return out


def window(m: pd.Series | pd.DataFrame, years: int):
    return m.iloc[-12 * years:]


def frontier(mret: pd.DataFrame, assets: list[str], rf_ann: float, years: int = 5, points: int = 40) -> dict:
    """보유종목 간 효율적 투자선 (롱온리, 합=1). 공분산: Ledoit-Wolf 축소추정.
    기대수익은 과거평균이라 매우 불안정 — 참고용."""
    sub = mret[assets].iloc[-12 * years:].dropna()
    if len(sub) < 24:
        return {}
    mu = sub.mean().values * 12
    S, shrink = lw_cov(sub.values)
    S = S * 12
    n = len(assets)
    cons_sum = {"type": "eq", "fun": lambda x: x.sum() - 1}
    bnds = [(0, 1)] * n
    x0 = np.ones(n) / n

    def vol(x):
        return float(np.sqrt(x @ S @ x))
    mv = minimize(vol, x0, bounds=bnds, constraints=[cons_sum], method="SLSQP")
    r_lo, r_hi = float(mv.x @ mu), float(mu.max())
    pts = []
    for tr in np.linspace(r_lo, r_hi, points):
        res = minimize(vol, mv.x, bounds=bnds, method="SLSQP",
                       constraints=[cons_sum, {"type": "eq", "fun": lambda x, tr=tr: x @ mu - tr}])
        if res.success:
            pts.append({"vol": vol(res.x), "ret": float(res.x @ mu), "w": dict(zip(assets, np.round(res.x, 4)))})
    # 최대 샤프
    neg_sh = lambda x: -((x @ mu - rf_ann) / vol(x))  # noqa: E731
    ms = minimize(neg_sh, x0, bounds=bnds, constraints=[cons_sum], method="SLSQP")
    return {"points": pts,
            "min_var": {"vol": vol(mv.x), "ret": float(mv.x @ mu), "w": dict(zip(assets, np.round(mv.x, 4)))},
            "max_sharpe": {"vol": vol(ms.x), "ret": float(ms.x @ mu), "w": dict(zip(assets, np.round(ms.x, 4)))},
            "shrinkage": shrink, "years": years}
