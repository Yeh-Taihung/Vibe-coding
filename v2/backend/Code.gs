/**
 * 寶新 工程處 數據中控台 — 後台（Google Apps Script）
 *
 * 這段程式綁在「工程處中控台資料」試算表上，負責：
 *   1. 確認登入者：中控台用 Google 帳號登入，這裡驗證登入憑證，並比對「使用者」分頁的白名單。
 *   2. 讀資料：把各分頁整理後送給中控台；員工編號、到職日、離職日只留在試算表，不會送出。
 *   3. 寫資料：中控台按「儲存」時，只更新有變動的欄位，並在「異動紀錄」分頁記下誰改了什麼。
 *   4. 每日備份：每天自動複製一份試算表到「中控台備份」資料夾，保留 30 份。
 *
 * 安裝步驟請看 backend/部署步驟.md。
 * 注意：各分頁第一列的標題格式是「中文 (key)」，括號內的英文是程式對應用的，請不要修改。
 */

const TABLES = {
  people:      { tab: "人員",         key: "name" },
  units:       { tab: "單位",         key: "name" },
  companies:   { tab: "公司",         key: "name" },
  projects:    { tab: "專案",         key: "id" },
  assignments: { tab: "派遣與到崗",   key: "id" },
  tasks:       { tab: "安裝任務",     key: "id" },
  issues:      { tab: "任務與問題點", key: "id" },
};
const USERS_TAB = "使用者", LOG_TAB = "異動紀錄", LISTS_TAB = "選單";
// 只留在試算表、不送到中控台，也不允許從中控台覆寫的欄位
const HIDDEN = { people: ["empNo", "hireDate", "leaveDate"] };
const JSON_KEYS = ["milestones", "log", "openings", "visaHistory"];
const BOOL_KEYS = ["deleted", "dueTBD", "retired"];
const ROLES = ["管理", "編輯", "檢視"];

// 各分頁的欄位順序與中文標題（新欄位會自動加在最右邊）
const SCHEMA = {
  people: [["name","姓名"],["enName","英文名"],["orgType","類型"],["company","公司"],["unit","單位"],["extDept","其他部門"],["org","供應商公司"],
           ["title","職稱"],["role","工種"],["status","在職狀態"],["note","備註"],["empNo","員工編號（不顯示）"],["hireDate","到職日（不顯示）"],["leaveDate","離職日（不顯示）"],
           ["id","系統編號"],["deleted","已刪除"],["deletedAt","刪除日"],["lastAt","最後更新"],["lastBy","更新者"]],
  units: [["name","單位名稱"],["level","層級"],["parent","上層單位"],["openings","職缺"],["retired","已停用"],["lastAt","最後更新"],["lastBy","更新者"]],
  companies: [["name","公司"],["group","集團"],["full","全名"],["lastAt","最後更新"],["lastBy","更新者"]],
  projects: [["id","專案編號"],["name","專案名稱"],["country","國家"],["city","城市"],["status","狀態"],["owner","負責人"],["start","開始日"],["planEnd","計畫完成"],
             ["note","備註"],["milestones","項目節點"],["lastAt","最後更新"],["lastBy","更新者"]],
  assignments: [["id","編號"],["person","人員"],["project","專案編號"],["country","國家"],["city","城市"],["line","產線"],["duty","派遣目的／職責"],
                ["planStart","計畫開始"],["planEnd","計畫結束"],["actualStart","實際開始"],["actualEnd","實際結束"],["status","狀態"],["budget","預算 TWD"],["cost","實支 TWD"],
                ["note","備註"],["source","來源"],["updated","資料更新日"],["deleted","已刪除"],["deletedAt","刪除日"],["lastAt","最後更新"],["lastBy","更新者"]],
  tasks: [["id","編號"],["project","專案編號"],["section","工段"],["process","工序"],["task","任務"],["planStart","計畫開始"],["planEnd","計畫結束"],
          ["actualStart","實際開始"],["actualEnd","實際結束"],["owner","負責單位"],["status","狀態"],["note","備註"],["updated","資料更新日"],["lastAt","最後更新"],["lastBy","更新者"]],
  issues: [["id","編號"],["project","專案編號"],["kind","類型"],["title","事項"],["desc","說明"],["category","類別"],["severity","嚴重度"],["owner","負責人"],
           ["party","協力單位"],["opened","啟動日"],["due","預計完成"],["dueTBD","期限未定"],["closed","實際完成"],["status","狀態"],["task","關聯任務"],["note","備註"],
           ["log","對策與進度"],["source","來源"],["deleted","已刪除"],["deletedAt","刪除日"],["lastAt","最後更新"],["lastBy","更新者"]],
};
const DEFAULT_LISTS = {
  country: "中國、印尼、印度、摩洛哥、斯洛伐克、美國", assignStatus: "暫定、確認、取消", taskStatus: "未開始、進行中、有風險、完成",
  milestone: "KO、PA、TT、SOP、開工、設備進廠、驗收、量產", issueStatus: "Open、處理中、待確認、已結案", issueSeverity: "高、中、低",
  issueCategory: "進度、人力、設備、物料、品質、安全、合約、其他", projectStatus: "規劃中、評估中、進行中、暫停、結案、未啟動",
};

