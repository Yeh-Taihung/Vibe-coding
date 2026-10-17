// 把 Code.gs 的設定匯出成 JSON，給建表與測試共用
const fs = require("fs"), vm = require("vm"), path = require("path");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8") + "\n;this.__ = {TABLES, SCHEMA, JSON_KEYS, BOOL_KEYS, HIDDEN, USERS_TAB, LOG_TAB, LISTS_TAB};", ctx);
process.stdout.write(JSON.stringify(ctx.__));
