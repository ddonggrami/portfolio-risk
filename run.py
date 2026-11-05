#!/usr/bin/env python3
"""포트폴리오 리스크 대시보드 실행.

  python run.py              # 실제 시세로 계산 → site/index.html
  python run.py --demo       # 합성 데이터로 화면 미리보기
  python run.py --notify     # 계산 후 텔레그램 알림 (환경변수 필요)

알림 정책(--notify): 매일 요약을 보내되, NOTIFY_ONLY_ALERTS=1 이면 경고가 있을 때만.
"""
import argparse
import logging
import os
import sys
from pathlib import Path

from pvrisk.config import load_config
from pvrisk.pipeline import run
from pvrisk.report import notify_telegram, render, summary_text


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--out", default="site/index.html")
    ap.add_argument("--notify", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    cfg = load_config(a.config)
    res = run(cfg, demo=a.demo)
    out = render(res, Path(a.out))
    # 공개 저장소의 Actions 로그는 누구나 볼 수 있으므로 CI에서는 금액을 출력하지 않음
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"완료: 기준일 {res['meta']['price_date']}, 알림 {len(res['alerts'])}건")
    else:
        print(summary_text(res))
    print(f"\n→ {out} ({out.stat().st_size/1e6:.1f} MB)")
    if a.notify:
        urgent = any(x["level"] in ("critical", "warning") for x in res["alerts"])
        if urgent or os.environ.get("NOTIFY_ONLY_ALERTS") != "1":
            sent = notify_telegram(summary_text(res, os.environ.get("DASHBOARD_URL")))
            print("텔레그램:", "전송" if sent else "미설정/실패")
    return 0


if __name__ == "__main__":
    sys.exit(main())
