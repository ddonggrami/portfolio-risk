/* Portfolio Risk Monitor — 화면 */
(function () {
"use strict";
const E = window.PRE, F = E.fmt, $ = s => document.querySelector(s);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const SER = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ───────── 저장소 (휴대폰 안에만 저장) ─────────
const LS = {
  get(k, d) { try { const v = localStorage.getItem("pr." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("pr." + k, JSON.stringify(v)); } catch (e) { } },
  del(k) { try { localStorage.removeItem("pr." + k); } catch (e) { } },
};
const DEF = { limit: { amount: 2e7, h: 252, c: 0.95, warn: 0.8, mode: "pct", pct: 0.2 }, varMethod: "boot", erp: null, targets: null,
  fr: { method: "shrink", years: 5, maxW: 1, extra: [] }, repo: "", ddWarn: [0.10, 0.20], moveTh: 0.03,
  rule: { mode: "band", freq: "Q", abs: 0.05, rel: 0.25, basis: "sleeve" } };
const S = {
  holdings: LS.get("holdings", []), cash: LS.get("cash", 0), set: Object.assign({}, DEF, LS.get("settings", {})),
  token: LS.get("token", ""), view: "home", mkt: "rs", rsSel: null, mgSel: null, basket: null, frIdx: null, overlay: null,
};
S.set.fr = Object.assign({}, DEF.fr, S.set.fr || {}); S.set.limit = Object.assign({}, DEF.limit, S.set.limit || {}); S.set.rule = Object.assign({}, DEF.rule, S.set.rule || {});
const saveSet = () => LS.set("settings", S.set);

// ───────── 공통 렌더 도구 ─────────
const pct = (x, d) => F.pct(x, d), won = F.won;
const sg = (x, d) => !Number.isFinite(x) ? "–" : `<span class="${x >= 0 ? "pos" : "neg"}">${x >= 0 ? "+" : ""}${(x * 100).toFixed(d === undefined ? 1 : d)}%</span>`;
const sgp = x => !Number.isFinite(x) ? "–" : `<span class="${x <= 0 ? "pos" : "neg"}">${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%p</span>`;
const num = (x, d) => !Number.isFinite(x) ? "–" : x.toFixed(d === undefined ? 2 : d);
function table(head, rows, opt) {
  opt = opt || {};
  return `<div class="tbl"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r, i) =>
    `<tr class="${opt.click ? "click" : ""} ${opt.sel && opt.sel(i) ? "sel" : ""}" ${opt.click ? `data-i="${i}"` : ""}>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function badge(level, text) {
  const m = { critical: "b-crit", warning: "b-warn", ok: "b-good", info: "b-info", mute: "b-mute" }[level] || "b-mute";
  const ic = { critical: "✕", warning: "!", ok: "✓", info: "i", mute: "·" }[level] || "";
  return `<span class="badge ${m}">${ic} ${esc(text)}</span>`;
}
const stateLevel = s => ({ "강세": "ok", "회복 조짐": "info", "중립": "mute", "약화 조짐": "warning", "약세": "critical" }[s] || "mute");
function layout(extra) {
  const ax = { gridcolor: css("--grid"), linecolor: css("--axis"), zerolinecolor: css("--axis"), tickfont: { color: css("--muted"), size: 11 }, automargin: true };
  return Object.assign({ paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)", font: { family: "system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif", size: 12, color: css("--ink2") },
    margin: { l: 46, r: 12, t: 8, b: 40 }, hoverlabel: { bgcolor: css("--card"), bordercolor: css("--grid"), font: { color: css("--ink") } },
    xaxis: Object.assign({}, ax), yaxis: Object.assign({}, ax), legend: { orientation: "h", y: -0.22, font: { color: css("--ink2") } }, hovermode: "closest", showlegend: false }, extra || {});
}
const AX = (extra) => Object.assign({ gridcolor: css("--grid"), linecolor: css("--axis"), zerolinecolor: css("--axis"), tickfont: { color: css("--muted"), size: 11 }, automargin: true }, extra);
// 모바일에서 탭/드래그로 의도치 않게 확대되지 않도록 축을 고정하고, 탭하면 값만 보이게 함
const plot = (id, data, lay) => {
  const el = document.getElementById(id); if (!el) return;
  const L = layout(lay); L.dragmode = false;
  for (const k of Object.keys(L)) if (/^[xy]axis\d*$/.test(k)) L[k] = Object.assign({}, L[k], { fixedrange: true });
  Plotly.react(el, data, L, { displayModeBar: false, responsive: true, scrollZoom: false, doubleClick: false });
};
const spin = t => `<div class="empty"><span class="spin"></span> ${t || "계산 중…"}</div>`;
const later = fn => new Promise(r => setTimeout(() => r(fn()), 20));

// ───────── 신호 설명 (ⓘ) ─────────
const INFO = {
  "상관 낮음": ["상관 낮음", "기준(달리는 말 또는 내 포트)과 이 ETF의 <b>최근 6개월(126거래일)</b> 일간 수익률 상관이 0.30 미만입니다.",
    [["왜 6개월인가", "2006~2026년 실제 ETF 쌍 3만여 개로 검증한 결과, 6개월 상관이 다음 6개월 상관을 가장 잘 맞혔습니다(상관 0.89, 평균 오차 ±0.14)."],
     ["1개월은?", "1개월 상관은 잡음이 큽니다. 1개월 상관이 12개월보다 0.2 이상 급락했던 경우, 다음 6개월 상관은 그 1개월 값보다 평균 0.29 높게 되돌아갔습니다."],
     ["12개월은?", "예측력은 비슷하지만(0.885) 변화를 늦게 반영해 참고 열로만 보여줍니다."]]],
  "상관 낮아지는 중": ["상관 낮아지는 중", "<b>6개월 상관이 12개월 상관보다 0.20 이상 낮습니다.</b> 관계가 약해지는 방향으로 바뀌고 있다는 뜻입니다.",
    [["왜 6개월 대 12개월인가", "6개월은 다음 6개월을 가장 잘 예측하는 창이고, 12개월은 그보다 한 단계 긴 기준선입니다. 둘의 차이로 추세를 봅니다."],
     ["왜 1개월을 안 쓰나", "1개월 급락은 대부분 되돌아갔습니다(위 '상관 낮음' 설명 참고). 1개월 값은 표에만 보여줍니다."],
     ["얼마나 믿을 만한가", "검증상 하락 신호가 뜬 뒤 다음 6개월 상관은 12개월 값보다 평균 0.08~0.10 낮았습니다. 방향은 맞지만 폭은 신호보다 작습니다."]]],
  "하락장 상관 낮음": ["하락장 상관 낮음", "기준 자산이 <b>떨어진 날만</b> 골라 계산한 최근 12개월 상관이 0.30 미만입니다. 정작 필요할 때 같이 빠지지 않는지를 봅니다.",
    [["왜 12개월인가", "하락한 날만 쓰면 표본이 절반으로 줄어 6개월로는 불안정합니다. 그래서 12개월(약 120일)과 3년을 함께 보여줍니다."],
     ["검증", "과거 하락장 상관 → 다음 6개월 하락장 상관: 상관 0.81."]]],
  "중복 노출": ["중복 노출", "<b>6개월 상관이 0.80(짝 찾기) 또는 0.90(보유 종목 간) 이상</b>입니다. 이름은 달라도 사실상 같은 위험입니다.",
    [["왜 6개월인가", "상관 예측력이 가장 좋은 창이라서입니다. 예: SPMO–SOXX는 2016년 이후 평균 0.78이었지만 최근 6개월 0.97."]]],
  "상대강도": ["상대강도 상태", "ETF÷S&P500 선(상대강도선)과 그 <b>10개월(210거래일) 이동평균</b>, 그리고 1·3·6개월 상대수익으로 판정합니다.",
    [["강세", "선이 이동평균 위 + 3·6개월 상대수익 플러스"], ["약화 조짐", "아직 위지만 1·3개월 상대수익 마이너스"], ["약세", "선이 이동평균 아래 + 6개월 상대수익 마이너스"], ["회복 조짐", "아직 아래지만 1·3개월 상대수익 플러스"],
     ["왜 10개월인가", "Faber의 10개월 추세 규칙(학계·실무에서 널리 쓰임)."],
     ["주의", "검증 결과 앞으로의 상대수익 예측력은 거의 0이었습니다. 지금 상태를 확인하는 용도입니다."]]],
  "마진": ["마진(손익비)", "52주 고점 대비 낙폭과 3년 S&P500 대비 초과수익이 지금과 비슷했던 과거 월말들의 <b>이후 12개월</b> 수익 분포입니다.",
    [["왜 12개월인가", "손익비는 단기보다 1년 단위에서 의미가 있고, 장기 반전 연구(3~5년)보다 짧아 표본을 확보할 수 있는 절충입니다."],
     ["주의", "그때까지의 데이터만으로 다시 계산한 표본외 검증에서 예측력이 없었습니다."]]],
  "VaR": ["VaR 계산 방식", "주어진 기간·확률에서 '이 정도까지는 잃을 수 있다'는 경계입니다(최악의 손실 아님).",
    [["블록 부트스트랩", "최근 10년 일간 수익을 21일(1개월) 묶음으로 1만 번 재표본. 폭락이 몰려오는 성질을 보존."], ["EWMA", "최근 변동성(λ=0.94, 체감 약 1개월)이 계속된다고 가정. 위험이 커지는 걸 가장 빨리 반영."], ["역사적 250일", "최근 1년 실제 손익. 바젤 은행 규제 방식."],
     ["가정", "현재 비중이 그대로 유지된다고 가정합니다(리밸런싱 규칙은 아래 리밸런싱 카드에서 따로 비교)."]]],
  "위험한도": ["위험한도 (B 방식)", "1년 95% VaR가 한도를 넘지 않도록 <b>위험자산의 크기</b>만 조절하고, 위험자산 <b>안의 비율</b>은 분기 리밸런싱이 맞춥니다.",
    [["한도 금액", "기본: 분기 첫날 평가액의 20%. 분기마다 새로 잡힙니다(손실이 나면 다음 분기 한도도 같이 줄어듦). 고정 금액으로 바꿀 수도 있습니다."],
     ["줄일 때", "사용률이 105%를 넘으면, 사용률이 90%가 되도록 모든 위험자산을 같은 비율로 팔아 SGOV로 옮깁니다. VaR는 위험자산 크기에 거의 비례하므로 이렇게 계산합니다."],
     ["다시 늘릴 때", "사용률이 70% 아래로 내려오고 위험자산이 기본 비중(목표비중의 위험자산 합)보다 작으면, 90%가 되는 선까지 목표 비율대로 다시 삽니다."],
     ["분기초 평가액", "지금 보유 수량을 직전 분기 마지막 거래일 종가(원화)로 계산한 값입니다. 분기 중에 매매했다면 약간 다를 수 있습니다."],
     ["근거", "2018~2026 백테스트(원화): 연수익 19.8%, 변동성 16.7%, 최대낙폭 −25.9%. 그대로 보유는 25.9% / 30.1% / −51.5%."]]],
  "한도 맞춤 재편안": ["한도 맞춤 재편안", "1년 95% VaR 사용률을 목표(기본 90%)까지 낮추는 방법을 세 가지로 계산합니다. 각 안은 정수 주로 맞춘 뒤 VaR를 다시 계산했습니다.",
    [["① 같은 비율로 줄이기", "위험자산 안의 목표 비율은 그대로 두고 전체 크기만 줄여 SGOV로. 리밸런싱 규칙과 충돌이 없는 기본안."],
     ["② 위험 큰 종목 위주", "1%p를 SGOV로 옮겼을 때 VaR가 가장 많이 줄어드는 종목부터 팝니다. 매매 건수가 적지만 목표 비율에서 벗어납니다."],
     ["③ 다른 ETF 편입", "시장·후보 목록의 ETF(이력 5년 이상) 중, 일부(10~30%)를 편입하고 나머지 초과분만 SGOV로 옮겼을 때 균형 기대수익이 가장 높게 남는 조합. ①보다 나을 때만 표시합니다."],
     ["주의", "VaR는 최근 10년 표본 기준입니다. 채권처럼 과거에 주식과 반대로 움직였던 자산은 그 관계가 바뀌면(2022년처럼) 효과가 줄어듭니다."]]],
  "균형 기대수익": ["균형 기대수익", "각 ETF의 S&P500 대비 베타 × 주식 위험프리미엄 + 무위험금리(최근 5년 월간). 최근 성과를 따라가지 않는 중립적인 기준으로, 재편안끼리 '수익 여지를 얼마나 남겼는지' 비교하는 용도입니다. 예측이 아닙니다.", []],
  "견고한 개선": ["견고한 개선", "과거 평균·축소 추정·시장 균형 <b>세 가지 기대수익 가정 모두</b>에서 샤프 비율이 좋아지는 변경안입니다. 수익 예측이 틀려도 개선될 가능성이 높습니다.", []],
  "리밸런싱": ["리밸런싱 규칙", "설정에서 고른 규칙에 따라 알림과 아래 비교표가 달라집니다.",
    [["정기", "주기 말마다 무조건 목표비중으로."], ["허용범위 이탈 시", "목표 ±절대 %p 또는 목표의 ±상대 % 중 좁은 쪽을 벗어나는 날 즉시. 국민연금 SAA 허용범위 방식."], ["정기 점검 + 허용범위", "주기 말에만 확인하고, 벗어났을 때만 매매. 매매 횟수가 가장 적음(Vanguard 권장 방식)."],
     ["5/25 규칙", "±5%p 또는 목표의 ±25% 중 좁은 쪽. 작은 비중 종목에 ±5%p는 너무 넓기 때문."],
     ["위험자산 안 비율 기준", "SGOV·현금을 뺀 위험자산끼리의 비율로 허용범위를 봅니다. 위험자산 전체 크기는 위험한도가 따로 조절하므로, 둘이 서로 부딪히지 않습니다."]]],
};
function ib(key) { return INFO[key.replace(/ .*년$/, "")] || key.startsWith("이력") ? `<button class="ib" data-info="${esc(key.startsWith("이력") ? "이력" : key)}" aria-label="${esc(key)} 설명"></button>` : ""; }
INFO["이력"] = ["짧은 이력", "상장한 지 5년이 안 돼 위기 구간 데이터가 없습니다. 추천 후보에서는 제외하고 표에만 보여줍니다.", []];
function showInfo(key) {
  const it = INFO[key]; if (!it) return;
  $("#sheetBox").innerHTML = `<h3>${esc(it[0])}</h3><p>${it[1]}</p>${it[2].length ? `<dl>${it[2].map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join("")}</dl>` : ""}<div class="row" style="margin-top:12px"><button class="btn" id="sheetX">닫기</button></div>`;
  $("#sheet").classList.add("on"); $("#sheetX").onclick = () => $("#sheet").classList.remove("on");
}
document.addEventListener("click", e => { const b = e.target.closest("[data-info]"); if (b) { e.stopPropagation(); showInfo(b.dataset.info); } else if (e.target.id === "sheet") $("#sheet").classList.remove("on"); }, true);
const tag = t => `<span class="pill">${esc(t)}</span>${ib(t)}`;

// ───────── 데이터 적재 ─────────
async function getJSON(u) { const r = await fetch(u + (u.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); }
async function loadData() {
  try {
    S.market = await getJSON("market.json");
    const pd = LS.get("returns_date", null);
    S.returns = await getJSON("returns.json");
    LS.set("returns_date", S.market.meta.price_date);
    S.ctx = E.load(S.market, S.returns);
    try { S.status = await getJSON("status.json"); } catch (e) { S.status = null; }
    if (S.set.erp === null) S.set.erp = S.market.defaults.erp;
    S.loadError = null;
  } catch (e) { S.loadError = String(e); }
  S.port = null; S.rec = null; computePort(); renderAll();
}

// ───────── 상태(정상 작동) 판단 ─────────
function nextRuns(now) { // UTC 기준 예약: 평일 매시 :07 (14~21시), 평일 23:17, 일요일 00:13
  const out = [];
  for (let d = 0; d < 4; d++) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d));
    const wd = base.getUTCDay();
    if (wd >= 1 && wd <= 5) { for (let h = 14; h <= 21; h++) out.push(new Date(base.getTime() + h * 3600e3 + 7 * 60e3)); out.push(new Date(base.getTime() + 23 * 3600e3 + 17 * 60e3)); }
    if (wd === 0) out.push(new Date(base.getTime() + 13 * 60e3));
  }
  return out.filter(x => x > now).sort((a, b) => a - b);
}
const kst = d => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(5, 16).replace("T", " ").replace("-", "/");
function health() {
  if (S.loadError) return { lv: "critical", txt: "데이터를 불러오지 못함", detail: S.loadError };
  const g = new Date(S.market.meta.generated_iso), now = new Date(), age = (now - g) / 3600e3;
  const prev = nextRuns(new Date(g.getTime())).filter(x => x < now);
  const missed = prev.filter(x => (now - x) / 3600e3 > 1.5).length;
  const lv = missed >= 2 ? "critical" : missed === 1 ? "warning" : "ok";
  return { lv, age, missed, next: nextRuns(now)[0], txt: lv === "ok" ? "정상 작동" : lv === "warning" ? "예정된 점검 1회 지연" : `예정된 점검 ${missed}회 누락` };
}

// ───────── 포트폴리오 계산 ─────────
function computePort() {
  S.port = null;
  if (!S.ctx || !S.holdings.length) return;
  const H = S.holdings.filter(h => h.t && h.shares > 0);
  const W = E.weights(S.ctx, H, +S.cash || 0);
  if (!Object.keys(W.w).length) { S.port = { W, empty: true }; return; }
  const set = { lam: S.market.defaults.ewma_lambda, limit: S.set.limit, targets: S.set.targets, erp: S.set.erp, dupTh: S.market.defaults.signals.dup_corr || 0.9 };
  const diag = E.diagnose(S.ctx, W.w, W.nav, set);
  const alerts = E.alerts(S.ctx, W.w, W.nav, diag, { limit: S.set.limit, targets: S.set.targets, ddWarn: S.set.ddWarn, moveTh: S.set.moveTh, dupTh: set.dupTh, rule: S.set.rule });
  S.port = { W, diag, alerts, set };
  S.rec = null;
  S.plans = null; S.simRes = null;
  later(() => {
    S.rec = E.recommend(S.ctx, W.w, W.nav, diag, set);
    if (diag.util > 1) calcPlans(S.planTarget || 0.9, true);
    if (S.view === "port") renderPort(); if (S.view === "home") renderHome(); if (S.view === "fr") renderFr();
  });
}

function curHoldings() { return S.holdings.filter(h => h.t && h.shares > 0); }
function calcPlans(target, quiet) {
  const P = S.port; if (!P || P.empty) return;
  S.planTarget = target;
  S.plans = E.limitPlans(S.ctx, curHoldings(), +S.cash || 0, P.diag.limAmt, { target, targets: S.set.targets, erp: P.set.erp || S.market.defaults.erp });
  if (!quiet && S.view === "port") renderPort();
}

// ───────── 헤더 ─────────
function renderHdr() {
  if (!S.market) { $("#hdr").innerHTML = S.loadError ? "데이터 없음" : '<span class="spin"></span> 불러오는 중…'; return; }
  const h = health(), m = S.market.meta;
  const col = { ok: "--good", warning: "--warn", critical: "--crit" }[h.lv];
  $("#hdr").innerHTML = `<span class="dot" style="background:var(${col})"></span>${h.txt} · 점검 ${m.generated} · 시세 ${m.price_date}${m.provisional ? " (장중 잠정)" : " 종가"}${m.demo ? " · 데모" : ""}`;
}

function notifyLine() {
  const st = S.status; if (!st) return "";
  const k = { ok: ["ok", "연결됨"], configured: ["ok", "설정됨"], expired: ["critical", "인증 만료 — 다시 연결 필요"], send_failed: ["warning", "전송 실패"], error: ["warning", "연결 오류"], off: ["mute", "꺼짐"] }[st.kakao] || ["mute", st.kakao];
  const sent = st.kakao_sent ? ` · 마지막 전송 ${kst(new Date(st.kakao_sent))}` : "";
  const warnPf = st.kakao !== "off" && !st.portfolio ? `<div class="note">보유내역이 동기화되지 않아 시장 알림만 갑니다 (설정 → 암호화해서 올리기)</div>` : "";
  const warnPw = st.kakao !== "off" && !st.password ? `<div class="note">PORTFOLIO_PASSWORD가 없어 카톡 연결을 자동 유지할 수 없습니다</div>` : "";
  return `<div class="alert" style="margin-top:8px">${badge(k[0], "카톡 알림")}<div class="t">${k[1]}${sent}${st.kakao === "expired" || st.kakao === "off" ? ' <a href="kakao.html">연결하기</a>' : ""}${warnPf}${warnPw}</div></div>`;
}

// ═════════ 홈 ═════════
function renderHome() {
  const el = $("#v-home");
  if (!S.market) { el.innerHTML = S.loadError ? `<div class="card"><h2>데이터를 불러오지 못했습니다</h2><p class="desc">${esc(S.loadError)}</p></div>` : spin("불러오는 중…"); return; }
  const h = health(), m = S.market.meta, rg = S.market.regime;
  let html = `<div class="card"><div class="spread"><h2>점검 상태</h2>${badge(h.lv, h.txt)}</div>
    <div class="grid2" style="margin-top:8px">
      <div class="kpi"><div class="l">마지막 점검</div><div class="v">${m.generated.slice(5)}</div><div class="s">${h.age < 1 ? Math.round(h.age * 60) + "분 전" : h.age.toFixed(1) + "시간 전"}</div></div>
      <div class="kpi"><div class="l">다음 자동 점검</div><div class="v">${h.next ? kst(h.next) : "–"}</div><div class="s">미장 중 매시간 · 매일 마감 후</div></div>
    </div>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="runNow">지금 점검</button><span class="note" id="runMsg">${S.token ? "누르면 3~5분 뒤 새 결과가 반영됩니다" : "설정에서 GitHub 토큰을 넣으면 쓸 수 있습니다"}</span></div>
    ${m.failed && m.failed.length ? `<p class="note">가격 수집 실패: ${m.failed.join(", ")}</p>` : ""}
    ${notifyLine()}</div>`;
  if (S.port && !S.port.empty) {
    const d = S.port.diag, vl = { "양호": "ok", "보통": "warning", "점검 필요": "critical" }[d.verdict];
    html += `<div class="card"><div class="spread"><h2>내 포트폴리오 진단</h2>${badge(vl, d.verdict)}</div>
      <p class="desc">총 ${won(S.port.W.nav)} · 위험 쪽 5개 항목 종합</p>
      ${d.items.map(i => `<div class="alert">${badge(["ok", "warning", "critical"][i.level], i.label)}<div class="t">${esc(i.text)}</div></div>`).join("")}
      <div style="margin-top:8px">${S.rec ? (S.rec.actions[0] ? `<b>지금 할 일 1순위:</b> ${esc(S.rec.actions[0].title)} — 변동성 ${sgp(S.rec.actions[0].dVolEwma)}, 1년 VaR ${won(S.rec.actions[0].var1y0)} → ${won(S.rec.actions[0].var1y1)}` : "추천할 변경 없음") : '<span class="spin"></span> 추천 계산 중'}
      <button class="btn" style="margin-left:6px" data-go="port">자세히</button></div></div>`;
    const A = S.port.alerts, act = A.filter(a => a.level !== "ok");
    html += `<div class="card"><h2>알림 상태</h2><p class="desc">알림이 없다면 아래 항목이 모두 기준 안에 있다는 뜻입니다. 오른쪽은 기준까지 남은 거리입니다.</p>
      ${(act.length ? act : []).concat(A.filter(a => a.level === "ok")).map(a => `<div class="alert">${badge(a.level, a.label)}${ib({ "중복 노출": "중복 노출", "상대강도(참고)": "상대강도", "리밸런싱": "리밸런싱", "정기 리밸런싱": "리밸런싱", "위험한도": "VaR" }[a.label] || "")}<div class="t">${esc(a.text)}<div class="d">${esc(a.dist || "")}</div></div></div>`).join("")}</div>`;
  } else {
    html += `<div class="card"><h2>내 포트폴리오</h2><p class="desc">보유 ETF와 주수를 입력하면 진단, VaR, 편입·편출 제안, 알림 상태가 여기에 표시됩니다. 입력한 내용은 이 휴대폰에만 저장됩니다.</p><button class="btn primary" data-go="port">보유내역 입력</button></div>`;
  }
  const sb = rg.stock_bond_corr63;
  html += `<div class="card"><h2>시장 국면</h2>
    <div class="grid2 g-md-3">
      <div class="kpi"><div class="l">S&P500 추세</div><div class="v">${rg.spy_above_10m ? "10개월선 위" : "10개월선 아래"}</div><div class="s">고점 대비 ${pct(rg.spy_dd)}</div></div>
      <div class="kpi"><div class="l">주식–채권 상관 (3개월)</div><div class="v">${num(sb)}</div><div class="s">1년 ${num(rg.stock_bond_corr252)} · ${sb > 0.2 ? "채권 헤지 약함" : sb < -0.2 ? "채권 헤지 작동" : "중립"}</div></div>
      <div class="kpi"><div class="l">S&P500 최근 3개월</div><div class="v">${sg(rg.spy_ret3m)}</div><div class="s">무위험 ${pct(m.rf_now, 2)} · 원/달러 ${Math.round(m.fx_now).toLocaleString()}</div></div>
    </div></div>`;
  el.innerHTML = html;
  const rb = $("#runNow"); if (rb) rb.onclick = runNow;
  el.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
}

// ═════════ 내 포트 ═════════
function holdingsEditor() {
  const opts = E.tickers(S.ctx).sort().map(t => `<option value="${t}">${esc(S.market.names[t] || "")}</option>`).join("");
  const rows = (S.holdings.length ? S.holdings : [{ t: "", shares: "" }]).map((h, i) =>
    `<div class="hold-row"><input list="tk" placeholder="티커 (예: SPMO)" value="${esc(h.t)}" data-k="t" data-i="${i}" autocapitalize="characters"><input type="number" inputmode="decimal" placeholder="주수" value="${h.shares}" data-k="shares" data-i="${i}"><button class="btn" data-del="${i}">삭제</button></div>`).join("");
  return `<div class="card"><h2>보유내역</h2><p class="desc">ETF·종목과 보유 주수. 이 휴대폰에만 저장되며, 텔레그램 알림을 원하면 설정에서 암호화 동기화를 켜세요.</p>
    <datalist id="tk">${opts}</datalist><div id="hrows">${rows}</div>
    <div class="row"><button class="btn" id="addRow">+ 종목 추가</button></div>
    <div class="row" style="margin-top:8px"><label class="small">원화 현금</label><input type="number" inputmode="numeric" id="cash" value="${S.cash || ""}" placeholder="0" style="flex:1"></div>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="saveH">저장하고 분석</button><span class="note" id="hmsg"></span></div></div>`;
}
function readHoldings() {
  const H = [];
  document.querySelectorAll("#hrows .hold-row").forEach(r => {
    const t = r.querySelector('[data-k="t"]').value.trim().toUpperCase().replace(".", "-"), s = parseFloat(r.querySelector('[data-k="shares"]').value);
    if (t) H.push({ t, shares: Number.isFinite(s) ? s : 0 });
  });
  return H;
}
function renderPort() {
  const el = $("#v-port");
  if (!S.ctx) { el.innerHTML = spin(); return; }
  let html = holdingsEditor();
  const P = S.port;
  if (P && !P.empty) {
    const W = P.W, d = P.diag, V = d.V, C = d.C, m = S.set.varMethod;
    if (W.missing.length) html += `<div class="banner">${W.missing.join(", ")}: 아직 시세 데이터가 없어 계산에서 빠져 있습니다. 보유내역이 알림 서버에 올라가 있으면 다음 자동 점검 때 시세를 받아옵니다(홈의 '지금 점검'을 누르면 3~5분).</div>`;
    const vl = { "양호": "ok", "보통": "warning", "점검 필요": "critical" }[d.verdict];
    html += `<div class="card"><div class="spread"><h2>진단</h2>${badge(vl, d.verdict)}</div>
      ${d.items.map(i => `<div class="alert">${badge(["ok", "warning", "critical"][i.level], i.label)}<div class="t">${esc(i.text)}</div></div>`).join("")}
      <h3>최근 작동 (설명용)</h3>
      ${table(["기간", "내 포트", "S&P500", "60/40"], Object.entries(d.recent).map(([k, r]) => [k, sg(r.port), sg(r.spy), sg(r.b6040)]))}
      <p class="note">최근 성과는 '현 시장에서 어땠는지'를 보여줄 뿐, 앞으로의 성과를 예측하지 않습니다(검증 결과는 시장 탭).</p></div>`;
    // 보유 현황
    const tk = Object.keys(W.w).sort((a, b) => W.w[b] - W.w[a]);
    html += `<div class="card"><h2>보유 현황</h2><p class="desc">총 ${won(W.nav)} · 위험기여 = 그 종목이 포트폴리오 변동성에서 차지하는 몫 (EWMA ≈ 최근 1개월 / 3년)</p>
      ${table(["종목", "평가액", "비중", "위험기여(최근)", "위험기여(3년)", "연변동성(최근)", "상대강도"], tk.map(t => [t, won(W.values[t]), pct(W.w[t]), C[t] ? pct(C[t].ewma) : "–", C[t] ? pct(C[t].y3) : "–", C[t] ? pct(C[t].ewma_vol) : "–", S.market.rs[t] ? badge(stateLevel(S.market.rs[t].state), S.market.rs[t].state) : "–"]))}</div>`;
    // VaR
    const util = d.util, ucol = util > 1 ? "--crit" : util > S.set.limit.warn ? "--warn" : "--good";
    const rows = E.HORIZONS.map(([h, lab]) => { const r = V[m][h]; if (!r) return null; return [lab, `${won(r[0.95].amt)}<br><span class="note">${pct(r[0.95].pct)}</span>`, `${won(r[0.99].amt)}<br><span class="note">${pct(r[0.99].pct)}</span>`, `${won(r[0.95].es_amt)}`]; }).filter(Boolean);
    html += `<div class="card"><h2>VaR (원화 기준, 환율 위험 포함) ${ib("VaR")}</h2>
      <div class="seg" id="varSeg">${[["boot", "블록 부트스트랩"], ["ewma", "EWMA(최근 변동성)"], ["hs250", "역사적 250일"]].map(([k, l]) => `<button data-k="${k}" class="${k === m ? "on" : ""}">${l}</button>`).join("")}</div>
      <p class="desc">${{ boot: `최근 ${V.years}년 일간 수익을 21일 블록으로 1만 번 재표본. 기대 초과수익 0 가정.`, ewma: "최근 변동성(λ=0.94, 체감 약 1개월)이 그대로 이어진다고 가정한 정규 근사.", hs250: "최근 250거래일 실제 손익. 10일은 √10 환산(바젤 관행)." }[m]}</p>
      ${table(["기간", "95% VaR", "99% VaR", "95% ES"], rows)}
      <h3>위험한도: ${S.set.limit.h === 252 ? "1년" : S.set.limit.h + "일"} ${Math.round(S.set.limit.c * 100)}% VaR ≤ ${won(d.limAmt)} ${ib("위험한도")}</h3>
      ${d.qStart ? `<p class="note">분기초(${d.qStart.date}) 평가액 ${won(d.qStart.value)}의 ${pct(S.set.limit.pct, 0)} · 분기 들어 ${sg(d.qStart.chg)} · 위험자산 비중 ${pct(d.riskyK, 0)}${d.k0 ? ` (기본 ${pct(d.k0, 0)})` : ""}</p>` : ""}
      <div class="meter" role="img" aria-label="사용률 ${pct(util, 0)}"><i style="width:${Math.min(util, 1.5) / 1.5 * 100}%;background:var(${ucol})"></i><b style="left:${100 / 1.5}%"></b></div>
      <div class="note">사용률 ${pct(util, 0)} (부트스트랩 기준) · 세로선 = 한도 100%</div>${limActHtml(d)}</div>`;
    html += plansCard(d) + simCard();
    // 추천
    html += `<div class="card"><h2>지금 할 일</h2><p class="desc">예측이 잘 되는 위험(상관·변동성·중복 노출)을 근거로 고른 변경안. 기대수익 가정 세 가지 모두에서 샤프가 좋아지면 '견고한 개선'.</p><div id="recBox">${S.rec ? recHtml() : spin("편입·편출 효과 계산 중…")}</div></div>`;
    // 스트레스
    html += `<div class="card"><h2>과거 위기 재현 (현재 비중)</h2>${table(["위기", "유형", "원화", "달러", "S&P500"], d.S.map(s => [s.name, s.type, s.krw === null ? "데이터 없음" : sg(s.krw), sg(s.usd), sg(s.spy)]))}
      <p class="note">원화와 달러의 차이 = 환율 효과. 상장 전 구간은 비슷한 ETF로 이어 붙였습니다.</p></div>`;
    const rule = S.set.rule, tg = S.set.targets || null, tw = tg || Object.fromEntries(Object.entries(W.w));
    const RC = E.ruleCompare(S.ctx, tw, rule), SLV = rule.basis === "sleeve" ? E.sleeveOf(tw).sleeve : null, TGV = SLV || tg, BD = TGV ? E.bands(TGV, rule) : {};
    const kNow = E.riskyShare(W.w), curOf = t => SLV ? (kNow > 0 ? (W.w[t] || 0) / kNow : 0) : (W.w[t] || 0), baseV = SLV ? kNow * W.nav : W.nav;
    html += `<div class="card"><h2>리밸런싱 ${ib("리밸런싱")}</h2>
      <p class="desc">현재 규칙: <b>${E.RULES[rule.mode]}</b>${rule.mode === "calendar" || rule.mode === "both" ? ` · ${E.FREQ[rule.freq]}` : ""}${rule.mode === "band" || rule.mode === "both" ? ` · ±${pct(rule.abs, 0)}p${rule.rel > 0 ? ` 또는 ±${pct(rule.rel, 0)} 중 좁은 쪽` : ""}` : ""} ${SLV ? " · <b>위험자산 안 비율 기준</b>" : ""} (설정에서 변경) · 목표비중: ${tg ? "설정됨" : "미설정 → 현재 비중을 목표로 가정"}</p>
      ${tg ? table(["종목", SLV ? "현재(위험자산 안)" : "현재", "목표", "허용범위", "상태"], Object.keys(TGV).map(t => { const c = curOf(t), g = TGV[t], dv = c - g, out = Math.abs(dv) > BD[t]; return [t, pct(c), pct(g, 0), `${pct(Math.max(0, g - BD[t]))} ~ ${pct(g + BD[t])}`, rule.mode === "none" ? "–" : out ? badge("warning", `${dv > 0 ? "매도" : "매수"} ${won(Math.abs(dv) * baseV)}`) : '<span class="pill">유지</span>']; })) : ""}
      ${SLV ? `<p class="note">위험자산 전체 크기(지금 ${pct(kNow, 0)})는 위험한도가 조절하고, 여기서는 위험자산끼리의 비율만 맞춥니다.</p>` : ""}
      <h3>규칙별 과거 10년 비교 (원화, 목표비중으로 시작)</h3>
      ${table(["규칙", "연수익", "변동성", "최대낙폭", "매매 횟수/년", "회전율/년"], RC.map(r => [`${r.mine ? "<b>▶ " : ""}${esc(r.label)}${r.mine ? "</b>" : ""}`, pct(r.cagr), pct(r.vol), pct(r.mdd), num(r.rebPerYear, 1), pct(r.turnPerYear, 0)]))}
      <p class="note">${RC[0].from}부터 계산. 회전율이 높을수록 양도세(연 250만원 공제 후 22%)와 매매비용이 커집니다. VaR와 투자선은 '현재 비중 유지'를 가정합니다. 바이앤홀드로 10년 두면 비중이 ${Object.entries(RC[0].driftW).map(([k, v]) => `${k} ${pct(v, 0)}`).join(", ")}로 바뀝니다.</p></div>`;
    html += `<div class="card"><h2>보유 종목 간 상관 (중복 노출) ${ib("중복 노출")}</h2>${table(["쌍", "3개월", "6개월", "12개월"], d.D.map(x => [`${x.a}–${x.b}`, num(x.c63), num(x.c126), num(x.c252)]))}<p class="note">6개월 상관 ${S.market.defaults.signals.dup_corr || 0.9} 초과 = 같은 위험을 두 번 지는 상태.</p></div>`;
  } else if (P && P.empty) html += `<div class="card empty">입력한 종목의 가격 데이터가 아직 없습니다.</div>`;
  el.innerHTML = html;
  bindHoldings();
  const vs = $("#varSeg"); if (vs) vs.querySelectorAll("button").forEach(b => b.onclick = () => { S.set.varMethod = b.dataset.k; saveSet(); renderPort(); });
  bindRec(); bindPlans(); bindSim();
}
function limActHtml(d) {
  const a = d.limAct;
  if (!a) return `<p class="note" style="margin-top:6px">조치 필요 없음 · 105% 넘으면 줄이고, 70% 아래면서 위험자산이 기본 비중보다 작으면 다시 늘립니다.</p>`;
  if (a.kind === "cut") return a.reachable
    ? `<div class="banner" style="margin-top:10px">한도 초과 — 목표 비율대로 위험자산 ${pct(a.k, 0)} → ${pct(a.kNew, 0)}(${won(a.amt)}어치)로 줄여 SGOV로 옮기면 사용률 90%가 됩니다. 아래 <b>한도 맞춤 재편안 ①</b>과 같은 계산이며, 종목별 주수와 다른 방법(원화 현금·위험 큰 종목 위주·다른 ETF 편입)도 거기 있습니다.</div>`
    : `<div class="banner" style="margin-top:10px">한도 초과 — SGOV도 원화로 보면 환율 위험이 있어, SGOV로만 옮겨서는 VaR가 ${won(a.vFloor)} 아래로 내려가지 않습니다. 아래 재편안의 원화 현금·다른 ETF 안을 보세요.</div>`;
  const fx = S.market.meta.fx_now, lp = S.market.last_px;
  const rows = Object.entries(a.trades).filter(([, v]) => Math.abs(v) >= 1e4).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
    .map(([t, v]) => [t, `${v > 0 ? "매수" : "매도"} ${won(Math.abs(v))}`, lp[t] ? `약 ${Math.round(Math.abs(v) / (lp[t] * fx))}주` : "–"]);
  return `<div class="action" style="margin-top:10px"><div class="spread"><span class="h">${a.kind === "cut" ? "한도 초과 — 위험자산 줄이기" : "여유 생김 — 위험자산 다시 늘리기"}</span>${badge(a.kind === "cut" ? "critical" : "info", `${pct(a.k, 0)} → ${pct(a.kNew, 0)}`)}</div>
    ${table(["종목", "매매", "주수"], rows)}<p class="note">${a.kind === "cut" ? "모든 위험자산을 같은 비율로 줄여 위험자산 안의 비율은 그대로 둡니다." : "목표비중의 위험자산 안 비율대로 삽니다."} 주수는 오늘 가격 기준 근사입니다.</p></div>`;
}
// ───────── 한도 맞춤 재편안 ─────────
const wonS = x => (x > 0 ? "+" : x < 0 ? "−" : "") + won(Math.abs(x));
function tradeTable(T) {
  return table(["종목", "매매", "주수", "금액"], T.map(x => [x.t, x.d > 0 ? '<span class="pos">매수</span>' : '<span class="neg">매도</span>', `${x.from} → <b>${x.to}</b> (${x.d > 0 ? "+" : ""}${Math.round(x.d * 1000) / 1000})`, x.amt === null ? "–" : wonS(x.amt)]));
}
function plansCard(d) {
  const tg = S.planTarget || 0.9, P = S.plans;
  let body;
  if (!P) body = d.util > 1 ? spin("재편안 계산 중…") : `<p class="desc">지금은 한도 안(사용률 ${pct(d.util, 0)})이라 자동으로 계산하지 않았습니다. 미리 보려면 목표 사용률을 고르고 '계산'을 누르세요.</p>`;
  else if (!P.need) body = `<p class="desc">현재 사용률 ${pct(P.util0, 0)}로 이미 목표(${pct(tg, 0)}) 안입니다.</p>`;
  else if (!P.plans.length) body = `<p class="desc">위험자산을 모두 줄여도 목표에 닿지 않습니다. 목표 사용률을 높이거나 한도를 다시 정해 주세요.</p>`;
  else body = (P.floorSGOV && !P.floorSGOV.reachable ? `<div class="banner">SGOV로 옮기는 것만으로는 목표에 닿지 않습니다. SGOV도 원화로 보면 환율 위험이 있어서, 위험자산을 ${pct(P.floorSGOV.k, 0)}까지 줄였을 때 1년 VaR ${won(P.floorSGOV.var)}가 최저입니다. 원화 현금·다른 ETF 안을 보세요.</div>` : "") + P.plans.map((p, i) => {
    const c = p.check;
    return `<div class="action"><div class="spread"><span class="h">${["①", "②", "③", "④", "⑤", "⑥"][i]} ${esc(p.title)}</span>${badge(c.util <= 1 ? "ok" : "critical", `사용률 ${pct(c.util, 0)}`)}</div>
      <div class="note" style="margin:4px 0 8px">${esc(p.why)}</div>
      <div class="grid2 g-md-3">
        <div class="kpi"><div class="l">1년 95% VaR</div><div class="v">${won(c.var1y)}</div><div class="s">현재 ${won(P.var0)}</div></div>
        <div class="kpi"><div class="l">균형 기대수익 ${ib("균형 기대수익")}</div><div class="v">${pct(p.er1, 1)}</div><div class="s">현재 ${pct(p.er0, 1)} · 연</div></div>
        <div class="kpi"><div class="l">최악의 위기</div><div class="v">${c.worst ? sg(c.worst.krw) : "–"}</div><div class="s">${c.worst ? esc(c.worst.name) : ""}</div></div>
      </div>
      <details style="margin-top:8px"><summary>매매 ${p.trades.length}건 보기 (주수)</summary>${tradeTable(p.trades)}<p class="note">매매 후 남는 원화 현금 약 ${won(p.cash)}. 오늘 가격·환율 기준, 정수 주로 맞춘 뒤 VaR를 다시 계산한 값입니다.</p></details>
      <div class="row" style="margin-top:8px"><button class="btn" data-plan="${i}">시뮬레이터에 넣기</button></div></div>`;
  }).join("") + `<p class="note">균형 기대수익이 높을수록 같은 한도 안에서 수익 여지를 더 남긴 안입니다. ③ 이후는 후보 ETF 중 최대 30%까지 편입해 보고 가장 나은 것만 보여줍니다. 계산 창: 최근 ${P.years}년.</p>`;
  return `<div class="card"><h2>한도 맞춤 재편안 ${ib("한도 맞춤 재편안")}</h2>
    <div class="row"><label class="small">목표 사용률</label><select id="planT">${[0.7, 0.8, 0.9, 1].map(x => `<option value="${x}" ${Math.abs(x - tg) < 1e-9 ? "selected" : ""}>${pct(x, 0)}</option>`).join("")}</select><button class="btn" id="planGo">계산</button><span class="note">한도 ${won(d.limAmt)}</span></div>
    <div id="planBox" style="margin-top:8px">${body}</div></div>`;
}
function bindPlans() {
  const g = $("#planGo"); if (!g) return;
  g.onclick = () => { $("#planBox").innerHTML = spin("재편안 계산 중…"); later(() => calcPlans(+$("#planT").value)); };
  document.querySelectorAll("[data-plan]").forEach(b => b.onclick = () => {
    const p = S.plans.plans[+b.dataset.plan]; const H0 = curHoldings();
    const rows = H0.map(h => ({ t: h.t, now: h.shares, shares: 0 }));
    for (const h of p.holdings) { const r = rows.find(x => x.t === h.t); if (r) r.shares = h.shares; else rows.push({ t: h.t, now: 0, shares: h.shares }); }
    S.sim = { rows }; runSim(); renderPort(); const el = $("#simCard"); if (el) el.scrollIntoView({ behavior: "smooth" });
  });
}
// ───────── 재편 시뮬레이션 ─────────
function simRows() { if (!S.sim) S.sim = { rows: curHoldings().map(h => ({ t: h.t, now: h.shares, shares: h.shares })) }; return S.sim.rows; }
function simCard() {
  const opts = E.tickers(S.ctx).sort().map(t => `<option value="${t}">${esc(S.market.names[t] || "")}</option>`).join("");
  const R = simRows(), lp = S.market.last_px, fx = S.market.meta.fx_now;
  let html = `<div class="card" id="simCard"><h2>재편 시뮬레이션</h2><p class="desc">바꿀 주수를 넣고 '계산'을 누르면 같은 한도·같은 계산 창으로 지금과 비교합니다. 매매 차액은 원화 현금으로 처리합니다.</p>
    <datalist id="tk2">${opts}</datalist>
    <div class="tbl"><table><thead><tr><th>종목</th><th>지금</th><th>바꾼 뒤</th><th>평가액</th></tr></thead><tbody>${R.map((r, i) => `<tr>
      <td>${r.now ? esc(r.t) : `<input list="tk2" data-st="${i}" value="${esc(r.t)}" placeholder="티커" style="width:84px" autocapitalize="characters">`}</td><td>${r.now || 0}</td>
      <td><input type="number" inputmode="decimal" data-ss="${i}" value="${r.shares}" style="width:80px"></td><td class="small">${lp[r.t] ? won(r.shares * lp[r.t] * fx) : "–"}</td></tr>`).join("")}</tbody></table></div>
    <div class="row" style="margin-top:8px"><button class="btn" id="simAdd">+ 종목 추가</button><button class="btn" id="simReset">지금으로 되돌리기</button><button class="btn primary" id="simGo">계산</button></div>
    <div id="simOut" style="margin-top:10px">${S.simRes ? simResHtml() : ""}</div></div>`;
  return html;
}
function readSim() {
  const R = simRows();
  document.querySelectorAll("[data-ss]").forEach(el => { const v = parseFloat(el.value); R[+el.dataset.ss].shares = Number.isFinite(v) && v > 0 ? v : 0; });
  document.querySelectorAll("[data-st]").forEach(el => { R[+el.dataset.st].t = el.value.trim().toUpperCase().replace(".", "-"); });
}
function runSim() {
  const P = S.port, R = simRows(), lp = S.market.last_px, fx = S.market.meta.fx_now;
  const H0 = curHoldings(), H1 = R.filter(r => r.t && r.shares > 0).map(r => ({ t: r.t, shares: r.shares }));
  const unknown = H1.filter(h => !S.ctx.R[h.t] || !lp[h.t]).map(h => h.t);
  const val = H => H.reduce((a, h) => a + (lp[h.t] ? h.shares * lp[h.t] * fx : 0), 0);
  const cash0 = +S.cash || 0, diff = val(H0) - val(H1), cash1 = Math.max(0, cash0 + diff);
  const C = E.compareHoldings(S.ctx, H0, cash0, H1.filter(h => unknown.indexOf(h.t) < 0), cash1, { limAmt: P.diag.limAmt, erp: P.set.erp || S.market.defaults.erp });
  S.simRes = { C, cash0, cash1, deposit: Math.max(0, -(cash0 + diff)), unknown, H1 };
}
function simResHtml() {
  const { C, cash1, deposit, unknown } = S.simRes, a = C.a, b = C.b;
  if (!b) return `<p class="desc">계산할 종목이 없습니다.</p>`;
  const row = (lab, x, y, f, better) => { const d = Number.isFinite(x) && Number.isFinite(y) ? y - x : null; return [lab, f(x), `<b>${f(y)}</b>`, d === null || Math.abs(d) < 1e-9 ? "" : `<span class="${better === "none" ? "" : (better === "low" ? d < 0 : d > 0) ? "pos" : "neg"}">${better === "low" ? (d < 0 ? "▼" : "▲") : (d > 0 ? "▲" : "▼")}</span>`]; };
  const rows = [
    row("평가액(현금 포함)", a.nav, b.nav, won), row("SGOV·현금 외 비중", a.k, b.k, x => pct(x, 0), "none"),
    row("1년 95% VaR", a.var1y, b.var1y, won, "low"), row("한도 사용률", a.util, b.util, x => pct(x, 0), "low"),
    row("1년 95% ES", a.es1y, b.es1y, won, "low"), row("3개월 95% VaR", a.var3m, b.var3m, won, "low"), row("1개월 95% VaR", a.var1m, b.var1m, won, "low"), row("10일 95% VaR", a.var10d, b.var10d, won, "low"), row("1일 99% VaR", a.var1d99, b.var1d99, won, "low"),
    row("연변동성(최근)", a.volNow, b.volNow, x => pct(x, 1), "low"), row("연변동성(3년)", a.vol3y, b.vol3y, x => pct(x, 1), "low"),
    row("최악의 위기", a.worst && a.worst.krw, b.worst && b.worst.krw, x => pct(x, 1)), row("균형 기대수익(연)", a.er, b.er, x => pct(x, 1)),
  ];
  return `${badge(b.util <= 1 ? "ok" : "critical", b.util <= 1 ? "한도 안" : "한도 초과")}
    ${table(["", "지금", "바꾼 뒤", ""], rows)}
    <p class="note">VaR 계산 창: 두 포트 공통 구간의 최근 ${b.years}년 · 한도 ${won(S.port.diag.limAmt)} 고정 · 최악의 위기: ${b.worst ? esc(b.worst.name) : "–"}</p>
    ${unknown.length ? `<div class="banner">${unknown.join(", ")}: 시세 데이터가 없어 계산에서 뺐습니다.</div>` : ""}
    ${deposit > 0 ? `<div class="banner">매수가 매도보다 ${won(deposit)} 많습니다 — 추가 입금으로 가정했습니다.</div>` : `<p class="note">매매 후 원화 현금 ${won(cash1)}</p>`}
    ${C.trades.length ? `<h3>매매 목록</h3>${tradeTable(C.trades)}` : ""}
    <div class="row" style="margin-top:8px"><button class="btn" id="simApply">이 구성으로 보유내역 바꾸기</button><span class="note" id="simMsg"></span></div>`;
}
function bindSim() {
  const go = $("#simGo"); if (!go) return;
  document.querySelectorAll("[data-ss],[data-st]").forEach(el => el.oninput = readSim);
  $("#simAdd").onclick = () => { readSim(); simRows().push({ t: "", now: 0, shares: 0 }); renderPort(); };
  $("#simReset").onclick = () => { S.sim = null; S.simRes = null; renderPort(); };
  go.onclick = () => { readSim(); $("#simOut").innerHTML = spin("계산 중…"); later(() => { runSim(); $("#simOut").innerHTML = simResHtml(); bindSimApply(); }); };
  bindSimApply();
}
function bindSimApply() {
  const b = $("#simApply"); if (!b) return;
  b.onclick = () => {
    if (!b.dataset.ok) { b.dataset.ok = 1; b.textContent = "한 번 더 누르면 실제 보유내역이 바뀝니다"; return; }
    S.holdings = S.simRes.H1.map(h => ({ t: h.t, shares: h.shares })); S.cash = Math.round(S.simRes.cash1);
    LS.set("holdings", S.holdings); LS.set("cash", S.cash); S.sim = null; S.simRes = null;
    computePort(); renderPort(); renderHome();
    const pw = LS.get("pw", ""); if (S.token && pw) syncUp(pw).catch(() => { });
    window.scrollTo(0, 0);
  };
}
function recHtml() {
  const A = S.rec.actions; if (!A.length) return `<p class="desc">위험 측면에서 뚜렷하게 개선되는 변경안이 없습니다.</p>`;
  return A.map((a, i) => {
    const ok = Object.entries(a.dSharpe).map(([k, v]) => `${{ hist: "과거평균", shrink: "축소", capm: "균형" }[k]} ${v >= 0 ? "+" : ""}${v.toFixed(3)}${v > 0.005 ? " ✓" : ""}`).join(" · ");
    return `<div class="action"><div class="spread"><span class="h">${i + 1}. ${esc(a.title)}</span>${a.robust ? badge("ok", "견고한 개선") + ib("견고한 개선") : a.better >= 2 ? badge("info", `${a.better}/3 개선`) : badge("mute", "위험만 감소")}</div>
      <div class="note" style="margin:4px 0 8px">근거: ${esc(a.why)}</div>
      <div class="grid2 g-md-3">
        <div class="kpi"><div class="l">연변동성 (최근 / 3년)</div><div class="v">${sgp(a.dVolEwma)}</div><div class="s">${pct(a.volEwma0)}→${pct(a.volEwma1)} / ${pct(a.vol3y0)}→${pct(a.vol3y1)}</div></div>
        <div class="kpi"><div class="l">1년 95% VaR</div><div class="v">${won(a.var1y1)}</div><div class="s">현재 ${won(a.var1y0)} · ${a.varYears}년 표본</div></div>
        <div class="kpi"><div class="l">최악의 위기 (${a.nStress}개 비교)</div><div class="v">${sg(a.worst1)}</div><div class="s">현재 ${sg(a.worst0)}</div></div>
      </div>
      <div class="note" style="margin-top:6px">샤프 변화: ${ok}</div>
      <div class="row" style="margin-top:8px"><button class="btn" data-fr="${i}">투자선에서 보기</button></div></div>`;
  }).join("") + `<p class="note">수익 쪽 신호(상대강도·마진)는 검증상 예측력이 거의 없어 추천 근거에서 제외했습니다.</p>`;
}
function bindRec() { document.querySelectorAll("[data-fr]").forEach(b => b.onclick = () => { S.overlay = +b.dataset.fr; S.frIdx = null; S.frZoom = true; S.frZoomRange = null; go("fr"); }); }
function bindHoldings() {
  const sync = () => { S.holdings = readHoldings(); };
  const ar = $("#addRow"); if (!ar) return;
  ar.onclick = () => { sync(); S.holdings.push({ t: "", shares: "" }); renderPort(); };
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { sync(); S.holdings.splice(+b.dataset.del, 1); renderPort(); });
  $("#saveH").onclick = () => {
    sync(); S.holdings = S.holdings.filter(h => h.t && h.shares > 0); S.cash = +($("#cash").value || 0);
    LS.set("holdings", S.holdings); LS.set("cash", S.cash);
    const unk = S.holdings.filter(h => !S.ctx.R[h.t]).map(h => h.t);
    const msg = unk.length ? `저장됨. ${unk.join(", ")}는 다음 점검부터 반영` : "저장됨";
    computePort(); renderPort(); renderHome();
    const pw = LS.get("pw", "");
    if (S.token && pw) {
      $("#hmsg").innerHTML = msg + ' · <span class="spin"></span> 알림 서버에 올리는 중';
      syncUp(pw).then(() => { const m = $("#hmsg"); if (m) m.textContent = msg + " · 알림 서버에도 반영됨"; })
        .catch(e => { const m = $("#hmsg"); if (m) m.textContent = msg + " · 알림 서버 반영 실패: " + (e.message || e); });
    } else $("#hmsg").textContent = msg + (S.token ? "" : " (알림 서버 반영은 설정에서 한 번 연결)");
  };
}

