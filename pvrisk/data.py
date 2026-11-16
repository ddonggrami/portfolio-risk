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
YUA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}


def _yahoo(ticker: str, rng: str | None = None, start: str | None = None) -> pd.Series | None:
    """Yahoo chart API (배당·분할 반영 adjclose). 장중이면 마지막 봉은 현재가(잠정)."""
    params = {"interval": "1d", "events": "div,split", "includeAdjustedClose": "true"}
    if rng:
        params["range"] = rng
    else:
        params["period1"] = int(pd.Timestamp(start or "1990-01-01").timestamp())
        params["period2"] = int(time.time()) + 86400
    for attempt in range(4):
        host = ("query2", "query1")[attempt % 2]
        try:
            r = requests.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{ticker}",
                             params=params, headers=YUA, timeout=30)
            if r.status_code == 404:
                return None
            if r.status_code != 200:
                time.sleep(2 * (attempt + 1))
                continue
            res = r.json()["chart"]["result"][0]
            ts = res.get("timestamp")
            if not ts:
                return None
            gmt = res["meta"].get("gmtoffset", 0)
            idx = (pd.to_datetime(np.array(ts) + gmt, unit="s")).normalize()
            q = res["indicators"]
            close = np.array(q["quote"][0].get("close"), dtype=float)
            adj = np.array(q["adjclose"][0]["adjclose"], dtype=float) if q.get("adjclose") else close.copy()
            adj = np.where(np.isnan(adj), close, adj)
            s = pd.Series(adj, idx, name=ticker).dropna()
            return s[~s.index.duplicated(keep="last")].sort_index()
        except Exception as e:  # noqa: BLE001
            log.warning("Yahoo %s 실패 (%s)", ticker, e)
            time.sleep(2 * (attempt + 1))
    return None


def _merge_incremental(old: pd.Series, new: pd.Series) -> pd.Series | None:
    """캐시(old)에 최근치(new)를 이어붙임. 배당 등으로 수정주가가 재조정됐으면 None(전체 재수집 필요)."""
    ov = old.index.intersection(new.index)
    if len(ov) < 3:
        return None
    ov = ov[:-1]  # 마지막 날(잠정일 수 있음)은 비교에서 제외
    ratio = (new.loc[ov] / old.loc[ov]).dropna()
    if ratio.empty or (ratio - 1).abs().max() > 0.0005:
        return None
    return pd.concat([old[old.index < new.index[0]], new]).sort_index()


def fetch_prices(tickers: list[str], start: str) -> tuple[pd.DataFrame, dict]:
    """수정주가 DataFrame 과 소스 정보. Yahoo 우선, 실패 시 Tiingo(키 있을 때).
    캐시가 있으면 최근 1개월만 받아 이어붙임(수정주가가 재조정된 종목은 전체 재수집)."""
    token = os.environ.get("TIINGO_API_KEY", "").strip()
    cached = cache_load("prices")
    out, src = {}, {}
    for t in tickers:
        s = None
        old = cached[t].dropna() if isinstance(cached, pd.DataFrame) and t in cached else None
        if old is not None and len(old) > 250 and (pd.Timestamp.now() - old.index[-1]).days < 20:
            recent = _yahoo(t, rng="1mo")
            if recent is not None and len(recent):
                s = _merge_incremental(old, recent)
        if s is None:
            s = _yahoo(t, start=start)
        if s is not None and len(s) > 20:
            out[t], src[t] = s, "Yahoo"
        elif token:
            s = _tiingo(t, start, token)
            if s is not None and len(s) > 20:
                out[t], src[t] = s, "Tiingo"
        if t not in out:
            log.warning("가격 수집 실패: %s", t)
        time.sleep(0.3)
    if not out:
        raise RuntimeError("가격 데이터를 하나도 받지 못했습니다.")
    px = pd.DataFrame(out).sort_index()
    px = px[px.index >= pd.Timestamp(start)]
    cache_save("prices", px)
    return px, src


def last_bar_provisional(px: pd.DataFrame) -> bool:
    """마지막 봉이 아직 장 마감 전(미 동부 16:10 이전의 오늘)이면 True."""
    from zoneinfo import ZoneInfo
    now = pd.Timestamp.now(tz=ZoneInfo("America/New_York"))
    last = px.index[-1]
    return last.date() == now.date() and (now.hour, now.minute) < (16, 10)


def fetch_tbill() -> pd.Series:
    """3개월 T-bill 연수익률(소수). 일별."""
    s = _fred("DTB3")
    if s is not None and len(s) > 100:
        return (s / 100.0).rename("TBILL_YLD")
    irx = _yahoo("^IRX", start="2000-01-01")
    if irx is not None and len(irx) > 100:
        return (irx / 100.0).rename("TBILL_YLD")
    raise RuntimeError("T-bill 금리를 받지 못했습니다.")


def fetch_usdkrw() -> pd.Series:
    """원/달러 환율(1달러당 원). FRED 장기 히스토리 + Yahoo 최근일."""
    fred = _fred("DEXKOUS")
    yfs = _yahoo("KRW=X", start="2003-01-01")
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
