"""시세 데이터 수집.

우선순위
  가격  : Tiingo(수정주가 adjClose, 무료키) → yfinance(비공식) 순서로 시도
  T-bill: FRED DTB3(3개월 T-bill, 키 불필요) → yfinance ^IRX
  환율  : FRED DEXKOUS(원/달러, 며칠 지연) + yfinance KRW=X 로 최근일 보충

모든 가격은 분할·배당이 반영된 수정주가(총수익) 기준입니다.
"""
from __future__ import annotations

import io
import json
import logging
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from .config import PROXIES

log = logging.getLogger(__name__)
CACHE = Path(os.environ.get("PVRISK_CACHE", Path(__file__).resolve().parent.parent / ".cache"))
UA = {"User-Agent": "pvrisk/1.0 (personal portfolio dashboard)"}


# ─────────────────────────── 개별 소스 ───────────────────────────
def _tiingo(ticker: str, start: str, token: str) -> pd.Series | None:
    url = f"https://api.tiingo.com/tiingo/daily/{ticker.lower()}/prices"
    for attempt in range(3):
        try:
            r = requests.get(url, params={"startDate": start, "token": token}, headers=UA, timeout=30)
            if r.status_code == 404:
                return None
            if r.status_code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            js = r.json()
            if not js:
                return None
            df = pd.DataFrame(js)
            s = pd.Series(df["adjClose"].astype(float).values,
                          index=pd.to_datetime(df["date"], utc=True).dt.tz_convert(None).dt.normalize(), name=ticker)
            return s[~s.index.duplicated()].sort_index()
        except Exception as e:  # noqa: BLE001
            log.warning("Tiingo %s 실패 (%s)", ticker, e)
            time.sleep(2)
    return None


def _yfinance(tickers: list[str], start: str) -> pd.DataFrame:
    try:
        import yfinance as yf
    except ImportError:
        return pd.DataFrame()
    try:
        df = yf.download(tickers, start=start, auto_adjust=True, progress=False, threads=True)
    except Exception as e:  # noqa: BLE001
        log.warning("yfinance 실패 (%s)", e)
        return pd.DataFrame()
    if df.empty:
        return df
    px = df["Close"] if isinstance(df.columns, pd.MultiIndex) else df[["Close"]].rename(columns={"Close": tickers[0]})
    ix = pd.to_datetime(px.index)
    px.index = (ix.tz_convert(None) if ix.tz is not None else ix).normalize()
    return px


def _fred(series_id: str) -> pd.Series | None:
    url = "https://fred.stlouisfed.org/graph/fredgraph.csv"
    try:
        r = requests.get(url, params={"id": series_id}, headers=UA, timeout=30)
        r.raise_for_status()
        df = pd.read_csv(io.StringIO(r.text))
        df.columns = ["date", "value"]
        s = pd.to_numeric(df["value"], errors="coerce")
        s.index = pd.to_datetime(df["date"])
        return s.dropna().rename(series_id)
    except Exception as e:  # noqa: BLE001
        log.warning("FRED %s 실패 (%s)", series_id, e)
        return None


# ─────────────────────────── 공개 함수 ───────────────────────────
def fetch_prices(tickers: list[str], start: str) -> tuple[pd.DataFrame, dict]:
    """수정주가 DataFrame 과 소스 정보(dict ticker→source)."""
    token = os.environ.get("TIINGO_API_KEY", "").strip()
    out, src = {}, {}
    if token:
        for t in tickers:
            s = _tiingo(t, start, token)
            if s is not None and len(s) > 20:
                out[t], src[t] = s, "Tiingo"
            time.sleep(0.15)
    missing = [t for t in tickers if t not in out]
    if missing:
        yf_df = _yfinance(missing, start)
        for t in missing:
            if t in yf_df.columns and yf_df[t].notna().sum() > 20:
                out[t], src[t] = yf_df[t].dropna(), "Yahoo"
    if not out:
        raise RuntimeError("가격 데이터를 하나도 받지 못했습니다. TIINGO_API_KEY 를 확인하세요.")
    px = pd.DataFrame(out).sort_index()
    return px, src


