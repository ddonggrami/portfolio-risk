"""전체 계산 파이프라인 → JSON 직렬화 가능한 결과 dict."""
from __future__ import annotations

import datetime as dt
import logging

import numpy as np
import pandas as pd
from scipy.stats import norm

from . import correlation as C
from . import data as D
from . import performance as P
from . import rebalance as RB
from . import recommend as RC
from . import risk as R
from .config import all_tickers

log = logging.getLogger(__name__)


def _f(x):
    if x is None:
        return None
    if isinstance(x, (np.floating, float)):
        return None if not np.isfinite(x) else float(x)
    if isinstance(x, (np.integer,)):
        return int(x)
    return x


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, pd.Timestamp):
        return o.strftime("%Y-%m-%d")
    if isinstance(o, (dt.date,)):
        return o.isoformat()
    return _f(o)


def load_market(cfg: dict, demo: bool = False):
    start = str(cfg["params"]["history_start"])
    if demo:
        from . import synthetic
        px, tb, fx = synthetic.make()
        want = [t for t in all_tickers(cfg) if t in px.columns]
        px = px[want]
        src = {t: "DEMO(합성)" for t in want}
    else:
        px, src = D.fetch_prices(all_tickers(cfg), start)
        tb = D.fetch_tbill()
        fx = D.fetch_usdkrw() if cfg["base_currency"] == "KRW" else None
    px = px.loc[start:]
    # 미국 거래일만 남김 (보유종목 + SPY 모두 가격이 있는 날)
    if "SPY" in px:
        px = px[px["SPY"].notna()]
    # 마지막 날 일부 종목만 업데이트된 경우(소스 간 시차) 모든 보유종목이 있는 날까지만 사용
    held = [t for t in cfg["holdings"] if t in px]
    complete = px[held].notna().all(axis=1)
    if complete.any():
        px = px.loc[:complete[complete].index[-1]]
    return px, src, tb, fx


def portfolio_state(cfg, px: pd.DataFrame, fx: pd.Series | None) -> dict:
    hold = cfg["holdings"]
    last = px.index[-1]
    fx_now = float(fx.reindex(px.index.union(fx.index)).ffill().loc[last]) if fx is not None else 1.0
    p_now = px[list(hold)].ffill().iloc[-1]
    missing = [t for t in hold if pd.isna(p_now.get(t))]
    if missing:
        raise RuntimeError(f"가격이 없는 보유종목: {missing}")
    if cfg.get("holdings_mode", "weights") == "weights":
        as_of = pd.Timestamp(cfg["as_of"])
        base = px.loc[:as_of].ffill().iloc[-1] if (px.index <= as_of).any() else px.iloc[0]
        base_date = px.loc[:as_of].index[-1] if (px.index <= as_of).any() else px.index[0]
        fx_base = float(fx.reindex(px.index.union(fx.index)).ffill().loc[base_date]) if fx is not None else 1.0
        nav0 = float(cfg["nav"])
        shares = {t: float(wt) * nav0 / (float(base[t]) * fx_base) for t, wt in hold.items()}
        cash = 0.0
    else:
        shares = {t: float(s) for t, s in hold.items()}
        cash = float(cfg.get("cash", 0.0))
        base_date, nav0 = None, None
    values = {t: shares[t] * float(p_now[t]) * fx_now for t in hold}
    nav = sum(values.values()) + cash
    w = pd.Series({t: v / nav for t, v in values.items()})
    return {"shares": shares, "values": values, "nav": nav, "cash": cash, "w": w,
            "price_date": last.strftime("%Y-%m-%d"), "fx": fx_now,
            "base_date": base_date.strftime("%Y-%m-%d") if base_date is not None else None,
            "nav0": nav0, "prices": {t: float(p_now[t]) for t in hold}}


