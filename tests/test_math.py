"""핵심 계산 검증: 이론값을 알고 있는 데이터로 결과가 맞는지 확인."""
import datetime as dt

import numpy as np
import pandas as pd
from scipy.stats import norm

from pvrisk import data as D, performance as P, rebalance as RB, risk as R


def _iid(n=4000, sd=0.01, seed=0, cols=("A",)):
    rng = np.random.default_rng(seed)
    idx = pd.bdate_range("2010-01-01", periods=n)
    return pd.DataFrame(rng.normal(0, sd, (n, len(cols))), idx, list(cols))


def test_hs_var_matches_normal_quantile():
    x = np.random.default_rng(1).normal(0, 0.01, 200_000)
    v, e = R.hs_var_es(x, 0.99)
    assert abs(v - norm.ppf(0.99) * 0.01) < 2e-4
    assert abs(e - 0.01 * norm.pdf(norm.ppf(0.99)) / 0.01) < 3e-4


def test_one_day_ewma_sigma():
    r = _iid(3000, 0.01)
    r["TBILL"] = 0.0
    w = pd.Series({"A": 1.0})
    od = R.one_day(r, w, 1e8, 250, 0.94)
    assert abs(od["ewma_sigma_d"] - 0.01) < 0.002


def test_annual_bootstrap_close_to_lognormal():
    r = _iid(252 * 12, 0.01, seed=3)
    rf = pd.Series(0.0, r.index)
    w = pd.Series({"A": 1.0})
    a = R.annual(r, w, 1.0, rf, {"boot_years": 12, "boot_block": 21, "boot_paths": 20000, "ewma_lambda": 0.94})
    sig = 0.01 * np.sqrt(252)
    # 산술평균 0 → 로그수익 평균 ≈ -σ²/2
    theo = 1 - np.exp(-norm.ppf(0.95) * sig - 0.5 * sig**2)
    got = a["methods"]["bootstrap"]["0.95"]["pct"]
    assert abs(got - theo) < 0.02, (got, theo)


def test_backtest_exceptions_near_expected():
    r = _iid(1500, 0.01, seed=5)
    w = pd.Series({"A": 1.0})
    bt = R.backtest_1d(r, w, 250, 1000, 0.99)
    assert 3 <= bt["exc_hs"] <= 22  # 기대 10회


def test_risk_contrib_sums_to_one():
    r = _iid(1000, 0.01, cols=("A", "B", "C"))
    r["B"] = 0.5 * r["A"] + r["B"]
    w = pd.Series({"A": 0.5, "B": 0.3, "C": 0.2})
    rc = R.risk_contrib(r, w, 0.94)
    assert abs(rc["contrib_pct"].sum() - 1) < 1e-9


def test_fx_conversion():
    idx = pd.bdate_range("2020-01-01", periods=3)
    r = pd.DataFrame({"A": [0.0, 0.10, 0.0]}, idx)
    fx = pd.Series([1000, 1100, 1100], idx)
    b = R.to_base(r, fx)
    assert abs(b["A"].iloc[1] - (1.1 * 1.1 - 1)) < 1e-12


def test_tbill_accrual():
    idx = pd.bdate_range("2024-01-01", "2024-12-31")
    y = pd.Series(0.05, idx)
    rf = D.tbill_daily_return(y, idx)
    tot = np.prod(1 + rf) - 1
    assert 0.049 < tot < 0.053


def test_sharpe_definition():
    idx = pd.period_range("2020-01", periods=36, freq="M")
    rng = np.random.default_rng(2)
    rf = pd.Series(0.003, idx)
    m = rf + 0.01 + pd.Series(rng.normal(0, 0.03, 36), idx)
    s = P.stats(m, rf, None)
    ex = m - rf
    assert abs(s["sharpe"] - ex.mean() * 12 / (ex.std() * np.sqrt(12))) < 1e-12


