"""'달리는 말' 상대강도 신호 (S&P500 대비).

근거
- Jegadeesh & Titman (1993): 최근 1개월을 제외한 12개월(12-1) 수익률의 지속성
- Faber (2007/2013): 10개월 이동평균으로 추세 판정
- Antonacci (2014) 듀얼 모멘텀: 상대 모멘텀(vs S&P500) + 절대 모멘텀(vs T-bill)

상태 (매일 종가 기준)
  강세       : 상대강도선(RS)이 10개월 이동평균 위 + 3·6개월 상대수익 > 0
  약화 조짐  : RS가 아직 이동평균 위지만 1·3개월 상대수익 < 0
  약세       : RS가 이동평균 아래 + 6개월 상대수익 < 0
  회복 조짐  : RS가 아직 이동평균 아래지만 1·3개월 상대수익 > 0
  중립       : 그 외
"""
from __future__ import annotations

import numpy as np
import pandas as pd

M = 21  # 1개월 ≈ 21거래일
STATES = ["강세", "약화 조짐", "중립", "회복 조짐", "약세"]


def _ret(px: pd.Series, n: int) -> pd.Series:
    return px / px.shift(n) - 1


def state_frame(p: pd.Series, spy: pd.Series, sma_days: int = 210) -> pd.DataFrame:
    df = pd.concat([p.rename("p"), spy.rename("m")], axis=1).dropna()
    rs = df.p / df.m
    out = pd.DataFrame(index=df.index)
    out["rs"] = rs
    out["sma"] = rs.rolling(sma_days, min_periods=sma_days).mean()
    out["gap"] = rs / out["sma"] - 1
    for k in (1, 3, 6, 12):
        out[f"rel{k}"] = _ret(df.p, k * M) - _ret(df.m, k * M)
    out["rel12_1"] = (df.p.shift(M) / df.p.shift(12 * M) - 1) - (df.m.shift(M) / df.m.shift(12 * M) - 1)
    above = out["gap"] > 0
    st = np.full(len(out), "중립", dtype=object)
    st[(above & (out.rel3 > 0) & (out.rel6 > 0)).values] = "강세"
    st[(above & (out.rel1 < 0) & (out.rel3 < 0)).values] = "약화 조짐"
    st[(~above & (out.rel6 < 0)).values] = "약세"
    st[(~above & (out.rel1 > 0) & (out.rel3 > 0)).values] = "회복 조짐"
    st[out["sma"].isna().values] = "데이터 부족"
    out["state"] = st
    return out


def capture(p: pd.Series, spy: pd.Series, months: int) -> dict:
    m = pd.concat([p, spy], axis=1).dropna().resample("ME").last().pct_change().dropna().iloc[-months:]
    if len(m) < months * 0.8:
        return {}
    a, b = m.iloc[:, 0], m.iloc[:, 1]
    up, dn = b > 0, b < 0

    def geo(x):
        return float(np.prod(1 + x) ** (1 / len(x)) - 1) if len(x) else np.nan
    beta = float(np.cov(a, b)[0, 1] / np.var(b, ddof=1))
    return {"up": geo(a[up]) / geo(b[up]) if up.any() else None,
            "down": geo(a[dn]) / geo(b[dn]) if dn.any() else None,
            "beta": beta}


def backtest_flips(sf: pd.DataFrame, min_hold: int = 21) -> dict:
    """RS가 10개월 이동평균을 하향/상향 돌파한 날(직전 min_hold일 반대편 유지)의 성과.
    - lag   : 하향 돌파 직전 6개월 RS 고점 대비 이미 진행된 상대 하락폭 (신호가 얼마나 늦나)
    - after : 신호 후 3·6개월 상대수익
    """
    g = sf["gap"].dropna()
    rs = sf["rs"]
    side = np.sign(g.values)
    events = {"down": [], "up": []}
    last_flip = -10**9
    for i in range(min_hold, len(g)):
        if side[i] == 0 or side[i] == side[i - 1]:
            continue
        if not np.all(side[i - min_hold:i] == side[i - 1]):
            continue
        if i - last_flip < min_hold:
            continue
        last_flip = i
        d = g.index[i]
        k = "down" if side[i] < 0 else "up"
        pos = rs.index.get_loc(d)
        r0 = rs.iloc[pos]
        win = rs.iloc[max(0, pos - 126):pos + 1]
        lag = float(r0 / (win.max() if k == "down" else win.min()) - 1)
        aft = {}
        for mth in (3, 6):
            j = pos + mth * M
            aft[mth] = float(rs.iloc[j] / r0 - 1) if j < len(rs) else None
        events[k].append({"date": d.strftime("%Y-%m-%d"), "lag": lag, "after3": aft[3], "after6": aft[6]})

    def summ(ev, k):
        a6 = [e["after6"] for e in ev if e["after6"] is not None]
        a3 = [e["after3"] for e in ev if e["after3"] is not None]
        if not a6:
            return {"n": len(ev)}
        good = (np.array(a6) < 0) if k == "down" else (np.array(a6) > 0)
        return {"n": len(ev), "n_eval": len(a6), "hit6": float(good.mean()),
                "mean6": float(np.mean(a6)), "median6": float(np.median(a6)), "mean3": float(np.mean(a3)),
                "lag_median": float(np.median([e["lag"] for e in ev]))}
    yrs = max((g.index[-1] - g.index[0]).days / 365.25, 1)
    return {"down": summ(events["down"], "down"), "up": summ(events["up"], "up"),
            "flips_per_year": (len(events["down"]) + len(events["up"])) / yrs,
            "recent": (events["down"] + events["up"]) and sorted(events["down"] + events["up"], key=lambda e: e["date"])[-6:]}