def run(cfg: dict, demo: bool = False) -> dict:
    p = cfg["params"]
    px, src, tb, fx = load_market(cfg, demo)
    rf_d = D.tbill_daily_return(tb, px.index)
    rets_usd, spliced = D.build_returns(px, rf_d)
    rets_b = R.to_base(rets_usd, fx) if fx is not None else rets_usd
    st = portfolio_state(cfg, px, fx)
    w, nav = st["w"], st["nav"]
    held = list(w.index)
    lim = cfg["risk_limit"]
    conf = float(lim["confidence"])
    safe = cfg["rebalance"]["safe_asset"]

    # ── 위험 ───────────────────────────────────────────────
    od = R.one_day(rets_b, w, nav, p["var_window"], p["ewma_lambda"])
    bt = R.backtest_1d(rets_b, w, p["var_window"], 250, 0.99, p["ewma_lambda"])
    an = R.annual(rets_b, w, nav, rets_usd["TBILL"], p, horizon=int(lim["horizon_days"]))
    head_method = cfg["risk_limit"].get("method", "bootstrap")
    head = an["methods"][head_method][str(conf)]
    util = head["amt"] / float(lim["amount"])
    hist = R.annual_var_history(rets_b, w, nav, rets_usd["TBILL"], p, conf, months=24)
    rc = R.risk_contrib(rets_b, w, p["ewma_lambda"])
    sc = R.stress(rets_b, rets_usd, w, nav)
    pr_b = R.port_returns(rets_b, w)
    dd = R.drawdown(pr_b.iloc[-252 * 5:])
    ev = R.ewma_vol_series(pr_b, p["ewma_lambda"]).iloc[-504:]
    var1d_hist = (ev * norm.ppf(0.99) * nav)

    # 실제 보유 이후 성과 (weights 모드: as_of 이후)
    since = None
    if st["base_date"]:
        sub = pr_b.loc[st["base_date"]:].iloc[1:]
        if len(sub):
            v = (1 + sub).cumprod()
            since = {"ret": float(v.iloc[-1] - 1), "pnl": float(st["nav"] - st["nav0"]),
                     "mdd": float((v / v.cummax() - 1).min()), "days": len(sub)}

    # ── 상관 ───────────────────────────────────────────────
    wins = p["winsor_pct"]
    mat_cols = held + [t for t in ["SPY", "TLT", "IGV"] if t in rets_usd and t not in held]
    corr = {
        "cols": mat_cols,
        "p126": C.matrix(rets_usd, mat_cols, 126, "pearson", wins).values.tolist(),
        "s126": C.matrix(rets_usd, mat_cols, 126, "spearman", wins).values.tolist(),
        "p252": C.matrix(rets_usd, mat_cols, 252, "pearson", wins).values.tolist(),
        "p756": C.matrix(rets_usd, mat_cols, 756, "pearson", wins).values.tolist(),
    }
    pairs = []
    for a, b in cfg["watch_pairs"]:
        if a in rets_usd and b in rets_usd:
            rp = C.rolling_pair(rets_usd, a, b, p["corr_windows"], wins)
            sig = C.regime_signal(rp, gap=p["corr_regime_gap"])
            pairs.append({"a": a, "b": b, "dates": [d.strftime("%Y-%m-%d") for d in rp.index],
                          "series": {k: rp[k].round(4).tolist() for k in rp.columns}, "signal": sig})
    pr_usd = R.port_returns(rets_usd, w)

    # ── 성과 / 산점도 ───────────────────────────────────────
    mret = P.monthly(rets_usd)
    # 마지막 달이 미완성이면 포함하되 표기
    rf_m = mret["TBILL"]
    bench = cfg["benchmark"]
    series = {"내 포트폴리오": P.backtest_monthly_rebal(mret, w)}
    b6040 = cfg.get("blend_60_40")
    if b6040 and all(t in mret for t in b6040):
        series["60/40 (SPY/AGG)"] = P.backtest_monthly_rebal(mret, pd.Series([0.6, 0.4], index=b6040))
    for t in cfg["compare"]:
        if t in mret:
            series[t] = mret[t]
    for t in held:
        if t in mret and t not in series:
            series[t] = mret[t]
    perf = {}
    daily_map = {"내 포트폴리오": pr_usd}
    for yrs in p["perf_periods"]:
        perf[str(yrs)] = {}
        for name, s in series.items():
            win = P.window(s.dropna(), yrs)
            if len(win) < 12 * yrs * 0.9:
                continue
            kind = "port" if name == "내 포트폴리오" else ("blend" if name.startswith("60/40") else ("held" if name in held else "index"))
            stt = P.stats(win, rf_m, P.window(mret[bench], yrs), daily_map.get(name, rets_usd[name] if name in rets_usd else None))
            stt["kind"] = kind
            perf[str(yrs)][name] = stt
    # 백테스트 성장 곡선 (월간, 5년)
    growth = {}
    for name in ["내 포트폴리오", "60/40 (SPY/AGG)", bench]:
        if name in series:
            s = P.window(series[name].dropna(), 10)
            growth[name] = {"dates": [str(i) for i in s.index], "v": ((1 + s).cumprod() * 10000).round(2).tolist()}
    rf5 = float(np.prod(1 + P.window(rf_m, 5)) ** (12 / min(60, len(rf_m))) - 1)
    fr = P.frontier(mret, held, rf5, years=5)

    # ── 리밸런싱 ────────────────────────────────────────────
    tg = cfg.get("targets") or (cfg["holdings"] if cfg.get("holdings_mode", "weights") == "weights" else {})
    band = RB.band_check(w, pd.Series(tg, dtype=float), nav, cfg["rebalance"]["abs_band"], cfg["rebalance"]["rel_band"]) if tg else None
    today = dt.date.fromisoformat(st["price_date"])
    cal = RB.calendar_due(today, cfg["rebalance"]["calendar"])
    rs = RB.risk_scale_trades(w, nav, util, cfg["rebalance"]["risk_target_util"], safe)
    if rs:
        w_new = pd.Series(rs["new_weights"]).reindex(held).fillna(0.0)
        if safe not in held:
            rs["note"] = f"{safe}가 보유종목에 없어 근사치입니다."
        else:
            chk = R.annual(rets_b, w_new, nav, rets_usd["TBILL"], dict(p, boot_paths=4000), horizon=int(lim["horizon_days"]))
            rs["check_util"] = chk["methods"][head_method][str(conf)]["amt"] / float(lim["amount"])
            # 대안: 위험기여 1위 종목만 안전자산으로 옮기기 (이분탐색)
            top_t = rc.drop(index=[safe], errors="ignore")["contrib_pct"].idxmax()
            target = cfg["rebalance"]["risk_target_util"]

            def util_after(f):
                ww = w.copy()
                ww[safe] += ww[top_t] * f
                ww[top_t] *= (1 - f)
                a2 = R.annual(rets_b, ww, nav, rets_usd["TBILL"], dict(p, boot_paths=2000), horizon=int(lim["horizon_days"]), seed=3)
                return a2["methods"][head_method][str(conf)]["amt"] / float(lim["amount"])
            lo, hi = 0.0, 1.0
            if util_after(1.0) <= target:
                for _ in range(12):
                    mid = (lo + hi) / 2
                    lo, hi = (lo, mid) if util_after(mid) <= target else (mid, hi)
                f = hi
                amt = float(w[top_t] * f * nav)
                rs["alt"] = {"ticker": top_t, "frac": f, "amt": amt, "new_w": float(w[top_t] * (1 - f)),
                             "util": util_after(f), "shift_pct": float(w[top_t] * f)}
            else:
                rs["alt"] = {"ticker": top_t, "frac": 1.0, "insufficient": True, "util": util_after(1.0)}

    # ── 추천 ───────────────────────────────────────────────
    rec = RC.rank(rets_usd, w, cfg["candidates"], safe, wins)
    rec_cash = float(rec["dvol"].iloc[0] - rec["vs_cash"].iloc[0]) if not rec.empty and rec["vs_cash"].notna().any() else None

    # ── 알림 문장 ───────────────────────────────────────────
    alerts = []
    if util > 1:
        msg = f"1년 {int(conf*100)}% VaR {head['amt']/1e4:,.0f}만원 — 위험한도 {lim['amount']/1e4:,.0f}만원의 {util:.0%}. 한도 초과."
        if rs:
            msg += f" 위험자산 전체를 {1-rs['k']:.0%}씩 줄여 약 {rs['shift_pct']*nav/1e4:,.0f}만원을 {safe}로 옮기면 사용률 약 {rs.get('check_util', cfg['rebalance']['risk_target_util']):.0%}."
        alerts.append(("critical", msg))
    elif util > lim["warn_at"]:
        alerts.append(("warning", f"1년 VaR 위험한도 사용률 {util:.0%} — 주의 구간."))
    if band is not None:
        for t, r in band[band["breach"]].iterrows():
            act = "매도" if r["dev"] > 0 else "매수"
            alerts.append(("warning", f"{t} 비중 {r['current']:.1%} (목표 {r['target']:.0%}, 허용 {r['lower']:.1%}~{r['upper']:.1%}) → 약 {abs(r['trade_amt'])/1e4:,.0f}만원 {act}"))
    if cal.get("due"):
        alerts.append(("info", f"정기 점검 기간입니다 (기준일 {cal['last']}). 리밸런싱 표를 확인하세요."))
    for pr_ in pairs:
        s = pr_["signal"]
        if s.get("flag"):
            alerts.append(("warning", f"상관 레짐 변화: {pr_['a']}–{pr_['b']} 63일 상관 {s['short']:+.2f} vs 252일 {s['long']:+.2f} ({s['direction']})"))
    top = rc["contrib_pct"].idxmax()
    if rc.loc[top, "contrib_pct"] > 0.4:
        alerts.append(("info", f"위험 집중: {top} 한 종목이 포트폴리오 변동성의 {rc.loc[top, 'contrib_pct']:.0%}를 차지 (비중 {rc.loc[top, 'weight']:.0%})."))
    if bt["zone_hs"] != "green":
        alerts.append(("warning", f"1일 VaR 백테스트 {bt['exc_hs']}회 초과 (기대 {bt['expected']}회) — 모델이 위험을 과소평가 중일 수 있음."))
    if float(dd.iloc[-1]) < -cfg["drawdown_alert"]:
        alerts.append(("critical", f"현재 비중 기준 고점 대비 낙폭 {dd.iloc[-1]:.1%}."))

    res = {
        "meta": {"generated": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M KST"),
                 "price_date": st["price_date"], "demo": demo, "base": cfg["base_currency"],
                 "sources": src, "spliced": {k: list(v) for k, v in spliced.items()},
                 "rf_now": float(tb.dropna().iloc[-1]), "fx": st["fx"]},
        "state": {"nav": nav, "nav0": st["nav0"], "base_date": st["base_date"], "since": since,
                  "w": w.to_dict(), "values": st["values"], "prices": st["prices"], "shares": st["shares"]},
        "limit": {"amount": lim["amount"], "conf": conf, "util": util, "method": head_method,
                  "warn_at": lim["warn_at"], "head": head},
        "one_day": od, "backtest": bt, "annual": an,
        "annual_hist": {"dates": [d.strftime("%Y-%m-%d") for d in hist.index],
                        "bootstrap": hist["bootstrap"].tolist(), "ewma_scaled": hist["ewma_scaled"].tolist()},
        "var1d_hist": {"dates": [d.strftime("%Y-%m-%d") for d in var1d_hist.index], "v": var1d_hist.round(0).tolist()},
        "contrib": rc.reset_index(names="ticker").to_dict("records"),
        "stress": sc,
        "drawdown": {"dates": [d.strftime("%Y-%m-%d") for d in dd.index], "v": dd.round(4).tolist()},
        "corr": corr, "pairs": pairs,
        "perf": perf, "growth": growth, "frontier": fr,
        "rebalance": {"band": band.reset_index(names="ticker").to_dict("records") if band is not None else None,
                      "calendar": cal, "risk_scale": rs, "rules": cfg["rebalance"]},
        "recommend": rec.to_dict("records") if not rec.empty else [],
        "rec_cash_dvol": rec_cash,
        "alerts": [{"level": a, "text": t} for a, t in alerts],
        "params": p,
    }
    return clean(res)
