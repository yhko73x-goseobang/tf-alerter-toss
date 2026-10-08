/* datafeed.js — 토스증권 Open API 멀티시간대 (1m 리샘플 → 1/3/5/15/30m/1h/4h + 1d 직결)
 *
 * 연결 방식: 앱은 토스 원장(https://openapi.tossinvest.com)을 직접 호출하지 않습니다.
 * 같은 서버의 server.js 프록시(/api/toss/*)만 호출합니다. Client Secret·토큰은
 * 서버에만 보관됩니다 (브라우저/CORS·허용IP 문제를 서버 1곳에서 해결).
 *
 * 토스 제약 (openapi.json v1.2.24 기준):
 *  - 캔들 interval은 1m·1d 두 종류, 호출당 최대 200봉, 최신순 반환 → 오래된순으로 뒤집어 사용
 *  - 3m/5m/15m/30m/1h/4h는 1분봉을 받아서 로컬 리샘플 (before/nextBefore 페이지네이션)
 *  - 심볼: KRX 6자리(숫자·영문숫자, 예 005930·0008S0), US 티커(예 AAPL), 지수는 KOSPI·KOSDAQ만
 *    (KOSPI200·COMP·US100·NDX·IXIC·가상자산 등은 토스 미지원 → 명확한 오류로 안내)
 */
