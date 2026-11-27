# Spreadsheet views (pages 60-67) of reports that exist ONLY as SamvadX Excel downloads:
# the bank Feedback File's four sheets and the Call Auditor's Excel reports.
# Column headers are the real ones from src/lib/portfolio-feedback.ts and
# src/lib/call-audit-reports.ts; the window is a plain, unbranded spreadsheet view. All data is made up.
import json, pathlib

P = pathlib.Path(__file__).parent / "pages"
LETTERS = [chr(65 + i) for i in range(26)] + ["A" + chr(65 + i) for i in range(26)]

def sheet(name, filename, tabs, active, headers, rows, widths, start_col=0, note=""):
    cols = "".join(f'<col style="width:{w}px">' for w in [44] + widths)
    letters = "".join(f'<th class="lt">{LETTERS[start_col + i]}</th>' for i in range(len(headers)))
    head = "".join(f'<td class="hd">{h}</td>' for h in headers)
    body = ""
    for r, row in enumerate(rows, start=2):
        body += f'<tr><th class="rn">{r}</th>' + "".join(f'<td class="{ "num" if isinstance(c, (int, float)) or (isinstance(c, str) and c[:1].isdigit() and len(c) < 9 and "/" not in c) else ""}">{c}</td>' for c in row) + "</tr>"
    for r in range(len(rows) + 2, 31):
        body += f'<tr><th class="rn">{r}</th>' + '<td></td>' * len(headers) + "</tr>"
    tabs_html = "".join(f'<span class="tab {"on" if t == active else ""}">{t}</span>' for t in tabs)
    first = headers[0]
    html = f"""<style>
.win{{position:fixed;inset:0;display:flex;flex-direction:column;background:#fff;font-family:Inter,system-ui,sans-serif;color:#1f2937}}
.title{{height:38px;display:flex;align-items:center;gap:10px;padding:0 14px;background:#f3f4f6;border-bottom:1px solid #d1d5db;font-size:13px}}
.dot{{width:11px;height:11px;border-radius:50%;display:inline-block}}
.fx{{height:32px;display:flex;align-items:center;border-bottom:1px solid #d1d5db;font-size:12px}}
.fx .ref{{width:90px;text-align:center;border-right:1px solid #d1d5db;height:100%;display:flex;align-items:center;justify-content:center;color:#374151}}
.fx .f{{padding:0 10px;color:#6b7280;font-style:italic}}
.grid{{flex:1;overflow:hidden}}
table{{border-collapse:collapse;table-layout:fixed;font-size:12px;width:max-content}}
th,td{{border:1px solid #e5e7eb;height:24px;padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
th.lt{{background:#f3f4f6;color:#6b7280;font-weight:500;text-align:center;font-size:11px}}
th.rn{{background:#f3f4f6;color:#6b7280;font-weight:500;font-size:11px;text-align:center}}
th.corner{{background:#e5e7eb}}
td.hd{{font-weight:700;color:#111827;background:#fff}}
td.num{{text-align:right}}
tr.sel td.hd:first-of-type{{outline:2px solid #1D4ED8;outline-offset:-2px}}
.tabs{{height:34px;display:flex;align-items:stretch;gap:2px;padding:0 10px;background:#f3f4f6;border-top:1px solid #d1d5db;font-size:12px}}
.tab{{display:flex;align-items:center;padding:0 16px;color:#4b5563}}
.tab.on{{background:#fff;color:#1D4ED8;font-weight:600;border-bottom:3px solid #1D4ED8}}
.note{{margin-left:auto;display:flex;align-items:center;color:#6b7280;font-size:11px}}
</style>
<div class="win">
  <div class="title"><span class="dot" style="background:#f87171"></span><span class="dot" style="background:#fbbf24"></span><span class="dot" style="background:#34d399"></span>
    <span style="margin-left:8px;font-weight:600">{filename}</span><span style="color:#6b7280">— downloaded from SamvadX</span></div>
  <div class="fx"><span class="ref">{LETTERS[start_col]}1</span><span class="f">{first}</span></div>
  <div class="grid"><table><colgroup>{cols}</colgroup>
    <tr><th class="corner"></th>{letters}</tr>
    <tr class="sel"><th class="rn">1</th>{head}</tr>
    {body}
  </table></div>
  <div class="tabs">{tabs_html}<span class="note">{note}</span></div>
</div>"""
    (P / f"{name}.html").write_text(f"<!-- {json.dumps({'role': 'none', 'title': filename, 'height': 38 + 32 + 25 + 24 * (len(rows) + 2) + 34 + 4})} -->\n{html}\n")