// ---------------------------------------------------------------- 入口
function doGet() { return ContentService.createTextOutput("寶新工程處中控台後台運作中"); }

function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const user = verify_(req.token);
    if (req.action === "load") {
      touchUser_(user.email);
      out = { ok: true, user: { email: user.email, name: user.name, role: user.role }, data: loadAll_(), at: new Date().toISOString() };
    } else if (req.action === "save") {
      if (user.role === "檢視") throw err_(403, "你的帳號只有檢視權限，無法修改資料");
      out = { ok: true, saved: save_(req.items || [], user), at: new Date().toISOString() };
    } else throw err_(400, "未知的動作");
  } catch (x) {
    out = { ok: false, code: x.code || 500, error: x.message || String(x) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- 登入驗證
function err_(code, msg) { const e = new Error(msg); e.code = code; return e; }

function verify_(token) {
  if (!token) throw err_(401, "請先登入");
  const cache = CacheService.getScriptCache();
  const h = "t:" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  let info = cache.get(h);
  if (info) info = JSON.parse(info);
  else {
    const r = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token), { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw err_(401, "登入已過期，請重新登入");
    const t = JSON.parse(r.getContentText());
    const cid = PropertiesService.getScriptProperties().getProperty("CLIENT_ID");
    if (!cid) throw err_(500, "後台尚未設定 CLIENT_ID（指令碼屬性）");
    if (t.aud !== cid) throw err_(401, "登入來源不符");
    if (String(t.email_verified) !== "true") throw err_(403, "這個 Google 帳號的 Email 尚未驗證");
    info = { email: String(t.email).toLowerCase(), name: t.name || "" };
    const ttl = Math.floor(Math.min(3000, Number(t.exp) - Date.now() / 1000 - 30));
    if (ttl > 60) cache.put(h, JSON.stringify(info), ttl);
  }
  const u = users_().find(x => x.email === info.email);
  if (!u || !u.on) throw err_(403, `${info.email} 尚未開通中控台權限，請聯絡管理者`);
  return { email: u.email, name: u.name || info.name, role: u.role };
}

function users_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(USERS_TAB);
  if (!sh) return [];
  return sh.getDataRange().getDisplayValues().slice(1).filter(r => r[0]).map(r => ({
    email: String(r[0]).trim().toLowerCase(), name: r[1], role: ROLES.includes(r[2]) ? r[2] : "檢視", on: String(r[3]).trim() !== "否",
  }));
}

function touchUser_(email) {
  try {
    const sh = SpreadsheetApp.getActive().getSheetByName(USERS_TAB);
    const v = sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues();
    const ix = v.findIndex(r => String(r[0]).trim().toLowerCase() === email);
    if (ix > 0) sh.getRange(ix + 1, 5).setValue(Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm"));
  } catch (e) { /* 只是紀錄，失敗不影響登入 */ }
}

// ---------------------------------------------------------------- 讀取
function keyOf_(header) {
  const m = String(header).match(/\(([A-Za-z0-9_]+)\)\s*$/);
  return m ? m[1] : String(header).trim();
}
function label_(table, key) {
  const f = (SCHEMA[table] || []).find(x => x[0] === key);
  return `${f ? f[1] : key} (${key})`;
}
function normDate_(v) {
  const m = String(v).match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  return m ? `${m[1]}-${("0" + m[2]).slice(-2)}-${("0" + m[3]).slice(-2)}` : v;
}
function decode_(key, v) {
  if (v === "") return BOOL_KEYS.includes(key) ? false : "";
  if (JSON_KEYS.includes(key)) { try { return JSON.parse(v); } catch (e) { return key === "openings" ? null : []; } }
  if (BOOL_KEYS.includes(key)) return /^(true|是|y|1)$/i.test(String(v).trim());
  return normDate_(v);
}
function encode_(key, v) {
  if (v === null || v === undefined) return "";
  if (JSON_KEYS.includes(key) || typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "TRUE" : "";
  return String(v);
}

// 比對前把 JSON 欄位整理成同一種寫法，避免只是空白不同就被當成「有修改」
function normJson_(key, v) {
  if (!v || !(JSON_KEYS.includes(key) || /^[\[{]/.test(v))) return v;
  try { return JSON.stringify(JSON.parse(v)); } catch (e) { return v; }
}

function readTable_(table, strip) {
  const sh = SpreadsheetApp.getActive().getSheetByName(TABLES[table].tab);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getDisplayValues();
  const keys = v[0].map(keyOf_), hide = strip ? (HIDDEN[table] || []) : [];
  const k = TABLES[table].key;
  return v.slice(1).map(r => {
    const o = {};
    keys.forEach((key, i) => { if (key && !hide.includes(key) && key !== "lastAt" && key !== "lastBy") o[key] = decode_(key, r[i]); });
    return o;
  }).filter(o => o[k]);
}

function loadAll_() {
  const data = {};
  Object.keys(TABLES).forEach(t => data[t] = readTable_(t, true));
  const lists = {};
  const sh = SpreadsheetApp.getActive().getSheetByName(LISTS_TAB);
  const rows = sh ? sh.getDataRange().getDisplayValues().slice(1) : Object.entries(DEFAULT_LISTS);
  rows.forEach(r => { if (r[0]) lists[keyOf_(r[0])] = String(r[1]).split(/[、,，\n]/).map(s => s.trim()).filter(Boolean); });
  data.lists = lists;
  return data;
}

// ---------------------------------------------------------------- 寫入
function save_(items, user) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActive(), now = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss");
    const logRows = [], saved = [];
    items.forEach(it => {
      const table = it.table;
      if (!TABLES[table]) throw err_(400, `不能寫入「${table}」`);
      const sh = ss.getSheetByName(TABLES[table].tab) || ensureTab_(ss, table);
      const kName = TABLES[table].key;
      const rec = Object.assign({}, it.record || {});
      (HIDDEN[table] || []).forEach(h => delete rec[h]);
      let key = String(rec[kName] || it.key || "").trim();
      if (!key) throw err_(400, `${TABLES[table].tab}：缺少 ${kName}`);

      let headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
      let keys = headers.map(keyOf_);
      const addCol = k => { const c = keys.length + 1; sh.getRange(1, c).setValue(label_(table, k)).setFontWeight("bold"); keys.push(k); return c; };
      ["lastAt", "lastBy"].concat(Object.keys(rec)).forEach(k => { if (!keys.includes(k)) addCol(k); });

      const kc = keys.indexOf(kName);
      const last = sh.getLastRow();
      const col = last > 1 ? sh.getRange(2, kc + 1, last - 1, 1).getDisplayValues().map(r => String(r[0]).trim()) : [];
      let rowIx = col.indexOf(key);
      let oldKey = "";
      // 兩個人同時新增，編號撞到時換一個新編號（姓名類的鍵則視為同一筆）
      if (it.isNew && rowIx >= 0 && kName === "id") {
        oldKey = key; key = nextId_(key, col); rec.id = key; rowIx = -1;
      }
      rec[kName] = key;
      const width = keys.length;
      const rowNo = rowIx >= 0 ? rowIx + 2 : last + 1;
      const range = sh.getRange(rowNo, 1, 1, width);
      const cur = rowIx >= 0 ? range.getDisplayValues()[0] : new Array(width).fill("");
      while (cur.length < width) cur.push("");
      const next = cur.slice(), changed = {};
      Object.keys(rec).forEach(k => {
        const c = keys.indexOf(k), nv = encode_(k, rec[k]);
        if (c >= 0 && nv !== normJson_(k, cur[c])) { next[c] = nv; changed[k] = rec[k]; }
      });
      if (!Object.keys(changed).length && rowIx >= 0) { saved.push({ table, key, oldKey, record: rowObj_(table, keys, next) }); return; }
      next[keys.indexOf("lastAt")] = now;
      next[keys.indexOf("lastBy")] = user.email;
      range.setNumberFormat("@").setValues([next]);
      const action = rowIx < 0 ? "新增" : (changed.deleted === true ? "刪除" : "更新");
      logRows.push([now, user.email, user.name || "", TABLES[table].tab, key, action, JSON.stringify(changed).slice(0, 4000)]);
      saved.push({ table, key, oldKey, record: rowObj_(table, keys, next) });
    });
    if (logRows.length) {
      const lg = ss.getSheetByName(LOG_TAB) || ensureLog_(ss);
      lg.getRange(lg.getLastRow() + 1, 1, logRows.length, logRows[0].length).setNumberFormat("@").setValues(logRows);
    }
    SpreadsheetApp.flush();
    return saved;
  } finally { lock.releaseLock(); }
}

function rowObj_(table, keys, row) {
  const o = {}, hide = HIDDEN[table] || [];
  keys.forEach((k, i) => { if (k && !hide.includes(k) && k !== "lastAt" && k !== "lastBy") o[k] = decode_(k, row[i]); });
  return o;
}

function nextId_(key, col) {
  const m = key.match(/^([A-Za-z]+-?)(\d+)$/);
  if (m && m[2].length <= 4) {   // ISS-041、T030 這類流水號：取目前最大值 +1
    const nums = col.map(x => (x.match(new RegExp("^" + m[1] + "(\\d+)$")) || [])[1]).filter(Boolean).map(Number);
    return m[1] + String(Math.max(0, ...nums) + 1).padStart(m[2].length, "0");
  }
  return key + "-" + Utilities.getUuid().slice(0, 4);
}

// ---------------------------------------------------------------- 安裝與維護
/** 第一次安裝時執行一次：補齊分頁與標題、設定純文字格式、建立白名單與每日備份。可重複執行。 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(t => ensureTab_(ss, t));
  if (!ss.getSheetByName(USERS_TAB)) {
    const u = ss.insertSheet(USERS_TAB);
    u.getRange(1, 1, 1, 5).setValues([["Email", "姓名", "權限（管理／編輯／檢視）", "啟用（是／否）", "最後登入"]]).setFontWeight("bold");
    u.getRange(2, 1, 1, 4).setValues([[Session.getEffectiveUser().getEmail(), "", "管理", "是"]]);
    u.setFrozenRows(1);
    u.getRange("C2:C500").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLES, true).build());
    u.getRange("D2:D500").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["是", "否"], true).build());
  }
  if (!ss.getSheetByName(LISTS_TAB)) {
    const l = ss.insertSheet(LISTS_TAB);
    l.getRange(1, 1, 1, 2).setValues([["類別 (key)", "選項（用頓號、分隔）"]]).setFontWeight("bold");
    const rows = Object.entries(DEFAULT_LISTS);
    l.getRange(2, 1, rows.length, 2).setNumberFormat("@").setValues(rows);
  }
  ensureLog_(ss);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === "backupDaily").forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("backupDaily").timeBased().everyDays(1).atHour(2).inTimezone("Asia/Taipei").create();
  if (!PropertiesService.getScriptProperties().getProperty("CLIENT_ID"))
    Logger.log("提醒：還沒設定 CLIENT_ID。請到「專案設定 > 指令碼屬性」新增 CLIENT_ID。");
  Logger.log("安裝完成");
}

function ensureTab_(ss, table) {
  let sh = ss.getSheetByName(TABLES[table].tab);
  if (!sh) {
    sh = ss.insertSheet(TABLES[table].tab);
    const hs = SCHEMA[table].map(([k]) => label_(table, k));
    sh.getRange(1, 1, 1, hs.length).setValues([hs]).setFontWeight("bold");
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat("@");
  return sh;
}

function ensureLog_(ss) {
  let lg = ss.getSheetByName(LOG_TAB);
  if (!lg) {
    lg = ss.insertSheet(LOG_TAB);
    lg.getRange(1, 1, 1, 7).setValues([["時間", "Email", "姓名", "分頁", "鍵", "動作", "變更內容"]]).setFontWeight("bold");
    lg.setFrozenRows(1);
  }
  return lg;
}

/** 每天凌晨 2 點自動執行：複製整份試算表到「中控台備份」資料夾，保留最近 30 份。 */
function backupDaily() {
  const file = DriveApp.getFileById(SpreadsheetApp.getActive().getId());
  const it = DriveApp.getFoldersByName("中控台備份");
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder("中控台備份");
  file.makeCopy(`${file.getName()}_備份_${Utilities.formatDate(new Date(), "Asia/Taipei", "yyyyMMdd")}`, folder);
  const copies = [];
  const fs = folder.getFiles();
  while (fs.hasNext()) copies.push(fs.next());
  copies.sort((a, b) => b.getDateCreated() - a.getDateCreated()).slice(30).forEach(f => f.setTrashed(true));
}