// ═════════ 시장 ═════════
function renderMkt() {
  const el = $("#v-mkt"); if (!S.market) { el.innerHTML = spin(); return; }
  const tabs = [["rs", "달리는 말"], ["pair", "짝 찾기"], ["mg", "마진"]];
  el.innerHTML = `<div class="seg" id="mktSeg">${tabs.map(([k, l]) => `<button data-k="${k}" class="${k === S.mkt ? "on" : ""}">${l}</button>`).join("")}</div><div id="mktBody"></div>`;
  el.querySelectorAll("#mktSeg button").forEach(b => b.onclick = () => { S.mkt = b.dataset.k; renderMkt(); });
  ({ rs: renderRS, pair: renderPair, mg: renderMg })[S.mkt]();
}
function renderRS() {
  const M = S.market, R = M.rs, V = M.rs_val || {}, bt = M.rs_bt || {};
  const keys = Object.keys(R).sort((a, b) => R[b].rel6 - R[a].rel6);
  if (!S.rsSel || !R[S.rsSel]) S.rsSel = keys[0];
  const ic = V.ic || {};
  let html = `<div class="card"><h2>S&P500 대비 상대강도 ${ib("상대강도")}</h2>
    <div class="banner">이 신호는 <b>지금 S&P500보다 강한지 약한지</b>를 보여줄 뿐, 앞으로를 예측하지 못했습니다. ${V.start || ""}~ ${V.n || ""}개 월말 표본에서 이후 6개월 상대수익과의 순위상관: 1개월 ${num(ic.rel1 && ic.rel1.f6)}, 3개월 ${num(ic.rel3 && ic.rel3.f6)}, 6개월 ${num(ic.rel6 && ic.rel6.f6)}, 추세선 ${num(ic.gap && ic.gap.f6)}. '약세 전환' 신호 뒤 6개월간 실제로 S&P500에 뒤진 비율 ${pct(bt.down ? bt.down.hit6 : NaN, 0)}(${bt.down ? bt.down.n : 0}회), 신호가 뜰 땐 이미 상대강도가 평균 ${pct(bt.down ? -bt.down.lag_median : NaN, 1)} 빠진 뒤였습니다.</div>
    <p class="desc">상태: 강세 · 약화 조짐 · 중립 · 회복 조짐 · 약세 — 상대강도선(ETF÷S&P500)과 그 10개월 이동평균, 1·3·6개월 상대수익으로 판정. 상승장 포착률 = S&P500이 오른 달에 몇 배 올랐나(3년).</p>
    ${table(["ETF", "상태", "1개월", "3개월", "6개월", "12개월", "추세선 대비", "상승장 포착", "하락장 포착"], keys.map(t => { const r = R[t]; return [`<b>${t}</b> <span class="note">${esc(r.name)}</span>`, badge(stateLevel(r.state), r.state), sg(r.rel1), sg(r.rel3), sg(r.rel6), sg(r.rel12), sg(r.gap), num(r.cap3y.up), num(r.cap3y.down)]; }), { click: true, sel: i => keys[i] === S.rsSel })}</div>`;
  const r = R[S.rsSel];
  html += `<div class="card"><div class="spread"><h2>${S.rsSel} 상대강도선</h2>${badge(stateLevel(r.state), r.state + " · " + r.since + "~")}</div>
    <p class="desc">ETF÷S&P500 (3년 전=100). 선이 이동평균 위면 S&P500보다 강한 추세. 직전 상태: ${r.prev_state || "–"}</p>
    <div class="chart" id="cRS"></div>
    <p class="note">이 ETF의 과거 전환 신호: 약세 전환 ${r.bt.down.n || 0}회(이후 6개월 상대수익 평균 ${sg(r.bt.down.mean6)}), 회복 전환 ${r.bt.up.n || 0}회(평균 ${sg(r.bt.up.mean6)}), 연 ${num(r.bt.flips_per_year, 1)}회 전환. 절대 모멘텀(12개월 수익 vs 무위험): ${r.abs_mom ? "플러스" : "마이너스"} (${sg(r.abs12)})</p></div>`;
  $("#mktBody").innerHTML = html;
  $("#mktBody").querySelectorAll("tr.click").forEach(tr => tr.onclick = () => { S.rsSel = keys[+tr.dataset.i]; renderRS(); });
  plot("cRS", [
    { x: r.chart.d, y: r.chart.rs, mode: "lines", name: "상대강도", line: { color: css("--s1"), width: 2 }, hovertemplate: "%{x}<br>%{y:.1f}<extra>상대강도</extra>" },
    { x: r.chart.d, y: r.chart.sma, mode: "lines", name: "10개월 이동평균", line: { color: css("--s2"), width: 2 }, hovertemplate: "%{y:.1f}<extra>10개월 평균</extra>" }],
    { hovermode: "x unified", showlegend: true });
}
function renderPair() {
  const M = S.market, runners = M.groups.runners.filter(t => S.ctx.R[t]);
  const hasPort = S.port && !S.port.empty;
  if (!S.basket) S.basket = hasPort ? ["__port"] : ["SOXX"];
  const chips = (hasPort ? [["__port", "내 포트(위험자산)"]] : []).concat(runners.map(t => [t, t]));
  $("#mktBody").innerHTML = `<div class="card"><h2>짝 찾기 — 상관이 낮거나 낮아지는 ETF ${ib("상관 낮음")}</h2>
    <div class="banner ok">상관은 예측이 잘 되는 편입니다. 6개월 상관 → 다음 6개월 상관: 상관계수 0.89(평균 오차 ±0.14), 하락장 상관 0.81 (2006~2026, 검증).</div>
    <p class="desc">기준이 될 '달리는 말'을 고르세요 (여러 개면 동일 비중 바스켓).</p>
    <div class="chips">${chips.map(([k, l]) => `<span class="chip ${S.basket.includes(k) ? "on" : ""}" data-k="${k}">${l}</span>`).join("")}</div>
    <div id="pairBox">${spin()}</div></div>`;
  $("#mktBody").querySelectorAll(".chip").forEach(c => c.onclick = () => {
    const k = c.dataset.k;
    if (k === "__port") S.basket = ["__port"]; else { S.basket = S.basket.filter(x => x !== "__port"); S.basket = S.basket.includes(k) ? S.basket.filter(x => x !== k) : [...S.basket, k]; if (!S.basket.length) S.basket = [k]; }
    renderPair();
  });
  later(() => {
    let bw = {};
    if (S.basket[0] === "__port") { const w = S.port.W.w; for (const t in w) if (t !== E.CASH && t !== "SGOV") bw[t] = w[t]; }
    else S.basket.forEach(t => { bw[t] = 1 / S.basket.length; });
    const cands = [...new Set([...M.groups.candidates, ...M.groups.runners])];
    const P = E.pairs(S.ctx, bw, cands, { low: M.defaults.signals.pair_low_corr, drop: M.defaults.signals.pair_drop });
    const box = $("#pairBox"); if (!box) return;
    box.innerHTML = `<p class="note">정렬: 10% 편입 시 변동성 감소가 큰 순 (최근 EWMA와 3년의 평균). 하락장 상관 = 기준 바스켓이 떨어진 날만 계산.</p>
      ${table(["ETF", "신호", "6개월", "12개월", "1개월", "3개월", "하락장 1년", "하락장 3년", "10% 편입 시 변동성"], P.slice(0, 25).map(p => [`<b>${p.t}</b> <span class="note">${esc(p.name)}</span>`, p.tags.map(tag).join(" ") || "–", `<b>${num(p.c126)}</b>`, num(p.c252), num(p.c21), num(p.c63), num(p.dn252), num(p.dn756), sgp((p.dvol_ewma + p.dvol_y3) / 2)]))}`;
  });
}
function renderMg() {
  const M = S.market, G = M.margin, V = M.margin_val || {}, held = S.port && !S.port.empty ? Object.keys(S.port.W.w) : [];
  const keys = Object.keys(G).filter(t => !G[t].insufficient).sort((a, b) => (held.includes(b) - held.includes(a)) || (G[b].gap - G[a].gap));
  if (!S.mgSel || !G[S.mgSel]) S.mgSel = held.find(t => G[t] && !G[t].insufficient) || keys[0];
  const dt = M.regime.spy_dd_table || [];
  let html = `<div class="card"><h2>마진 (손익비) ${ib("마진")}</h2>
    <div class="banner">솔직한 검증 결과: '과거에 비슷한 상태였을 때 이후 12개월' 신호는 그때까지의 데이터만 써서 다시 계산해 보니 예측력이 없었습니다(순위상관 ${num(V.ic)}, 표본 ${V.n || "–"}). 마진 개선 신호 뒤 평균 ${sg(V.fwd_when_improve)}, 악화 뒤 ${sg(V.fwd_when_worse)}, 전체 ${sg(V.fwd_all)}. 개별 ETF가 많이 빠졌다고 다른 ETF보다 더 오르지는 않았습니다.</div>
    <h3>그나마 근거가 있는 것: 시장 전체가 빠졌을 때</h3>
    <p class="desc">S&P500 고점 대비 낙폭 구간별 이후 12개월 수익 (2006~, 월말 기준, 겹치는 표본 주의). 지금 S&P500 낙폭 ${pct(M.regime.spy_dd)}.</p>
    ${table(["S&P500 낙폭", "표본(월/해)", "하위10%", "중앙값", "상위10%", "상승 확률"], dt.map(r => [r.bucket, `${r.n}/${r.years}`, sg(r.p10), sg(r.p50), sg(r.p90), pct(r.p_up, 0)]))}</div>`;
  html += `<div class="card"><h2>ETF별 현재 위치 (참고)</h2><p class="desc">52주 고점 대비 낙폭, 최근 5년 가격 범위 내 위치(0=최저, 1=최고), 3년 S&P500 대비 초과수익의 과열 정도(z). 비슷한 과거 상태 이후 12개월 중앙값과 전체 기간 중앙값 비교. 보유 종목이 위에 옵니다.</p>
    ${table(["ETF", "52주 고점 대비", "5년 위치", "3년 초과 z", "비슷한 상태 후 12개월", "전체", "유효 표본(해)", "판정"], keys.map(t => { const g = G[t]; return [`<b>${t}</b>${held.includes(t) ? ' <span class="pill">보유</span>' : ""}`, sg(g.dd52), num(g.pos5y), num(g.rel36_z, 1), sg(g.cond.p50), sg(g.uncond.p50), g.cond.n_years, g.flag ? badge(g.flag === "과열" ? "warning" : "info", g.flag) : `<span class="pill">${g.signal}</span>`]; }), { click: true, sel: i => keys[i] === S.mgSel })}</div>`;
  const g = G[S.mgSel];
  if (g) html += `<div class="card"><h2>${S.mgSel}: 비슷한 상태 이후 12개월 분포</h2>
    <p class="desc">${g.years} 중 지금과 가장 비슷한 ${g.cond.n}개월(서로 다른 ${g.cond.n_years}개 해). 상승 확률 ${pct(g.cond.p_up, 0)}, 오를 때 평균 ${sg(g.cond.avg_up)}, 내릴 때 평균 ${sg(g.cond.avg_dn)} → 손익비 ${num(g.payoff, 1)}</p>
    <div class="chart short" id="cMg"></div><p class="note">위 검증처럼 이 분포는 예측력이 확인되지 않았습니다. 과거 사례 참고용입니다.</p></div>`;
  $("#mktBody").innerHTML = html;
  $("#mktBody").querySelectorAll("tr.click").forEach(tr => tr.onclick = () => { S.mgSel = keys[+tr.dataset.i]; renderMg(); });
  if (g) plot("cMg", [
    { y: ["비슷한 상태", "전체 기간"], x: [g.cond.p90 - g.cond.p10, g.uncond.p90 - g.uncond.p10], base: [g.cond.p10, g.uncond.p10].map(x => x), type: "bar", orientation: "h", marker: { color: [css("--s1"), css("--axis")] }, hovertemplate: "%{y}: 하위10%~상위10%<extra></extra>", width: 0.45 },
    { y: ["비슷한 상태", "전체 기간"], x: [g.cond.p50, g.uncond.p50], mode: "markers", marker: { symbol: "line-ns", size: 22, line: { width: 3, color: css("--ink") } }, hovertemplate: "중앙값 %{x:.1%}<extra></extra>" }],
    { xaxis: AX({ tickformat: ".0%", zeroline: true }), margin: { l: 80, r: 12, t: 8, b: 30 } });
}

