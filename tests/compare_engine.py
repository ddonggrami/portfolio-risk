"""JS 엔진(app/engine.js) 결과를 Python 기준 구현과 비교. 사용: python tests/compare_engine.py site eng.json"""
import json, sys
import numpy as np, pandas as pd
from scipy.optimize import minimize
sys.path.insert(0, ".")
from pvrisk import risk as R
from pvrisk.correlation import lw_cov

d, ej = sys.argv[1], sys.argv[2]
rj = json.load(open(f"{d}/returns.json")); o = json.load(open(ej))
idx = pd.to_datetime(rj["dates"])
ru = pd.DataFrame({t: pd.Series([np.nan if x is None else x * 1e-4 for x in v], idx) for t, v in rj["r"].items()})
fx = pd.Series([np.nan if x is None else x for x in rj["fx"]], idx).ffill()
fxr = fx.pct_change().fillna(0.0); fxr.iloc[0] = 0
rb = ru.mul(1 + fxr, axis=0).add(fxr, axis=0)
w = pd.Series({"SPMO": .4, "GLD": .3, "SOXX": .2, "BRK-B": .1})
sub = rb[w.index].iloc[1:].dropna()
cov = R.ewma_cov(sub, 0.94)
# engine 은 공통 유효 구간 마지막 1000개, 파이썬 ewma_cov 는 마지막 1008개 → 동일 창으로 맞춤
x = sub.values[-1000:]; n = len(x); wt = (1 - .94) * .94 ** np.arange(n - 1, -1, -1); wt /= wt.sum()
S = (x * wt[:, None]).T @ x
sig = float(np.sqrt(w.values @ S @ w.values) * np.sqrt(252))
checks = []
def chk(name, a, b, tol):
    ok = abs(a - b) <= tol; checks.append(ok); print(f"{'OK ' if ok else 'BAD'} {name}: js={a:.5f} py={b:.5f}")
chk("EWMA 연변동성(원화)", o["sigma_ann"], sig, 1e-3)
S3 = sub.iloc[-756:].cov().values; v3 = float(np.sqrt(w.values @ S3 @ w.values * 252))
chk("3년 표본 변동성", o["contrib"]["_vol"]["y3"], v3, 1e-3)
mv = S3 @ w.values; cr = w.values * mv / (w.values @ mv)
chk("3년 위험기여 SPMO", o["contrib"]["SPMO"]["y3"], cr[0], 1e-3)
# 스트레스
for s, row in zip(R.SCENARIOS, o["stress"]):
    name, a, b = s
    sb = rb.loc[a:b, w.index].iloc[1:]  # 시작일(고점) 종가 이후부터
    if sb.isna().any().any(): continue
    pb = float(np.prod(1 + (sb * w.values).sum(axis=1)) - 1)
    chk(f"스트레스 {name}", row[1], pb, 2e-3)
# 1일 HS VaR 250
pr = (sub * w.values).sum(axis=1)
hs = -np.quantile(pr.iloc[-250:].values, 0.01)
chk("1일 99% HS250", o["hs250"]["1"]["0.99"]["pct"], hs, 2e-4)
# 1년 부트스트랩 ≈ 파이썬 annual (난수 다름 → 허용오차 크게)
an = R.annual(rb[w.index].iloc[1:], w, 1e8, ru.get("SGOV", pd.Series(0, idx)) * 0 + pd.Series([x * 1e-7 for x in rj["rf"]], idx), {"boot_years": 10, "boot_block": 21, "boot_paths": 20000, "ewma_lambda": .94})
chk("1년 95% VaR 부트스트랩", o["boot"]["252"]["0.95"]["pct"], an["methods"]["bootstrap"]["0.95"]["pct"], 0.01)
# 월간 LW 공분산 + 투자선 (과거평균)
tk = ["SPMO", "GLD", "SOXX", "BRK-B", "SGOV", "XLE"]
Sjs = np.array(o["S"]); mu = np.array(o["mu_hist"])
cols = tk + ["SPY"]
m = (1 + ru[cols]).groupby(idx.to_period("M")).prod() - 1
cnt = ru["SPY"].groupby(idx.to_period("M")).count()
m = m[cnt >= 15].dropna().iloc[-60:]
Spy, sh = lw_cov(m[tk].values)
chk("LW 축소강도", o["lw_shrink"], sh, 1e-3)
chk("LW 공분산 최대오차", float(np.abs(Sjs - Spy * 12).max()), 0.0, 1e-5)
chk("과거평균 SOXX", mu[2], float(m["SOXX"].mean() * 12), 1e-4)
def solve_at(vol):
    cons = [{"type": "eq", "fun": lambda x: x.sum() - 1}, {"type": "ineq", "fun": lambda x: vol**2 - x @ Spy * 12 @ x}]
    r = minimize(lambda x: -(x @ mu), np.ones(6) / 6, bounds=[(0, 1)] * 6, constraints=cons, method="SLSQP")
    return float(r.x @ mu)
fr = o["frontier"]
for k in (5, 20, 40):
    vol, ret = fr[k]
    chk(f"투자선 점 {k} (vol {vol:.3f})", ret, solve_at(vol), 2e-3)
print(f"\n{sum(checks)}/{len(checks)} 통과")
sys.exit(0 if all(checks) else 1)
