"""시장 데이터 수집 → 앱이 읽는 market.json / returns.json 생성.

포트폴리오(보유내역)와 무관한 계산만 여기서 합니다.
보유내역 관련 계산(VaR, 진단, 추천, 투자선)은 app/engine.js 가 브라우저(및 알림용 Node)에서 수행합니다.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

from . import data as D
from . import margin as MG
from . import rs as RS
from .config import PROXIES, all_tickers
from .pipeline import clean

log = logging.getLogger(__name__)

STRESS = [
    ("글로벌 금융위기", "2007-10-09", "2009-03-09", "신용·유동성"),
    ("2011 미 신용등급 강등", "2011-07-22", "2011-10-03", "신용"),
    ("2018 4분기 급락", "2018-09-20", "2018-12-24", "긴축"),
    ("코로나 폭락", "2020-02-19", "2020-03-23", "경기침체·유동성"),
    ("2022 금리 인상기", "2022-01-03", "2022-10-12", "인플레이션·금리"),
    ("2025 관세 쇼크", "2025-02-19", "2025-04-08", "정책"),
]


def build(cfg: dict, demo: bool = False) -> tuple[dict, dict]:
    start = str(cfg["params"]["history_start"])
    if demo:
        from . import synthetic
        px, tb, fx = synthetic.make()
        src = {t: "DEMO" for t in px.columns}
        provisional = False
    else:
        px, src = D.fetch_prices(all_tickers(cfg), start)
        tb = D.fetch_tbill()
        fx = D.fetch_usdkrw()
        provisional = D.last_bar_provisional(px)
    px = px.loc[start:]
    px = px[px["SPY"].notna()]
    rf_d = D.tbill_daily_return(tb, px.index)
    rets, spliced = D.build_returns(px, rf_d)

    sig = cfg.get("signals", {})
    rf_ann = float(tb.dropna().iloc[-1])
    rs = RS.analyze(px, cfg.get("runners", {}), int(sig.get("rs_sma_days", 210)), rf_ann)

    names = {}
    for grp in ("runners", "candidates"):
        for t, n in (cfg.get(grp) or {}).items():
            names.setdefault(t, n)
    universe = [t for t in px.columns]
    mg = MG.analyze(px, universe, float(sig.get("margin_gap", 0.05)))
    mval = MG.validate(px, [t for t in universe if t != "SPY"])

    # 시장 국면 요약
    spy = px["SPY"]
    spy_m = spy.resample("ME").last()
    regime = {
        "spy_above_10m": bool(spy.iloc[-1] > spy_m.iloc[-11:-1].mean()) if len(spy_m) > 11 else None,
        "spy_dd": float(spy.iloc[-1] / spy.max() - 1),
        "spy_ret3m": float(spy.iloc[-1] / spy.iloc[-64] - 1),
    }
    # 시장 전체 할인 구간: S&P500 고점 대비 낙폭 구간별 이후 12개월 수익 (1993~, SPY 자체 역사)
    spy_all = spy.dropna()
    ddall = spy_all / spy_all.cummax() - 1
    f12 = spy_all.shift(-252) / spy_all - 1
    me = ddall.groupby(ddall.index.to_period("M")).tail(1).index
    buckets = [(0, -0.05, "0~-5%"), (-0.05, -0.10, "-5~-10%"), (-0.10, -0.20, "-10~-20%"), (-0.20, -1, "-20% 이하")]
    rows = []
    for hi, lo, lab in buckets:
        msk = (ddall.loc[me] <= hi) & (ddall.loc[me] > lo) & f12.loc[me].notna()
        x = f12.loc[me][msk]
        if len(x):
            rows.append({"bucket": lab, "n": int(len(x)), "years": int(x.index.year.nunique()),
                         "p10": float(x.quantile(.1)), "p50": float(x.median()), "p90": float(x.quantile(.9)),
                         "p_up": float((x > 0).mean())})
    regime["spy_dd_table"] = rows
    if "TLT" in rets:
        regime["stock_bond_corr63"] = float(rets["SPY"].iloc[-63:].corr(rets["TLT"].iloc[-63:]))
        regime["stock_bond_corr252"] = float(rets["SPY"].iloc[-252:].corr(rets["TLT"].iloc[-252:]))

    first_real = {t: px[t].first_valid_index().strftime("%Y-%m-%d") for t in px.columns if px[t].first_valid_index() is not None}
    last_px = {t: float(px[t].dropna().iloc[-1]) for t in px.columns if px[t].notna().any()}
    last_dt = {t: px[t].dropna().index[-1].strftime("%Y-%m-%d") for t in px.columns if px[t].notna().any()}

    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
    market = {
        "meta": {"generated": now.strftime("%Y-%m-%d %H:%M"), "generated_iso": now.isoformat(),
                 "price_date": px.index[-1].strftime("%Y-%m-%d"), "provisional": provisional,
                 "demo": demo, "sources": src, "rf_now": rf_ann, "fx_now": float(fx.dropna().iloc[-1]),
                 "n_tickers": len(px.columns), "failed": [t for t in all_tickers(cfg) if t not in px.columns]},
        "names": names, "groups": {"runners": list((cfg.get("runners") or {}).keys()),
                                   "candidates": list(cfg["candidates"].keys())},
        "first_real": first_real, "proxy": {k: v[0] for k, v in spliced.items()},
        "last_px": last_px, "last_dt": last_dt,
        "rs": rs["runners"], "rs_bt": rs["bt_summary"], "rs_val": rs["validation"],
        "margin": mg, "margin_val": mval,
        "regime": regime,
        "stress": [{"name": n, "start": a, "end": b, "type": ty} for n, a, b, ty in STRESS],
        "defaults": {"frontier": cfg.get("frontier_default"), "erp": cfg.get("frontier_erp", 0.045),
                     "signals": sig, "rebalance": cfg["rebalance"], "risk_limit": cfg["risk_limit"],
                     "ewma_lambda": cfg["params"]["ewma_lambda"], "boot_block": cfg["params"]["boot_block"]},
    }

    # 일간 수익률 (bp×100 → 정수 1 = 0.01%) — 대용치로 이은 구간 포함
    r = rets.drop(columns=["TBILL"])
    enc = {}
    for t in r.columns:
        v = r[t].values
        enc[t] = [None if not np.isfinite(x) else int(round(x * 1e4)) for x in v]
    fxa = fx.reindex(r.index.union(fx.index)).ffill().reindex(r.index)
    returns = {"dates": [d.strftime("%Y-%m-%d") for d in r.index], "unit": 1e-4, "r": enc,
               "rf": [int(round(x * 1e7)) for x in rets["TBILL"].values], "rf_unit": 1e-7,
               "fx": [None if not np.isfinite(x) else round(float(x), 2) for x in fxa.values]}
    return clean(market), returns


def write(out_dir: Path, market: dict, returns: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "market.json").write_text(json.dumps(market, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out_dir / "returns.json").write_text(json.dumps(returns, separators=(",", ":")), encoding="utf-8")
