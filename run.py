#!/usr/bin/env python3
"""앱 빌드: 시장 데이터(market.json, returns.json) 계산 + 앱 파일 복사 → site/

  python run.py            # 실제 시세
  python run.py --app-only # 데이터는 그대로 두고 앱 파일만 다시 복사

보유내역 관련 계산은 앱(브라우저)과 알림 스크립트(scripts/alerts.mjs)가 합니다.
"""
import argparse
import logging
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def copy_app(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for p in (ROOT / "app").rglob("*"):
        if p.is_file():
            dst = out / p.relative_to(ROOT / "app")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
    (out / ".nojekyll").touch()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config")
    ap.add_argument("--out", default="site")
    ap.add_argument("--app-only", action="store_true")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    out = Path(a.out)
    copy_app(out)
    if not a.app_only:
        from pvrisk.config import load_config
        from pvrisk import market as MK
        cfg = load_config(a.config)
        m, r = MK.build(cfg)
        MK.write(out, m, r)
        print(f"완료: 시세 {m['meta']['price_date']}{' (장중 잠정)' if m['meta']['provisional'] else ''}, "
              f"종목 {m['meta']['n_tickers']}개, 실패 {m['meta']['failed'] or '없음'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