// ═════════ 투자선 ═════════
function frAll() {
  const base = new Set();
  if (S.port && !S.port.empty) Object.keys(S.port.W.w).forEach(t => base.add(t === E.CASH ? "SGOV" : t));
  else (S.market.defaults.frontier || []).forEach(t => base.add(t));
  base.add("SGOV");
  if (S.rec && S.overlay !== null) S.rec.actions.forEach(a => base.add(a.to));
  S.set.fr.extra.forEach(t => base.add(t));
  return [...base].filter(t => S.ctx.R[t]);
}
const frOff = () => S.set.fr.off || (S.set.fr.off = []);
function frSet() { return frAll().filter(t => !frOff().includes(t)); }
function renderFr() {
  const el = $("#v-fr"); if (!S.ctx) { el.innerHTML = spin(); return; }
  const f = S.set.fr, all = frAll(), tk = frSet(), held = S.port && !S.port.empty ? Object.keys(S.port.W.w).map(t => t === E.CASH ? "SGOV" : t) : [];
  const heldOff = held.filter(t => frOff().includes(t));
  const opts = E.tickers(S.ctx).sort().map(t => `<option value="${t}">${esc(S.market.names[t] || "")}</option>`).join("");
  el.innerHTML = `<div class="card"><h2>효율적 투자선</h2>
    <p class="desc">자산을 눌러 넣고 빼세요 (파란색 = 포함). 직접 추가한 자산은 길게 누르면 목록에서 삭제됩니다.</p>
    <div class="chips">${all.map(t => `<button class="chip ${tk.includes(t) ? "on" : ""}" data-k="${t}" aria-pressed="${tk.includes(t)}">${tk.includes(t) ? "✓ " : ""}${t}${held.includes(t) ? " <i>보유</i>" : ""}</button>`).join("")}</div>
    ${heldOff.length ? `<div class="banner">보유 중인 ${heldOff.join(", ")}를 뺐기 때문에 '현재 포트' 위치와 추천 화살표는 표시하지 않습니다.</div>` : ""}
    <div class="row"><input list="tk2" id="frAdd" placeholder="자산 추가 (예: XLV)" autocapitalize="characters" style="flex:1"><button class="btn" id="frAddB">추가</button><datalist id="tk2">${opts}</datalist></div>
    <div style="margin-top:10px">
      <div class="seg" id="frM">${E.METHODS.map(([k, l]) => `<button data-k="${k}" class="${k === f.method ? "on" : ""}">${l}</button>`).join("")}</div>
      <div class="seg" id="frY">${[3, 5, 10].map(y => `<button data-k="${y}" class="${y === f.years ? "on" : ""}">${y}년</button>`).join("")}</div>
      <div class="seg" id="frW">${[[1, "제한 없음"], [0.5, "종목당 50%"], [0.3, "30%"]].map(([k, l]) => `<button data-k="${k}" class="${k === f.maxW ? "on" : ""}">${l}</button>`).join("")}</div>
    </div>
    <p class="note" id="frNote"></p>
    <div class="row" style="margin-bottom:6px"><button class="btn" id="frZoom" hidden>전체 보기</button><button class="btn" id="frPrevX" hidden>비교선 지우기</button><button class="btn" id="frAxB">축 범위 ${f.axis ? "(직접 설정)" : "(자동 고정)"}</button></div>
    <div id="frAx" hidden class="card" style="background:var(--row-alt);padding:10px">
      <p class="desc">자산을 넣고 빼도 축은 그대로 고정됩니다. 직접 정하려면 % 단위로 입력하세요.</p>
      <div class="grid2"><label class="small">변동성 최소 <input type="number" step="1" id="ax0" style="width:100%"></label><label class="small">변동성 최대 <input type="number" step="1" id="ax1" style="width:100%"></label>
      <label class="small">기대수익 최소 <input type="number" step="1" id="ay0" style="width:100%"></label><label class="small">기대수익 최대 <input type="number" step="1" id="ay1" style="width:100%"></label></div>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="axApply">적용</button><button class="btn" id="axAuto">자동으로</button></div></div>
    <div class="chart tall" id="cFr"></div>
    <div class="legend" id="frLeg"></div>
    <h3>감당할 변동성: <span id="frVol"></span></h3>
    <input type="range" id="frSl" min="0" max="100" value="50">
    <div id="frW8"></div></div>
    <div class="card"><h2>변동성별 비중 변화</h2><p class="desc">가로축 = 감당할 변동성, 세로 = 투자선 위 최적 비중. 세로 점선 = 위에서 고른 변동성.</p><div class="chart tall" id="cTr"></div></div>
    <div class="card"><h2>세 가지 기대수익 가정</h2><div id="frMeth"></div></div>`;
  el.querySelectorAll(".chips .chip").forEach(c => {
    c.onclick = () => {
      const k = c.dataset.k, off = frOff();
      if (S.frLast) S.frPrev = { pts: S.frLast, label: `${off.includes(k) ? k + " 넣기" : k + " 빼기"} 전` };
      if (off.includes(k)) off.splice(off.indexOf(k), 1);
      else { if (tk.length <= 2) { $("#frNote").textContent = "자산이 최소 2개는 있어야 투자선을 그릴 수 있습니다."; return; } off.push(k); }
      S.frIdx = null; saveSet(); renderFr();
    };
    let tm; c.addEventListener("touchstart", () => { tm = setTimeout(() => { const k = c.dataset.k; if (S.set.fr.extra.includes(k)) { S.set.fr.extra = S.set.fr.extra.filter(x => x !== k); S.set.fr.off = frOff().filter(x => x !== k); saveSet(); renderFr(); } }, 700); }, { passive: true });
    c.addEventListener("touchend", () => clearTimeout(tm)); c.addEventListener("touchmove", () => clearTimeout(tm));
  });
  $("#frAddB").onclick = () => {
    const t = $("#frAdd").value.trim().toUpperCase().replace(".", "-");
    if (!S.ctx.R[t]) { $("#frNote").textContent = `${t}: 데이터가 없는 티커입니다.`; return; }
    if (S.frLast) S.frPrev = { pts: S.frLast, label: `${t} 넣기 전` };
    S.set.fr.off = frOff().filter(x => x !== t); if (!all.includes(t)) S.set.fr.extra.push(t); S.frIdx = null; saveSet(); renderFr();
  };
  [["frM", "method", x => x], ["frY", "years", Number], ["frW", "maxW", Number]].forEach(([id, key, cv]) => el.querySelectorAll(`#${id} button`).forEach(b => b.onclick = () => { if (S.frLast) S.frPrev = { pts: S.frLast, label: "설정 변경 전" }; S.set.fr[key] = cv(b.dataset.k); saveSet(); S.frIdx = null; renderFr(); }));
  $("#frAxB").onclick = () => { const p = $("#frAx"); p.hidden = !p.hidden; };
  $("#axApply").onclick = () => {
    const v = ["ax0", "ax1", "ay0", "ay1"].map(id => parseFloat($("#" + id).value) / 100);
    if (v.some(x => !Number.isFinite(x)) || v[1] <= v[0] || v[3] <= v[2]) { $("#frNote").textContent = "축 범위를 확인하세요 (최소 < 최대)."; return; }
    S.set.fr.axis = { x: [v[0], v[1]], y: [v[2], v[3]] }; S.frZoom = false; saveSet(); renderFr();
  };
  $("#axAuto").onclick = () => { S.set.fr.axis = null; S.frAuto = null; saveSet(); renderFr(); };
  $("#frPrevX").onclick = () => { S.frPrev = null; renderFr(); };
  later(() => drawFr(tk));
}
function drawFr(tk) {
  const f = S.set.fr, M = E.monthly(S.ctx, tk, f.years);
  if (M.rows.length < 24) { $("#frNote").textContent = "공통 데이터가 2년 미만이라 그릴 수 없습니다. 이력이 짧은 자산을 빼보세요."; return; }
  const ex = E.expected(M, f.method, S.set.erp), fr = E.frontier(ex.mu, ex.S, { maxW: f.maxW, rf: ex.rf }), P = fr.pts;
  $("#frNote").textContent = `월간 수익률 ${M.rows.length}개월(${M.labels[0]}~${M.labels[M.labels.length - 1]}), 달러 기준 · 공분산 Ledoit-Wolf 축소 ${num(ex.shrink)} · 무위험 ${pct(ex.rf, 2)}` +
    (f.method === "shrink" ? ` · 평균을 ${pct(ex.phi, 0)} 축소` : f.method === "capm" ? ` · 위험프리미엄 ${pct(S.set.erp, 1)} × 베타` : " · 과거 평균 그대로(최근 많이 오른 자산에 쏠림)");
  const hasP = S.port && !S.port.empty && !Object.keys(S.port.W.w).some(t => frOff().includes(t === E.CASH ? "SGOV" : t));
  const map = w => { const o = {}; for (const k in w) { const t = k === E.CASH ? "SGOV" : k; o[t] = (o[t] || 0) + w[k]; } return o; };
  const cur = hasP ? E.point(ex, tk, map(S.port.W.w)) : null;
  if (S.frIdx === null) { const v0 = cur ? cur.vol : fr.maxSharpe.vol; let bi = 0; P.forEach((p, i) => { if (Math.abs(p.vol - v0) < Math.abs(P[bi].vol - v0)) bi = i; }); S.frIdx = bi; }
  const sl = $("#frSl"); sl.max = P.length - 1; sl.value = S.frIdx;
  const traces = [
    { x: P.map(p => p.vol), y: P.map(p => p.ret), mode: "lines", name: "효율적 투자선", line: { color: css("--s1"), width: 2.5 }, hovertemplate: "변동성 %{x:.1%}<br>기대수익 %{y:.1%}<extra>투자선</extra>" },
    { x: tk.map((t, i) => Math.sqrt(ex.S[i][i])), y: ex.mu, text: tk, mode: "markers+text", textposition: "top center", textfont: { size: 10.5, color: css("--ink2") }, name: "개별 자산", marker: { size: 8, color: css("--axis"), line: { color: css("--card"), width: 1.5 } }, hovertemplate: "%{text}<br>변동성 %{x:.1%}<br>기대수익 %{y:.1%}<extra></extra>" },
    { x: [fr.maxSharpe.vol], y: [fr.maxSharpe.ret], mode: "markers", name: "최대 샤프", marker: { symbol: "diamond", size: 11, color: css("--s3"), line: { color: css("--card"), width: 2 } }, hovertemplate: "최대 샤프<br>%{x:.1%}, %{y:.1%}<extra></extra>" },
  ];
  const ann = [];
  if (cur) traces.push({ x: [cur.vol], y: [cur.ret], mode: "markers", name: "현재 포트", marker: { symbol: "star", size: 16, color: css("--s8"), line: { color: css("--card"), width: 1.5 } }, hovertemplate: "현재 포트<br>변동성 %{x:.1%}<br>기대수익 %{y:.1%}<extra></extra>" });
  if (cur && S.rec && S.overlay !== null) {
    S.rec.actions.filter(a => Object.keys(a.w1).every(t => tk.includes(t === E.CASH ? "SGOV" : t))).forEach((a, i) => {
      const p = E.point(ex, tk, map(a.w1)), on = i === S.overlay;
      traces.push({ x: [p.vol], y: [p.ret], mode: "markers+text", text: [String(i + 1)], textposition: "middle right", textfont: { size: 11, color: css("--ink") }, name: a.title, marker: { size: on ? 12 : 9, color: on ? css("--s2") : css("--s4"), line: { color: css("--card"), width: 1.5 } }, hovertemplate: `${esc(a.title)}<br>변동성 %{x:.1%}<br>기대수익 %{y:.1%}<extra></extra>` });
      ann.push({ x: p.vol, y: p.ret, ax: cur.vol, ay: cur.ret, xref: "x", yref: "y", axref: "x", ayref: "y", showarrow: true, arrowhead: 2, arrowsize: 1, arrowwidth: on ? 2 : 1, arrowcolor: on ? css("--s2") : css("--axis"), text: "" });
    });
  }
  if (S.frPrev) traces.unshift({ x: S.frPrev.pts.map(p => p[0]), y: S.frPrev.pts.map(p => p[1]), mode: "lines", name: S.frPrev.label, line: { color: css("--muted"), width: 1.5, dash: "dash" }, hovertemplate: `${esc(S.frPrev.label)}<br>변동성 %{x:.1%}<br>기대수익 %{y:.1%}<extra></extra>` });
  S.frLast = P.map(p => [p.vol, p.ret]);
  const sel = P[S.frIdx];
  const vline = x => ({ type: "line", x0: x, x1: x, yref: "paper", y0: 0, y1: 1, line: { color: css("--muted"), width: 1, dash: "dot" } });
  // 축 고정: 목록의 모든 자산(꺼진 것 포함)으로 범위를 한 번 정하고, 이후에는 넓어지기만 함
  const akey = [f.method, f.years, f.maxW].join("|");
  if (!S.frAuto || S.frAuto.key !== akey) {
    let xs = [0], ys = [];
    const allTk = frAll(), Ma = E.monthly(S.ctx, allTk, f.years);
    if (Ma.rows.length >= 24) { const ea = E.expected(Ma, f.method, S.set.erp); allTk.forEach((t, i) => { xs.push(Math.sqrt(ea.S[i][i])); ys.push(ea.mu[i]); }); ys.push(ea.rf); }
    S.frAuto = { key: akey, x: [0, Math.max(...xs)], y: ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 0.1] };
  }
  const ext = [...P.map(p => [p.vol, p.ret]), ...tk.map((t, i) => [Math.sqrt(ex.S[i][i]), ex.mu[i]]), ...(cur ? [[cur.vol, cur.ret]] : [])];
  S.frAuto.x = [0, Math.max(S.frAuto.x[1], ...ext.map(e => e[0]))];
  S.frAuto.y = [Math.min(S.frAuto.y[0], ...ext.map(e => e[1])), Math.max(S.frAuto.y[1], ...ext.map(e => e[1]))];
  const padY = (S.frAuto.y[1] - S.frAuto.y[0]) * 0.1;
  let xr = f.axis ? f.axis.x : [S.frAuto.x[0], S.frAuto.x[1] * 1.08], yr = f.axis ? f.axis.y : [S.frAuto.y[0] - padY, S.frAuto.y[1] + padY * 1.5];
  ["ax0", "ax1", "ay0", "ay1"].forEach((id, k) => { const el = $("#" + id); if (el && el.value === "") el.value = ((k < 2 ? xr : yr)[k % 2] * 100).toFixed(1); });
  const showActs = cur && S.rec && S.overlay !== null;
  if (S.frZoom === undefined) S.frZoom = !!showActs;
  if (cur && S.frZoom && S.frZoomRange && S.frZoomRange.key === akey) { xr = S.frZoomRange.x; yr = S.frZoomRange.y; }
  else if (cur && S.frZoom) {
    const pts = [cur, ...(showActs ? S.rec.actions.filter(a => Object.keys(a.w1).every(t => tk.includes(t === E.CASH ? "SGOV" : t))).map(a => E.point(ex, tk, map(a.w1))) : [])], vs = pts.map(p => p.vol), rs = pts.map(p => p.ret);
    const dx = Math.max(0.03, (Math.max(...vs) - Math.min(...vs)) * 0.6), dy = Math.max(0.015, (Math.max(...rs) - Math.min(...rs)) * 0.6);
    xr = [Math.min(...vs) - dx, Math.max(...vs) + dx]; yr = [Math.min(...rs) - dy, Math.max(...rs) + dy];
    S.frZoomRange = { key: akey, x: xr, y: yr };  // 확대 범위도 고정 (자산을 넣고 빼도 그대로)
  }
  const fine = (xr[1] - xr[0]) < 0.12;
  plot("cFr", traces, { xaxis: AX({ tickformat: fine ? ".1%" : ".0%", title: { text: "연 변동성", font: { size: 11 } }, range: xr }), yaxis: AX({ tickformat: (yr[1] - yr[0]) < 0.06 ? ".1%" : ".0%", title: { text: "기대수익(연)", font: { size: 11 } }, range: yr }), annotations: ann, shapes: [vline(sel.vol)] });
  const px = $("#frPrevX"); if (px) px.hidden = !S.frPrev;
  const zb = $("#frZoom"); if (zb) { zb.hidden = !cur; zb.textContent = S.frZoom ? "전체 보기" : (showActs ? "변경안 주변 확대" : "현재 포트 주변 확대"); zb.onclick = () => { S.frZoom = !S.frZoom; S.frZoomRange = null; drawFr(tk); }; }
  $("#frLeg").innerHTML = `<span><i style="background:var(--s1)"></i>투자선</span>${S.frPrev ? `<span><i style="background:var(--muted)"></i>${esc(S.frPrev.label)}(점선)</span>` : ""}<span><i style="background:var(--s3)"></i>최대 샤프</span>${cur ? '<span><i style="background:var(--s8)"></i>현재 포트(★)</span>' : ""}${S.overlay !== null && S.rec ? '<span><i style="background:var(--s2)"></i>추천 변경안(번호)</span>' : ""}<span><i style="background:var(--axis)"></i>개별 자산</span>`;
  // 비중 변화 (8개 넘으면 평균 비중 작은 것부터 '기타'로)
  const avg = tk.map((t, j) => [t, j, P.reduce((s, p) => s + p.w[j], 0)]).sort((a, b) => b[2] - a[2]);
  const main = avg.slice(0, 7), rest = avg.slice(7), groups = main.map(([t, j]) => [t, [j]]); if (rest.length) groups.push(["기타", rest.map(x => x[1])]);
  if (avg.length === 8) { groups.pop(); groups.push([avg[7][0], [avg[7][1]]]); }
  plot("cTr", groups.map(([t, js], i) => ({ x: P.map(p => p.vol), y: P.map(p => js.reduce((s, j) => s + p.w[j], 0)), stackgroup: "w", name: t, mode: "lines", line: { width: 0.5, color: css("--card") }, fillcolor: css(SER[i % 8]), hovertemplate: `${t} %{y:.0%}<extra></extra>` })),
    { showlegend: true, hovermode: "x unified", xaxis: AX({ tickformat: fine ? ".1%" : ".0%", title: { text: "연 변동성", font: { size: 11 } }, range: xr }), yaxis: AX({ tickformat: ".0%", range: [0, 1] }), shapes: [vline(sel.vol)], legend: { orientation: "h", y: -0.25 } });
  const showW = () => {
    const p = P[S.frIdx]; $("#frVol").textContent = `${pct(p.vol)} → 기대수익 ${pct(p.ret)} (샤프 ${num((p.ret - ex.rf) / p.vol)})`;
    const cw = cur ? cur.v : null;
    $("#frW8").innerHTML = table(["자산", "투자선 비중", ...(cw ? ["현재 비중", "차이"] : [])], tk.map((t, j) => [t, pct(p.w[j], 0), ...(cw ? [pct(cw[j], 0), sgp(p.w[j] - cw[j]).replace(/pos|neg/, "")] : [])]).filter((r, j) => p.w[j] > 0.005 || (cw && cw[j] > 0.005)));
  };
  showW();
  sl.oninput = () => { S.frIdx = +sl.value; showW(); const s = [vline(P[S.frIdx].vol)]; Plotly.relayout("cFr", { shapes: s }); Plotly.relayout("cTr", { shapes: s }); };
  // 세 방식 비교
  const rows = E.METHODS.map(([m, l]) => {
    const e2 = E.expected(M, m, S.set.erp), f2 = E.frontier(e2.mu, e2.S, { maxW: f.maxW, rf: e2.rf }), c2 = cur ? E.point(e2, tk, map(S.port.W.w)) : null;
    return [l, pct(f2.maxSharpe.ret), pct(f2.maxSharpe.vol), Object.entries(Object.fromEntries(tk.map((t, j) => [t, f2.maxSharpe.w[j]]))).filter(x => x[1] > 0.02).sort((a, b) => b[1] - a[1]).map(([t, v]) => `${t} ${pct(v, 0)}`).join(", "), c2 ? sgp(E.retAtVol(f2, c2.vol) - c2.ret).replace(/pos|neg/, "") : "–"];
  });
  $("#frMeth").innerHTML = `<p class="desc">과거 평균: PV와 같은 방식(추정오차 큼). 축소 추정: 평균을 최소분산 포트폴리오 쪽으로 당김(Jorion 1986). 시장 균형: 무위험 + 베타×위험프리미엄(과거 수익 거의 무시).</p>
    ${table(["가정", "최대샤프 수익", "변동성", "최대샤프 구성", ...(cur ? ["현재 대비 개선 여지"] : [])], rows.map(r => cur ? r : r.slice(0, 4)))}
    <p class="note">세 가정에서 최대샤프 구성이 크게 다르면 그 차이는 '수익 예측'에서 나온 것입니다. 공통으로 남는 비중이 더 믿을 만합니다.</p>`;
}

