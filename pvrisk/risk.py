"""VaR / ES / 위험기여 / 스트레스 / 드로다운.

원칙
- '현재 보유비중을 과거 시장에 그대로 적용'하는 가상 손익(hypothetical P&L) 방식.
- VaR 계산에는 아웃라이어를 제거하지 않음 (꼬리 손실이 곧 측정 대상).
- 1년 VaR 는 기대 초과수익 0 가정(위험자산의 과거 고수익을 미래에 그대로 가정하지 않음).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import norm


# ─────────────────────────── 기본 도구 ───────────────────────────
def to_base(rets_usd: pd.DataFrame, fx: pd.Series | None) -> pd.DataFrame:
    """달러 수익률 → 원화 수익률: (1+r)(1+fx)-1. TBILL도 달러 자산이므로 환율 적용."""
    if fx is None:
        return rets_usd
    fxr = fx.reindex(rets_usd.index.union(fx.index)).ffill().reindex(rets_usd.index).pct_change(fill_method=None).fillna(0.0)
    return rets_usd.mul(1 + fxr, axis=0).add(fxr, axis=0)


def port_returns(rets: pd.DataFrame, w: pd.Series) -> pd.Series:
    """일별 리밸런싱 가정의 포트폴리오 수익률 (현재 비중 고정)."""
    cols = w.index
    sub = rets[cols].dropna()
    return (sub * w.values).sum(axis=1).rename("PORT")


def ewma_cov(rets: pd.DataFrame, lam: float = 0.94, min_obs: int = 252) -> pd.DataFrame:
    x = rets.dropna().values
    x = x[-max(min_obs * 4, 1000):]
    n = len(x)
    wts = (1 - lam) * lam ** np.arange(n - 1, -1, -1)
    wts /= wts.sum()
    xc = x  # RiskMetrics: 평균 0 가정
    cov = (xc * wts[:, None]).T @ xc
    return pd.DataFrame(cov, index=rets.columns, columns=rets.columns)


def ewma_vol_series(r: pd.Series, lam: float = 0.94) -> pd.Series:
    r = r.dropna()
    v = np.empty(len(r))
    s2 = float(r.iloc[:60].var())
    for i, x in enumerate(r.values):
        v[i] = np.sqrt(s2)
        s2 = lam * s2 + (1 - lam) * x * x
    return pd.Series(v, r.index)


def hs_var_es(r: np.ndarray, c: float) -> tuple[float, float]:
    """역사적 시뮬레이션. 손실을 양수로 반환."""
    q = np.quantile(r, 1 - c, method="linear")
    tail = r[r <= q]
    return float(-q), float(-tail.mean()) if len(tail) else float(-q)


def normal_var_es(sigma: float, c: float, mu: float = 0.0) -> tuple[float, float]:
    z = norm.ppf(c)
    return float(z * sigma - mu), float(sigma * norm.pdf(z) / (1 - c) - mu)


# ─────────────────────────── 1일 VaR ───────────────────────────
def one_day(rets_b: pd.DataFrame, w: pd.Series, nav: float, window: int, lam: float) -> dict:
    pr = port_returns(rets_b, w)
    last = pr.iloc[-window:].values
    out = {}
    for c in (0.95, 0.99):
        hv, he = hs_var_es(last, c)
        out[f"hs_{int(c*100)}"] = {"pct": hv, "amt": hv * nav, "es_pct": he, "es_amt": he * nav}
    cov = ewma_cov(rets_b[w.index], lam)
    sig = float(np.sqrt(w.values @ cov.values @ w.values))
    for c in (0.95, 0.99):
        v, e = normal_var_es(sig, c)
        out[f"ewma_{int(c*100)}"] = {"pct": v, "amt": v * nav, "es_pct": e, "es_amt": e * nav}
    he, hee = hs_var_es(last, 0.975)
    out["es_975_hs"] = {"pct": hee, "amt": hee * nav}
    out["ewma_sigma_d"] = sig
    out["ewma_sigma_ann"] = sig * np.sqrt(252)
    return out


def backtest_1d(rets_b: pd.DataFrame, w: pd.Series, window: int = 250, test: int = 250, c: float = 0.99, lam: float = 0.94) -> dict:
    """최근 test 일 동안, 매일 그 전날까지 window 일로 계산한 VaR와 실제 손익 비교."""
    pr = port_returns(rets_b, w)
    vals = pr.values
    idx = pr.index
    n = len(vals)
    hs, ew, real, dates = [], [], [], []
    ev = ewma_vol_series(pr, lam).values
    z = norm.ppf(c)
    for t in range(max(window, n - test), n):
        hs.append(-np.quantile(vals[t - window:t], 1 - c))
        ew.append(z * ev[t])
        real.append(vals[t])
        dates.append(idx[t])
    hs, ew, real = map(np.array, (hs, ew, real))
    exc_hs = int((real < -hs).sum())
    exc_ew = int((real < -ew).sum())

    def zone(k):  # Basel 신호등 (250일, 99%)
        return "green" if k <= 4 else ("yellow" if k <= 9 else "red")
    return {
        "dates": [d.strftime("%Y-%m-%d") for d in dates],
        "hs": hs.tolist(), "ewma": ew.tolist(), "real": real.tolist(),
        "exc_hs": exc_hs, "exc_ewma": exc_ew, "zone_hs": zone(exc_hs), "zone_ewma": zone(exc_ew),
        "expected": round(len(real) * (1 - c), 1),
    }


# ─────────────────────────── 1년 VaR ───────────────────────────
def _demean_to_rf(pr: pd.Series, rf: pd.Series) -> np.ndarray:
    """초과수익의 표본평균을 제거해 '기대 초과수익 0'으로 만든 일간 수익률."""
    rf = rf.reindex(pr.index).fillna(0.0)
    ex = pr - rf
    return (ex - ex.mean() + rf.mean()).values


def annual(rets_b: pd.DataFrame, w: pd.Series, nav: float, rf_b: pd.Series, cfg_p: dict,
           horizon: int = 252, seed: int = 42) -> dict:
    pr_full = port_returns(rets_b, w)
    yrs = cfg_p.get("boot_years", 10)
    pr = pr_full.iloc[-int(252 * yrs):]
    x = _demean_to_rf(pr, rf_b)
    rng = np.random.default_rng(seed)
    B = int(cfg_p.get("boot_block", 21))
    P = int(cfg_p.get("boot_paths", 10000))
    nb = int(np.ceil(horizon / B))
    starts = rng.integers(0, len(x) - B, size=(P, nb))
    blocks = starts[..., None] + np.arange(B)
    paths = np.log1p(x[blocks].reshape(P, -1)[:, :horizon]).sum(axis=1)
    boot = np.expm1(paths)
    # 경로 중 최대낙폭도 계산 (보조지표)
    res = {"horizon": horizon, "methods": {}}
    for c in (0.95, 0.99):
        bv, be = hs_var_es(boot, c)
        res["methods"].setdefault("bootstrap", {})[str(c)] = {"pct": bv, "amt": bv * nav, "es_pct": be, "es_amt": be * nav}
    # 실제 과거 1년(겹치는 롤링) 수익률 분포 — 전체 히스토리
    xf = _demean_to_rf(pr_full, rf_b)
    lr = np.log1p(xf)
    cs = np.concatenate([[0], np.cumsum(lr)])
    roll = np.expm1(cs[horizon:] - cs[:-horizon])
    for c in (0.95, 0.99):
        hv, he = hs_var_es(roll, c)
        res["methods"].setdefault("historical", {})[str(c)] = {"pct": hv, "amt": hv * nav, "es_pct": he, "es_amt": he * nav}
    # 현재 EWMA 변동성이 1년간 지속된다는 가정 (스트레스 성격)
    cov = ewma_cov(rets_b[w.index], cfg_p.get("ewma_lambda", 0.94))
    sig = float(np.sqrt(w.values @ cov.values @ w.values)) * np.sqrt(horizon)
    for c in (0.95, 0.99):
        z = norm.ppf(c)
        # 로그정규 근사: 손실률 = 1 - exp(-z σ - σ²/2)
        v = 1 - np.exp(-z * sig - 0.5 * sig**2)
        e = 1 - np.exp(-sig * norm.pdf(z) / (1 - c) - 0.5 * sig**2)
        res["methods"].setdefault("ewma_scaled", {})[str(c)] = {"pct": float(v), "amt": float(v) * nav, "es_pct": float(e), "es_amt": float(e) * nav}
    res["hist_years"] = round(len(pr_full) / 252, 1)
    res["boot_years"] = round(len(pr) / 252, 1)
    res["dist"] = np.percentile(boot, np.linspace(0.5, 99.5, 120)).tolist()
    res["sigma_ann_hist"] = float(pr.std() * np.sqrt(252))
    return res


def annual_var_history(rets_b: pd.DataFrame, w: pd.Series, nav: float, rf_b: pd.Series, cfg_p: dict,
                       c: float, months: int = 24) -> pd.DataFrame:
    """지난 months 개월 각 월말 시점에서 계산했을 1년 VaR (현재 비중 기준)."""
    ends = rets_b.index.to_series().groupby(rets_b.index.to_period("M")).last().iloc[-months:]
    rows = []
    p2 = dict(cfg_p, boot_paths=2000)
    for d in ends:
        sub = rets_b.loc[:d]
        a = annual(sub, w, nav, rf_b.loc[:d], p2, seed=1)
        rows.append({"date": d, "bootstrap": a["methods"]["bootstrap"][str(c)]["amt"],
                     "ewma_scaled": a["methods"]["ewma_scaled"][str(c)]["amt"]})
    return pd.DataFrame(rows).set_index("date")


# ─────────────────────────── 위험 기여 ───────────────────────────
def risk_contrib(rets_b: pd.DataFrame, w: pd.Series, lam: float) -> pd.DataFrame:
    cov = ewma_cov(rets_b[w.index], lam)
    sig = float(np.sqrt(w.values @ cov.values @ w.values))
    mcr = cov.values @ w.values / sig
    cr = w.values * mcr
    stand = np.sqrt(np.diag(cov.values)) * np.sqrt(252)
    return pd.DataFrame({
        "weight": w.values,
        "vol_ann": stand,
        "contrib_pct": cr / sig,
        "marginal_ann": mcr * np.sqrt(252),
    }, index=w.index)


# ─────────────────────────── 스트레스 ───────────────────────────
SCENARIOS = [
    ("글로벌 금융위기", "2007-10-09", "2009-03-09"),
    ("2011 미 신용등급 강등", "2011-07-22", "2011-10-03"),
    ("2018 4분기 급락", "2018-09-20", "2018-12-24"),
    ("코로나 폭락", "2020-02-19", "2020-03-23"),
    ("2022 금리 인상기", "2022-01-03", "2022-10-12"),
    ("2025 관세 쇼크", "2025-02-19", "2025-04-08"),
]


def stress(rets_b: pd.DataFrame, rets_usd: pd.DataFrame, w: pd.Series, nav: float) -> list[dict]:
    out = []
    for name, a, b in SCENARIOS:
        sub_b = rets_b.loc[a:b, w.index]
        if len(sub_b) < 5 or sub_b.isna().any().any():
            out.append({"name": name, "start": a, "end": b, "ret": None})
            continue
        pb = float(np.prod(1 + (sub_b * w.values).sum(axis=1)) - 1)
        pu = float(np.prod(1 + (rets_usd.loc[a:b, w.index] * w.values).sum(axis=1)) - 1)
        spy = float(np.prod(1 + rets_usd.loc[a:b, "SPY"]) - 1) if "SPY" in rets_usd else None
        out.append({"name": name, "start": a, "end": b, "ret": pb, "ret_usd": pu, "amt": pb * nav, "spy": spy})
    return out


# ─────────────────────────── 드로다운 ───────────────────────────
def drawdown(r: pd.Series) -> pd.Series:
    v = (1 + r.fillna(0)).cumprod()
    return v / v.cummax() - 1
