# Portfolio Risk Monitor

내 포트폴리오의 위험을 매일 아침 자동으로 점검하는 대시보드입니다. Portfolio Visualizer 스타일을 따릅니다.

- **위험한도 사용률:** 1년 VaR가 내가 정한 손실한도의 몇 %인지
- **1일 VaR · 백테스트:** 매일 보는 계기판
- **리스크-수익 산점도:** S&P500·주요 지수와 내 포트폴리오 비교, 효율적 투자선 포함
- **상관 레짐 모니터:** 주식-채권, 반도체-소프트웨어 등 자산 간 상관 변화 감지
- **리밸런싱 신호:** 5/25 허용범위, 분기 점검, 위험한도 초과 시 조정안
- **분산 추천:** 지금 포트폴리오와 상관이 낮은 ETF

매일 **화~토 08:17(한국시간)**에 GitHub이 자동으로 계산해 비밀번호가 걸린 웹페이지로 올립니다. PC를 켜둘 필요가 없습니다.

---

## 처음 설정 (한 번만, 15분 정도)

### 1. Tiingo 무료 API 키 발급
1. https://www.tiingo.com 에 가입합니다.
2. 오른쪽 위 계정 메뉴 → **API** → **Token**을 복사합니다.
3. 이 키는 아무에게도 보내지 말고 아래 2단계에서 Secret으로 넣습니다.

### 2. GitHub Secret 등록
저장소의 **Settings → Secrets and variables → Actions → New repository secret**에서 아래 항목을 추가합니다.

| 이름 | 값 | 필수 |
|---|---|---|
| `PORTFOLIO_YAML` | 아래 "보유내역 설정" 내용 전체 | 필수 |
| `TIINGO_API_KEY` | 1단계에서 복사한 키 | 필수 |
| `DASHBOARD_PASSWORD` | 대시보드 비밀번호. 12자 이상 권장 | 필수 |
| `TELEGRAM_BOT_TOKEN` | 텔레그램 알림용 (아래 참고) | 선택 |
| `TELEGRAM_CHAT_ID` | 텔레그램 알림용 | 선택 |

### 3. GitHub Pages 켜기
**Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿉니다.

### 4. 첫 실행
**Actions** 탭 → **daily-risk** → **Run workflow**를 누릅니다. 3~5분 뒤 아래 주소에서 대시보드가 열립니다.

`https://<내아이디>.github.io/<저장소이름>/`

비밀번호 입력 후 **30일간 기억**을 체크하면 폰에서도 매번 입력할 필요가 없습니다.

---

## 보유내역 설정 (`PORTFOLIO_YAML`)

이 내용을 Secret에 그대로 붙여넣습니다. 여기 적지 않은 항목은 `config.example.yaml`의 기본값을 씁니다.

```yaml
nav: 100000000
holdings_mode: weights
as_of: 2026-11-05
holdings:
  MU: 0.30
  SGOV: 0.20
  SPMO: 0.20
  GLD: 0.15
  SOXX: 0.10
  BRK-B: 0.05
risk_limit:
  amount: 20000000
  confidence: 0.95
```

**weights 방식**
- `as_of` 날짜의 종가로 보유 주수를 역산합니다.
- 그 뒤 가격 변화에 따른 비중 이탈은 자동으로 추적합니다.
- 매매하면 `as_of`, `nav`, 비중을 새로 적어주세요.

**shares 방식 (더 정확함)**
- 매매할 때마다 보유 주수만 고치면 됩니다.
```yaml
holdings_mode: shares
holdings: {MU: 210, SGOV: 200, SPMO: 180, GLD: 40, SOXX: 30, BRK-B: 10}
cash: 0
targets: {MU: 0.30, SGOV: 0.20, SPMO: 0.20, GLD: 0.15, SOXX: 0.10, BRK-B: 0.05}
```

**표기 규칙:** 티커는 Yahoo/Tiingo 표기를 씁니다. 버크셔 B주는 `BRK-B`입니다.

## 텔레그램 알림 (선택)
매일 아침 요약과 경고를 폰으로 받을 수 있습니다.
1. 텔레그램에서 `@BotFather` → `/newbot`으로 봇을 만들고 토큰을 받습니다 → `TELEGRAM_BOT_TOKEN`
2. 만든 봇에게 아무 메시지나 보냅니다.
3. 브라우저에서 `https://api.telegram.org/bot<토큰>/getUpdates`를 열어 `chat.id` 숫자를 찾습니다 → `TELEGRAM_CHAT_ID`
4. 경고가 있는 날만 받고 싶으면: **Settings → Secrets and variables → Actions → Variables**에서 `NOTIFY_ONLY_ALERTS` = `1`로 설정합니다.

---

## 계산 방식 요약

| 항목 | 기본값 | 근거 |
|---|---|---|
| 한도 판정 | 1년 95% VaR, 원화 기준 | 장기투자자는 연간 위험예산이 적합. 원화 투자자이므로 환율 위험 포함 |
| 1년 VaR 방식 | 최근 10년, 21일 블록 부트스트랩 1만 경로 | √252 환산은 변동성 군집을 과소평가하므로 블록 단위로 재표본 |
| 기대수익 가정 | 초과수익 0 | 반도체의 과거 고수익이 반복된다고 가정하지 않음(보수적) |
| 1일 VaR | 역사적 250일 + EWMA λ=0.94 | 바젤 역사적 시뮬레이션 관행, RiskMetrics |
| 백테스트 | 250일, 99% | 바젤 신호등 규칙(0~4회 그린존) |
| 상관계수 | 달러 수익률, 63/126/252일 롤링 | 단기와 장기의 괴리를 레짐 변화 신호로 사용 |
| 아웃라이어 | 상관·추천 계산에만 1% 윈저라이징 | VaR는 꼬리가 측정 대상이므로 손대지 않음 |
| 성과 평가 | 월간 수익률, 1/3/5년 | GIPS: 36개월 월간 수익률로 3년 표준편차 |
| 무위험수익률 | 각 달의 3개월 T-bill (FRED DTB3) | 분석기간 평균 사용. 현재 금리를 과거에 적용하지 않음 |
| 공분산 | Ledoit-Wolf 축소추정 | 표본 공분산의 추정오차 완화 |
| 리밸런싱 | ±5%p 또는 ±25% 중 좁은 쪽, 분기 점검 | 국민연금 SAA 허용범위 방식을 개인용으로 변형 |

**상장 전 기간 대용치:** 상장 전 기간은 비슷한 자산의 수익률로 이어 붙여 긴 히스토리를 확보합니다. 예를 들어 SGOV는 2020년 이전을 T-bill 금리로 계산한 수익률로 채웁니다.

## 로컬에서 실행 (선택)
```bash
pip install -r requirements.txt
python run.py --demo            # 합성 데이터로 화면 미리보기
TIINGO_API_KEY=... python run.py  # 실제 데이터 (config.yaml 또는 PORTFOLIO_YAML 사용)
python -m pytest -q tests       # 수식 검증 테스트
```

## 개인정보 보호
- 저장소는 공개지만 보유내역과 금액은 GitHub Secret에만 있습니다.
- 공개 저장소의 Actions 로그는 누구나 볼 수 있으므로, 로그에는 금액을 출력하지 않습니다.
- 웹페이지는 AES로 암호화되어 비밀번호 없이는 내용을 볼 수 없습니다.

> 통계적 추정치이며 투자 권유가 아닙니다. VaR는 '최악의 손실'이 아니라 '주어진 확률에서의 손실 경계'입니다.
