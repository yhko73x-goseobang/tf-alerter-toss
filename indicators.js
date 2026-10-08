/* indicators.js — 30분봉 전용 순수 계산 (의존성 없음) */
(function (global) {
  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function bollinger(closes, n, k) {
    const mid = sma(closes, n);
    const up = new Array(closes.length).fill(null);
    const dn = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd; dn[i] = mid[i] - k * sd;
    }
    return { mid, up, dn };
  }
  function priceChannel(highs, lows, n) {
    const up = new Array(highs.length).fill(null);
    const dn = new Array(highs.length).fill(null);
    const mid = new Array(highs.length).fill(null);
    for (let i = n - 1; i < highs.length; i++) {
      let h = -Infinity, l = Infinity;
      for (let j = i - n + 1; j <= i; j++) { if (highs[j] > h) h = highs[j]; if (lows[j] < l) l = lows[j]; }
      up[i] = h; dn[i] = l; mid[i] = (h + l) / 2;
    }
    return { up, mid, dn };
  }
  function volMA(vols, n) { return sma(vols, n); }
  function ema(values, n) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { out[i] = null; continue; }
      if (prev == null) {
        // 시드: 이전 n개 단순평균
        if (i + 1 < n) { out[i] = null; continue; }
        let s = 0, ok = true;
        for (let j = i - n + 1; j <= i; j++) { if (values[j] == null) { ok = false; break; } s += values[j]; }
        if (!ok) { out[i] = null; continue; }
        prev = s / n;
      } else prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }
  function stdev(values, n) {
    const out = new Array(values.length).fill(null);
    const m = sma(values, n);
    for (let i = n - 1; i < values.length; i++) {
      if (m[i] == null) continue;
      let s = 0, cnt = 0;
      for (let j = i - n + 1; j <= i; j++) { if (values[j] == null) continue; s += (values[j] - m[i]) ** 2; cnt++; }
      out[i] = cnt ? Math.sqrt(s / n) : null;
    }
    return out;
  }
  // Adaptive Trend Flow (Pine 이식): fast/slow EMA 기준 + 변동성 밴드 추적
  function atf(bars, len, smoothLen, sens) {
    len = len || 10; smoothLen = smoothLen || 14; sens = sens == null ? 0.5 : sens;
    const n = bars.length;
    const typical = bars.map(b => (b.high + b.low + b.close) / 3);
    const fastEma = ema(typical, len);
    const slowEma = ema(typical, len * 2);
    const vol = stdev(typical, len);
    const smoothVol = ema(vol, smoothLen);
    const basis = new Array(n).fill(null), upper = new Array(n).fill(null), lower = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (fastEma[i] == null || slowEma[i] == null || smoothVol[i] == null) continue;
      basis[i] = (fastEma[i] + slowEma[i]) / 2;
      upper[i] = basis[i] + smoothVol[i] * sens;
      lower[i] = basis[i] - smoothVol[i] * sens;
    }
    const trend = new Array(n).fill(0), level = new Array(n).fill(null);
    const longX = new Array(n).fill(false), shortX = new Array(n).fill(false);
    const intensity = new Array(n).fill(0);
    let run = 0, lastS = 0;
    let prevLevel = null, state = 0, prevCloseLvl = null;
    for (let i = 0; i < n; i++) {
      const c = bars[i].close, u = upper[i], l = lower[i], bs = basis[i];
      if (u == null || l == null || bs == null) continue;
      if (prevLevel == null) { state = c > bs ? 1 : -1; prevLevel = state === 1 ? l : u; }
      if (state === 1) {
        if (c < l) { state = -1; prevLevel = u; }
        else prevLevel = l;
      } else {
        if (c > u) { state = 1; prevLevel = l; }
        else prevLevel = u;
      }
      trend[i] = state; level[i] = prevLevel;
      if (state !== lastS) { run = 0; lastS = state; }
      run = Math.min(run + 1, 20);
      intensity[i] = run;
      if (prevCloseLvl != null) {
        const pc = bars[i - 1].close;
        if (pc <= prevCloseLvl && c > prevLevel) longX[i] = true;
        if (pc >= prevCloseLvl && c < prevLevel) shortX[i] = true;
      }
      prevCloseLvl = prevLevel;
    }
    return { basis, upper, lower, trend, level, longX, shortX, intensity };
  }

  // Linear Regression Channel (Pine 이식: len=100, dev=2.0, 종가 기준)
  function linregChannel(closes, len, devlen) {
    len = len || 100; devlen = devlen == null ? 2.0 : devlen;
    const top = new Array(closes.length).fill(null);
    const bot = new Array(closes.length).fill(null);
    const half = Math.floor(len / 2), oddAdj = (1 - len % 2) / 2;
    for (let i = len - 1; i < closes.length; i++) {
      let sum = 0, sumI = 0, sumII = 0, sumIV = 0, ok = true;
      for (let j = 0; j < len; j++) {
        const v = closes[i - len + 1 + j];
        if (v == null || !isFinite(v)) { ok = false; break; }
        sum += v; sumI += j; sumII += j * j; sumIV += j * v;
      }
      if (!ok) continue;
      const denom = len * sumII - sumI * sumI;
      if (!denom) continue;
      const slope = (len * sumIV - sumI * sum) / denom;
      const mid = sum / len;
      const intercept = mid - slope * half + oddAdj * slope;
      const endy = intercept + slope * (len - 1);
      let ds = 0;
      for (let x = 0; x < len; x++) {
        const f = slope * (len - x) + intercept;
        const d = closes[i - x] - f;
        ds += d * d;
      }
      const dev = Math.sqrt(ds / len);
      top[i] = endy + dev * devlen;
      bot[i] = endy - dev * devlen;
    }
    return { top, bot };
  }

  // bars: [{time,open,high,low,close,volume}] (time=초)
  function computeAll(bars, p) {
    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const vols = bars.map(b => b.volume);
    const mas = {};
    (p.maLengths || [20, 60, 100, 200]).forEach(n => { mas[n] = sma(closes, n); });
    const bb = bollinger(closes, p.bbN, p.bbK);
    const pc = priceChannel(highs, lows, p.pcLen);
    const vma = volMA(vols, p.volN);
    const atfFast = atf(bars, 10, 14, 0.5);
    const atfSlow = atf(bars, 10, 14, 2.0);
    const lr = linregChannel(closes, 100, 2.0);
    return { mas, bb, pc, vma, atfFast, atfSlow, lr };
  }

  global.Indicators = { sma, ema, stdev, bollinger, priceChannel, volMA, atf, linregChannel, computeAll };
})(window);