FB_TABS = ["Feedback by Loan", "Date-wise Feedback", "CC Report", "Summary"]
FB_FILE = "Feedback File - Personal Loan Nov-26.xlsx"

# ── Feedback by Loan (first columns of the bank's allocation layout) ──
sheet("60-feedback-by-loan", FB_FILE, FB_TABS, "Feedback by Loan",
      ["Profile Name", "Loan Account Number", "Reference ID", "Call Date", "Agent ID", "Agent Name", "Supervisor Name", "Customer Mobile Number", "Customer Name", "Intensity of Calls", "Connect Count", "Team", "Best Disposition Name", "Last Disposition Name"],
      [["Personal Loan Nov-26", "PL-198730", "REF-55120", "24/11/2026", "A014", "Priya Sharma", "Rohan Mehta", "97XXX XX884", "Sneha Kulkarni", 3, 2, "Team East", "Paid", "Paid"],
       ["Personal Loan Nov-26", "PL-201147", "REF-55204", "24/11/2026", "A014", "Priya Sharma", "Rohan Mehta", "94XXX XX019", "Manoj Pillai", 9, 4, "Team East", "Promise to Pay", "Promise to Pay"],
       ["Personal Loan Nov-26", "PL-204518", "REF-55311", "24/11/2026", "A022", "Neha Saxena", "Rohan Mehta", "98XXX XX231", "Arjun Verma", 4, 2, "Team East", "Call Back", "Refused to Pay"],
       ["Personal Loan Nov-26", "PL-207761", "REF-55402", "24/11/2026", "A011", "Rahul Nair", "Rohan Mehta", "99XXX XX452", "Farhan Qureshi", 6, 1, "Team East", "Call Back", "Call Back"],
       ["Personal Loan Nov-26", "PL-195402", "REF-55017", "22/11/2026", "A019", "Aakash Patel", "Rohan Mehta", "90XXX XX367", "Lakshmi Narayanan", 11, 3, "Team East", "Settlement", "Settlement"],
       ["Personal Loan Nov-26", "PL-200615", "REF-55188", "24/11/2026", "A007", "Imran Shaikh", "Rohan Mehta", "96XXX XX115", "Pooja Bansal", 5, 2, "Team East", "Promise to Pay", "Promise to Pay"],
       ["Personal Loan Nov-26", "PL-196274", "REF-55092", "21/11/2026", "A016", "Divya Menon", "Rohan Mehta", "95XXX XX628", "Deepak Rao", 6, 3, "Team East", "Dispute", "Dispute"],
       ["Personal Loan Nov-26", "PL-208842", "REF-55430", "16/11/2026", "A014", "Priya Sharma", "Rohan Mehta", "93XXX XX506", "Ananya Ghosh", 3, 2, "Team East", "Paid", "Paid"],
       ["Personal Loan Nov-26", "PL-209983", "REF-55471", "24/11/2026", "A014", "Priya Sharma", "Rohan Mehta", "88XXX XX740", "Ravi Teja", 4, 3, "Team East", "Partially Paid", "Partially Paid"],
       ["Personal Loan Nov-26", "PL-203390", "REF-55260", "23/11/2026", "A025", "Sanjay Gupta", "Rohan Mehta", "98XXX XX554", "Ritu Agarwal", 5, 2, "Team East", "Paid", "Paid"]],
      [150, 130, 95, 85, 65, 105, 110, 135, 125, 95, 90, 85, 125, 125], note="44 columns in the bank's own order · sample data")

