// alert-30m-toss 서버 — 정적 서빙 + 토스증권 Open API 프록시
// 실행: TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 환경변수(또는 .env) 설정 후
//       node server.js → http://localhost:8083/
// 폰 접속: 같은 Wi-Fi에서 http://<PC의-LAN-IP>:8083/ (앱 종목탭 '서버 주소'에 입력)
// 허용 IP: 토스 WTS 설정에 등록된 IP는 이 서버의 '외부 egress IP'여야 함
//          (폰 IP가 아님 — 폰은 서버를 경유하므로 Secret·IP 등록이 서버 1곳으로 끝남)
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = +(process.env.PORT || 8083);
const TOSS_BASE = "https://openapi.tossinvest.com";

// .env 간이 로더 (없으면 무시, 환경변수 우선)
try {
  const envPath = path.join(ROOT, ".env");
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf-8").split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    });
  }
} catch (_) {}

const CLIENT_ID = process.env.TOSS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.TOSS_CLIENT_SECRET || "";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".wav": "audio/wav",
};

// ---- 토큰 캐시 (토스는 client당 유효 토큰 1개, expires_in 24h) ----
let cached = { token: "", expAt: 0 };
let inflight = null;
async function getToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    const e = new Error("서버에 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 미설정 (.env 또는 환경변수)");
    e.code = "NO_KEYS";
    throw e;
  }
  if (cached.token && Date.now() < cached.expAt - 120000) return cached.token;
  if (inflight) return inflight;
  inflight = (async () => {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    });
    const r = await fetch(`${TOSS_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const t = await r.text();
    if (!r.ok) {
      cached = { token: "", expAt: 0 };
      const e = new Error(r.status === 403
        ? "토스 403: 서버 IP가 허용 IP에 없음 (WTS Open API > 허용 IP 관리에 이 서버의 외부 IP 등록)"
        : `토스 토큰 실패 HTTP ${r.status}: ${t.slice(0, 200)}`);
      e.code = r.status === 403 ? "IP_DENIED" : "TOKEN_FAIL";
      throw e;
    }
    const j = JSON.parse(t);
    cached = { token: j.access_token, expAt: Date.now() + (j.expires_in || 86400) * 1000 };
    return cached.token;
  })();
  try { return await inflight; }
  finally { inflight = null; }
}

async function tossGet(pathQ, retry) {
  const token = await getToken();
  const r = await fetch(TOSS_BASE + pathQ, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const t = await r.text();
  if (r.status === 401 && !retry) { // 토큰 무효화 시 1회 재발급 후 재시도
    cached = { token: "", expAt: 0 };
    return tossGet(pathQ, true);
  }
  if (!r.ok) {
    let msg = `토스 HTTP ${r.status}`;
    try {
      const j = JSON.parse(t);
      if (j.error) msg = `토스 오류 [${j.error.code || r.status}]: ${j.error.message || ""}`;
    } catch (_) { msg += `: ${t.slice(0, 150)}`; }
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return t;
}

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
    res.end();
    return;
  }
  try {
    const u = new URL(req.url, "http://localhost");
    // ---- 토스 프록시 ----
    if (u.pathname === "/api/toss/status" && req.method === "GET") {
      return send(res, 200, JSON.stringify({
        ok: true, hasKeys: !!(CLIENT_ID && CLIENT_SECRET),
        tokenCached: !!cached.token,
        expiresInSec: cached.token ? Math.max(0, Math.round((cached.expAt - Date.now()) / 1000)) : 0,
        base: TOSS_BASE,
        note: "캔들 1m·1d만 제공 (30m 등은 1m 리샘플). 심볼: 6자리 KR·미국 티커·KOSPI/KOSDAQ.",
      }));
    }
    if (u.pathname === "/api/toss/candles" && req.method === "GET") {
      const symbol = (u.searchParams.get("symbol") || "").trim();
      const interval = u.searchParams.get("interval") || "1m";
      const count = Math.min(200, Math.max(1, +(u.searchParams.get("count") || 200)));
      if (!symbol || !/^[A-Za-z0-9.\-]+$/.test(symbol)) return send(res, 400, JSON.stringify({ error: "symbol 형식 오류" }));
      if (!["1m", "1d"].includes(interval)) return send(res, 400, JSON.stringify({ error: "interval은 1m·1d만 지원 (토스 제약)" }));
      const q = new URLSearchParams({ symbol, interval, count: String(count), adjusted: "true" });
      const before = u.searchParams.get("before");
      if (before) q.set("before", before);
      try {
        const t = await tossGet(`/api/v1/candles?${q.toString()}`);
        return send(res, 200, t);
      } catch (e) { return send(res, e.code === "NO_KEYS" || e.code === "IP_DENIED" ? 502 : (e.status || 502), JSON.stringify({ error: e.message })); }
    }
    if (u.pathname.startsWith("/api/toss/indicators/") && req.method === "GET") {
      const m = u.pathname.match(/^\/api\/toss\/indicators\/([A-Za-z0-9_]+)\/candles$/);
      if (!m) return send(res, 404, JSON.stringify({ error: "not found" }));
      const symbol = m[1];
      if (!["KOSPI", "KOSDAQ"].includes(symbol)) return send(res, 400, JSON.stringify({ error: "지표 심볼은 KOSPI·KOSDAQ만 지원" }));
      const interval = u.searchParams.get("interval") || "1m";
      if (!["1m", "1d"].includes(interval)) return send(res, 400, JSON.stringify({ error: "interval은 1m·1d만 지원" }));
      const q = new URLSearchParams({ interval, count: String(Math.min(200, Math.max(1, +(u.searchParams.get("count") || 200)))) });
      const before = u.searchParams.get("before");
      if (before) q.set("before", before);
      try {
        const t = await tossGet(`/api/v1/market-indicators/${symbol}/candles?${q.toString()}`);
        return send(res, 200, t);
      } catch (e) { return send(res, e.status || 502, JSON.stringify({ error: e.message })); }
    }
    if (u.pathname === "/api/toss/prices" && req.method === "GET") {
      const symbols = (u.searchParams.get("symbols") || "").trim();
      if (!symbols) return send(res, 400, JSON.stringify({ error: "symbols 필요" }));
      try {
        const t = await tossGet(`/api/v1/prices?symbols=${encodeURIComponent(symbols)}`);
        return send(res, 200, t);
      } catch (e) { return send(res, e.status || 502, JSON.stringify({ error: e.message })); }
    }
    // ---- 정적 파일 ----
    let f = u.pathname.split("?")[0];
    if (f === "/") f = "/index.html";
    const fp = path.join(ROOT, decodeURIComponent(f));
    if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
    const data = fs.readFileSync(fp);
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch (_) { res.writeHead(404); res.end("not found"); }
}).listen(PORT, () => console.log(`Toss alerter: http://localhost:${PORT}/`));