// ═════════ 설정 ═════════
function repoInfo() {
  if (S.set.repo && S.set.repo.includes("/")) { const [o, r] = S.set.repo.split("/"); return { o, r }; }
  const h = location.hostname, p = location.pathname.split("/").filter(Boolean);
  if (h.endsWith(".github.io")) return { o: h.split(".")[0], r: p[0] || h };
  return null;
}
async function gh(path, opt) {
  const ri = repoInfo(); if (!ri) throw new Error("저장소를 알 수 없습니다(설정에서 입력)");
  const r = await fetch(`https://api.github.com/repos/${ri.o}/${ri.r}${path}`, Object.assign({ headers: { Authorization: `Bearer ${S.token}`, Accept: "application/vnd.github+json" } }, opt || {}));
  if (!r.ok && r.status !== 204) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.status === 204 ? null : r.json();
}
async function runNow() {
  const msg = $("#runMsg"); if (!S.token) { go("set"); return; }
  try {
    msg.innerHTML = '<span class="spin"></span> 점검 요청 중…';
    const t0 = new Date();
    await gh("/actions/workflows/daily.yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main", inputs: { reason: "manual" } }) });
    for (let k = 0; k < 60; k++) {
      await new Promise(r => setTimeout(r, 10000));
      const runs = await gh("/actions/runs?event=workflow_dispatch&per_page=1"), run = runs.workflow_runs[0];
      if (!run || new Date(run.created_at) < new Date(t0 - 60e3)) { msg.innerHTML = '<span class="spin"></span> 대기열…'; continue; }
      if (run.status !== "completed") { msg.innerHTML = `<span class="spin"></span> 점검 중 (${Math.round((new Date() - t0) / 1000)}초)`; continue; }
      if (run.conclusion !== "success") { msg.textContent = `점검 실패: ${run.conclusion}. GitHub Actions 기록을 확인하세요.`; return; }
      msg.innerHTML = '<span class="spin"></span> 완료 · 결과 불러오는 중'; await new Promise(r => setTimeout(r, 20000));
      await loadData(); return;
    }
    msg.textContent = "10분 넘게 끝나지 않았습니다. 나중에 다시 확인하세요.";
  } catch (e) { msg.textContent = String(e.message || e); }
}
async function syncUp(pw) {
  const box = await E.encrypt({ holdings: S.holdings, cash: S.cash, settings: { limit: S.set.limit, targets: S.set.targets, ddWarn: S.set.ddWarn, moveTh: S.set.moveTh, erp: S.set.erp, rule: S.set.rule }, saved: new Date().toISOString() }, pw);
  let sha; try { sha = (await gh("/contents/portfolio.enc.json")).sha; } catch (e) { }
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(box))));
  await gh("/contents/portfolio.enc.json", { method: "PUT", body: JSON.stringify({ message: "update encrypted portfolio", content, sha }) });
}
// 설정을 바꾸면 알림 서버에도 자동 반영 (토큰과 비밀번호를 기억해 둔 경우)
function autoSync(sel, msg) {
  const m = $(sel), pw = LS.get("pw", "");
  if (!(S.token && pw)) { if (m) m.textContent = msg + " · 카톡 알림에 반영하려면 아래에서 '암호화해서 올리기'"; return; }
  if (m) m.innerHTML = msg + ' · <span class="spin"></span> 알림 서버에 올리는 중';
  syncUp(pw).then(() => { const n = $(sel); if (n) n.textContent = msg + " · 알림 서버에도 반영됨"; })
    .catch(e => { const n = $(sel); if (n) n.textContent = msg + " · 서버 반영 실패: " + (e.message || e); });
}
function renderSet() {
  const el = $("#v-set"), L = S.set.limit, ri = repoInfo();
  el.innerHTML = `<div class="card"><h2>위험한도 ${ib("위험한도")}</h2>
    <div class="row"><button class="btn primary" id="presetB">B 방식으로 한 번에 설정</button></div>
    <p class="note">분기초 평가액의 20% 한도 + 분기 점검·5/25 허용범위(위험자산 안 비율 기준) + 현재 비중을 목표로 저장. 2018~2026 백테스트에서 고른 방식입니다.</p>
    <div class="row" style="margin-top:8px"><label class="small" style="width:100px">한도 방식</label><select id="limM" style="flex:1"><option value="pct" ${L.mode === "pct" ? "selected" : ""}>분기초 평가액의 %</option><option value="amount" ${L.mode !== "pct" ? "selected" : ""}>고정 금액</option></select></div>
    <div class="row" id="limPRow" style="margin-top:6px;${L.mode === "pct" ? "" : "display:none"}"><label class="small" style="width:100px">분기초의</label><input type="number" step="1" id="limP" value="${((L.pct || 0.2) * 100).toFixed(0)}" style="width:80px">%<span class="note" id="limPNote">${S.port && !S.port.empty && S.port.diag.qStart ? `지금 기준 ${won(S.port.diag.limAmt)}` : ""}</span></div>
    <div class="row" id="limARow" style="margin-top:6px;${L.mode === "pct" ? "display:none" : ""}"><label class="small" style="width:100px">고정 금액(원)</label><input type="number" id="limA" value="${L.amount}" style="flex:1"></div>
    <div class="row" style="margin-top:6px"><label class="small" style="width:100px">기준</label>
      <select id="limH">${E.HORIZONS.map(([h, l]) => `<option value="${h}" ${h === L.h ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select id="limC">${[0.95, 0.99].map(c => `<option value="${c}" ${c === L.c ? "selected" : ""}>${c * 100}%</option>`).join("")}</select> VaR</div>
    <div class="row" style="margin-top:6px"><label class="small" style="width:100px">주의 구간</label><input type="number" id="limW" value="${L.warn * 100}" style="width:80px">% 이상</div>
    <h3>리밸런싱 목표비중</h3><p class="desc">${S.set.targets ? Object.entries(S.set.targets).map(([t, v]) => `${t} ${pct(v, 0)}`).join(", ") + ` · 위험자산 기본 비중 ${pct(E.riskyShare(S.set.targets), 0)}` : "설정 안 됨"} · 허용범위·주기는 아래 '리밸런싱 규칙'에서</p>
    <div class="row"><button class="btn" id="tgSet">현재 비중을 목표로 저장</button><button class="btn" id="tgClr">목표 해제</button></div>
    <h3>시장 균형 가정</h3><div class="row"><label class="small" style="width:100px">주식 위험프리미엄</label><input type="number" step="0.1" id="erp" value="${(S.set.erp * 100).toFixed(1)}" style="width:80px">%</div>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="setSave">저장</button><span class="note" id="setMsg"></span></div></div>
  <div class="card"><h2>리밸런싱 규칙 ${ib("리밸런싱")}</h2>
    <div class="row"><label class="small" style="width:100px">방식</label><select id="rbMode" style="flex:1">${Object.entries(E.RULES).map(([k, l]) => `<option value="${k}" ${k === S.set.rule.mode ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="row" style="margin-top:6px"><label class="small" style="width:100px">주기</label><select id="rbFreq">${Object.entries(E.FREQ).map(([k, l]) => `<option value="${k}" ${k === S.set.rule.freq ? "selected" : ""}>${l}</option>`).join("")}</select><span class="note">정기 방식에서 사용</span></div>
    <div class="row" style="margin-top:6px"><label class="small" style="width:100px">허용범위</label>±<input type="number" step="0.5" id="rbAbs" value="${(S.set.rule.abs * 100).toFixed(1)}" style="width:70px">%p 또는 목표의 ±<input type="number" step="1" id="rbRel" value="${(S.set.rule.rel * 100).toFixed(0)}" style="width:64px">%</div>
    <div class="row" style="margin-top:6px"><label class="small" style="width:100px">비중 기준</label><select id="rbBasis" style="flex:1"><option value="sleeve" ${S.set.rule.basis !== "total" ? "selected" : ""}>위험자산 안 비율 (SGOV 제외)</option><option value="total" ${S.set.rule.basis === "total" ? "selected" : ""}>전체 비중</option></select></div>
    <p class="note">상대 %를 0으로 두면 절대 %p만 씁니다. 예: 5 / 25 → 5/25 규칙, 5 / 20 → 5/20 규칙. 위험한도를 쓰면 '위험자산 안 비율'이 맞습니다.</p>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="rbSave">저장</button><span class="note" id="rbMsg"></span></div></div>
  <div class="card"><h2>카톡 알림</h2><p class="desc">카카오톡 '나와의 채팅'으로 짧은 요약과 '앱에서 보기' 버튼이 옵니다. 신호가 생길 때 즉시, 일요일 아침엔 주간 요약.</p>
    <a class="btn primary" href="kakao.html" style="text-decoration:none;display:inline-block">카톡 알림 연결하기</a></div>
  <div class="card"><h2>GitHub 연결 (지금 점검 · 알림 동기화)</h2>
    <p class="desc">저장소: <b>${ri ? ri.o + "/" + ri.r : "알 수 없음"}</b> <input id="repo" placeholder="아이디/저장소 (자동 인식 안 될 때)" value="${esc(S.set.repo || "")}" style="width:100%;margin-top:4px"></p>
    <p class="desc">세분화 토큰(Fine-grained token): 이 저장소만, 권한 Actions 읽기·쓰기 + Contents 읽기·쓰기. 이 휴대폰에만 저장됩니다.</p>
    <input type="password" id="tok" placeholder="github_pat_..." value="${S.token ? "••••••••" : ""}" style="width:100%">
    <div class="row" style="margin-top:8px"><button class="btn" id="tokSave">토큰 저장</button><button class="btn" id="tokDel">토큰 삭제</button></div>
    <h3>알림용 보유내역 동기화</h3>
    <p class="desc">보유내역을 비밀번호로 암호화(AES-256)해서 저장소에 올립니다. 서버는 GitHub Secret의 PORTFOLIO_PASSWORD로만 풀 수 있으니 같은 비밀번호를 쓰세요.</p>
    <input type="password" id="pw" placeholder="비밀번호 (Secret과 동일)" value="${LS.get("pw", "") ? "••••••••" : ""}" style="width:100%">
    <label class="small" style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="pwKeep" ${LS.get("pw", "") ? "checked" : ""}> 이 휴대폰에 기억하고, 내 포트에서 저장할 때마다 자동으로 올리기</label>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="syncB">암호화해서 올리기</button><span class="note" id="syncMsg">${S.token && LS.get("pw", "") ? "자동 동기화 켜짐" : ""}</span></div></div>
  <div class="card"><h2>방법과 검증</h2>
    <details><summary>VaR</summary><p class="desc">원화 기준(달러 수익 × 환율 변화). 부트스트랩: 최근 10년 일간 수익을 21일 블록으로 1만 경로 재표본, 기대 초과수익 0. EWMA: λ=0.94(RiskMetrics). 역사적: 최근 250일(바젤). 극단값은 제거하지 않음.</p></details>
    <details><summary>상관·짝 찾기</summary><p class="desc">달러 수익률, 1·3·6·12개월 창. 하락장 상관 = 기준 자산이 떨어진 날만. 6개월 상관의 다음 6개월 예측력 0.89, 하락장 상관 0.81로 검증.</p></details>
    <details><summary>상대강도·마진</summary><p class="desc">상대강도: Jegadeesh·Titman 12-1, Faber 10개월 추세, Antonacci 듀얼 모멘텀 방식. 마진: 52주 낙폭·3년 초과수익이 비슷한 과거 시점의 이후 12개월. 둘 다 검증상 예측력이 거의 없어 참고용으로만 표시.</p></details>
    <details><summary>투자선</summary><p class="desc">월간 수익률, Ledoit-Wolf 공분산 축소, 롱온리. 기대수익: 과거 평균 / Bayes-Stein 축소(Jorion 1986) / CAPM 균형(rf + β×ERP).</p></details>
    <details><summary>데이터</summary><p class="desc">Yahoo 수정주가(배당 재투자), FRED 3개월 T-bill·원/달러(실패 시 Yahoo). 상장 전 구간은 대용치: ${Object.entries(S.market ? S.market.proxy : {}).map(([k, v]) => `${k}←${v}`).join(", ")}.</p></details>
    <div class="row" style="margin-top:10px"><button class="btn" id="theme">다크/라이트 전환</button><button class="btn" id="wipe">이 기기 데이터 지우기</button></div>
    <p class="note">통계적 추정이며 투자 권유가 아닙니다.</p></div>`;
  $("#limM").onchange = () => { const p = $("#limM").value === "pct"; $("#limPRow").style.display = p ? "" : "none"; $("#limARow").style.display = p ? "none" : ""; };
  $("#limP").oninput = () => { const q = S.port && !S.port.empty && E.quarterStart(S.ctx, S.port.W.w, S.port.W.nav); const n = $("#limPNote"); if (q && n) n.textContent = `지금 기준 ${won(q.value * (+$("#limP").value / 100))} (분기초 ${won(q.value)})`; };
  $("#setSave").onclick = () => {
    S.set.limit = { mode: $("#limM").value, pct: +$("#limP").value / 100, amount: +$("#limA").value, h: +$("#limH").value, c: +$("#limC").value, warn: +$("#limW").value / 100 };
    S.set.erp = +$("#erp").value / 100; S.set.repo = $("#repo").value.trim(); saveSet(); computePort(); autoSync("#setMsg", "저장됨"); renderHdr();
  };
  $("#rbSave").onclick = () => { S.set.rule = { mode: $("#rbMode").value, freq: $("#rbFreq").value, abs: +$("#rbAbs").value / 100, rel: +$("#rbRel").value / 100, basis: $("#rbBasis").value }; saveSet(); computePort(); autoSync("#rbMsg", "저장됨 · 알림과 비교표에 반영"); };
  $("#presetB").onclick = () => {
    S.set.limit = Object.assign({}, S.set.limit, { mode: "pct", pct: 0.2, h: 252, c: 0.95 });
    S.set.rule = { mode: "both", freq: "Q", abs: 0.05, rel: 0.25, basis: "sleeve" };
    if (S.port && !S.port.empty) { S.set.targets = Object.assign({}, S.port.W.w); delete S.set.targets[E.CASH]; }
    saveSet(); computePort(); renderSet(); autoSync("#setMsg", "B 방식으로 설정됨" + (S.port && !S.port.empty ? " · 현재 비중을 목표로 저장" : " · 보유내역을 넣은 뒤 '현재 비중을 목표로 저장'을 눌러주세요"));
  };
  $("#tgSet").onclick = () => { if (!S.port || S.port.empty) return; S.set.targets = Object.assign({}, S.port.W.w); delete S.set.targets[E.CASH]; saveSet(); computePort(); renderSet(); autoSync("#setMsg", "목표 저장됨"); };
  $("#tgClr").onclick = () => { S.set.targets = null; saveSet(); computePort(); renderSet(); autoSync("#setMsg", "목표 해제됨"); };
  $("#tokSave").onclick = () => { const v = $("#tok").value.trim(); if (v && !v.startsWith("•")) { S.token = v; LS.set("token", v); } S.set.repo = $("#repo").value.trim(); saveSet(); renderSet(); };
  $("#tokDel").onclick = () => { S.token = ""; LS.del("token"); renderSet(); };
  $("#syncB").onclick = async () => {
    let pw = $("#pw").value; const m = $("#syncMsg");
    if (pw.startsWith("•")) pw = LS.get("pw", "");
    if (!pw || pw.length < 8) { m.textContent = "비밀번호 8자 이상"; return; } if (!S.token) { m.textContent = "먼저 토큰을 저장하세요"; return; }
    m.innerHTML = '<span class="spin"></span> 암호화·업로드 중'; try { await syncUp(pw); if ($("#pwKeep").checked) LS.set("pw", pw); else LS.del("pw"); m.textContent = $("#pwKeep").checked ? "완료. 앞으로는 내 포트에서 저장만 하면 자동으로 올라갑니다." : "완료. 다음 점검부터 알림에 반영됩니다."; } catch (e) { m.textContent = String(e.message || e); }
  };
  $("#theme").onclick = () => { const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); const nx = cur === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = nx; LS.set("theme", nx); renderAll(); };
  $("#wipe").onclick = () => { ["holdings", "cash", "settings", "token", "pw", "returns_date"].forEach(LS.del); location.reload(); };
}

// ───────── 라우팅 ─────────
function go(v) {
  S.view = v; document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  document.querySelectorAll("section.view").forEach(s => s.classList.toggle("on", s.id === "v-" + v));
  window.scrollTo(0, 0); renderView();
}
function renderView() { ({ home: renderHome, port: renderPort, mkt: renderMkt, fr: renderFr, set: renderSet })[S.view](); }
function renderAll() { renderHdr(); renderView(); }
document.querySelectorAll("#nav button").forEach(b => b.onclick = () => go(b.dataset.v));
(function () { const t = LS.get("theme", null); if (t) document.documentElement.dataset.theme = t; })();
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => { });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.market && (Date.now() - new Date(S.market.meta.generated_iso)) > 50 * 60e3) loadData(); });
renderAll(); loadData();
window.__S = S;
})();