# ── Date-wise Feedback (a Code + Feedback column per date, newest first) ──
DATES = ["24/11/2026", "22/11/2026", "19/11/2026", "17/11/2026"]
sheet("61-feedback-datewise", FB_FILE, FB_TABS, "Date-wise Feedback",
      ["Loan Account Number", "Customer Name", "Customer Mobile Number"] + [x for d in DATES for x in (f"{d} Code", f"{d} Feedback")],
      [["PL-198730", "Sneha Kulkarni", "97XXX XX884", 100, "15:41 Paid via UPI on call", "", "", 200, "11:42 PTP 12,500 by 19/11", 300, "17:05 Travelling, call Monday"],
       ["PL-201147", "Manoj Pillai", "94XXX XX019", 200, "15:11 PTP 20,000 by 25/11", 300, "16:02 Salary on 20th", 600, "10:15 No answer", 200, "15:22 PTP 16,810 by 15/11"],
       ["PL-204518", "Arjun Verma", "98XXX XX231", 700, "15:15 Refused to pay", 300, "11:04 Call after lunch", "", "", 600, "18:40 Switched off"],
       ["PL-207761", "Farhan Qureshi", "99XXX XX452", 300, "15:35 Call on 26th", 600, "10:20 Ringing", 600, "12:44 Busy", "", ""],
       ["PL-195402", "Lakshmi Narayanan", "90XXX XX367", "", "", 400, "12:30 Settlement offer sent", 600, "17:51 No answer", 400, "11:10 Asked for settlement"],
       ["PL-200615", "Pooja Bansal", "96XXX XX115", 200, "15:38 PTP 35,700 by 26/11", "", "", 300, "16:14 Call on 22nd", 600, "10:02 Switched off"],
       ["PL-196274", "Deepak Rao", "95XXX XX628", "", "", 500, "15:22 Says EMI already debited", "", "", 300, "14:31 Call later"],
       ["PL-209983", "Ravi Teja", "88XXX XX740", 100, "14:02 Paid 10,000, balance 28/11", "", "", 200, "11:47 PTP 19,350 by 22/11", "", ""],
       ["PL-203390", "Ritu Agarwal", "98XXX XX554", "", "", 100, "15:19 Paid via bank link", 300, "11:00 Call on 22nd", 600, "16:20 Ringing"]],
      [125, 125, 130, 120, 210, 120, 210, 120, 210, 120, 210], note="Codes: 100 Paid · 200 PTP · 300 Call Back · 400 Settlement · 500 Dispute · 600 Not Contacted · 700 RTP")

