"""리밸런싱 신호.

세 가지 트리거 (국민연금 SAA 허용범위 방식을 개인 포트폴리오에 맞게 변형)
  1) 범위 이탈: |현재 - 목표| > min(절대밴드 5%p, 목표×25%)  — '5/25 규칙'
  2) 정기 점검: 분기말(또는 월말) 직후
  3) 위험한도: 1년 VaR 사용률 > 100% → 위험자산을 안전자산으로 옮겨 사용률을 목표(90%)로
"""
from __future__ import annotations

import datetime as dt

import pandas as pd


def band_check(w: pd.Series, tgt: pd.Series, nav: float, abs_band: float, rel_band: float) -> pd.DataFrame:
    idx = tgt.index.union(w.index)
    w = w.reindex(idx).fillna(0.0)
    tgt = tgt.reindex(idx).fillna(0.0)
    band = pd.concat([pd.Series(abs_band, idx), tgt * rel_band], axis=1).min(axis=1)
    band[tgt == 0] = abs_band
    dev = w - tgt
    df = pd.DataFrame({"current": w, "target": tgt, "dev": dev, "band": band,
                       "lower": (tgt - band).clip(lower=0), "upper": tgt + band})
    df["breach"] = dev.abs() > band
    df["trade_amt"] = -dev * nav          # 목표로 되돌리는 매매금액 (+매수 / -매도)
    df["util"] = (dev.abs() / band).where(band > 0, 0.0)  # 밴드 소진율
    return df


def calendar_due(today: dt.date, mode: str) -> dict:
    if mode == "none":
        return {"due": False}
    months = (3, 6, 9, 12) if mode == "quarterly" else tuple(range(1, 13))
    ends = pd.date_range(pd.Timestamp(today) - pd.Timedelta(days=400), pd.Timestamp(today) + pd.Timedelta(days=400), freq="ME")
    ends = [d.date() for d in ends if d.month in months]
    last_day = max(d for d in ends if d <= today)
    nxt = min(d for d in ends if d > today)
    days_since = (today - last_day).days
    return {"due": 0 <= days_since <= 7, "last": str(last_day), "next": str(nxt), "days_since": days_since}


def risk_scale_trades(w: pd.Series, nav: float, util: float, target_util: float, safe: str) -> dict | None:
    """위험자산 전체를 같은 비율 k로 줄이고 그 금액을 안전자산으로.
    안전자산의 위험이 ~0 이므로 VaR ≈ k × 현재 VaR → k = 목표사용률 / 현재사용률."""
    if util <= 1.0:
        return None
    k = target_util / util
    risky = w.drop(labels=[safe], errors="ignore")
    cut = risky * (1 - k)
    trades = (-cut * nav).to_dict()
    trades[safe] = float(cut.sum() * nav)
    neww = (risky * k).to_dict()
    neww[safe] = float(w.get(safe, 0.0) + cut.sum())
    return {"k": k, "trades": trades, "new_weights": neww, "shift_pct": float(cut.sum())}
