// 本機測試用：在記憶體裡模擬 Google 試算表與 Apps Script 環境，直接執行 Code.gs。
// 用法：node mock_server.js sheet.json 8787
const fs = require("fs"), vm = require("vm"), path = require("path"), http = require("http"), crypto = require("crypto");
const seed = JSON.parse(fs.readFileSync(process.argv[2], "utf8")), PORT = +process.argv[3] || 8787;
const CLIENT_ID = "test-client";

class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  _grow() { const d = this.sh.d; while (d.length < this.r + this.nr - 1) d.push([]); }
  getDisplayValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = this.sh.d[this.r - 1 + i] || []; const o = []; for (let j = 0; j < this.nc; j++) o.push(row[this.c - 1 + j] ?? ""); out.push(o); } return out; }
  setValues(v) { this._grow(); v.forEach((row, i) => { const R = this.sh.d[this.r - 1 + i]; row.forEach((x, j) => R[this.c - 1 + j] = String(x)); }); return this; }
  setValue(x) { return this.setValues([[x]]); }
  setFontWeight() { return this; } setNumberFormat() { return this; } setDataValidation() { return this; }
}
class Sheet {
  constructor(name, d) { this.name = name; this.d = d.map(r => r.map(String)); }
  getLastRow() { let n = this.d.length; while (n && !this.d[n - 1].some(x => x !== "")) n--; return n; }
  getLastColumn() { return Math.max(0, ...this.d.map(r => { let n = r.length; while (n && (r[n - 1] ?? "") === "") n--; return n; })); }
  getMaxRows() { return Math.max(1000, this.d.length); } getMaxColumns() { return Math.max(26, this.getLastColumn()); }
  getRange(r, c, nr = 1, nc = 1) { return typeof r === "string" ? new Range(this, 1, 1, 1, 1) : new Range(this, r, c, nr, nc); }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  setFrozenRows() {}
}
const sheets = {}; Object.entries(seed).forEach(([n, d]) => sheets[n] = new Sheet(n, d));
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n, [])), getId: () => "mock" };
const cache = new Map(); let fetches = 0;
const ctx = {
  SpreadsheetApp: { getActive: () => ss, flush() {}, newDataValidation: () => ({ requireValueInList() { return this; }, build() { return {}; } }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
  CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === "CLIENT_ID" ? CLIENT_ID : null }) },
  UrlFetchApp: { fetch(url) { fetches++; const tok = decodeURIComponent(url.split("id_token=")[1]);
    let p; try { p = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()); } catch (e) { return { getResponseCode: () => 400, getContentText: () => "{}" }; }
    if (p.exp * 1000 < Date.now()) return { getResponseCode: () => 400, getContentText: () => "{}" };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(Object.assign({ email_verified: "true" }, p)) }; } },
  Utilities: { DigestAlgorithm: { SHA_256: "sha256" }, computeDigest: (a, s) => crypto.createHash("sha256").update(s).digest(),
    base64EncodeWebSafe: b => Buffer.from(b).toString("base64url"), formatDate: (d, tz, f) => d.toISOString().replace("T", " ").slice(0, f.length > 16 ? 19 : 16), getUuid: () => crypto.randomUUID() },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Session: { getEffectiveUser: () => ({ getEmail: () => "admin@example.com" }) },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased() { return this; }, everyDays() { return this; }, atHour() { return this; }, inTimezone() { return this; }, create() {} }) },
  Logger: { log: m => console.log("[Logger]", m) }, console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8"), ctx);
http.createServer((req, res) => {
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url === "/__sheet") { res.end(JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([n, s]) => [n, s.d])))); return; }
    if (req.url === "/__stats") { res.end(JSON.stringify({ fetches })); return; }
    const out = req.method === "POST" ? ctx.doPost({ postData: { contents: body } }) : ctx.doGet();
    res.setHeader("Content-Type", "application/json"); res.end(out.s);
  });
}).listen(PORT, () => console.log("mock on", PORT));