def test_band_5_25():
    w = pd.Series({"A": 0.36, "B": 0.03, "C": 0.61})
    t = pd.Series({"A": 0.30, "B": 0.05, "C": 0.65})
    b = RB.band_check(w, t, 1e8, 0.05, 0.25)
    assert b.loc["A", "band"] == 0.05 and b.loc["A", "breach"]          # 6%p > 5%p
    assert abs(b.loc["B", "band"] - 0.0125) < 1e-12 and b.loc["B", "breach"]  # 2%p > 1.25%p
    assert not b.loc["C", "breach"]
    assert abs(b.loc["A", "trade_amt"] + 0.06e8) < 1


def test_calendar():
    c = RB.calendar_due(dt.date(2026, 10, 3), "quarterly")
    assert c["due"] and c["last"] == "2026-09-30" and c["next"] == "2026-12-31"
    assert not RB.calendar_due(dt.date(2026, 11, 5), "quarterly")["due"]


def test_risk_scale():
    w = pd.Series({"X": 0.8, "SGOV": 0.2})
    rs = RB.risk_scale_trades(w, 1e8, 1.5, 0.9, "SGOV")
    assert abs(rs["k"] - 0.6) < 1e-12
    assert abs(rs["new_weights"]["X"] - 0.48) < 1e-12
    assert abs(sum(rs["trades"].values())) < 1e-6


def test_tiingo_parse(monkeypatch):
    class R:
        status_code = 200
        def raise_for_status(self): pass
        def json(self):
            return [{"date": f"2024-01-{d:02d}T00:00:00.000Z", "adjClose": 100 + d, "close": 1} for d in range(2, 30)]
    monkeypatch.setattr(D.requests, "get", lambda *a, **k: R())
    s = D._tiingo("BRK-B", "2024-01-01", "x")
    assert s.index.tz is None and len(s) == 28 and s.iloc[0] == 102


def test_fred_parse(monkeypatch):
    class R:
        text = "observation_date,DTB3\n2024-01-02,5.25\n2024-01-03,.\n2024-01-04,5.20\n"
        def raise_for_status(self): pass
    monkeypatch.setattr(D.requests, "get", lambda *a, **k: R())
    s = D._fred("DTB3")
    assert list(s.values) == [5.25, 5.20]


def test_splice_proxy():
    idx = pd.bdate_range("2020-01-01", periods=10)
    px = pd.DataFrame({"SPY": np.linspace(100, 110, 10), "MTUM": np.linspace(50, 60, 10),
                       "SPMO": [np.nan] * 5 + list(np.linspace(20, 21, 5))}, idx)
    rf = pd.Series(0.0001, idx)
    r, sp = D.build_returns(px, rf)
    assert r["SPMO"].iloc[:4].equals(r["MTUM"].iloc[:4])
    assert sp["SPMO"][0] == "MTUM"


def test_lw_cov_preserves_variances():
    from pvrisk.correlation import lw_cov
    rng = np.random.default_rng(0)
    x = np.column_stack([rng.normal(0, 0.0001, 500), rng.normal(0, 0.03, 500)])
    S, _ = lw_cov(x)
    assert np.allclose(np.sqrt(np.diag(S)), x.std(axis=0, ddof=1))


def test_rs_states():
    from pvrisk import rs as RS
    idx = pd.bdate_range("2015-01-01", periods=800)
    spy = pd.Series(np.linspace(100, 150, 800), idx)
    up = spy * np.linspace(1, 1.5, 800)            # 꾸준히 S&P500보다 강함
    sf = RS.state_frame(up, spy, 210)
    assert sf["state"].iloc[-1] == "강세"
    down = spy * np.linspace(1.5, 1, 800)
    assert RS.state_frame(down, spy, 210)["state"].iloc[-1] == "약세"


def test_margin_features_no_lookahead():
    from pvrisk import margin as MG
    idx = pd.bdate_range("2010-01-01", periods=252 * 6)
    rng = np.random.default_rng(1)
    p = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.01, len(idx)))), idx)
    spy = pd.Series(100 * np.exp(np.cumsum(rng.normal(0, 0.01, len(idx)))), idx)
    f = MG._features(p, spy)
    assert f["fwd12"].iloc[-12:].isna().all()     # 마지막 12개월은 미래수익 없음
