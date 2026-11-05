"""상관계수 분석 (달러 수익률 기준 — 환율이 자산 간 관계를 오염시키지 않도록).

- 상관·추천 계산에만 1%/99% 윈저라이징 적용
- Pearson 과 Spearman(순위) 병행
- 단기(63일) vs 장기(252일) 상관의 괴리 = 레짐 변화 신호
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def winsorize(df: pd.DataFrame, p: float) -> pd.DataFrame:
    if p <= 0:
        return df
    lo = df.quantile(p)
    hi = df.quantile(1 - p)
    return df.clip(lower=lo, upper=hi, axis=1)


def matrix(rets: pd.DataFrame, cols: list[str], window: int, method: str = "pearson", wins: float = 0.01) -> pd.DataFrame:
    sub = rets[cols].iloc[-window:].dropna(how="any")
    sub = winsorize(sub, wins)
    return sub.corr(method=method)


def rolling_pair(rets: pd.DataFrame, a: str, b: str, windows: list[int], wins: float, last_days: int = 252 * 6) -> pd.DataFrame:
    sub = rets[[a, b]].dropna()
    # 윈저라이징 임계값은 전체 표본에서 한 번만 정함(미래정보 누출 최소화를 위해 확장창 대신 단순화)
    sub = winsorize(sub, wins)
    out = {}
    for wdw in windows:
        out[f"w{wdw}"] = sub[a].rolling(wdw).corr(sub[b])
    df = pd.DataFrame(out).iloc[-last_days:]
    return df


def regime_signal(df: pd.DataFrame, short="w63", long="w252", gap=0.30) -> dict:
    s, l = df[short].dropna(), df[long].dropna()
    if s.empty or l.empty:
        return {"flag": False}
    cs, cl = float(s.iloc[-1]), float(l.iloc[-1])
    # 1년 전 대비 장기 상관 변화
    l_1y = float(l.iloc[-252]) if len(l) > 252 else np.nan
    flag = abs(cs - cl) >= gap
    sign_flip = (np.sign(cs) != np.sign(cl)) and abs(cs) > 0.1 and abs(cl) > 0.1
    # 단기 상관의 3년 분포 내 백분위
    hist = df[short].dropna().iloc[-756:]
    pct = float((hist < cs).mean()) if len(hist) else np.nan
    structural = bool(np.isfinite(l_1y) and abs(cl - l_1y) >= gap)
    return {
        "flag": bool(flag or sign_flip or structural), "structural": structural,
        "short": cs, "long": cl, "gap": cs - cl,
        "long_1y_ago": l_1y, "sign_flip": bool(sign_flip), "pct_3y": pct,
        "direction": "약해지는 중" if cs < cl else "강해지는 중",
    }


def port_vs_assets(rets: pd.DataFrame, port: pd.Series, assets: list[str], windows: list[int], wins: float) -> pd.DataFrame:
    rows = {}
    for a in assets:
        if a not in rets:
            continue
        df = pd.concat([port.rename("P"), rets[a]], axis=1).dropna()
        df = winsorize(df, wins)
        rows[a] = {f"w{w}": (df["P"].iloc[-w:].corr(df[a].iloc[-w:]) if len(df) >= w else np.nan) for w in windows}
    return pd.DataFrame(rows).T


def lw_cov(x: np.ndarray) -> tuple[np.ndarray, float]:
    """Ledoit-Wolf 축소를 '상관행렬'에 적용한 뒤 각 자산 표준편차로 되돌린 공분산.
    (공분산에 바로 적용하면 축소 목표가 '평균 분산 × 단위행렬'이라 SGOV 같은
    저변동 자산의 분산이 크게 부풀려지는 왜곡이 생김)"""
    from sklearn.covariance import LedoitWolf
    sd = x.std(axis=0, ddof=1)
    sd = np.where(sd > 0, sd, 1e-12)
    lw = LedoitWolf().fit((x - x.mean(axis=0)) / sd)
    c = lw.covariance_
    d = np.sqrt(np.diag(c))
    c = c / np.outer(d, d)
    return c * np.outer(sd, sd), float(lw.shrinkage_)
