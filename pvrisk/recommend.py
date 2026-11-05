"""분산투자 후보 추천.

방법: 위험자산 비중 중 5%를 후보 ETF로 바꿨을 때(기존 위험자산에서 비례 차감)
  - 포트폴리오 연 변동성 변화 (Ledoit-Wolf 축소 공분산, 최근 252일, 윈저라이징)
  - 포트폴리오와의 상관 (126일 / 252일), 그리고 그 변화 방향
을 계산해 변동성 감소폭 순으로 정렬. 기대수익은 예측하지 않습니다(위험 측면만).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from .correlation import lw_cov, winsorize

EQUITY = {"IGV", "XLV", "XLU", "XLP", "XLE", "XLF", "XLI", "ITA", "USMV", "QUAL", "VLUE", "SCHD", "RSP",
          "IWM", "EFA", "EWJ", "INDA", "EEM", "VNQ", "PAVE", "URA", "XLK", "XLY", "XLC", "XLB", "MTUM", "QQQ"}


def rank(rets_usd: pd.DataFrame, w: pd.Series, candidates: dict, safe: str, wins: float,
         swap: float = 0.05, window: int = 252) -> pd.DataFrame:
    held = list(w.index)
    rows = []
    port = (rets_usd[held].dropna() * w.values).sum(axis=1)
    risky = w.drop(labels=[safe], errors="ignore")
    if risky.sum() <= 0:
        return pd.DataFrame()
    # 기준선: 같은 5%를 안전자산(현금성)으로 옮겼을 때의 변동성 변화
    cash_dvol = None
    if safe in held:
        sub = winsorize(rets_usd[held].dropna().iloc[-window:], wins)
        S = lw_cov(sub.values)[0] * 252
        w0 = w.values.copy()
        w1 = w0.copy()
        rm = np.array([h != safe for h in held])
        w1[rm] -= swap * w0[rm] / w0[rm].sum()
        w1[held.index(safe)] += swap
        cash_dvol = float(np.sqrt(w1 @ S @ w1) - np.sqrt(w0 @ S @ w0))
    for c, label in candidates.items():
        if c in held or c not in rets_usd:
            continue
        cols = held + [c]
        sub = rets_usd[cols].dropna().iloc[-window:]
        if len(sub) < 200:
            continue
        sub = winsorize(sub, wins)
        S = lw_cov(sub.values)[0] * 252
        w0 = np.append(w.values, 0.0)
        w1 = w0.copy()
        rmask = np.array([h != safe for h in held] + [False])
        w1[rmask] -= swap * w0[rmask] / w0[rmask].sum()
        w1[-1] = swap
        v0 = float(np.sqrt(w0 @ S @ w0))
        v1 = float(np.sqrt(w1 @ S @ w1))
        pc = pd.concat([port.rename("P"), rets_usd[c]], axis=1).dropna()
        pc = winsorize(pc, wins)
        c63 = pc["P"].iloc[-63:].corr(pc[c].iloc[-63:])
        c126 = pc["P"].iloc[-126:].corr(pc[c].iloc[-126:])
        c252 = pc["P"].iloc[-252:].corr(pc[c].iloc[-252:])
        semi = None
        if "SOXX" in rets_usd:
            sc = rets_usd[["SOXX", c]].dropna().iloc[-126:]
            semi = float(sc["SOXX"].corr(sc[c]))
        own_vol = float(rets_usd[c].iloc[-252:].std() * np.sqrt(252))
        r1y = float(np.prod(1 + rets_usd[c].iloc[-252:].fillna(0)) - 1)
        rows.append({"ticker": c, "label": label, "corr63": c63, "corr126": c126, "corr252": c252,
                     "corr_trend": c63 - c252, "corr_soxx126": semi, "vol": own_vol, "ret_1y": r1y,
                     "port_vol_before": v0, "port_vol_after": v1, "dvol": v1 - v0,
                     "vs_cash": (v1 - v0 - cash_dvol) if cash_dvol is not None else None,
                     "cls": "equity" if c in EQUITY else "diversifier",
                     "obs": len(rets_usd[c].dropna())})
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    return df.sort_values("dvol").reset_index(drop=True)
