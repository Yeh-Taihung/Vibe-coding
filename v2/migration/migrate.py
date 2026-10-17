"""
寶新系統工程處 數據中控台 v2 — 舊資料搬移腳本

把舊版 4 張 Google 試算表（出差紀錄、芝加哥電芯、芝加哥 Module Pack、合約）
轉成新架構：人員 / 專案 / 派遣 / 任務 / 合約 / 選單。

所有修改都會寫進 migration_report.md，方便逐筆核對。
用法：python3 migrate.py <raw資料夾> <輸出資料夾>
"""
import csv, json, re, sys
from datetime import date, datetime
from pathlib import Path

RAW = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
TODAY = date(2026, 10, 17)
report = {"清理": [], "刪除": [], "合併": [], "待確認": []}


def rd(name):
    with open(RAW / name, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def d(s):
    s = (s or "").strip()
    if not s:
        return ""
    return datetime.strptime(s, "%Y/%m/%d").date().isoformat()


# ---------- 名稱正規化 ----------
NAME_FIX = {"吳健銘": "吳建銘"}  # 同一人兩種寫法，以出差紀錄為準
# 協理確認過的行程：舊表標「暫定」，但已確定成行（2026/10/17 確認）
CONFIRMED_TRIPS = {("馮祥豪", "2026/10/10")}


def clean_name(raw):
    n = raw.strip()
    tentative = "(暫定)" in n
    n = n.replace("(暫定)", "")
    n2 = re.sub(r"^(CS|OS|AS)\s+", "", n)
    if n2 != raw.strip():
        report["清理"].append(f"姓名「{raw}」→「{NAME_FIX.get(n2, n2)}」" + ("（狀態設為暫定）" if tentative else ""))
    if n2 in NAME_FIX:
        report["清理"].append(f"姓名「{n2}」→「{NAME_FIX[n2]}」（統一寫法）")
        n2 = NAME_FIX[n2]
    return n2, tentative


# ---------- 專案 ----------
PROJECTS = [
    # id, 名稱, 國家, 城市, 狀態
    ("P01", "芝加哥 Module & PACK 產線", "美國", "芝加哥", "進行中"),
    ("P02", "芝加哥電芯項目", "美國", "芝加哥", "進行中"),
    ("P03", "印度售服中心建廠支援", "印度", "Ahmedabad", "進行中"),
    ("P04", "北美建廠評估", "美國", "Fremont", "評估中"),
    ("P05", "印尼建廠評估", "印尼", "", "評估中"),
    ("P06", "工廠技轉", "中國", "合肥", "進行中"),
    ("P07", "在地化生產", "中國", "", "進行中"),
    ("P08", "教育訓練 Training", "中國", "", "進行中"),
    ("P09", "斯洛伐克項目", "斯洛伐克", "", "未啟動"),
    ("P10", "摩洛哥項目", "摩洛哥", "", "未啟動"),
]
PROJ_MAP = {  # 舊專案名稱 → (專案ID, 產線)
    "芝加哥#C#D產線支持": ("P01", "CD"), "芝加哥#D產線支持": ("P01", "D"),
    "芝加哥#C產線": ("P01", "C"), "芝加哥#D產線": ("P01", "D"),
    "芝加哥電芯項目": ("P02", "電芯"), "芝加哥電芯設備": ("P02", "電芯"),
    "印度售服中心建廠支援": ("P03", ""), "北美建廠評估": ("P04", ""),
    "印尼建廠評估": ("P05", ""), "工廠技轉": ("P06", ""),
    "在地化生產相關": ("P07", ""), "Training": ("P08", ""),
}

# ---------- 地點：拆成 國家 + 城市 ----------
LOC_MAP = {
    "芝加哥": ("美國", "芝加哥"), "舊金山/芝加哥": ("美國", "舊金山、芝加哥"),
    "天津": ("中國", "天津"), "上海": ("中國", "上海"), "合肥": ("中國", "合肥"),
    "安徽桐城": ("中國", "桐城"), "馬鞍山": ("中國", "馬鞍山"),
    "印度Ahmedabad、Pune": ("印度", "Ahmedabad、Pune"), "印度Ahmedabad": ("印度", "Ahmedabad"),
    "印尼": ("印尼", ""),
}

people = {}  # name -> person dict


def person(name, org_type, org, role="", visa="", visa_exp="", updated=""):
    p = people.get(name)
    if not p:
        p = people[name] = {"id": f"H{len(people)+1:03d}", "name": name, "orgType": org_type,
                            "org": org, "role": role, "dept": "", "visaType": "", "visaExpiry": "", "visaHistory": [], "_upd": ""}
    if role and not p["role"]:
        p["role"] = role
    # 簽證以「資料更新日期」最新的那筆為準
    if (visa or visa_exp) and (updated or "") >= p["_upd"]:
        p["visaType"] = visa or p["visaType"]
        p["visaExpiry"] = visa_exp or p["visaExpiry"]
        p["_upd"] = updated or p["_upd"]
    return p


assignments = []


def add_asg(**kw):
    kw["id"] = f"A{len(assignments)+1:04d}"
    for k in ("planStart", "planEnd", "actualStart", "actualEnd", "line", "duty", "note"):
        kw.setdefault(k, "")
    kw.setdefault("budget", None); kw.setdefault("cost", None)
    assignments.append(kw)


# ---------- 1. 出差紀錄（寶新同仁）----------
for r in rd("trips.csv"):
    name, tentative = clean_name(r["name"])
    if tentative and (name, r["start"]) in CONFIRMED_TRIPS:
        tentative = False
        report["清理"].append(f"{name} {r['start']} 芝加哥行程：協理確認已成行，狀態由暫定改為確認")
    pid, line = PROJ_MAP[r["project"]]
    country, city = LOC_MAP[r["location"]]
    person(name, "寶新", "", "項目管理")
    s, e = d(r["start"]), d(r["end"])
    # 已發生的行程：計畫=實際；未來行程只填計畫
    past = e and e < TODAY.isoformat()
    add_asg(person=name, project=pid, country=country, city=city, line=line, duty=r["work"],
            planStart=s, planEnd=e, actualStart=s if past else "", actualEnd=e if past else "",
            status="暫定" if tentative else "確認", source="出差紀錄")

# ---------- 2. 現場人力（電芯 + Module Pack）----------
def load_manpower(fname, pid, has_planned_arrival):
    rows = rd(fname)
    for r in rows:
        name, _ = clean_name(r["name"])
        upd = d(r.get("updated", ""))
        is_bx = r["supplier"] == "寶新"
        person(name, "寶新" if is_bx else "供應商", "" if is_bx else r["supplier"], r["role"],
               r["visa"], d(r["visa_expiry"]), upd)
        if is_bx:
            report["合併"].append(f"{fname}: 寶新同仁 {name} 的派遣以出差紀錄為準，僅取用簽證資料")
            continue
        arr, pl, al = d(r["arrival"]), d(r["planned_leave"]), d(r["actual_leave"])
        pa = d(r.get("planned_arrival", "")) if has_planned_arrival else ""
        problem = None
        if not arr:
            problem = "沒有到崗日"
        elif pl and pl < arr:
            problem = f"預計離崗 {pl} 早於到崗 {arr}"
        elif al and al < arr:
            problem = f"實際離開 {al} 早於到崗 {arr}"
        if problem:
            report["刪除"].append(f"{fname}: {r['supplier']} {name} — {problem}")
            continue
        add_asg(person=name, project=pid, country="美國", city=r["location"] or "芝加哥",
                line=r["line"], duty=r["duty"], planStart=pa or arr, planEnd=pl,
                actualStart=arr if arr <= TODAY.isoformat() else "", actualEnd=al,
                status="確認", source=fname, updated=upd)


load_manpower("cell_manpower.csv", "P02", True)
load_manpower("module_manpower.csv", "P01", False)

# ---------- 3. 任務 ----------
tasks = []
for i, r in enumerate(rd("cell_tasks.csv"), 1):
    st = r["status"] or "未開始"
    if st == "卡關":
        st = "有風險"
    if not r["status"]:
        report["清理"].append(f"任務 {r['process']}／{r['task']}：狀態空白 → 未開始")
    tasks.append({"id": f"T{i:03d}", "project": "P02", "section": r["section"], "process": r["process"],
                  "task": r["task"], "planStart": d(r["forecast_start"]), "planEnd": d(r["forecast_end"]),
                  "actualStart": d(r["actual_start"]), "actualEnd": d(r["actual_end"]),
                  "owner": r["owner"], "status": st, "note": r["note"], "updated": ""})
report["清理"].append("任務表英文標題修正：實際開始/結束 原標為 Plan Start/End → Actual Start/End；"
                    "計畫開始/結束 原標為 Forecast → Plan")
report["清理"].append("任務表「區域」欄與「工序」內容相同，已併入工序")
report["清理"].append("簽證欄位（類型、到期日）不搬移：簽證由各公司與個人自行管理，改以人員「備註」記錄必要資訊")

# ---------- 4. 合約 ----------
def parse_amount(s):
    m = re.fullmatch(r"US\$(\d+)/天", s)
    if m:
        return "USD", int(m.group(1)), "日", ""
    m = re.fullmatch(r"US\$(\d+)", s)
    if m:
        return "USD", int(m.group(1)), "總價", ""
    m = re.fullmatch(r"US\$(\d+)\+US\$(\d+)\((.+)\)", s)
    if m:
        return "USD", int(m.group(1)) + int(m.group(2)), "日", f"{m.group(3)}：US${m.group(1)}+US${m.group(2)}"
    return "", None, "", s


contracts = []
for i, r in enumerate(rd("contracts.csv"), 1):
    cur, amt, unit, extra = parse_amount(r["amount"])
    status = {"合約簽訂": "已簽訂"}.get(r["status"], r["status"])
    if "用印中" in status:
        report["清理"].append(f"合約「{r['name']}」狀態「{r['status']}」→「用印中」（備註保留雙方用印）")
        extra = (extra + "；" if extra else "") + r["status"]
        status = "用印中"
    pid = "P02" if "電芯" in r["name"] else "P01"
    contracts.append({"id": f"C{i:03d}", "name": r["name"], "project": pid, "partyA": r["party_a"],
                      "partyB": r["party_b"], "status": status, "type": r["type"],
                      "start": d(r["start"]), "end": d(r["end"]), "currency": cur, "amount": amt,
                      "unit": unit, "owner": r["owner"], "note": "；".join(x for x in (r["note"], extra) if x),
                      "updated": d(r["updated"])})
    if r["amount"] == "US$5000000":
        report["待確認"].append(f"合約「{r['name']}」金額 US$5,000,000 —— Indicom 與 AIS 金額相同，請確認是否為暫填")

# ---------- 6. 組織與人員名單（依 2026/10/17 協理提供之組織圖與 HR 名單）----------
UNITS = [  # 名稱, 層級, 上層
    ("工程處", "處", ""),
    ("系統工程部", "部", "工程處"),
    ("售後服務部", "部", "工程處"),
    ("系統安裝課", "課", "系統工程部"),   # 組織圖寫「系統整合課」，HR 系統為「系統安裝課」，以 HR 為準
    ("專案管理課", "課", "系統工程部"),
]
ROSTER = [tuple(r.values()) for r in rd("roster.csv")]  # HR 名單（中文名, 英文名, 員工編號, 單位, 職稱）放在 raw/，不進 GitHub
OPENINGS = [("系統安裝課", 3, "PLC、Robot、電控"), ("專案管理課", 2, "")]
for zh, en, no, unit, title in ROSTER:
    p_ = person(zh, "寶新", "", title)
    p_.update({"enName": en, "empNo": no, "unit": unit, "title": title, "role": title, "status": "在職"})
for p_ in people.values():
    if p_["orgType"] == "寶新" and not p_.get("empNo"):
        p_.update({"unit": "", "title": p_.get("role", "")})
        report["待確認"].append(f"{p_['name']} 不在目前組織圖／HR 名單，暫列「未列入組織圖」，請確認是否仍在工程處")
report["清理"].append("依組織圖與 HR 名單建立單位：工程處／系統工程部（系統安裝課、專案管理課）／售後服務部，並補上英文名、員工編號、職稱")
report["待確認"].append("系統工程部下的課：組織圖寫「系統整合課」，HR 名單寫「系統安裝課」，目前採 HR 名稱")
# 公司別（協禾集團）：所有內部同仁預設寶新；工程處以外的支援同仁記在 extDept
COMPANIES = [{"name": "寶新", "group": "協禾集團", "full": "寶新新能源科技"}, {"name": "寶禾創能", "group": "協禾集團", "full": "寶禾創能"}]
EXT_DEPT = {"吳建銘": ("寶新", "業務部")}   # 協理確認：業務部同事，支援美國出差
for p_ in people.values():
    if p_["orgType"] == "寶新":
        p_.setdefault("company", "寶新")
        if p_["name"] in EXT_DEPT:
            p_["company"], p_["extDept"] = EXT_DEPT[p_["name"]]
            report["清理"].append(f"{p_['name']}：協理確認為{p_['company']}{p_['extDept']}同事（支援美國行程），列為支援同仁，不計入工程處人數")
            report["待確認"][:] = [x for x in report["待確認"] if not x.startswith(p_["name"])]
units = [{"name": n, "level": lv, "parent": pa, "openings": next(({"count": c, "note": nt} for u, c, nt in OPENINGS if u == n), None)} for n, lv, pa in UNITS]

# ---------- 收尾 ----------
for p in people.values():
    p.pop("_upd")
    # 協理決定（2026/10/17）：簽證由各公司與個人自行管理，中控台不保存簽證資料
    for k in ("visaType", "visaExpiry", "visaHistory"): p.pop(k, None)
    p.setdefault("note", "")
report["待確認"].append("專案的開始日、計畫完成日、負責人舊資料沒有，請課長/經理級以上補上")
report["刪除"].append("斯洛伐克、摩洛哥人力表：測試資料，整份捨棄（專案保留為「未啟動」）")
report["刪除"].append("出差紀錄「Manpower List 20260527版本」分頁：舊版副本，不搬移")

# ---------- 5. Open Issue：舊任務表「卡關」轉為待追蹤事項 ----------
issues = []
for t in tasks:
    if t["status"] != "有風險":
        continue
    issues.append({"id": f"ISS-{len(issues)+1:03d}", "project": t["project"],
                   "title": f"{t['process']}{t['task']}卡關", "desc": t["note"], "category": "進度",
                   "severity": "高", "owner": "", "party": t["owner"], "opened": TODAY.isoformat(), "due": "",
                   "status": "Open", "task": t["id"],
                   "log": [{"at": TODAY.isoformat(), "text": "由舊任務表「卡關」狀態轉入"}]})
    report["清理"].append(f"任務 {t['process']}／{t['task']} 卡關 → 建立 Open Issue {issues[-1]['id']}")

# ---------- 7. 週會「任務與問題點追蹤表」→ Open Issue ----------
PIC = {"Justin": "石宛明", "Leo": "葉泰宏", "Neo": "林政曄", "James": "李明坤", "Andow": "陳韋志", "Allen": "沈祐嘉",
       "Frank": "陳詠澂", "Kenny": "楊濟丞", "Lucy": "吳羿樺", "Johnson": "陳俊宇", "Mike": "馮祥豪", "Patrick": "林松源"}
def guess_project(t):
    if "印尼" in t: return "P05"
    if "Fremont" in t: return "P04"
    if "電芯" in t or t.startswith("AIS") or t.startswith("Indicom"): return "P02"
    return ""
def to_iso(v):
    from datetime import datetime as _dt
    if isinstance(v, _dt): return v.date().isoformat()
    return ""
def parse_log(txt, year=2026):
    out = []
    for line in str(txt or "").replace("\r", "").split("\n"):
        line = line.strip()
        if not line: continue
        m = re.match(r"^(\d{1,2})/(\d{1,2})", line)
        if m:
            mo, dd = int(m.group(1)), int(m.group(2))
            body = re.sub(r"^\d{1,2}/\d{1,2}(\s*[-、,]\s*\d{1,2}(/\d{1,2})?)*\s*", "", line).strip()
            out.append({"at": f"{year}-{mo:02d}-{dd:02d}", "text": body or line})
        elif out and out[-1]["at"]:
            out[-1]["text"] += "\n" + line
        else:
            out.append({"at": "", "text": line})
    return out
tracker_path = RAW / "tracker.xlsx"
if tracker_path.exists():
    import openpyxl
    ws = openpyxl.load_workbook(tracker_path).worksheets[0]
    n_imp = 0
    for row in ws.iter_rows(min_row=5, values_only=True):
        title = (row[1] or "")
        if not str(title).strip(): continue
        title = str(title).strip().replace("\n", " ")
        kick, target, act, closed, pic, note = row[2], row[3], row[4], row[5], row[6], row[7]
        owner = PIC.get(str(pic).strip(), "") if pic else ""
        log = parse_log(act)
        closed_iso = to_iso(closed)
        status = "已結案" if closed_iso else ("處理中" if any(l["at"] for l in log) else "Open")
        n_imp += 1
        issues.append({"id": f"ISS-{len(issues)+1:03d}", "project": guess_project(title), "title": title, "desc": "",
            "kind": "任務", "category": "其他", "severity": "中", "owner": owner, "party": "" if owner else (str(pic or "") if pic else ""),
            "opened": to_iso(kick) or "", "due": to_iso(target), "dueTBD": str(target).strip().upper() in ("TBD", "TBC"),
            "status": status, "closed": closed_iso, "note": str(note or "").strip(), "log": log, "source": "週會追蹤表 v1_20261002"})
        if pic and not owner: report["待確認"].append(f"追蹤表「{title}」負責人「{pic}」對應不到人員，已放在對口欄")
    report["清理"].append(f"匯入週會「任務與問題點追蹤表」{n_imp} 項為 Open Issue；進度依日期拆成紀錄，有實際完成日者設為已結案")
    report["待確認"].append("追蹤表沒有專案欄：已依關鍵字對應印尼BMS→印尼建廠評估、Fremont→北美建廠評估、電芯／AIS／Indicom→芝加哥電芯項目，其餘列為「處內事務」，可再指定")

projects = [{"id": i, "name": n, "country": c, "city": ct, "status": s, "owner": "",
             "start": "", "planEnd": "", "note": "", "milestones": []} for i, n, c, ct, s in PROJECTS]
lists = {
    "country": sorted({a["country"] for a in assignments} | {p["country"] for p in projects}),
    "orgBX": ["系統工程部", "售後服務部", "專案課"],
    "assignStatus": ["暫定", "確認", "取消"],
    "taskStatus": ["未開始", "進行中", "有風險", "完成"],
    "milestone": ["KO", "PA", "TT", "SOP", "開工", "設備進廠", "驗收", "量產"],
    "contractStatus": ["草擬", "審閱中", "簽呈中", "用印中", "已簽訂", "已終止"],
    "visaType": ["ESTA", "B", "L", "E2", "C8", "其他"],
    "issueStatus": ["Open", "處理中", "待確認", "已結案"],
    "issueSeverity": ["高", "中", "低"],
    "issueCategory": ["進度", "人力", "簽證", "設備", "物料", "品質", "安全", "合約", "其他"],
    "visaAction": ["新辦", "加簽", "補簽", "延期", "換發", "註銷"],
    "projectStatus": ["規劃中", "評估中", "進行中", "暫停", "結案", "未啟動"],
}
db = {"version": "2.0.0", "generated": TODAY.isoformat(), "people": list(people.values()),
      "projects": projects, "assignments": assignments, "tasks": tasks, "issues": issues, "contracts": contracts,
      "units": units, "companies": COMPANIES, "lists": lists, "log": [{"at": TODAY.isoformat(), "by": "migration", "action": "從舊版 4 張試算表搬移"}]}
(OUT / "db.json").write_text(json.dumps(db, ensure_ascii=False, indent=1), encoding="utf-8")

lines = ["# 舊資料搬移報告", "", f"產生日期：{TODAY}", "",
         f"- 人員 {len(people)} 位（寶新 {sum(p['orgType']=='寶新' for p in people.values())}、供應商 {sum(p['orgType']=='供應商' for p in people.values())}）",
         f"- 派遣 {len(assignments)} 筆、專案 {len(projects)} 個、任務 {len(tasks)} 筆、合約 {len(contracts)} 份", ""]
for k, v in report.items():
    lines += [f"## {k}（{len(v)}）", ""] + [f"- {x}" for x in v] + [""]
(OUT / "migration_report.md").write_text("\n".join(lines), encoding="utf-8")
print("\n".join(lines[:8]))
