"""대시보드 HTML 생성 + 텔레그램 알림."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import requests

T = Path(__file__).resolve().parent / "templates"
log = logging.getLogger(__name__)


def render(res: dict, out: Path) -> Path:
    html = (T / "dashboard.html").read_text(encoding="utf-8")
    plotly = (T / "vendor" / "plotly-cartesian.min.js").read_text(encoding="utf-8")
    payload = json.dumps(res, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    html = html.replace("__DATA__", payload).replace("<script>__PLOTLY__</script>", "<script>" + plotly + "</script>")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return out


def summary_text(res: dict, url: str | None = None) -> str:
    L = res["limit"]
    od = res["one_day"]
    lines = [
        f"📊 포트폴리오 리스크 ({res['meta']['price_date']} 종가)",
        f"총자산 {res['state']['nav']/1e4:,.0f}만원",
        f"1년 {int(L['conf']*100)}% VaR {L['head']['amt']/1e4:,.0f}만원 → 한도 사용률 {L['util']:.0%}",
        f"1일 99% VaR {od['ewma_99']['amt']/1e4:,.0f}만원 · 연변동성 {od['ewma_sigma_ann']:.1%}",
    ]
    icon = {"critical": "🔴", "warning": "🟡", "info": "🔵"}
    if res["alerts"]:
        lines.append("")
        lines += [f"{icon.get(a['level'], '•')} {a['text']}" for a in res["alerts"]]
    else:
        lines.append("🟢 특이사항 없음")
    if url:
        lines += ["", url]
    return "\n".join(lines)


def notify_telegram(text: str) -> bool:
    tok, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not tok or not chat:
        return False
    try:
        r = requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                          json={"chat_id": chat, "text": text, "disable_web_page_preview": True}, timeout=20)
        r.raise_for_status()
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("텔레그램 전송 실패: %s", e)
        return False
