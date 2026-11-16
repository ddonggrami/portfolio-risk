# Portfolio Risk Monitor

미국 ETF 포트폴리오의 위험을 점검하는 안드로이드용 웹앱(PWA)입니다. 휴대폰 홈 화면에 설치해서 앱처럼 씁니다.

## 기능

| 탭 | 내용 |
|---|---|
| 홈 | 점검 상태(정상 작동 여부, 마지막·다음 점검), "지금 점검" 버튼, 포트폴리오 진단, 알림 기준까지 남은 거리, 시장 국면 |
| 내 포트 | 보유 ETF·주수 입력, 진단(양호/보통/점검 필요), VaR 표(1일~1년 × 95·99%), 위험기여, 편입·편출 제안과 효과, 위기 재현, 리밸런싱 규칙 비교, 중복 노출 |
| 시장 | 달리는 말(S&P500 대비 상대강도), 짝 찾기(상관·하락장 상관), 마진(손익비) — 신호마다 검증 결과와 ⓘ 설명 |
| 투자선 | 효율적 투자선, 변동성별 비중 변화, 현재 포트와 추천 변경안의 위치(화살표), 기대수익 가정 3종 비교 |
| 설정 | 위험한도, 리밸런싱 규칙(방식·주기·허용범위), 목표비중, GitHub 연결, 보유내역 암호화 동기화 |

**보유내역은 휴대폰에만 저장됩니다.** 사이트에 올라가는 건 누구나 볼 수 있는 시장 데이터뿐입니다. 텔레그램 알림을 원할 때만 비밀번호로 암호화한 사본을 저장소에 올립니다.

**자동 점검 일정 (한국시간)**
- 미장 중 매시간: 23:07~06:07
- 장 마감 후 확정 점검: 화~토 08:17
- 주간 요약: 일요일 09:13

---

## 처음 설정 (약 20분, 한 번만)

### 1. GitHub 저장소 만들기
1. https://github.com 에 로그인(계정이 없으면 가입)합니다.
2. 오른쪽 위 **+** → **New repository**를 누릅니다.
3. 이름은 예를 들어 `portfolio-risk`로 하고, **Public**을 선택합니다.
   - 무료 GitHub Pages는 공개 저장소에서만 됩니다.
   - 보유내역은 저장소에 평문으로 올라가지 않습니다.
4. 다른 옵션은 건드리지 말고 **Create repository**를 누릅니다.
5. 만든 저장소 주소(`아이디/portfolio-risk`)를 Claude에게 알려주면 코드를 올려 드립니다.

### 2. GitHub Pages 켜기
**Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 바꿉니다.

### 3. Secret 등록 (선택이지만 알림에 필요)
**Settings → Secrets and variables → Actions → New repository secret**에서 등록합니다.

| 이름 | 값 | 용도 |
|---|---|---|
| `PORTFOLIO_PASSWORD` | 직접 정한 비밀번호(12자 이상 권장) | 앱이 암호화한 보유내역을 서버가 풀 때 |
| `TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 | 알림 전송 |
| `TELEGRAM_CHAT_ID` | 텔레그램 채팅 ID | 알림 전송 |
| `TIINGO_API_KEY` | (선택) Tiingo 무료 키 | Yahoo가 막힐 때 예비 시세 |

**텔레그램 봇 만들기**
1. 텔레그램에서 `@BotFather` → `/newbot`으로 봇을 만들고 토큰을 받습니다.
2. 만든 봇에게 아무 말이나 보냅니다.
3. 브라우저에서 `https://api.telegram.org/bot<토큰>/getUpdates`를 열고, 거기 나오는 `"chat":{"id": 숫자}`가 채팅 ID입니다.

### 4. 첫 실행
**Actions** 탭 → **risk-check** → **Run workflow**를 누릅니다. 약 5분 뒤 아래 주소에서 앱이 열립니다.

`https://<아이디>.github.io/<저장소이름>/`

### 5. 안드로이드에 설치
1. 크롬으로 위 주소를 엽니다.
2. 오른쪽 위 **⋮** → **홈 화면에 추가**(또는 **앱 설치**)를 누릅니다.
3. 앱에서 **내 포트** → 보유 ETF와 주수를 입력하고 **저장하고 분석**을 누릅니다.

### 6. "지금 점검" 버튼과 알림 동기화
1. GitHub → 오른쪽 위 프로필 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**으로 갑니다.
2. 아래처럼 설정해서 만듭니다.
   - Repository access: **Only select repositories** → 이 저장소만
   - Permissions → Repository permissions
     - **Actions**: Read and write
     - **Contents**: Read and write
   - 만료 기간: 원하는 기간 (만료되면 새로 만들어 다시 넣으면 됩니다)
3. 앱 **설정 → GitHub 연결**에 토큰을 붙여넣고 저장합니다.
4. 같은 화면에서 `PORTFOLIO_PASSWORD`와 **같은 비밀번호**를 넣고 **암호화해서 올리기**를 누릅니다.
5. 보유내역을 바꿀 때마다 다시 올리면 됩니다.

---

## 계산 방식과 검증

| 항목 | 방식 | 근거 / 검증 |
|---|---|---|
| VaR | 원화 기준. 블록 부트스트랩(10년, 21일 블록, 1만 경로) · EWMA(λ=0.94) · 역사적 250일 | 바젤 관행, RiskMetrics. 극단값은 제거하지 않음 |
| 짝 찾기 | 1·3·6·12개월 상관, 하락장 상관 | 6개월 상관 → 다음 6개월: 상관 0.89. 하락장 상관 0.81 |
| 상대강도 | 10개월 추세 + 1·3·6개월 상대수익 | **예측력 없음**(순위상관 ≈ 0). 현재 상태 확인용 |
| 마진 | 비슷한 과거 상태 이후 12개월 분포 | **표본외 예측력 없음**(순위상관 -0.01). 참고용 |
| 투자선 | 월간, Ledoit-Wolf 공분산, 롱온리 | 기대수익 3가지(과거평균 · Bayes-Stein 축소 · CAPM 균형) |
| 추천 | 위험 근거(중복 노출, 위험 집중, 낮은 상관, 위험한도) | 세 가정 모두에서 샤프가 오르면 "견고한 개선" |
| 리밸런싱 | 안 함 / 정기 / 허용범위 / 정기 점검 + 허용범위 | 규칙별 10년 비교(수익·변동성·낙폭·회전율) |

**데이터:** Yahoo 수정주가(배당 재투자), FRED 3개월 T-bill과 원/달러 환율(실패 시 Yahoo). 상장 전 구간은 비슷한 ETF로 이어 붙입니다.

**검증 장치:** 매 실행마다 JS 엔진 결과를 Python 기준 구현과 비교하고(17개 항목), 하나라도 틀리면 배포하지 않습니다.

## 개발
```bash
pip install -r requirements.txt
python run.py                        # site/ 생성 (실제 시세)
python -m http.server -d site 8000   # http://localhost:8000
python -m pytest -q tests
node tests/engine_run.js site out.json && python tests/compare_engine.py site out.json
```

> 통계적 추정이며 투자 권유가 아닙니다.