# ── CC Report (one row per event) ──
sheet("62-feedback-cc-report", FB_FILE, FB_TABS, "CC Report",
      ["Loan Account Number", "Customer Name", "Date", "Time (IST)", "Feedback Type", "Disconnected By", "Agent Name", "DID Used", "Dial Type", "Call Duration", "Call Status", "Disposition", "Feedback / Remarks", "PTP Amount", "PTP Date"],
      [["PL-198730", "Sneha Kulkarni", "24/11/2026", "15:41:08", "Call", "Agent", "Priya Sharma", "022XXXX4512", "Single", "00:04:17", "Connected", "Paid", "Paid via UPI on call", "", ""],
       ["PL-200615", "Pooja Bansal", "24/11/2026", "15:38:44", "Call", "Customer", "Imran Shaikh", "022XXXX4518", "Productive Dial", "00:05:02", "Connected", "Promise to Pay", "Will pay full via bank link", "35,700", "26/11/2026"],
       ["PL-207761", "Farhan Qureshi", "24/11/2026", "15:35:12", "Call", "Agent", "Rahul Nair", "022XXXX4505", "Productive Dial", "00:01:12", "Connected", "Call Back", "Call on 26th", "", ""],
       ["PL-204518", "Arjun Verma", "24/11/2026", "15:15:37", "Call", "Customer", "Neha Saxena", "022XXXX4502", "Progressive Dial", "00:01:40", "Connected", "Refused to Pay", "Refused to pay", "", ""],
       ["PL-201147", "Manoj Pillai", "24/11/2026", "15:11:50", "Call", "Agent", "Priya Sharma", "022XXXX4512", "Single", "00:03:05", "Connected", "Promise to Pay", "PTP 20,000 by 25/11", "20,000", "25/11/2026"],
       ["PL-209983", "Ravi Teja", "24/11/2026", "14:02:21", "Payment", "", "Priya Sharma", "", "", "", "", "Partially Paid", "Paid 10,000, balance 28/11", "9,350", "28/11/2026"],
       ["PL-195402", "Lakshmi Narayanan", "22/11/2026", "12:30:06", "Settlement", "", "Aakash Patel", "", "", "", "", "Settlement", "Settlement offer sent", "78,000", "30/11/2026"],
       ["PL-196274", "Deepak Rao", "22/11/2026", "15:22:47", "Call", "Agent", "Divya Menon", "022XXXX4509", "Progressive Dial", "00:02:56", "Connected", "Dispute", "Says EMI already debited", "", ""],
       ["PL-203390", "Ritu Agarwal", "22/11/2026", "15:19:31", "Call", "Customer", "Sanjay Gupta", "022XXXX4515", "Manual Dial", "00:03:48", "Connected", "Paid", "Paid via bank link", "", ""],
       ["PL-207761", "Farhan Qureshi", "22/11/2026", "10:20:03", "Call", "", "Rahul Nair", "022XXXX4505", "Productive Dial", "00:00:00", "Not answered", "Not Contacted", "Ringing", "", ""]],
      [125, 120, 85, 75, 85, 105, 105, 105, 115, 85, 95, 115, 190, 85, 85], note="One row per call, payment, settlement and promise · 24 columns")

# ── Summary ──
sheet("63-feedback-summary", FB_FILE, FB_TABS, "Summary", ["Item", "Value"],
      [["Portfolio", "Personal Loan Nov-26"], ["Lender", "Sunrise Finance"], ["Period", "All feedback to date"],
       ["Total loans in portfolio", 4820], ["Loans called in period", 4136], ["Loans connected in period", 2941],
       ["Total call attempts", 18240], ["Calls from earlier allocations", 1206], ["Manual calls matched by number", 388],
       ["", ""], ["Best disposition per loan", "Loans"], ["Paid", 912], ["Promise to Pay", 642], ["Call Back", 731],
       ["Settlement", 196], ["Partially Paid", 254], ["Dispute", 88], ["Refused to Pay", 275], ["Not Contacted", 1722]],
      [300, 220], note="")

# ── Call Auditor Excel reports ──
sheet("64-auditor-audit-feedback", "Audit + Feedback - 1 to 24 Nov 2026.xlsx", ["Audit + Feedback"], "Audit + Feedback",
      ["Agent Name", "Dial Type", "DID Used", "Call Duration", "Disposition", "Score Earned", "Score Possible", "Final Score %", "Grade", "Fatal Error", "Opening: Greeted the customer properly", "Greeted the customer properly (Points of 5)", "Opening: Confirmed the right person"],
      [["Priya Sharma", "Single", "022XXXX4512", "00:04:17", "Paid", 92, 100, "92%", "Excellent", "No", "Yes", 5, "Yes"],
       ["Kiran Joshi", "Single", "022XXXX4521", "00:06:30", "Settlement", 81, 100, "81%", "Good", "No", "Yes", 5, "Yes"],
       ["Imran Shaikh", "Productive Dial", "022XXXX4518", "00:05:02", "Promise to Pay", 88, 100, "88%", "Good", "No", "Yes", 5, "Yes"],
       ["Neha Saxena", "Progressive Dial", "022XXXX4502", "00:01:40", "Refused to Pay", 0, 100, "0%", "Fatal", "Yes", "Yes", 5, "No"],
       ["Rahul Nair", "Productive Dial", "022XXXX4505", "00:04:40", "Promise to Pay", 84, 95, "88%", "Good", "No", "Yes", 5, "Yes"],
       ["Divya Menon", "Progressive Dial", "022XXXX4509", "00:02:56", "Dispute", 90, 100, "90%", "Excellent", "No", "Yes", 5, "Yes"],
       ["Meera Krishnan", "Manual Dial", "022XXXX4544", "00:03:48", "Partially Paid", 72, 100, "72%", "Needs Improvement", "No", "No", 0, "Yes"]],
      [115, 115, 105, 85, 115, 85, 90, 85, 120, 75, 225, 235, 200], start_col=14,
      note="Three columns for every scorecard item, then the AI's view and replies")

