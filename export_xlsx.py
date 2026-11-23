#!/usr/bin/env python3
"""CrewUp monthly Excel backup. Usage: export_xlsx.py <db_path> <YYYY-MM> <out.xlsx>
Sheets are split by data type AND by shop, so the owner can check everything in Excel
if anything goes wrong in the app. No pay data is ever printed for staff — this script
runs only from the owner-only export endpoint."""
import sqlite3, sys, json
from datetime import date
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

def main():
    db_path, month, out = sys.argv[1], sys.argv[2], sys.argv[3]
    y, m = int(month[:4]), int(month[5:7])
    last = 31 if m in (1, 3, 5, 7, 8, 10, 12) else 30 if m != 2 else (29 if (y % 4 == 0 and (y % 100 or y % 400 == 0)) else 28)
    frm, to = f"{month}-01", f"{month}-{last:02d}"
    con = sqlite3.connect(db_path); con.row_factory = sqlite3.Row
    shops = con.execute("SELECT * FROM shops ORDER BY id").fetchall()
    staff = {r["id"]: r["name"] for r in con.execute("SELECT * FROM staff")}
    shopname = {r["id"]: r["name"] for r in shops}
    wb = Workbook(); wb.remove(wb.active)
    head = PatternFill("solid", fgColor="DDEBF7"); bold = Font(bold=True)

    def sheet(title, headers, rows):
        ws = wb.create_sheet(title[:31])
        ws.append(headers)
        for c in ws[1]:
            c.font = bold; c.fill = head
        for r in rows: ws.append(r)
        for col in ws.columns:
            ws.column_dimensions[col[0].column_letter].width = max(12, min(42, max(len(str(c.value or "")) for c in col) + 2))
        return ws

    def rate(shop_id, staff_id, d):
        row = con.execute("SELECT agent_rate, worker_rate FROM shops WHERE id=?", (shop_id,)).fetchone()
        agent, worker = row["agent_rate"], row["worker_rate"]
        rh = con.execute("SELECT agent_rate, worker_rate FROM rate_history WHERE scope='shop' AND scope_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1", (shop_id, d)).fetchone()
        if rh:
            agent = rh["agent_rate"] if rh["agent_rate"] is not None else agent
            worker = rh["worker_rate"] if rh["worker_rate"] is not None else worker
        ov = con.execute("SELECT worker_rate_override FROM staff WHERE id=?", (staff_id,)).fetchone()
        if ov and ov["worker_rate_override"] is not None: worker = ov["worker_rate_override"]
        rh2 = con.execute("SELECT worker_rate FROM rate_history WHERE scope='staff' AND scope_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1", (staff_id, d)).fetchone()
        if rh2 and rh2["worker_rate"] is not None: worker = rh2["worker_rate"]
        return agent, worker

    recs = con.execute("SELECT * FROM clock_records WHERE date BETWEEN ? AND ? ORDER BY date, shop_id", (frm, to)).fetchall()
    shifts = con.execute("SELECT * FROM shifts WHERE date BETWEEN ? AND ? ORDER BY date, shop_id", (frm, to)).fetchall()
    avail = con.execute("SELECT * FROM availability WHERE date BETWEEN ? AND ? ORDER BY date", (frm, to)).fetchall()
    transfers = con.execute("SELECT * FROM transfers WHERE date BETWEEN ? AND ? ORDER BY date", (frm, to)).fetchall()
    rates = con.execute("SELECT * FROM rate_history ORDER BY effective_from").fetchall()

    # Summary (per shop + totals)
    srows = []
    tot_agent = tot_pay = tot_taxi = 0.0
    for s in shops:
        rs = [r for r in recs if r["shop_id"] == s["id"] and r["clock_out"]]
        hrs = sum(r["hours"] or 0 for r in rs); wp = ap = tx = 0.0
        for r in rs:
            a, w = rate(s["id"], r["staff_id"], r["date"]); mult = 1.5 if r["is_15x"] else 1
            wp += (r["hours"] or 0) * w * mult; ap += (r["hours"] or 0) * a * mult; tx += r["taxi_amount"] or 0
        tot_agent += ap; tot_pay += wp; tot_taxi += tx
        srows.append([s["name"], len(rs), round(hrs, 2), round(wp, 2), round(ap, 2), round(tx, 2), round(ap + tx, 2)])
    srows.append(["TOTAL", sum(r[1] for r in srows), round(sum(r[2] for r in srows), 2), round(tot_pay, 2), round(tot_agent, 2), round(tot_taxi, 2), round(tot_agent + tot_taxi, 2)])
    sheet("Summary", ["Shop", "Shifts", "Hours", "Worker pay ($)", "Agent total ($)", "Taxi ($)", "To submit to shop ($)"], srows)

    # Per-shop sheets: clock, pay, taxi
    for s in shops:
        rs = [r for r in recs if r["shop_id"] == s["id"]]
        sheet(f"Clock-{s['name']}", ["Date", "Staff", "Clock in", "Clock out", "Hours", "1.5x", "Covers for", "Source"],
              [[r["date"], staff.get(r["staff_id"], ""), r["clock_in"] or "", r["clock_out"] or "", r["hours"] or "", "Yes" if r["is_15x"] else "", staff.get(r["covers_for_id"], "") if r["covers_for_id"] else "", r["source"]] for r in rs])
        prow = {}
        for r in rs:
            if not r["clock_out"]: continue
            a, w = rate(s["id"], r["staff_id"], r["date"]); mult = 1.5 if r["is_15x"] else 1
            p = prow.setdefault(r["staff_id"], [staff.get(r["staff_id"], ""), 0.0, 0.0, 0.0])
            p[1] += r["hours"] or 0; p[2] += (r["hours"] or 0) * w * mult; p[3] += (r["hours"] or 0) * a * mult
        sheet(f"Pay-{s['name']}", ["Staff", "Hours", "Worker pay ($)", "Agent amount ($)"],
              [[v[0], round(v[1], 2), round(v[2], 2), round(v[3], 2)] for v in prow.values()])
        sheet(f"Taxi-{s['name']}", ["Date", "Staff", "Amount ($)", "Heads", "Per head ($)", "Cap $20/head", "Claimable ($)", "Payer", "Receipt no.", "Riders", "Transport", "Company transport at", "Warning", "Remark"],
              [[r["date"], staff.get(r["staff_id"], ""), r["taxi_amount"] or 0,
                1 + len(json.loads(r["riders"] or "[]") if r["riders"] else []),
                round((r["taxi_amount"] or 0) / max(1, 1 + len(json.loads(r["riders"] or "[]") if r["riders"] else [])), 2),
                20 if s["name"] == "Bae's" else "",
                round(min(r["taxi_amount"] or 0, 20 * (1 + len(json.loads(r["riders"] or "[]") if r["riders"] else []))) if s["name"] == "Bae's" and (r["transport_mode"] or "taxi") == "taxi" else (0 if (r["transport_mode"] or "taxi") == "company" else (r["taxi_amount"] or 0)), 2),
                r["taxi_payer"] or "", r["taxi_receipt_no"] or "",
                ", ".join(staff.get(i, "") for i in (json.loads(r["riders"] or "[]") if r["riders"] else [])),
                r["transport_mode"] or "taxi", r["company_transport_at"] or "", r["taxi_warning"] or "", r["taxi_remark"] or ""] for r in rs if (r["taxi_amount"] or 0) or r["taxi_receipt_no"] or (r["transport_mode"] or "taxi") == "company" or r["taxi_warning"]])

    sheet("Shifts", ["Date", "Shop", "Staff", "Time start", "Time end", "Covers for", "Status"],
          [[r["date"], shopname.get(r["shop_id"], ""), staff.get(r["staff_id"], ""), r["time_start"] or "", r["time_end"] or "", staff.get(r["covers_for_id"], "") if r["covers_for_id"] else "", r["status"]] for r in shifts])
    sheet("Availability", ["Date", "Staff", "Available"],
          [[r["date"], staff.get(r["staff_id"], ""), "Yes" if r["available"] else "No"] for r in avail])
    sheet("Replacements", ["Date", "Kind", "Staff", "From shop", "To shop"],
          [[r["date"], r["kind"], staff.get(r["staff_id"], ""), shopname.get(r["from_shop_id"], ""), shopname.get(r["to_shop_id"], "")] for r in transfers])
    sheet("RateHistory", ["Scope", "Scope id", "Agent rate", "Worker rate", "Effective from"],
          [[r["scope"], r["scope_id"], r["agent_rate"], r["worker_rate"], r["effective_from"]] for r in rates])
    sheet("Clock-All", ["Date", "Shop", "Staff", "Clock in", "Clock out", "Hours", "1.5x", "Covers for", "Taxi ($)", "Taxi payer", "Receipt no."],
          [[r["date"], shopname.get(r["shop_id"], ""), staff.get(r["staff_id"], ""), r["clock_in"] or "", r["clock_out"] or "", r["hours"] or "", "Yes" if r["is_15x"] else "", staff.get(r["covers_for_id"], "") if r["covers_for_id"] else "", r["taxi_amount"] or 0, r["taxi_payer"] or "", r["taxi_receipt_no"] or ""] for r in recs])
    wb.save(out)
    print(f"wrote {out} sheets={wb.sheetnames}")

if __name__ == "__main__":
    main()
