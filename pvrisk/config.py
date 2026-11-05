"""설정 로딩: config.example.yaml 을 기본값으로 깔고, 그 위에
환경변수 PORTFOLIO_YAML(GitHub Secret) 또는 config.yaml 내용을 덮어씁니다."""
from __future__ import annotations

import copy
import datetime as dt
import os
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent


def _deep_merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict) and k not in ("holdings", "targets", "candidates"):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_config(path: str | None = None) -> dict:
    base = yaml.safe_load((ROOT / "config.example.yaml").read_text(encoding="utf-8"))
    override = None
    if os.environ.get("PORTFOLIO_YAML"):
        override = yaml.safe_load(os.environ["PORTFOLIO_YAML"])
    elif path and Path(path).exists():
        override = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    elif (ROOT / "config.yaml").exists():
        override = yaml.safe_load((ROOT / "config.yaml").read_text(encoding="utf-8"))
    cfg = _deep_merge(base, override or {})
    validate(cfg)
    return cfg


def validate(cfg: dict) -> None:
    h = cfg["holdings"]
    if not h:
        raise ValueError("holdings 가 비어 있습니다.")
    if cfg.get("holdings_mode", "weights") == "weights":
        s = sum(float(v) for v in h.values())
        if abs(s - 1.0) > 0.005:
            raise ValueError(f"holdings 비중 합이 {s:.1%} 입니다. 100%가 되도록 고쳐주세요.")
    if isinstance(cfg.get("as_of"), str):
        cfg["as_of"] = dt.date.fromisoformat(cfg["as_of"])
    if isinstance(cfg["params"].get("history_start"), str):
        cfg["params"]["history_start"] = dt.date.fromisoformat(cfg["params"]["history_start"])
    tg = cfg.get("targets") or {}
    if tg:
        s = sum(float(v) for v in tg.values())
        if abs(s - 1.0) > 0.005:
            raise ValueError(f"targets 비중 합이 {s:.1%} 입니다.")


def all_tickers(cfg: dict) -> list[str]:
    t = list(cfg["holdings"].keys())
    t += list((cfg.get("targets") or {}).keys())
    t += [cfg["benchmark"]] + list(cfg["compare"]) + list(cfg.get("blend_60_40") or [])
    for a, b in cfg["watch_pairs"]:
        t += [a, b]
    t += list(cfg["candidates"].keys())
    t += list(PROXIES.values())
    seen, out = set(), []
    for x in t:
        if x and x not in seen and x != "TBILL":
            seen.add(x)
            out.append(x)
    return out


# 상장 전 기간을 메우는 대용치 (상관·VaR의 긴 히스토리용)
# TBILL 은 FRED 3개월 T-bill 금리를 일할 계산한 합성 수익률
PROXIES = {
    "SGOV": "TBILL",
    "BIL": "TBILL",
    "SPMO": "MTUM",
    "MTUM": "SPY",
    "USMV": "SPLV",
    "QUAL": "SPY",
    "VLUE": "IWD",
    "SCHD": "DVY",
    "IGV": "XLK",
}