sheet("65-auditor-fatal-errors", "Fatal Errors - 1 to 24 Nov 2026.xlsx", ["Fatal Errors"], "Fatal Errors",
      ["Audit Date", "Auditor", "Team", "Manager", "Agent Name", "Call Date", "Loan Account Number", "Customer Name", "Fatal Errors", "Feedback to Agent", "Agent's Reply"],
      [["18/11/2026", "Kavya Iyer", "Team East", "Rohan Mehta", "Neha Saxena", "18/11/2026", "PL-204518", "Arjun Verma", "Disclosed the debt to someone else", "Spoke about the loan with the person who answered before confirming identity.", ""],
       ["14/11/2026", "Kavya Iyer", "Team North", "Vivek Chauhan", "Sanjay Gupta", "13/11/2026", "TW-117630", "Rakesh Yadav", "Harassment or repeated pressure", "Five calls in one hour after the borrower asked to be called tomorrow.", "Understood, will follow callback time."],
       ["09/11/2026", "Arjun Kapoor", "Team West", "Sunita Rao", "Vikas Tiwari", "08/11/2026", "PL-199871", "Seema Rathi", "Gave false information or false threats", "Mentioned legal action that has not been started.", "Acknowledged."]],
      [90, 100, 90, 105, 105, 90, 135, 115, 245, 400, 240], note="Every call failed for a fatal error")

sheet("66-auditor-ai-vs-auditor", "AI vs Auditor - 1 to 24 Nov 2026.xlsx", ["AI vs Auditor"], "AI vs Auditor",
      ["Call Date", "Team", "Agent Name", "Loan Account Number", "AI Agent Tone", "AI Customer Tone", "AI Overall Tone", "AI Confidence", "Status", "Auditor", "Auditor's Tone Verdict", "Auditor vs AI", "Auditor's Comment on AI"],
      [["24/11/2026", "Team East", "Priya Sharma", "PL-198730", "Polite", "Cooperative", "Positive", "0.91", "Reviewed", "Kavya Iyer", "Positive", "Same as AI", ""],
       ["22/11/2026", "Team North", "Kiran Joshi", "TW-118204", "Polite", "Hesitant", "Neutral", "0.78", "Reviewed", "Kavya Iyer", "Positive", "Different", "Borrower agreed to settle by the end."],
       ["21/11/2026", "Team East", "Imran Shaikh", "PL-200615", "Firm", "Cooperative", "Positive", "0.85", "Reviewed", "Kavya Iyer", "Positive", "Same as AI", ""],
       ["20/11/2026", "Team East", "Rahul Nair", "PL-201147", "Empathetic", "Stressed", "Positive", "0.88", "Waiting for auditor", "", "", "", ""],
       ["18/11/2026", "Team East", "Neha Saxena", "PL-204518", "Pushy", "Angry", "Negative", "0.93", "Reviewed", "Kavya Iyer", "Negative", "Same as AI", "Also a fatal error."],
       ["17/11/2026", "Cards Recovery", "Fatima Khan", "CC-77412", "Polite", "Cooperative", "Positive", "0.67", "Reviewed", "Arjun Kapoor", "Neutral", "Different", "No commitment taken."]],
      [90, 110, 110, 135, 105, 120, 110, 95, 140, 100, 145, 100, 260], note="Where the AI agreed or disagreed with the auditor")

