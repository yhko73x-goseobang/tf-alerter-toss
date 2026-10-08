/* alerter.js — 30분봉 조건 판정 (완성봉 기준, 진행봉은 프리뷰) */
(function (global) {
  // params: {pcLen,bbN,bbK,maLengths,volN,volK, enabled:{PC,BB,MA200,VOL}}
  function evalBar(bars, ind, i, params) {
    const hits = [];
    const b = bars[i];
    if (!b || i < 2) return hits;
    const en = params.enabled || {};
    // PC 하단
    if (en.PC !== false) {
      const dn = ind.pc.dn[i];
      if (dn != null && b.low <= dn) hits.push({ type: "PC", label: `PC하단 터치 (${fmt(b.low)} ≤ ${fmt(dn)})` });
    }
    // BB 하단
    if (en.BB !== false) {
      const dn = ind.bb.dn[i];
      if (dn != null && b.low <= dn) hits.push({ type: "BB", label: `BB하단 터치 (${fmt(b.low)} ≤ ${fmt(dn)})` });
    }
    // MA200 터치 (관통형: 봉 안에 MA200 포함)
    if (en.MA200 !== false) {
      const ma = (ind.mas[200] || ind.mas["200"] || [])[i];
      if (ma != null && b.low <= ma && ma <= b.high) hits.push({ type: "MA200", label: `MA200 터치 (${fmt(ma)})` });
    }
    // 거래량 급증
    if (en.VOL === true) {
      const vma = ind.vma[i];
      if (vma != null && vma > 0 && b.volume >= vma * params.volK) hits.push({ type: "VOL", label: `거래량 급증 (${compact(b.volume)} ≥ 평균×${params.volK})` });
    }
    // 회귀채널 터치 (상단 or 하단)
    if (en.LR !== false && ind.lr) {
      const tp = ind.lr.top[i], bt = ind.lr.bot[i];
      if (tp != null && b.high >= tp) hits.push({ type: "LR", label: `회귀 상단 터치 (${fmt(b.high)} ≥ ${fmt(tp)})` });
      else if (bt != null && b.low <= bt) hits.push({ type: "LR", label: `회귀 하단 터치 (${fmt(b.low)} ≤ ${fmt(bt)})` });
    }
    return hits;
  }
  function fmt(n) {
    return Number(n).toLocaleString("ko-KR", { maximumFractionDigits: n >= 1000 ? 0 : 2 });
  }
  function compact(n) {
    if (n >= 1e8) return (n / 1e8).toFixed(1) + "억";
    if (n >= 1e4) return (n / 1e4).toFixed(1) + "만";
    return String(Math.round(n));
  }
  global.Alerter = { evalBar, fmt, compact };
})(window);