(function (global) {
  const TFS = {
    "1m": { sec: 60, interval: "1m", minAge: 60 * 1000 },
    "3m": { sec: 180, interval: "1m", minAge: 60 * 1000 },
    "5m": { sec: 300, interval: "1m", minAge: 60 * 1000 },
    "15m": { sec: 900, interval: "1m", minAge: 2 * 60 * 1000 },
    "30m": { sec: 1800, interval: "1m", minAge: 3 * 60 * 1000 },
    "1h": { sec: 3600, interval: "1m", minAge: 10 * 60 * 1000 },
    "4h": { sec: 14400, interval: "1m", minAge: 30 * 60 * 1000 },
    "1D": { sec: 86400, interval: "1d", minAge: 2 * 60 * 60 * 1000 },
  };

  // 토스 미지원 별칭 → 안내 문구
  const UNSUPPORTED = {
    KOSPI200: "KOSPI 지수를 사용하세요",
    COMP: "토스 미지원 (미국 지수는 개별 티커 사용)",
    US100: "토스 미지원 (미국 지수는 개별 티커 사용)",
    NDX: "토스 미지원 (미국 지수는 개별 티커 사용)",
    IXIC: "토스 미지원 (미국 지수는 개별 티커 사용)",
  };

  // 표시용 심볼 → 토스 호출 규격. 실패 시 Error(사유 포함)
  function tossSymbol(symbol) {
    const s = String(symbol || "").trim().toUpperCase();
    if (!s) throw new Error("빈 종목 코드");
    if (s === "KOSPI" || s === "KOSDAQ") return { kind: "index", toss: s };
    if (UNSUPPORTED[s]) throw new Error(`${s}: ${UNSUPPORTED[s]}`);
    if (/^[A-Z0-9]{6}$/.test(s)) return { kind: "stock", toss: s }; // KRX 6자리 (ETF 영숫자 포함)
    if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) return { kind: "stock", toss: s }; // US 티커
    if (s.includes("/")) throw new Error(`${s}: 가상자산은 토스 API 미지원`);
    throw new Error(`${s}: 토스 지원 형식 아님 (6자리 번호·미국 티커·KOSPI/KOSDAQ)`);
  }
  function isTossSupported(symbol) {
    try { tossSymbol(symbol); return true; }
    catch (_) { return false; }
  }

  // 같은 서버(또는 지정 서버)의 프록시 베이스. 기본 "" = 같은 origin
  function serverBase() {
    try {
      const v = localStorage.getItem("a30t_server");
      return (v == null ? "" : v).replace(/\/+$/, "");
    } catch (_) { return ""; }
  }

  async function tossFetch(path) {
    const base = serverBase();
    let r;
    try {
      r = await fetch(base + path, { headers: { Accept: "application/json" } });
    } catch (e) {
      throw new Error(`서버 접속 실패 (${base || "같은 서버"}): server.js 실행 확인 — ${e.message}`);
    }
    if (r.ok) return r.json();
    let msg = `서버 HTTP ${r.status}`;
    try {
      const j = await r.json();
      if (j && j.error) msg = j.error;
    } catch (_) {}
    throw new Error(msg);
  }

  function toBar(c) {
    const t = Math.floor(Date.parse(c.timestamp) / 1000);
    const num = v => parseFloat(v);
    return {
      time: t,
      open: num(c.openPrice), high: num(c.highPrice),
      low: num(c.lowPrice), close: num(c.closePrice),
      volume: parseInt(c.volume, 10) || 0,
    };
  }
  function mergeBars(oldest, fresh) {
    const m = new Map();
    oldest.forEach(b => m.set(b.time, b));
    fresh.forEach(b => m.set(b.time, b));
    return [...m.values()].sort((a, b) => a.time - b.time);
  }

  // 1분봉 페이지네이션 (최신순 응답 → 오래된순 누적). beforeCursor: ISO 문자열
  async function fetchMinutePages(info, maxPages, beforeCursor) {
    let out = [];
    let before = beforeCursor || null;
    for (let p = 0; p < maxPages; p++) {
      const qs = new URLSearchParams({
        symbol: info.toss, interval: "1m", count: "200",
      });
      if (before) qs.set("before", before);
      const url = info.kind === "index"
        ? `/api/toss/indicators/${info.toss}/candles?${qs.toString()}`
        : `/api/toss/candles?${qs.toString()}`;
      const j = await tossFetch(url);
      const page = ((j.result && j.result.candles) || []).map(toBar).filter(b => b.time && isFinite(b.close));
      page.sort((a, b) => a.time - b.time);
      out = mergeBars(page, out);
      const nb = j.result && j.result.nextBefore;
      if (!nb || page.length < 200) break;
      before = nb;
    }
    return out;
  }
  async function fetchDailyPages(info, maxPages) {
    let out = [];
    let before = null;
    for (let p = 0; p < maxPages; p++) {
      const qs = new URLSearchParams({
        symbol: info.toss, interval: "1d", count: "200",
      });
      if (before) qs.set("before", before);
      // 지수 일봉도 indicators 경로
      const url = info.kind === "index"
        ? `/api/toss/indicators/${info.toss}/candles?${qs.toString()}`
        : `/api/toss/candles?${qs.toString()}`;
      const j = await tossFetch(url);
      const page = ((j.result && j.result.candles) || []).map(toBar).filter(b => b.time && isFinite(b.close));
      page.sort((a, b) => a.time - b.time);
      out = mergeBars(page, out);
      const nb = j.result && j.result.nextBefore;
      if (!nb || page.length < 200) break;
      before = nb;
    }
    return out;
  }

  function resample(bars, sec) {
    if (sec <= 60) return bars;
    const out = [];
    let cur = null;
    for (const b of bars) {
      const t = Math.floor(b.time / sec) * sec;
      if (!cur || cur.time !== t) {
        if (cur) out.push(cur);
        cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += b.volume;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  const DEEP_PAGES = 22;   // 첫 적재: 1분봉 최대 22페이지(약 4400분) → 30m 약 140봉
  const MAX_KEEP_1M = 6000; // 인트라데이 베이스 보관 상한 (1분봉)
  const MAX_KEEP_1D = 600;  // 일봉 보관 상한

  class Feed {
    constructor() {
      this.symbols = [];
      this.spot = {};
      this.intra = new Map(); // symbol -> {bars, fetchedAt, deep}
      this.daily = new Map(); // symbol -> {bars, fetchedAt}
      this.tickCb = new Map();
      this.onWatch = null; this.onLog = null;
      this.pollSec = 20;
      this._timer = null;
    }
    get mode() { return "toss"; }
    log(m) { this.onLog && this.onLog(m); }
    key(symbol, tf) { return symbol + "|" + tf; }
    addSymbols(list) {
      let n = 0;
      list.forEach(s0 => {
        const id = String(s0.id).trim().toUpperCase();
        if (!id || this.symbols.some(s => s.id === id)) return;
        this.symbols.push({ id, name: s0.name || id, alert: s0.alert !== false, star: !!s0.star });
        n++;
      });
      return n;
    }
    removeSymbol(id) {
      this.symbols = this.symbols.filter(s => s.id !== id);
      Object.keys(TFS).forEach(tf => this.tickCb.delete(this.key(id, tf)));
      this.intra.delete(id); this.daily.delete(id);
      delete this.spot[id];
    }
    async ensureIntraday(symbol, force) {
      const info = tossSymbol(symbol); // 미지원이면 throw (상위에서 로그)
      const now = Date.now();
      let st = this.intra.get(symbol);
      if (!st) { st = { bars: [], fetchedAt: 0, deep: false }; this.intra.set(symbol, st); }
      const needDeep = force && !st.deep ? true : !st.deep;
      if (needDeep) {
        const bars = await fetchMinutePages(info, DEEP_PAGES, null);
        if (bars.length < 5) throw new Error(`${symbol}: 1분봉 부족`);
        st.bars = bars.slice(-MAX_KEEP_1M);
        st.fetchedAt = now; st.deep = true;
      } else if (force || now - st.fetchedAt > 60 * 1000) {
        // 최신 1페이지만 받아 병합 (스캔 부하 절감)
        const fresh = await fetchMinutePages(info, 1, null);
        if (fresh.length) {
          st.bars = mergeBars(st.bars, fresh).slice(-MAX_KEEP_1M);
          st.fetchedAt = now;
        }
      }
      return st.bars;
    }
    async ensureDaily(symbol, force) {
      const info = tossSymbol(symbol);
      const now = Date.now();
      let st = this.daily.get(symbol);
      if (!st) { st = { bars: [], fetchedAt: 0 }; this.daily.set(symbol, st); }
      if (force || !st.bars.length || now - st.fetchedAt > TFS["1D"].minAge) {
        const bars = await fetchDailyPages(info, 3);
        if (bars.length < 5) throw new Error(`${symbol}: 일봉 부족`);
        st.bars = bars.slice(-MAX_KEEP_1D);
        st.fetchedAt = now;
      }
      return st.bars;
    }
    async getBars(symbol, tfKey, force) {
      tfKey = TFS[tfKey] ? tfKey : "30m";
      symbol = String(symbol).trim().toUpperCase();
      if (tfKey === "1D") {
        const bars = await this.ensureDaily(symbol, force);
        const last = bars[bars.length - 1];
        if (last) { this.spot[symbol] = last.close; this.onWatch && this.onWatch({ ...this.spot }); }
        return bars.slice(-400);
      }
      const base = await this.ensureIntraday(symbol, force);
      const bars = resample(base, TFS[tfKey].sec).slice(-400);
      if (bars.length < 5) throw new Error(`${symbol}/${tfKey}: 봉 부족 (1분봉 원본 ${base.length}개)`);
      const last = bars[bars.length - 1];
      if (last) { this.spot[symbol] = last.close; this.onWatch && this.onWatch({ ...this.spot }); }
      return bars;
    }
    getBars30m(symbol, force) { return this.getBars(symbol, "30m", force); }
    subscribe(symbol, tfKey, cb) {
      if (typeof tfKey === "function") { cb = tfKey; tfKey = "30m"; }
      const k = this.key(symbol, tfKey);
      if (!this.tickCb.has(k)) this.tickCb.set(k, new Set());
      const set = this.tickCb.get(k);
      set.add(cb);
      return () => set.delete(cb);
    }
    emitLive(symbol, tfKey) {
      // 폴링 기반: 최신 봉을 틱처럼 통지 (차트 진행봉 프리뷰용)
      const k = this.key(symbol, tfKey);
      (this.tickCb.get(k) || []).forEach(cb => {
        try { cb({ symbol, price: this.spot[symbol], time: Date.now(), volume: 0 }, null); }
        catch (_) {}
      });
      this.onWatch && this.onWatch({ ...this.spot });
    }
    async refreshSpots() {
      // 관심종목 현재가 일괄 갱신 (토스 지원 종목만, 최대 200개)
      const ids = this.symbols.map(s => s.id).filter(isTossSupported).slice(0, 200);
      if (!ids.length) return;
      try {
        const j = await tossFetch(`/api/toss/prices?symbols=${encodeURIComponent(ids.join(","))}`);
        (j.result || []).forEach(r => {
          const px = parseFloat(r.lastPrice);
          if (isFinite(px)) this.spot[r.symbol.toUpperCase()] = px;
        });
        this.onWatch && this.onWatch({ ...this.spot });
      } catch (_) { /* 다음 주기에 재시도 */ }
    }
    startPolling(mainTf, symbolFn, onCycle) {
      this.stopPolling();
      this._timer = setInterval(async () => {
        const sym = typeof symbolFn === "function" ? symbolFn() : symbolFn;
        if (!sym) return;
        try {
          if (isTossSupported(sym)) {
            await this.ensureIntraday(sym, false);
            const base = (this.intra.get(sym) || {}).bars || [];
            const bars = (mainTf === "1D"
              ? await this.ensureDaily(sym, false)
              : resample(base, (TFS[mainTf] || TFS["30m"]).sec).slice(-400));
            const last = bars[bars.length - 1];
            if (last) this.spot[sym] = last.close;
            this.emitLive(sym, mainTf);
          }
          await this.refreshSpots();
        } catch (e) { this.log(`수신 실패 ${sym}/${mainTf}: ${e.message}`); }
        onCycle && onCycle();
      }, Math.max(15, this.pollSec) * 1000);
    }
    stopPolling() { if (this._timer) clearInterval(this._timer); this._timer = null; }
  }
  Feed.TFS = TFS;

  async function checkServer() {
    try {
      const j = await tossFetch("/api/toss/status");
      return j;
    } catch (e) { throw e; }
  }

  global.Feed30m = { TFS, Feed30m: Feed, TF_SEC: 1800, tossSymbol, isTossSupported, checkServer };
})(window);
