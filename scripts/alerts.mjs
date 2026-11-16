// 알림 작업: 암호화된 보유내역을 풀어 앱과 같은 엔진으로 점검 → 새로 생긴/해소된 알림만 텔레그램 전송.
// 공개 저장소의 Actions 로그는 누구나 볼 수 있으므로 금액·보유내역은 로그에 출력하지 않습니다.
import { createRequire } from "module";
import fs from "fs";
import path from "path";
const require = createRequire(import.meta.url);
const E = require("../app/engine.js");

const SITE = process.env.SITE || "site";
const KIND = process.env.RUN_KIND || "hourly"; // hourly | daily | weekly | manual
const PW = process.env.PORTFOLIO_PASSWORD || "";
const URL = process.env.DASHBOARD_URL || "";
const log = (...a) => console.log("[alerts]", ...a);

async function telegram(text) {
  if (process.env.DRY_RUN_FILE) { fs.appendFileSync(process.env.DRY_RUN_FILE, text + "\n\n────────\n"); return; } // 로컬 확인용
  const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { log("텔레그램 미설정 — 전송 생략"); return; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }) });
  log("텔레그램", r.ok ? "전송" : "실패 " + r.status);
}
const readJSON = p => JSON.parse(fs.readFileSync(p, "utf8"));
const F = E.fmt;

const market = readJSON(path.join(SITE, "market.json"));
const ctx = E.load(market, readJSON(path.join(SITE, "returns.json")));
const prov = market.meta.provisional;
const head = `📊 리스크 점검 ${market.meta.generated} (시세 ${market.meta.price_date}${prov ? " 장중 잠정" : " 종가"})`;

let pf = null;
if (fs.existsSync("portfolio.enc.json") && PW) {
  try { pf = await E.decrypt(readJSON("portfolio.enc.json"), PW); log("보유내역 복호화 성공"); }
  catch (e) { log("보유내역 복호화 실패 — 비밀번호(PORTFOLIO_PASSWORD)가 앱에서 쓴 것과 같은지 확인"); }
} else log(PW ? "portfolio.enc.json 없음 (앱 설정에서 동기화하세요)" : "PORTFOLIO_PASSWORD 미설정");

let prev = {};
if (fs.existsSync("prev_state.json") && PW) { try { prev = await E.decrypt(readJSON("prev_state.json"), PW); } catch (e) { prev = {}; } }

const INTRADAY_OK = ["util", "move", "dd"]; // 장중에는 이 항목만 판단 (신호 전환은 종가 확정 후)
let lines = [], state = Object.assign({}, prev.keys ? { keys: prev.keys } : { keys: {} });
let summary = "";

if (pf && pf.holdings && pf.holdings.length) {
  const st = pf.settings || {};
  const W = E.weights(ctx, pf.holdings, pf.cash || 0);
  const set = { lam: market.defaults.ewma_lambda, limit: Object.assign({ amount: 2e7, h: 252, c: 0.95, warn: 0.8 }, st.limit || {}), erp: st.erp || market.defaults.erp, dupTh: market.defaults.signals.dup_corr || 0.9 };
  const diag = E.diagnose(ctx, W.w, W.nav, set);
  const A = E.alerts(ctx, W.w, W.nav, diag, { limit: set.limit, targets: st.targets, ddWarn: st.ddWarn || [0.1, 0.2], moveTh: st.moveTh || 0.03, dupTh: set.dupTh, rule: st.rule });
  const cur = {}; for (const a of A) if (a.level !== "ok") cur[a.key] = a;
  const cat = k => k.split(":")[0];
  const consider = k => !prov || INTRADAY_OK.includes(cat(k));
  const prevKeys = state.keys || {};
  const fresh = Object.values(cur).filter(a => consider(a.key) && !prevKeys[a.key]);
  const gone = Object.keys(prevKeys).filter(k => consider(k) && !cur[k]);
  const icon = { critical: "🔴", warning: "🟡", info: "🔵" };
  for (const a of fresh) lines.push(`${icon[a.level] || "•"} ${a.label}: ${a.text} — ${a.dist || ""}`);
  for (const k of gone) lines.push(`🟢 해소: ${prevKeys[k]}`);
  const nk = {}; for (const k in prevKeys) if (!consider(k)) nk[k] = prevKeys[k];
  for (const a of Object.values(cur)) if (consider(a.key)) nk[a.key] = `${a.label} ${a.text}`;
  state.keys = nk;
  const V = diag.V;
  summary = [`진단: ${diag.verdict}`, ...diag.items.map(i => `${["✅", "⚠️", "❌"][i.level]} ${i.label}: ${i.text}`),
    `VaR: 1일 99% ${F.won(V.boot[1][0.99].amt)} · 1개월 95% ${F.won(V.boot[21][0.95].amt)} · 1년 95% ${F.won(V.boot[252][0.95].amt)}`,
    `현재 경고 ${Object.keys(cur).length}건`].join("\n");
  if (KIND === "weekly" || KIND === "manual") {
    try { const R = E.recommend(ctx, W.w, W.nav, diag, set); if (R.actions[0]) summary += `\n지금 할 일 1순위: ${R.actions[0].title} (변동성 ${F.pp(R.actions[0].dVolEwma)}, 근거: ${R.actions[0].why})`; } catch (e) { }
  }
  log(`점검 완료: 경고 ${Object.keys(cur).length}건, 신규 ${fresh.length}, 해소 ${gone.length}`);
} else {
  summary = "보유내역이 동기화되지 않아 시장 상태만 점검했습니다.";
}

const rg = market.regime;
const mkt = `시장: S&P500 ${rg.spy_above_10m ? "10개월선 위" : "10개월선 아래"}, 고점 대비 ${F.pct(rg.spy_dd)}, 주식–채권 3개월 상관 ${rg.stock_bond_corr63?.toFixed(2)}`;
if (KIND === "weekly") await telegram([`🗓 주간 요약`, head, "", summary, "", mkt, ...(lines.length ? ["", "이번 점검의 변화:", ...lines] : []), URL].join("\n"));
else if (KIND === "manual") await telegram([`🔎 지금 점검 결과`, head, "", lines.length ? lines.join("\n") : "새로 생긴 알림 없음 — 모든 항목이 이전과 같습니다.", "", summary, URL].join("\n"));
else if (lines.length) await telegram([head, "", ...lines, "", URL].join("\n"));
else log("새 알림 없음");

if (PW) { fs.writeFileSync(path.join(SITE, "alert_state.enc.json"), JSON.stringify(await E.encrypt(Object.assign(state, { at: market.meta.generated_iso }), PW))); }
fs.writeFileSync(path.join(SITE, "status.json"), JSON.stringify({ kind: KIND, at: market.meta.generated_iso, portfolio: !!pf, provisional: prov }));
