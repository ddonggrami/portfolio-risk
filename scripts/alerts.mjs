// 알림 작업: 암호화된 보유내역을 풀어 앱과 같은 엔진으로 점검 → 새로 생긴/해소된 알림만 전송.
// 채널: 카카오톡 '나와의 채팅'(짧은 요약 + 앱에서 보기 버튼), 텔레그램(설정했을 때만).
// 공개 저장소의 Actions 로그는 누구나 볼 수 있으므로 금액·보유내역·토큰은 로그에 출력하지 않습니다.
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(import.meta.url);
const E = require("../app/engine.js");

const SITE = process.env.SITE || "site";
const KIND = process.env.RUN_KIND || "hourly"; // hourly | daily | weekly | manual | deploy(앱 갱신만 — 알림을 보내지 않고 알림 상태도 그대로 둠)
const PW = process.env.PORTFOLIO_PASSWORD || "";
const APP_URL = process.env.DASHBOARD_URL || "";
const log = (...a) => console.log("[alerts]", ...a);
const readJSON = p => JSON.parse(fs.readFileSync(p, "utf8"));
const F = E.fmt;

// ───────── 이전 상태 (알림 키, 카카오 토큰) ─────────
let prev = {};
if (fs.existsSync("prev_state.json") && PW) { try { prev = await E.decrypt(readJSON("prev_state.json"), PW); } catch (e) { prev = {}; } }
const state = { keys: prev.keys || {}, kakao: prev.kakao || null, kk: prev.kk || {}, lastWeekly: prev.lastWeekly || null };
const status = { kind: KIND, portfolio: false, telegram: (process.env.TELEGRAM_BOT_TOKEN ? "configured" : "off") };

// ───────── 카카오톡 ─────────
const K = { key: process.env.KAKAO_REST_KEY || "", secret: process.env.KAKAO_CLIENT_SECRET || "", seed: process.env.KAKAO_REFRESH_TOKEN || "" };
let kakaoAccess = null;
async function kakaoToken() {
  if (kakaoAccess) return kakaoAccess;
  if (!K.key || !(K.seed || state.kakao)) return null;
  // 저장된 토큰이 시크릿보다 새것이면 그걸 사용 (시크릿을 새로 등록하면 시크릿 우선)
  const useStored = state.kakao && state.kakao.rt && state.kakao.seedHash === hash(K.seed);
  const rt = useStored ? state.kakao.rt : K.seed;
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: K.key, refresh_token: rt });
  if (K.secret) body.set("client_secret", K.secret);
  try {
    const r = await fetch("https://kauth.kakao.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" }, body });
    const j = await r.json();
    if (!r.ok || !j.access_token) { status.kakao = "expired"; status.kakao_err = j.error_code || String(r.status); log("카카오 토큰 갱신 실패", status.kakao_err); return null; }
    state.kakao = { rt: j.refresh_token || rt, seedHash: hash(K.seed), rotated: j.refresh_token ? new Date().toISOString() : (state.kakao && state.kakao.rotated) || null };
    if (j.refresh_token) log("카카오 리프레시 토큰 새로 발급 → 암호화 저장");
    status.kakao = "ok"; kakaoAccess = j.access_token; return kakaoAccess;
  } catch (e) { status.kakao = "error"; log("카카오 연결 오류"); return null; }
}
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
function clip(t, n) { return t.length <= n ? t : t.slice(0, n - 1) + "…"; }
async function kakaoSend(text) {
  const at = await kakaoToken(); if (!at) return false;
  if (process.env.DRY_RUN_FILE) { fs.appendFileSync(process.env.DRY_RUN_FILE, "[카톡]\n" + clip(text, 200) + "\n\n"); return true; }
  const tpl = { object_type: "text", text: clip(text, 200), link: { web_url: APP_URL, mobile_web_url: APP_URL }, button_title: "앱에서 보기" };
  const r = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", { method: "POST", headers: { Authorization: "Bearer " + at, "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" }, body: new URLSearchParams({ template_object: JSON.stringify(tpl) }) });
  const j = await r.json().catch(() => ({}));
  const ok = r.ok && j.result_code === 0;
  log("카카오 전송", ok ? "성공" : "실패 " + (j.code || r.status));
  if (ok) status.kakao_sent = new Date().toISOString(); else status.kakao = "send_failed";
  return ok;
}
// ───────── 텔레그램 (선택) ─────────
async function telegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return false;
  if (process.env.DRY_RUN_FILE) { fs.appendFileSync(process.env.DRY_RUN_FILE, "[텔레그램]\n" + text + "\n\n"); return true; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: text + (APP_URL ? "\n" + APP_URL : ""), disable_web_page_preview: true }) });
  status.telegram = r.ok ? "ok" : "failed"; log("텔레그램", r.ok ? "전송" : "실패 " + r.status); return r.ok;
}
async function send(short, long) { await kakaoSend(short); await telegram(long || short); }

