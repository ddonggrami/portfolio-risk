"""마진(손익비) 지표.

질문: "지금처럼 (고점 대비 많이 빠졌거나 / 많이 올랐거나) 한 상태에서 샀을 때, 과거에는 다음 12개월이 어땠나?"

방법 (경험적 조건부 분포, k-최근접 이웃)
- 상태 변수: 52주 고점 대비 낙폭, 3년 S&P500 대비 초과수익 (각 종목 자기 역사로 표준화)
- 과거 월말 중 지금과 상태가 가장 비슷한 k개 시점을 골라, 그 이후 12개월 수익 분포를 봄
- 전체 기간(무조건) 분포와 비교 → 중앙값 차이가 '마진 변화'
- 표본 중복을 감안해 '서로 다른 해의 수'를 유효 표본으로 함께 표시
- 자기 상장 후 데이터만 사용 (대용치 미사용), 최소 10년

검증: 각 시점에서 '그때까지 알 수 있던 데이터'로만 계산한 마진 신호가
실제 이후 12개월 수익과 얼마나 맞았는지(순위상관)를 함께 계산합니다.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import spearmanr


def _features(p: pd.Series, spy: pd.Series) -> pd.DataFrame:
    d = pd.concat([p.rename("p"), spy.rename("m")], axis=1).dropna()
    hi52 = d.p.rolling(252, min_periods=200).max()
    lo5, hi5 = d.p.rolling(1260, min_periods=1000).min(), d.p.rolling(1260, min_periods=1000).max()
    me = d.index.to_series().groupby(d.index.to_period("M")).last()
    f = pd.DataFrame(index=me.values)
    f["p"] = d.p.loc[me.values].values
    f["m"] = d.m.loc[me.values].values
    f["dd52"] = (d.p / hi52 - 1).loc[me.values].values
    f["pos5y"] = ((d.p - lo5) / (hi5 - lo5)).loc[me.values].values
    f["rel36"] = (f.p / f.p.shift(36) - 1) - (f.m / f.m.shift(36) - 1)
    f["fwd12"] = f.p.shift(-12) / f.p - 1
    return f


def _knn(train: pd.DataFrame, x: np.ndarray, sd: np.ndarray, k: int) -> pd.DataFrame:
    z = (train[["dd52", "rel36"]].values - x) / sd
    dist = np.sqrt((z ** 2).sum(axis=1))
    return train.iloc[np.argsort(dist)[:k]]


def _k(n: int) -> int:
    return int(min(36, max(12, round(0.15 * n))))


def one(p: pd.Series, spy: pd.Series, gap_th: float) -> dict | None:
    f = _features(p, spy)
    f = f.dropna(subset=["dd52", "rel36"])
    if len(f) < 84:
        return None
    train = f.dropna(subset=["fwd12"])
    if len(train) < 60:
        return None
    sd = train[["dd52", "rel36"]].std().values
    sd = np.where(sd > 1e-9, sd, 1.0)
    cur = f.iloc[-1]
    nb = _knn(train, cur[["dd52", "rel36"]].values.astype(float), sd, _k(len(train)))
    fw, al = nb.fwd12, train.fwd12
    up, dn = fw[fw > 0], fw[fw <= 0]
    gap = float(fw.median() - al.median())
    rsd = train.rel36.std()
    rel_z = float((cur.rel36 - train.rel36.mean()) / rsd) if rsd > 1e-9 else 0.0
    flag = None
    if cur.pos5y > 0.9 and rel_z > 1.5:
        flag = "과열"
    elif cur.pos5y < 0.2 and rel_z < -1.5:
        flag = "침체"
    signal = "마진 개선" if gap > gap_th else ("마진 악화" if gap < -gap_th else "보통")
    return {
        "dd52": float(cur.dd52), "pos5y": None if pd.isna(cur.pos5y) else float(cur.pos5y),
        "rel36": float(cur.rel36), "rel36_z": rel_z, "flag": flag, "signal": signal,
        "cond": {"p10": float(fw.quantile(.1)), "p50": float(fw.median()), "p90": float(fw.quantile(.9)),
                 "mean": float(fw.mean()), "p_up": float((fw > 0).mean()),
                 "avg_up": float(up.mean()) if len(up) else None, "avg_dn": float(dn.mean()) if len(dn) else None,
                 "n": int(len(fw)), "n_years": int(pd.Index(nb.index).year.nunique())},
        "uncond": {"p10": float(al.quantile(.1)), "p50": float(al.median()), "p90": float(al.quantile(.9)),
                   "p_up": float((al > 0).mean()), "n": int(len(al))},
        "gap": gap,
        "payoff": (float(up.mean() * len(up)) / float(-dn.mean() * len(dn))) if len(up) and len(dn) and dn.mean() < 0 else None,
        "years": f"{f.index[0].year}–{train.index[-1].year}",
    }


def validate(px: pd.DataFrame, tickers: list[str], min_train: int = 60) -> dict:
    """확장창 표본외 검증: 시점 t의 신호는 t-12개월까지 결과가 확정된 표본만 사용."""
    gaps, fwds, rels = [], [], []
    spy = px["SPY"]
    for t in tickers:
        if t not in px or px[t].notna().sum() < 252 * 10:
            continue
        f = _features(px[t].dropna(), spy).dropna(subset=["dd52", "rel36"])
        for i in range(len(f)):
            row = f.iloc[i]
            if pd.isna(row.fwd12):
                continue
            train = f.iloc[: max(0, i - 11)].dropna(subset=["fwd12"])
            if len(train) < min_train:
                continue
            sd = train[["dd52", "rel36"]].std().values
            sd = np.where(sd > 1e-9, sd, 1.0)
            nb = _knn(train, row[["dd52", "rel36"]].values.astype(float), sd, _k(len(train)))
            gaps.append(nb.fwd12.median() - train.fwd12.median())
            fwds.append(row.fwd12 - train.fwd12.median())
            rels.append(row.fwd12)
    if len(gaps) < 100:
        return {}
    g, fw = np.array(gaps), np.array(fwds)
    ic = spearmanr(g, fw).correlation
    hi, lo = g > 0.05, g < -0.05
    return {"n": int(len(g)), "ic": float(ic),
            "fwd_when_improve": float(np.mean(np.array(rels)[hi])) if hi.any() else None,
            "fwd_when_worse": float(np.mean(np.array(rels)[lo])) if lo.any() else None,
            "fwd_all": float(np.mean(rels)), "n_improve": int(hi.sum()), "n_worse": int(lo.sum())}


def analyze(px: pd.DataFrame, tickers: list[str], gap_th: float) -> dict:
    out = {}
    for t in tickers:
        if t not in px:
            continue
        s = px[t].dropna()
        if len(s) < 252 * 10:
            out[t] = {"insufficient": True, "first": s.index[0].strftime("%Y-%m-%d") if len(s) else None,
                      "dd52": float(s.iloc[-1] / s.iloc[-252:].max() - 1) if len(s) > 252 else None}
            continue
        r = one(s, px["SPY"], gap_th)
        if r:
            out[t] = r
    return out