# ── Scorecards: three downloads with the same layout, shown together ──
def score_grid(title, keys, rows):
    hdr = keys + ["Total Calls", "Connected", "Connect %", "Audited", "Average Score %", "Excellent", "Good", "Needs Improvement", "Poor", "Fatal", "Coaching Required"]
    th = "".join(f"<td class='hd'>{h}</td>" for h in hdr)
    tr = "".join("<tr>" + "".join(f"<td class='{'num' if isinstance(c, (int, float)) or str(c).endswith('%') else ''}'>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f"<div class='card'><div class='ct'>{title}</div><table><tr>{th}</tr>{tr}</table></div>"
sc = f"""<style>
.wrap{{position:fixed;inset:0;background:#eef2f7;padding:24px;font-family:Inter,system-ui,sans-serif;color:#1f2937;display:flex;flex-direction:column;gap:16px}}
.card{{background:#fff;border:1px solid #d1d5db;border-radius:8px;overflow:hidden}}
.ct{{background:#f3f4f6;border-bottom:1px solid #d1d5db;padding:8px 12px;font-size:13px;font-weight:600}}
table{{border-collapse:collapse;font-size:12px;width:100%}} td{{border:1px solid #e5e7eb;padding:5px 7px;white-space:nowrap}}
td.hd{{font-weight:700}} td.num{{text-align:right}}
</style><div class='wrap'>
{score_grid("Agent Scorecard.xlsx", ["Agent Code", "Agent Name", "Team", "Manager"], [
 ["A007", "Imran Shaikh", "Team East", "Rohan Mehta", 1506, 866, "58%", 52, "91%", 31, 18, 3, 0, 0, 0],
 ["A014", "Priya Sharma", "Team East", "Rohan Mehta", 1412, 819, "58%", 48, "90%", 27, 18, 3, 0, 0, 0],
 ["A016", "Divya Menon", "Team East", "Rohan Mehta", 1330, 718, "54%", 44, "88%", 22, 18, 4, 0, 0, 1],
 ["A022", "Neha Saxena", "Team East", "Rohan Mehta", 1035, 508, "49%", 36, "79%", 9, 16, 8, 2, 1, 4]])}
{score_grid("Team & Manager Scorecard.xlsx", ["Team", "Manager"], [
 ["Team East", "Rohan Mehta", 16820, 9251, "55%", 412, "87%", 196, 158, 46, 10, 2, 9],
 ["Team West", "Sunita Rao", 13940, 7389, "53%", 388, "85%", 171, 152, 51, 12, 2, 11],
 ["Team North", "Vivek Chauhan", 11210, 5605, "50%", 296, "78%", 88, 121, 61, 22, 4, 19]])}
{score_grid("Portfolio Scorecard.xlsx", ["Portfolio", "Lender"], [
 ["Personal Loan Nov-26", "Sunrise Finance", 18240, 10032, "55%", 520, "86%", 231, 204, 66, 16, 3, 14],
 ["Two-Wheeler Q4", "Meridian NBFC", 12410, 6577, "53%", 371, "84%", 152, 149, 52, 15, 3, 12],
 ["Cards Recovery", "Nova Bank", 6820, 3478, "51%", 205, "88%", 104, 78, 18, 4, 1, 5]])}
<div style="font-size:11px;color:#6b7280">Three Excel downloads with the same layout; each also has a column per scorecard item (e.g. "Confirmed the right person %"). Sample data.</div>
</div>"""
(P / "67-auditor-scorecards.html").write_text(f"<!-- {json.dumps({'role': 'none', 'title': 'Scorecards', 'height': 700})} -->\n{sc}\n")
print("ok")
