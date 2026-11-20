// 앱에서 동기화한 보유종목(암호화)을 풀어, 기본 유니버스에 없는 티커도 시세를 받도록 목록 파일로 남김.
// 로그에는 종목명을 출력하지 않습니다(공개 저장소).
import { createRequire } from "module";
import fs from "fs";
const require = createRequire(import.meta.url);
const E = require("../app/engine.js");
const PW = process.env.PORTFOLIO_PASSWORD || "";
let n = 0;
if (PW && fs.existsSync("portfolio.enc.json")) {
  try {
    const pf = await E.decrypt(JSON.parse(fs.readFileSync("portfolio.enc.json", "utf8")), PW);
    const t = [...new Set((pf.holdings || []).map(h => String(h.t || "").trim().toUpperCase().replace(".", "-")).filter(x => /^[A-Z0-9^=\-]{1,12}$/.test(x)))];
    fs.writeFileSync("extra_tickers.txt", t.join("\n")); n = t.length;
  } catch (e) { console.log("[extra] 보유내역 복호화 실패"); }
}
console.log(`[extra] 보유종목 ${n}개를 수집 목록에 추가`);