// ───────── 점검 ─────────
const market = readJSON(path.join(SITE, "market.json"));
const ctx = E.load(market, readJSON(path.join(SITE, "returns.json")));
const prov = market.meta.provisional;
const when = `${market.meta.generated.slice(5)}${prov ? " 장중" : ""}`;

let pf = null;
if (fs.existsSync("portfolio.enc.json") && PW) {
  try { pf = await E.decrypt(readJSON("portfolio.enc.json"), PW); log("보유내역 복호화 성공"); }
  catch (e) { log("보유내역 복호화 실패 — PORTFOLIO_PASSWORD가 앱에서 쓴 비밀번호와 같은지 확인"); }
} else log(PW ? "portfolio.enc.json 없음 (앱 설정에서 동기화하세요)" : "PORTFOLIO_PASSWORD 미설정 — 카카오 토큰 자동 보관도 안 됩니다");

const INTRADAY_OK = ["util", "move", "dd", "lim"]; // 장중에는 이 항목만 판단 (신호 전환은 종가 확정 후)
const icon = { critical: "🔴", warning: "🟡", info: "🔵" };
let fresh = [], gone = [], cur = {}, diag = null, W = null, set = null;

if (pf && pf.holdings && pf.holdings.length) {
  status.portfolio = true;
  const st = pf.settings || {};
  ctx.rfKRW = st.rfKRW ?? 0.025; // 원화 무위험금리 (투자선·샤프·균형 기대수익 기준)
  W = E.weights(ctx, pf.holdings, pf.cash || 0);
  set = { lam: market.defaults.ewma_lambda, limit: Object.assign({ amount: 2e7, h: 252, c: 0.95, warn: 0.8, mode: "pct", pct: 0.2 }, st.limit || {}), targets: st.targets || null, erp: st.erp || market.defaults.erp, dupTh: market.defaults.signals.dup_corr || 0.9 };
  diag = E.diagnose(ctx, W.w, W.nav, set);
  const A = E.alerts(ctx, W.w, W.nav, diag, { limit: set.limit, targets: st.targets, ddWarn: st.ddWarn || [0.1, 0.2], moveTh: st.moveTh || 0.03, dupTh: set.dupTh, rule: st.rule });
  // 상대강도는 검증상 예측력이 없어 앱에서만 보여주고 카톡으로는 보내지 않음
  const PUSH_OFF = ["rs"];
  for (const a of A) if (a.level !== "ok" && !PUSH_OFF.includes(a.key.split(":")[0])) cur[a.key] = a;
  for (const k of Object.keys(state.keys)) if (PUSH_OFF.includes(k.split(":")[0])) delete state.keys[k];
  const cat = k => k.split(":")[0], consider = k => !prov || INTRADAY_OK.includes(cat(k));
  fresh = Object.values(cur).filter(a => consider(a.key) && !state.keys[a.key]);
  gone = Object.keys(state.keys).filter(k => consider(k) && !cur[k]).map(k => state.keys[k]);
  const nk = {}; for (const k in state.keys) if (!consider(k)) nk[k] = state.keys[k];
  for (const a of Object.values(cur)) if (consider(a.key)) nk[a.key] = a.short;
  if (KIND !== "deploy") state.keys = nk; // 배포 실행은 알림 상태를 건드리지 않음 → 다음 정기 점검이 변화를 그대로 알림
  log(`점검 완료: 경고 ${Object.keys(cur).length}건, 신규 ${fresh.length}, 해소 ${gone.length}`);
}