def fetch_tbill() -> pd.Series:
    """3개월 T-bill 연수익률(소수). 일별."""
    s = _fred("DTB3")
    if s is not None and len(s) > 100:
        return (s / 100.0).rename("TBILL_YLD")
    df = _yfinance(["^IRX"], "2000-01-01")
    if not df.empty:
        return (df.iloc[:, 0].dropna() / 100.0).rename("TBILL_YLD")
    raise RuntimeError("T-bill 금리를 받지 못했습니다.")


def fetch_usdkrw() -> pd.Series:
    """원/달러 환율(1달러당 원). FRED 장기 히스토리 + Yahoo 최근일."""
    fred = _fred("DEXKOUS")
    yfd = _yfinance(["KRW=X"], "2003-01-01")
    yfs = yfd.iloc[:, 0].dropna() if not yfd.empty else None
    if fred is None and yfs is None:
        raise RuntimeError("원/달러 환율을 받지 못했습니다.")
    if fred is None:
        return yfs.rename("USDKRW")
    if yfs is None:
        return fred.rename("USDKRW")
    # Yahoo 값은 가끔 튀는 오류값이 있어 FRED와 3% 이상 다른 날은 FRED 우선
    both = pd.concat([fred.rename("f"), yfs.rename("y")], axis=1)
    bad = (both["y"] / both["f"] - 1).abs() > 0.03
    both.loc[bad, "y"] = np.nan
    s = both["f"].combine_first(both["y"])
    return s.dropna().rename("USDKRW")


# ─────────────────────────── 가공 ───────────────────────────
def tbill_daily_return(yld: pd.Series, index: pd.DatetimeIndex) -> pd.Series:
    """연 T-bill 금리를 거래일 수익률로 변환 (직전 거래일 대비 경과 일수 × 금리/360)."""
    y = yld.reindex(index.union(yld.index)).ffill().reindex(index)
    days = pd.Series(index, index=index).diff().dt.days.fillna(1).clip(upper=5)
    return (y * days / 360.0).fillna(0.0).rename("TBILL")


def build_returns(px: pd.DataFrame, rf_daily: pd.Series) -> tuple[pd.DataFrame, dict]:
    """일간 수익률 + 상장 이전 구간 대용치 이어붙이기.
    반환: (수익률, {ticker: 대용치가 시작되는 마지막 날짜})"""
    rets = px.pct_change(fill_method=None)
    rets = rets.iloc[1:]
    rets["TBILL"] = rf_daily.reindex(rets.index).fillna(0.0)
    spliced = {}

    def chain(t):
        seen = []
        while t in PROXIES and t not in seen:
            seen.append(t)
            t = PROXIES[t]
            yield t

    for t in list(px.columns):
        first = px[t].first_valid_index()
        if first is None:
            continue
        for p in chain(t):
            if p not in rets.columns:
                continue
            gap = rets.index < first
            fill = rets.loc[gap, t].isna() & rets.loc[gap, p].notna()
            if fill.any():
                rets.loc[fill[fill].index, t] = rets.loc[fill[fill].index, p]
                spliced[t] = (p, str(first.date()))
            first = rets[t].first_valid_index()
    # 극단적 데이터 오류(하루 ±80% 이상)는 결측 처리 — 실제 시장 이벤트는 건드리지 않음
    rets = rets.mask(rets.abs() > 0.8)
    return rets, spliced


def cache_save(name: str, obj) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    if isinstance(obj, (pd.DataFrame, pd.Series)):
        obj.to_pickle(CACHE / f"{name}.pkl")
    else:
        (CACHE / f"{name}.json").write_text(json.dumps(obj))


def cache_load(name: str):
    p = CACHE / f"{name}.pkl"
    if p.exists():
        return pd.read_pickle(p)
    p = CACHE / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text())
    return None