def analyze(px: pd.DataFrame, runners: dict, sma_days: int, rf_ann: float) -> dict:
    spy = px["SPY"]
    out = {}
    for t, name in runners.items():
        if t not in px or px[t].notna().sum() < sma_days + 260:
            continue
        p = px[t].dropna()
        sf = state_frame(p, spy, sma_days)
        last = sf.iloc[-1]
        stt = sf["state"]
        chg = stt.ne(stt.shift()).cumsum()
        since = stt[chg == chg.iloc[-1]].index[0]
        prev = stt[chg == chg.iloc[-1] - 1]
        abs12 = float(p.iloc[-1] / p.iloc[-1 - 12 * M] - 1) if len(p) > 12 * M else None
        wk = sf.iloc[-756:].iloc[::5]
        out[t] = {
            "name": name, "state": last.state, "since": since.strftime("%Y-%m-%d"),
            "prev_state": prev.iloc[0] if len(prev) else None,
            "gap": float(last.gap),
            **{f"rel{k}": float(last[f"rel{k}"]) for k in (1, 3, 6, 12)},
            "rel12_1": float(last.rel12_1),
            "abs12": abs12, "abs_mom": (abs12 is not None and abs12 > rf_ann),
            "cap3y": capture(p, spy, 36), "cap5y": capture(p, spy, 60),
            "bt": backtest_flips(sf),
            "first": p.index[0].strftime("%Y-%m-%d"),
            "chart": {"d": [d.strftime("%Y-%m-%d") for d in wk.index],
                      "rs": (wk.rs / wk.rs.iloc[0] * 100).round(2).tolist(),
                      "sma": (wk.sma / wk.rs.iloc[0] * 100).round(2).tolist()},
            "hist_state": [[d.strftime("%Y-%m-%d"), s] for d, s in stt.iloc[-504:].iloc[::5].items()],
        }
    # 전체 신호 백테스트 집계
    agg = {"down": [], "up": []}
    for v in out.values():
        for k in ("down", "up"):
            b = v["bt"][k]
            if b.get("n_eval"):
                agg[k].append(b)
    summary = {}
    for k, lst in agg.items():
        n = sum(b["n_eval"] for b in lst)
        if n:
            summary[k] = {"n": n,
                          "hit6": sum(b["hit6"] * b["n_eval"] for b in lst) / n,
                          "mean6": sum(b["mean6"] * b["n_eval"] for b in lst) / n,
                          "lag_median": float(np.median([b["lag_median"] for b in lst]))}
    return {"runners": out, "bt_summary": summary, "validation": validate(px, list(out.keys()), sma_days)}


def validate(px: pd.DataFrame, tickers: list[str], sma_days: int) -> dict:
    """월말 표본: 각 지표와 이후 3·6개월 S&P500 대비 상대수익의 순위상관(전 종목 통합)."""
    from scipy.stats import spearmanr
    spy = px["SPY"]
    rows = []
    for t in tickers:
        p = px[t].dropna()
        sf = state_frame(p, spy, sma_days)
        d = pd.concat([p, spy], axis=1).dropna()
        for k, n in ((3, 63), (6, 126)):
            sf[f"f{k}"] = (d.iloc[:, 0].shift(-n) / d.iloc[:, 0] - 1) - (d.iloc[:, 1].shift(-n) / d.iloc[:, 1] - 1)
        me = sf.groupby(sf.index.to_period("M")).tail(1).dropna(subset=["sma", "f6"])
        rows.append(me)
    if not rows:
        return {}
    A = pd.concat(rows)
    res = {"n": int(len(A)), "start": A.index.min().strftime("%Y-%m"), "ic": {}}
    for c in ("rel1", "rel3", "rel6", "rel12_1", "gap"):
        b = A.dropna(subset=[c])
        res["ic"][c] = {"f3": float(spearmanr(b[c], b.f3).correlation), "f6": float(spearmanr(b[c], b.f6).correlation)}
    res["by_state"] = {st: {"n": int((A.state == st).sum()), "f6": float(A[A.state == st].f6.mean()),
                            "beat": float((A[A.state == st].f6 > 0).mean())}
                       for st in STATES if (A.state == st).any()}
    return res