const nCur = Object.keys(cur).length;
const sortLv = (a, b) => ({ critical: 0, warning: 1, info: 2 }[a.level] - { critical: 0, warning: 1, info: 2 }[b.level]);
function changeLines(max) {
  const L = [...fresh.sort(sortLv).map(a => `${icon[a.level] || "•"} ${a.short}`), ...gone.map(s => `🟢 해소: ${s}`)];
  return L.length > max ? [...L.slice(0, max), `외 ${L.length - max}건`] : L;
}
function headline() {
  if (!diag) return "보유내역 미동기화 · 시장만 점검";
  const hc = E.limHC(set.limit), v = diag.V.boot[hc.h][hc.c].amt;
  return `진단 ${diag.verdict} · ${E.limLabel(set.limit).replace(" VaR", "").replace(" ", "")}VaR ${F.won(v)}(한도 ${F.pct(diag.util, 0)})`;
}
const rg = market.regime;

if (KIND === "deploy") {
  log("배포 실행 — 알림 보내지 않음");
} else if (KIND === "weekly" && state.lastWeekly && (Date.now() - Date.parse(state.lastWeekly)) < 3 * 864e5) {
  log("이번 주 주간 리포트는 이미 보냄 — 건너뜀"); // GitHub 예약 실행과 외부 스케줄러가 겹칠 때
} else if (KIND === "weekly") {
  state.lastWeekly = new Date().toISOString();
  let top = "";
  if (diag) { try { const R = E.recommend(ctx, W.w, W.nav, diag, set); if (R.actions[0]) top = `1순위: ${R.actions[0].title}`; } catch (e) { } }
  const warn = Object.values(cur).sort(sortLv).slice(0, 3).map(a => a.short).join(" · ");
  const short = [`[주간 리스크] ${when}`, headline(), diag ? `1일99% ${F.won(diag.V.boot[1][0.99].amt)} · 경고 ${nCur}건` : "", warn, top, `S&P500 고점대비 ${F.pct(rg.spy_dd)}`].filter(Boolean).join("\n");
  await send(short, short);
} else if (KIND === "manual") {
  const ch = changeLines(3);
  const short = [`[지금 점검] ${when}`, ch.length ? ch.join("\n") : "새 알림 없음 · 이전과 같음", headline(), `현재 경고 ${nCur}건`].join("\n");
  await send(short, short);
} else if (fresh.length || gone.length) {
  const short = [`[리스크 알림] ${when}`, ...changeLines(4), headline()].join("\n");
  await send(short, short);
} else {
  log("새 알림 없음");
  if (KIND === "daily") await kakaoToken(); // 메시지가 없어도 매일 토큰을 갱신해 연결 유지
}

// ───────── 상태 저장 (암호화) + 앱이 읽는 공개 상태 ─────────
if (status.kakao) state.kk.status = status.kakao;
if (status.kakao_sent) state.kk.sent = status.kakao_sent;
status.kakao = K.key ? (status.kakao || state.kk.status || "configured") : "off";
status.kakao_sent = status.kakao_sent || state.kk.sent || null;
if (PW) fs.writeFileSync(path.join(SITE, "alert_state.enc.json"), JSON.stringify(await E.encrypt(Object.assign(state, { at: market.meta.generated_iso }), PW)));
if (state.kakao && state.kakao.rotated) status.kakao_rotated = state.kakao.rotated;
status.at = market.meta.generated_iso; status.provisional = prov; status.password = !!PW;
fs.writeFileSync(path.join(SITE, "status.json"), JSON.stringify(status));
