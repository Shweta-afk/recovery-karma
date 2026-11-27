# Generates the report / extra mock pages (41-58) for the brochure screenshot set.
# Labels follow the real app (tab names and descriptions from src/routes/*.reports.tsx etc.).
# All data is made up. Run: python3 gen-report-pages.py && node build.mjs --shoot --only=<n>-
import json, pathlib

P = pathlib.Path(__file__).parent / "pages"

def page(name, meta, body):
    (P / f"{name}.html").write_text(f"<!-- {json.dumps(meta)} -->\n{body}\n")

def tabs(names, active):
    out = []
    for t in names:
        if t == active:
            out.append(f'<span class="border-b-2 border-foreground px-3 pb-2 font-medium text-foreground">{t}</span>')
        else:
            out.append(f'<span class="px-3 pb-2 text-muted-foreground">{t}</span>')
    return '<div class="flex flex-wrap gap-1 border-b border-border text-xs">' + "".join(out) + "</div>"

def date_filter(frm="2026-11-01", to="2026-11-24"):
    return (f'<div class="flex items-center gap-1.5"><i data-lucide="calendar-days" class="h-4 w-4 text-muted-foreground"></i>'
            f'<span class="flex h-9 items-center rounded-md border border-input bg-card px-2 text-sm">{d(frm)}</span>'
            f'<span class="text-xs text-muted-foreground">to</span>'
            f'<span class="flex h-9 items-center rounded-md border border-input bg-card px-2 text-sm">{d(to)}</span></div>')

def d(iso):
    y, m, dd = iso.split("-"); return f"{dd}/{m}/{y}"

def kpis(items, cols=4):
    cells = "".join(f'<div class="rounded-xl border border-border bg-card p-3"><div class="text-[11px] text-muted-foreground">{a}</div><div class="text-xl font-bold {c}">{b}</div>{f"<div class=\'text-[10px] text-muted-foreground\'>{s}</div>" if s else ""}</div>' for a, b, c, s in items)
    return f'<div class="grid grid-cols-{cols} gap-2">{cells}</div>'

def bars(values, labels, color="bg-primary/80", height="h-48", second=None):
    mx = max(values + (second or [0]))
    cols = []
    for i, v in enumerate(values):
        inner = f'<div class="w-full rounded-t {color}" style="height:{max(3, v / mx * 100):.0f}%"></div>'
        if second:
            inner = (f'<div class="flex h-full w-full items-end gap-0.5"><div class="flex-1 rounded-t bg-muted-foreground/30" style="height:{max(3, second[i] / mx * 100):.0f}%"></div>'
                     f'<div class="flex-1 rounded-t {color}" style="height:{max(3, v / mx * 100):.0f}%"></div></div>')
        cols.append(f'<div class="flex h-full flex-1 flex-col items-center justify-end gap-1">{inner}<span class="text-[10px] text-muted-foreground">{labels[i]}</span></div>')
    return f'<div class="flex {height} items-end gap-1.5">{"".join(cols)}</div>'

def table(head, rows, small=True):
    th = "".join(f'<th class="px-3 py-2.5 font-medium {"text-right" if h.startswith(">") else ""}">{h.lstrip(">")}</th>' for h in head)
    body = ""
    for r in rows:
        tds = "".join(f'<td class="px-3 py-2.5 {"text-right font-semibold" if head[i].startswith(">") else ""}">{c}</td>' for i, c in enumerate(r))
        body += f"<tr>{tds}</tr>"
    return (f'<div class="overflow-hidden rounded-xl border border-border bg-card"><table class="w-full {"text-xs" if small else "text-sm"}">'
            f'<thead class="border-b border-border"><tr class="text-left uppercase tracking-wider text-muted-foreground">{th}</tr></thead>'
            f'<tbody class="divide-y divide-border">{body}</tbody></table></div>')

def card(title, inner, extra=""):
    return f'<div class="rounded-xl border border-border bg-card p-4"><div class="mb-3 flex items-center justify-between"><div class="text-sm font-semibold">{title}</div>{extra}</div>{inner}</div>'

def pill(text, tone):
    return f'<span class="rounded-full bg-{tone}/15 px-2 py-0.5 text-[11px] font-semibold text-{tone}">{text}</span>'

DAYS = ["1", "3", "4", "5", "6", "7", "8", "10", "11", "12", "13", "14", "15", "17", "18", "19", "20", "21", "22", "24"]

# ── AGENT reports ───────────────────────────────────────────────────────────
AGENT_TABS = ["Collections Summary", "Monthly Trend", "Portfolio Health", "My Performance", "Time & Effort", "Outcome Breakdown", "PTP Follow-ups"]
AGENT_SUB = {
    "Collections Summary": "Calls, PTPs, and amount collected by day.",
    "Monthly Trend": "This month against last month, day by day.",
    "Portfolio Health": "Principal, DPD mix, and how much of each book you actually worked.",
    "My Performance": "Contact rate and PTP conversion trend.",
    "Time & Effort": "Talk, ringing, wrap, break and idle per day — measured.",
    "Outcome Breakdown": "How your logged calls resolve.",
    "PTP Follow-ups": "Open promises, ranked by urgency.",
}

def agent_reports(active, body):
    return f"""<div class="space-y-4">
  <div class="flex items-start justify-between gap-3">
    <div><h1 class="text-xl font-semibold tracking-tight">Reports</h1><p class="text-xs text-muted-foreground">Summaries and charts generated from your own call log.</p></div>
    <div class="flex items-center gap-2">{date_filter()}<button class="flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium"><i data-lucide="download" class="h-3.5 w-3.5"></i>Export CSV</button></div>
  </div>
  {tabs(AGENT_TABS, active)}
  <p class="text-xs text-muted-foreground">{AGENT_SUB[active]}</p>
  {body}
</div>"""

AG = {"role": "agent", "active": "Reports"}

page("41-agent-performance", {**AG, "title": "My Performance · SamvadX"}, agent_reports("My Performance", f"""
{kpis([("Calls this month", "1,412", "", "86 today"), ("Contact rate", "58%", "text-primary", "▲ 4 pts vs last month"), ("PTP conversion", "21%", "text-success", "of contacts gave a promise"), ("Collected", "₹5,18,000", "text-success", "47% of monthly target")])}
<div class="grid grid-cols-[3fr_2fr] gap-3">
{card("Contact rate by week", bars([49, 53, 56, 58], ["Week 1", "Week 2", "Week 3", "Week 4"], height="h-56"), '<span class="text-[11px] text-muted-foreground">% of calls answered</span>')}
{card("PTP conversion by week", bars([17, 19, 20, 23], ["Week 1", "Week 2", "Week 3", "Week 4"], color="bg-success/80", height="h-56"), '<span class="text-[11px] text-muted-foreground">% of contacts</span>')}
</div>
{table(["Week", ">Calls", ">Contacts", ">Contact rate", ">PTPs", ">PTP amount", ">Collected"], [
 ["1–7 Nov", "322", "158", "49%", "27", "₹2,94,600", "₹1,02,400"],
 ["8–14 Nov", "368", "195", "53%", "37", "₹3,58,100", "₹1,46,900"],
 ["15–21 Nov", "401", "225", "56%", "45", "₹4,12,300", "₹1,61,200"],
 ["22–24 Nov", "321", "186", "58%", "43", "₹3,70,500", "₹1,07,500"]])}
"""))

page("42-agent-outcomes", {**AG, "title": "Outcome Breakdown · SamvadX"}, agent_reports("Outcome Breakdown", f"""
<div class="grid grid-cols-[2fr_3fr] gap-3">
{card("Outcomes this month", '''<div class="flex items-center gap-6"><svg viewBox="0 0 120 120" class="h-48 w-48 -rotate-90">
<circle cx="60" cy="60" r="45" fill="none" stroke-width="22" style="stroke:var(--success)" stroke-dasharray="56.5 283"/>
<circle cx="60" cy="60" r="45" fill="none" stroke-width="22" style="stroke:var(--primary)" stroke-dasharray="62.2 283" stroke-dashoffset="-56.5"/>
<circle cx="60" cy="60" r="45" fill="none" stroke-width="22" style="stroke:var(--warning)" stroke-dasharray="48.1 283" stroke-dashoffset="-118.7"/>
<circle cx="60" cy="60" r="45" fill="none" stroke-width="22" style="stroke:var(--destructive)" stroke-dasharray="19.8 283" stroke-dashoffset="-166.8"/>
<circle cx="60" cy="60" r="45" fill="none" stroke-width="22" style="stroke:var(--muted-foreground)" stroke-opacity=".35" stroke-dasharray="96.2 283" stroke-dashoffset="-186.6"/></svg>
<div class="space-y-2 text-xs"><div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-sm bg-success"></span>Paid / Partially Paid · 20%</div><div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-sm bg-primary"></span>Promise to Pay · 22%</div><div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-sm bg-warning"></span>Call Back · 17%</div><div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-sm bg-destructive"></span>Refused to Pay · 7%</div><div class="flex items-center gap-2"><span class="h-2.5 w-2.5 rounded-sm bg-muted-foreground/40"></span>Not Contacted · 34%</div></div></div>''')}
{table(["Outcome", ">Calls", ">Share", ">Amount"], [
 [pill("Paid", "success"), "198", "14%", "₹4,12,000"],
 [pill("Partially Paid", "success"), "84", "6%", "₹1,06,000"],
 [pill("Promise to Pay", "primary"), "311", "22%", "₹13,64,800"],
 [pill("Call Back", "warning"), "240", "17%", "—"],
 [pill("Refused to Pay", "destructive"), "99", "7%", "—"],
 [pill("Not Contacted", "muted-foreground"), "480", "34%", "—"]], small=False)}
</div>
{card("Outcomes by week", bars([42, 51, 63, 57], ["Week 1", "Week 2", "Week 3", "Week 4"], color="bg-primary/80", height="h-40", second=[110, 121, 118, 109]), '<span class="text-[11px] text-muted-foreground">Grey: not contacted · Blue: promises + payments</span>')}
"""))

page("43-agent-ptp-followups", {**AG, "title": "PTP Follow-ups · SamvadX"}, agent_reports("PTP Follow-ups", f"""
{kpis([("Open promises", "47", "", "₹13.6L promised"), ("Due today", "6", "text-warning", "₹84,200"), ("Kept this month", "68%", "text-success", "126 of 185 due"), ("Missed", "14", "text-destructive", "escalated to your manager")])}
{table(["Borrower", "Loan ID", ">Promised", "Due date", "Days left", "Status"], [
 ["Sneha Kulkarni", "PL-198730", "₹12,500", "24 Nov 2026", "Today", pill("Due today", "warning")],
 ["Manoj Pillai", "PL-201147", "₹20,000", "25 Nov 2026", "1", pill("Open", "primary")],
 ["Pooja Bansal", "PL-200615", "₹35,700", "26 Nov 2026", "2", pill("Open", "primary")],
 ["Ravi Teja", "PL-209983", "₹9,350", "28 Nov 2026", "4", pill("Balance due", "primary")],
 ["Lakshmi Narayanan", "PL-195402", "₹78,000", "30 Nov 2026", "6", pill("Settlement", "primary")],
 ["Ananya Ghosh", "PL-208842", "₹23,450", "16 Nov 2026", "—", pill("Kept", "success")],
 ["Vikram Singh", "TW-118204", "₹14,575", "17 Nov 2026", "—", pill("Kept", "success")],
 ["Farhan Qureshi", "PL-207761", "₹8,400", "18 Nov 2026", "—", pill("Missed", "destructive")],
 ["Gaurav Malhotra", "CC-77412", "₹40,000", "17 Nov 2026", "—", pill("Missed", "destructive")]], small=False)}
"""))

page("44-agent-portfolio-health", {**AG, "title": "Portfolio Health · SamvadX"}, agent_reports("Portfolio Health", f"""
{kpis([("Accounts assigned", "412", "", "Personal Loan Nov-26"), ("Principal", "₹1.42 Cr", "", "across your book"), ("Worked", "86%", "text-primary", "354 accounts called at least once"), ("Resolved", "61", "text-success", "paid or settled")])}
<div class="grid grid-cols-2 gap-3">
{card("By DPD bucket", '''<div class="space-y-3 text-xs">
<div><div class="mb-1 flex justify-between"><span>1–30 DPD · 168 accounts</span><span class="font-semibold">94% worked</span></div><div class="h-2 rounded-full bg-muted"><div class="h-2 w-[94%] rounded-full bg-success"></div></div></div>
<div><div class="mb-1 flex justify-between"><span>31–60 DPD · 121 accounts</span><span class="font-semibold">88% worked</span></div><div class="h-2 rounded-full bg-muted"><div class="h-2 w-[88%] rounded-full bg-primary"></div></div></div>
<div><div class="mb-1 flex justify-between"><span>61–90 DPD · 79 accounts</span><span class="font-semibold">79% worked</span></div><div class="h-2 rounded-full bg-muted"><div class="h-2 w-[79%] rounded-full bg-warning"></div></div></div>
<div><div class="mb-1 flex justify-between"><span>90+ DPD · 44 accounts</span><span class="font-semibold">66% worked</span></div><div class="h-2 rounded-full bg-muted"><div class="h-2 w-[66%] rounded-full bg-destructive"></div></div></div></div>''')}
{card("By status", '''<div class="grid grid-cols-3 gap-2 text-center text-xs">
<div class="rounded-lg bg-muted/60 p-3"><div class="text-lg font-bold text-primary">58</div>New</div>
<div class="rounded-lg bg-muted/60 p-3"><div class="text-lg font-bold">131</div>Contacted</div>
<div class="rounded-lg bg-muted/60 p-3"><div class="text-lg font-bold text-success">47</div>Promised</div>
<div class="rounded-lg bg-muted/60 p-3"><div class="text-lg font-bold text-warning">22</div>Callback due</div>
<div class="rounded-lg bg-muted/60 p-3"><div class="text-lg font-bold text-success">44</div>Paid</div>
<div class="rounded-lg bg-muted/60 p-3"><div class="text-lg font-bold text-destructive">9</div>Dispute</div></div>''')}
</div>
{table(["DPD bucket", ">Accounts", ">Principal", ">Worked", ">Promised", ">Paid"], [
 ["1–30", "168", "₹41.2L", "158", "21", "26"], ["31–60", "121", "₹39.8L", "106", "14", "11"],
 ["61–90", "79", "₹33.6L", "62", "8", "5"], ["90+", "44", "₹27.4L", "29", "4", "2"]])}
"""))

page("45-agent-monthly-trend", {**AG, "title": "Monthly Trend · SamvadX"}, agent_reports("Monthly Trend", f"""
{kpis([("Collected · Nov (to date)", "₹5,18,000", "text-success", "▲ 11% vs Oct, same days"), ("Collected · Oct (same days)", "₹4,66,700", "", ""), ("Calls · Nov", "1,412", "", "▲ 6%"), ("PTPs · Nov", "152", "", "▲ 9%")])}
{card("Collected per day — November vs October", bars([18, 24, 9, 31, 22, 27, 14, 30, 26, 19, 33, 28, 12, 35, 29, 24, 37, 31, 22, 29], DAYS, height="h-64", second=[15, 21, 12, 25, 20, 22, 16, 24, 23, 18, 26, 25, 14, 28, 22, 21, 27, 26, 20, 24]), '<div class="flex gap-3 text-[11px] text-muted-foreground"><span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-primary"></span>November</span><span class="flex items-center gap-1"><span class="h-2 w-2 rounded-sm bg-muted-foreground/30"></span>October</span></div>')}
{table(["Month", ">Calls", ">Contacts", ">PTPs", ">Collected"], [
 ["November 2026 (to 24th)", "1,412", "764", "152", "₹5,18,000"], ["October 2026 (1–24)", "1,331", "702", "139", "₹4,66,700"],
 ["September 2026 (1–24)", "1,204", "611", "118", "₹3,98,200"]])}
"""))

page("46-agent-time-effort", {**AG, "title": "Time & Effort · SamvadX"}, agent_reports("Time & Effort", f"""
<p class="text-[11px] text-muted-foreground">These are measurements, not estimates.</p>
{kpis([("Talk time", "41h 18m", "", "this month"), ("Avg call", "2m 51s", "", ""), ("Longest call", "18m 02s", "", "Lakshmi Narayanan · 12 Nov"), ("Busiest day", "Tue 18 Nov", "", "112 calls")])}
{card("Per day — hours", bars([6.1, 6.4, 5.2, 6.8, 6.6, 6.0, 4.1, 6.9, 7.0, 6.3, 6.7, 6.2, 4.4, 6.8, 7.1, 6.5, 6.9, 6.6, 6.2, 6.0], DAYS, height="h-48"), '<span class="text-[11px] text-muted-foreground">Logged-in hours</span>')}
{table(["Day", "Login", "Logout", ">Talk", ">Ringing", ">Wrap-up", ">Break", ">Idle", ">Calls"], [
 ["Mon 24 Nov", "09:28", "—", "2h 41m", "38m", "22m", "35m", "19m", "86"],
 ["Sat 22 Nov", "09:31", "16:02", "2h 12m", "31m", "18m", "40m", "24m", "71"],
 ["Fri 21 Nov", "09:24", "18:41", "3h 05m", "44m", "26m", "45m", "21m", "104"],
 ["Thu 20 Nov", "09:35", "18:37", "2h 58m", "41m", "25m", "42m", "28m", "98"],
 ["Wed 19 Nov", "09:30", "18:44", "3h 11m", "46m", "27m", "44m", "17m", "107"]])}
"""))

# ── MANAGER reports ─────────────────────────────────────────────────────────
MGR_TABS = ["Overview", "By Agent", "Dial Mode", "Call Log", "Outcome Breakdown", "Monthly Trend", "Insights"]
MG = {"role": "manager", "active": "Reports"}

def mgr_reports(active, body, sub):
    return f"""<div class="space-y-4">
  <div class="flex items-start justify-between gap-3">
    <div><h1 class="text-xl font-semibold tracking-tight">Reports</h1><p class="text-xs text-muted-foreground">Team East · {sub}</p></div>
    <div class="flex items-center gap-2">{date_filter()}<button class="flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium"><i data-lucide="download" class="h-3.5 w-3.5"></i>Excel</button></div>
  </div>
  {tabs(MGR_TABS, active)}
  {body}
</div>"""

page("47-mgr-by-agent", {**MG, "title": "By Agent · SamvadX"}, mgr_reports("By Agent", f"""
{kpis([("Agents", "12", "", "active this month"), ("Calls", "16,820", "", ""), ("Contact rate", "55%", "text-primary", ""), ("Collected", "₹38.4L", "text-success", "Team DRR ₹1.97L / day")])}
{table(["Agent", ">Calls", ">Contacts", ">Contact rate", ">PTPs", ">PTP kept", ">Collected", ">Target", ">DRR", ">Talk time"], [
 ["Imran Shaikh", "1,506", "866", "58%", "61", "74%", "₹6,02,000", "₹11.0L", "₹41,500", "44h 10m"],
 ["Priya Sharma", "1,412", "819", "58%", "58", "71%", "₹5,18,000", "₹11.0L", "₹48,500", "41h 18m"],
 ["Divya Menon", "1,330", "718", "54%", "52", "69%", "₹4,95,000", "₹9.0L", "₹33,800", "38h 52m"],
 ["Rahul Nair", "1,288", "682", "53%", "49", "65%", "₹4,40,000", "₹10.5L", "₹50,800", "37h 05m"],
 ["Aakash Patel", "1,190", "631", "53%", "44", "63%", "₹3,90,000", "₹9.0L", "₹42,500", "34h 41m"],
 ["Kiran Joshi", "1,142", "617", "54%", "41", "66%", "₹3,62,000", "₹8.5L", "₹40,700", "33h 20m"],
 ["Meera Krishnan", "1,098", "571", "52%", "38", "61%", "₹3,11,500", "₹8.0L", "₹40,700", "31h 47m"],
 ["Neha Saxena", "1,035", "508", "49%", "33", "58%", "₹2,70,000", "₹8.0L", "₹44,200", "29h 15m"]])}
""", "every agent side by side"))

page("48-mgr-dial-mode", {**MG, "title": "Dial Mode · SamvadX"}, mgr_reports("Dial Mode", f"""
<div class="grid grid-cols-4 gap-2">
 <div class="rounded-xl border border-border bg-card p-3"><div class="flex items-center gap-1.5 text-xs font-semibold"><i data-lucide="zap" class="h-3.5 w-3.5 text-primary"></i>Productive Dial</div><div class="mt-1 text-xl font-bold">9,870</div><div class="text-[10px] text-muted-foreground">calls · 37% answered</div></div>
 <div class="rounded-xl border border-border bg-card p-3"><div class="flex items-center gap-1.5 text-xs font-semibold"><i data-lucide="list-ordered" class="h-3.5 w-3.5 text-primary"></i>Progressive Dial</div><div class="mt-1 text-xl font-bold">3,412</div><div class="text-[10px] text-muted-foreground">calls · 44% answered</div></div>
 <div class="rounded-xl border border-border bg-card p-3"><div class="flex items-center gap-1.5 text-xs font-semibold"><i data-lucide="phone" class="h-3.5 w-3.5 text-primary"></i>Single call</div><div class="mt-1 text-xl font-bold">2,206</div><div class="text-[10px] text-muted-foreground">calls · 51% answered</div></div>
 <div class="rounded-xl border border-border bg-card p-3"><div class="flex items-center gap-1.5 text-xs font-semibold"><i data-lucide="grid-3x3" class="h-3.5 w-3.5 text-primary"></i>Manual Dial</div><div class="mt-1 text-xl font-bold">1,332</div><div class="text-[10px] text-muted-foreground">calls · 63% answered</div></div>
</div>
<div class="grid grid-cols-[3fr_2fr] gap-3">
{card("Calls by dial mode per week", bars([2210, 2480, 2650, 2530], ["Week 1", "Week 2", "Week 3", "Week 4"], height="h-56", second=[1610, 1720, 1790, 1830]), '<span class="text-[11px] text-muted-foreground">Blue: Productive Dial · Grey: other modes</span>')}
{table(["Dial mode", ">Answered", ">PTPs", ">Collected"], [["Productive Dial", "3,652", "512", "₹17.9L"], ["Progressive Dial", "1,501", "221", "₹9.2L"], ["Single call", "1,125", "160", "₹6.8L"], ["Manual Dial", "839", "102", "₹4.5L"]], small=False)}
</div>
""", "how calls were placed and how each way performs"))

page("49-mgr-call-log", {**MG, "title": "Call Log · SamvadX"}, mgr_reports("Call Log", f"""
{table(["Time", "Agent", "Borrower", "Outcome", ">Talk time", "Dialled via", "Ended by", "Number used", "Recording"], [
 ["24 Nov 3:41 PM", "Priya Sharma", "Sneha Kulkarni · PL-198730", pill("Paid ₹12,500", "success"), "4:17", "Single", "Agent", "022 XXXX 4512", '<span class="flex items-center gap-1 text-primary"><i data-lucide="play-circle" class="h-4 w-4"></i>Play</span>'],
 ["24 Nov 3:38 PM", "Imran Shaikh", "Pooja Bansal · PL-200615", pill("PTP ₹35,700", "primary"), "5:02", "Productive", "Customer", "022 XXXX 4518", '<span class="flex items-center gap-1 text-primary"><i data-lucide="play-circle" class="h-4 w-4"></i>Play</span>'],
 ["24 Nov 3:35 PM", "Rahul Nair", "Farhan Qureshi · PL-207761", pill("Call Back", "warning"), "1:12", "Productive", "Agent", "022 XXXX 4505", '<span class="flex items-center gap-1 text-primary"><i data-lucide="play-circle" class="h-4 w-4"></i>Play</span>'],
 ["24 Nov 3:31 PM", "Kiran Joshi", "Vikram Singh · TW-118204", pill("Settlement", "primary"), "6:30", "Single", "Agent", "022 XXXX 4521", '<span class="flex items-center gap-1 text-primary"><i data-lucide="play-circle" class="h-4 w-4"></i>Play</span>'],
 ["24 Nov 3:27 PM", "Meera Krishnan", "Ritu Agarwal · PL-203390", pill("Partially Paid", "success"), "3:48", "Manual", "Customer", "022 XXXX 4544", '<span class="flex items-center gap-1 text-primary"><i data-lucide="play-circle" class="h-4 w-4"></i>Play</span>'],
 ["24 Nov 3:22 PM", "Divya Menon", "Deepak Rao · PL-196274", pill("Dispute", "destructive"), "2:56", "Progressive", "Agent", "022 XXXX 4509", '<span class="flex items-center gap-1 text-primary"><i data-lucide="play-circle" class="h-4 w-4"></i>Play</span>'],
 ["24 Nov 3:19 PM", "Aakash Patel", "Lakshmi Narayanan · PL-195402", pill("No Answer", "muted-foreground"), "—", "Productive", "—", "022 XXXX 4515", '<span class="text-muted-foreground">—</span>'],
 ["24 Nov 3:15 PM", "Neha Saxena", "Arjun Verma · PL-204518", pill("Refused to Pay", "destructive"), "1:40", "Progressive", "Customer", "022 XXXX 4502", '<span class="flex items-center gap-1 text-primary"><i data-lucide="play-circle" class="h-4 w-4"></i>Play</span>'],
 ["24 Nov 3:11 PM", "Priya Sharma", "Manoj Pillai · PL-201147", pill("PTP ₹20,000", "primary"), "3:05", "Single", "Agent", "022 XXXX 4512", '<span class="flex items-center gap-1 text-primary"><i data-lucide="play-circle" class="h-4 w-4"></i>Play</span>']], small=True)}
""", "every call, with outcome, talk time, who hung up and the number used"))

# ── MANAGER Call Audit ──────────────────────────────────────────────────────
page("50-mgr-call-audit", {"role": "manager", "active": "Call Audit", "title": "Call Audit · SamvadX"}, f"""<div class="space-y-4">
  <div class="flex items-start justify-between"><div><h1 class="text-xl font-semibold tracking-tight">Call Audit</h1><p class="text-xs text-muted-foreground">Team East · quality scores from the auditors and reviews for your team</p></div>{date_filter()}</div>
  {tabs(["Calls", "Team Performance", "Reviews"], "Team Performance")}
  {kpis([("Calls reviewed", "412", "", "this month"), ("Average score", "87.2%", "text-success", "▲ 2.1 pts"), ("Fatal errors", "2", "text-destructive", ""), ("Feedback acknowledged", "95%", "", "")])}
  <div class="grid grid-cols-[3fr_2fr] gap-3">
  {table(["Agent", ">Reviewed", ">Average score", ">Fatal", ">Acknowledged"], [
   ["Imran Shaikh", "52", "91%", "0", "52"], ["Priya Sharma", "48", "90%", "0", "47"], ["Divya Menon", "44", "88%", "0", "44"],
   ["Kiran Joshi", "39", "86%", "0", "37"], ["Rahul Nair", "41", "84%", "1", "40"], ["Neha Saxena", "36", "79%", "1", "31"]], small=False)}
  {card("Reviews received", '''<div class="space-y-3 text-xs">
   <div class="rounded-lg border border-border p-3"><div class="flex justify-between"><span class="font-semibold">Team review · November</span><span class="text-muted-foreground">Kavya Iyer · 20 Nov</span></div><p class="mt-1 text-sm">Strong openings across the team. Coach on offering the payment link before closing.</p><span class="mt-2 inline-block rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">Waiting for your reply</span></div>
   <div class="rounded-lg border border-border p-3"><div class="flex justify-between"><span class="font-semibold">Neha Saxena · Refused to Pay</span><span class="text-muted-foreground">18 Nov</span></div><p class="mt-1 text-sm">Fatal: no identity check before discussing the loan. Please retrain.</p><span class="mt-2 inline-block rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success">Acknowledged</span></div></div>''')}
  </div>
</div>""")

# ── ADMIN reports ───────────────────────────────────────────────────────────
ADM_TABS = ["Overview", "By Team", "By Agent", "Recovery", "Settlements", "Disputes", "Outcome Breakdown", "Monthly Trend", "Call Log", "Insights"]
AD = {"role": "admin", "active": "Reports"}

def adm_reports(active, body):
    return f"""<div class="space-y-4">
  <div class="flex items-start justify-between gap-3">
    <div><h1 class="text-xl font-semibold tracking-tight">Reports</h1><p class="text-xs text-muted-foreground">Every team and portfolio in your company</p></div>
    <div class="flex items-center gap-2">{date_filter()}<button class="flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-xs font-medium"><i data-lucide="download" class="h-3.5 w-3.5"></i>Excel</button></div>
  </div>
  {tabs(ADM_TABS, active)}
  {body}
</div>"""

page("51-admin-settlements", {**AD, "title": "Settlements · SamvadX"}, adm_reports("Settlements", f"""
{kpis([("Requests", "38", "", "this month"), ("Approved", "21", "text-success", "₹14.2L agreed"), ("Pending", "9", "text-warning", "₹6.1L proposed"), ("Rejected", "8", "text-destructive", "")])}
{table(["Raised", "Borrower", "Loan ID", "Portfolio", ">Outstanding", ">Proposed", "Requested by", "Status"], [
 ["22 Nov", "Lakshmi Narayanan", "PL-195402", "Personal Loan Nov-26", "₹1,04,600", "₹78,000", "Aakash Patel", pill("Pending", "warning")],
 ["21 Nov", "Gaurav Malhotra", "CC-77412", "Cards Recovery", "₹1,12,000", "₹82,500", "Meera Krishnan", pill("Approved", "success")],
 ["20 Nov", "Vikram Singh", "TW-118204", "Two-Wheeler Q4", "₹58,300", "₹45,000", "Kiran Joshi", pill("Approved", "success")],
 ["19 Nov", "Harish Kumar", "PL-199204", "Personal Loan Nov-26", "₹96,800", "₹50,000", "Rahul Nair", pill("Rejected", "destructive")],
 ["18 Nov", "Sunita Pawar", "CD-40211", "Consumer Durable", "₹31,400", "₹24,000", "Divya Menon", pill("Pending", "warning")],
 ["17 Nov", "Rakesh Yadav", "TW-117630", "Two-Wheeler Q4", "₹42,900", "₹33,000", "Imran Shaikh", pill("Approved", "success")]], small=False)}
"""))

page("52-admin-disputes", {**AD, "title": "Disputes · SamvadX"}, adm_reports("Disputes", f"""
{kpis([("Disputes raised", "26", "", "this month"), ("Open", "11", "text-warning", ""), ("Resolved", "15", "text-success", ""), ("Most common", "EMI already debited", "", "9 of 26")])}
{table(["Raised", "Borrower", "Loan ID", "Type", "Raised by", "Status"], [
 ["23 Nov", "Deepak Rao", "PL-196274", "EMI already debited", "Divya Menon", pill("Open", "warning")],
 ["21 Nov", "Kavita Joshi", "CC-77850", "Wrong amount", "Meera Krishnan", pill("Open", "warning")],
 ["20 Nov", "Mohan Das", "TW-118911", "Loan closed", "Kiran Joshi", pill("Resolved", "success")],
 ["19 Nov", "Asha Menon", "PL-202288", "Not my loan", "Rahul Nair", pill("Resolved", "success")],
 ["18 Nov", "Prakash Shetty", "CD-40377", "EMI already debited", "Imran Shaikh", pill("Open", "warning")]], small=False)}
"""))

page("53-admin-recovery", {**AD, "title": "Recovery · SamvadX"}, adm_reports("Recovery", f"""
{kpis([("Allocated", "₹42.6 Cr", "", "6 active portfolios"), ("Collected", "₹1.42 Cr", "text-success", "this month"), ("Accounts resolved", "2,184", "text-success", "paid or settled"), ("Open promises", "₹3.9 Cr", "text-primary", "1,240 accounts")])}
<div class="grid grid-cols-[3fr_2fr] gap-3">
{table(["Portfolio", "Lender", ">Accounts", ">Allocated", ">Collected", ">Resolved", ">Promised"], [
 ["Personal Loan Nov-26", "Sunrise Finance", "4,820", "₹18.6 Cr", "₹62.4L", "1,108", "₹1.6 Cr"],
 ["Two-Wheeler Q4", "Meridian NBFC", "3,105", "₹9.8 Cr", "₹38.1L", "612", "₹1.1 Cr"],
 ["Cards Recovery", "Nova Bank", "1,870", "₹8.1 Cr", "₹27.6L", "241", "₹0.7 Cr"],
 ["Consumer Durable", "Sunrise Finance", "2,440", "₹6.1 Cr", "₹13.9L", "223", "₹0.5 Cr"]], small=False)}
{card("Collected by portfolio", '''<div class="space-y-3 text-xs">
<div><div class="mb-1 flex justify-between"><span>Personal Loan Nov-26</span><b>₹62.4L</b></div><div class="h-3 rounded bg-muted"><div class="h-3 w-[100%] rounded bg-primary"></div></div></div>
<div><div class="mb-1 flex justify-between"><span>Two-Wheeler Q4</span><b>₹38.1L</b></div><div class="h-3 rounded bg-muted"><div class="h-3 w-[61%] rounded bg-primary"></div></div></div>
<div><div class="mb-1 flex justify-between"><span>Cards Recovery</span><b>₹27.6L</b></div><div class="h-3 rounded bg-muted"><div class="h-3 w-[44%] rounded bg-primary"></div></div></div>
<div><div class="mb-1 flex justify-between"><span>Consumer Durable</span><b>₹13.9L</b></div><div class="h-3 rounded bg-muted"><div class="h-3 w-[22%] rounded bg-primary"></div></div></div></div>''')}
</div>
"""))

# ── AUDITOR reports page (download cards — the real page has no on-screen preview) ──
AUD_REPORTS = [
 ("Audit + Feedback", "Every review with the call, each scorecard answer, the agent's feedback, the AI's view and replies."),
 ("Call Log", "One row per call, in your export's column order, then everything else we hold including every bank-file column."),
 ("Performance", "One row per agent per day: calls, login, idle, wrap-up, breaks, utilisation, PTP, collected, audit score."),
 ("Agent Scorecard", "Each agent's scores, grades and result on every scorecard parameter."),
 ("Team & Manager Scorecard", "The same, team by team."),
 ("Portfolio Scorecard", "The same, portfolio by portfolio."),
 ("Team Reviews", "Reviews written for each team and manager, with their replies."),
 ("Fatal Errors", "Every call failed for a fatal error."),
 ("AI vs Auditor", "Where the AI agreed or disagreed with the auditor, and what is still waiting."),
 ("Auditor Productivity", "How many calls each auditor reviewed, per day."),
]
cards = "".join(f'<div class="flex items-start justify-between gap-3 rounded-xl border border-border bg-card p-4"><div><h2 class="text-sm font-semibold">{t}</h2><p class="mt-1 text-xs text-muted-foreground">{a}</p></div><button class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border"><i data-lucide="download" class="h-4 w-4"></i></button></div>' for t, a in AUD_REPORTS)

FEEDBACK_FORM = f"""<div class="space-y-4 rounded-xl border border-border bg-card p-5">
  <div class="grid grid-cols-2 gap-4">
    <div class="space-y-1.5"><label class="text-xs font-medium">Team</label><div class="flex h-9 items-center justify-between rounded-md border border-input px-3 text-sm">Team East<i data-lucide="chevron-down" class="h-4 w-4 text-muted-foreground"></i></div></div>
    <div class="space-y-1.5"><label class="text-xs font-medium">Portfolio</label><div class="flex h-9 items-center justify-between rounded-md border border-input px-3 text-sm">Personal Loan Nov-26 · Team East<i data-lucide="chevron-down" class="h-4 w-4 text-muted-foreground"></i></div></div>
  </div>
  <div class="space-y-1.5"><label class="text-xs font-medium">Period</label>
    <div class="flex flex-wrap items-center gap-2">
      <span class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">All feedback</span>
      <span class="rounded-md border border-border px-3 py-1.5 text-xs">Today</span><span class="rounded-md border border-border px-3 py-1.5 text-xs">Last 5 days</span><span class="rounded-md border border-border px-3 py-1.5 text-xs">Last 7 days</span><span class="rounded-md border border-border px-3 py-1.5 text-xs">Last 30 days</span>
      {date_filter("2026-11-01", "2026-11-24")}
    </div></div>
  <label class="flex items-center gap-2 text-sm"><span class="h-4 w-4 rounded border border-input"></span>Include loans with no calls in this period</label>
  <label class="flex items-center gap-2 text-sm"><span class="flex h-4 w-4 items-center justify-center rounded border border-primary bg-primary text-white"><i data-lucide="check" class="h-3 w-3"></i></span>Include call recording links</label>
  <button class="flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"><i data-lucide="download" class="h-4 w-4"></i>Download feedback file</button>
  <p class="text-[11px] text-muted-foreground">One Excel file in the bank's own layout: Feedback by Loan, Date-wise Feedback, CC Report, All Feedback and Summary. Internal audit data is never included.</p>
</div>"""

page("54-auditor-reports", {"role": "auditor", "active": "Reports", "title": "Audit Reports · SamvadX"}, f"""<div class="space-y-4">
  <div class="flex items-start justify-between gap-3">
    <div><h1 class="text-xl font-semibold tracking-tight">Reports</h1><p class="text-xs text-muted-foreground">Everything downloads as Excel, in full detail.</p></div>
    <div class="flex items-center gap-2">{date_filter()}<span class="flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm">All teams<i data-lucide="chevron-down" class="h-4 w-4 text-muted-foreground"></i></span><button class="flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"><i data-lucide="download" class="h-4 w-4"></i>Download all reports</button></div>
  </div>
  <div class="grid grid-cols-2 gap-3">{cards}</div>
</div>""")

page("55-feedback-file-form", {"role": "manager", "active": "Feedback File", "title": "Feedback File · SamvadX"}, f"""<div class="mx-auto max-w-4xl space-y-4">
  <div><h1 class="text-xl font-semibold tracking-tight">Feedback File</h1><p class="text-xs text-muted-foreground">The bank's feedback report for a portfolio, built from every call, payment and promise on its loans.</p></div>
  {FEEDBACK_FORM}
</div>""")

# ── DATE CONTROL (the real control: From … to …, plus the dashboard's Today / This Month / Custom) ──
page("56-date-control", {"role": "manager", "active": "Call History", "title": "Call History · SamvadX"}, f"""<div class="space-y-4">
  <div><h1 class="text-xl font-semibold tracking-tight">Call History</h1><p class="text-xs text-muted-foreground">One date control on every list and report — days run midnight to midnight, India time</p></div>
  <div class="flex items-center gap-3 rounded-xl border-2 border-primary/40 bg-card p-3">
    {date_filter("2026-11-01", "2026-11-24")}
    <button class="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground"><i data-lucide="x" class="h-4 w-4"></i></button>
    <span class="ml-2 text-xs text-muted-foreground">From — to · pick any range · ✕ clears it</span>
    <div class="ml-auto flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
      <span class="rounded-md px-3 py-1 text-xs font-medium text-muted-foreground">Today</span>
      <span class="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-sm">This Month</span>
      <span class="flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium text-muted-foreground"><i data-lucide="calendar-days" class="h-3 w-3"></i>Custom</span>
    </div>
    <span class="text-[11px] text-muted-foreground">on dashboards</span>
  </div>
  {table(["Time", "Agent", "Borrower", "Outcome", ">Talk time", "Dialled via"], [
   ["24 Nov 3:41 PM", "Priya Sharma", "Sneha Kulkarni", pill("Paid ₹12,500", "success"), "4:17", "Single"],
   ["24 Nov 3:38 PM", "Imran Shaikh", "Pooja Bansal", pill("PTP ₹35,700", "primary"), "5:02", "Productive"],
   ["23 Nov 6:52 PM", "Rahul Nair", "Farhan Qureshi", pill("Call Back", "warning"), "1:12", "Productive"],
   ["22 Nov 11:05 AM", "Kiran Joshi", "Vikram Singh", pill("Settlement", "primary"), "6:30", "Single"],
   ["1 Nov 9:31 AM", "Meera Krishnan", "Ritu Agarwal", pill("Partially Paid", "success"), "3:48", "Manual"]], small=False)}
</div>""")

# ── DISPOSITION FORM (PTP selected) ─────────────────────────────────────────
page("57-agent-disposition-form", {"role": "agent", "active": "Call Queue", "title": "Record disposition · SamvadX"}, f"""<div class="mx-auto grid max-w-5xl grid-cols-[1fr_420px] gap-4">
  <div class="space-y-3 opacity-60">
    <div class="rounded-xl border border-border bg-card p-4"><div class="text-lg font-semibold">Manoj Pillai</div><div class="text-xs text-muted-foreground">PL-201147 · 94XXX XX019 · Call ended 03:05</div></div>
    <div class="h-64 rounded-xl border border-border bg-card"></div>
  </div>
  <div class="rounded-xl border border-border bg-card shadow-xl">
    <div class="border-b border-border px-4 py-3"><div class="text-sm font-semibold">Record disposition</div><div class="text-xs text-muted-foreground">Saved to the account and the bank feedback file</div></div>
    <div class="space-y-4 p-4">
      <div class="grid grid-cols-2 gap-2 text-xs">
        <button class="rounded-lg border border-border px-3 py-2 text-left font-medium">Paid</button>
        <button class="rounded-lg border border-border px-3 py-2 text-left font-medium">Partially Paid</button>
        <button class="rounded-lg border-2 border-primary bg-primary/10 px-3 py-2 text-left font-semibold text-primary">Promise to Pay</button>
        <button class="rounded-lg border border-border px-3 py-2 text-left font-medium">Call Back</button>
        <button class="rounded-lg border border-border px-3 py-2 text-left font-medium">Settlement</button>
        <button class="rounded-lg border border-border px-3 py-2 text-left font-medium">Dispute</button>
        <button class="rounded-lg border border-border px-3 py-2 text-left font-medium">Refused to Pay</button>
        <button class="rounded-lg border border-border px-3 py-2 text-left font-medium">Not Contacted</button>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div class="space-y-1.5"><label class="text-xs font-medium">Promised amount</label><div class="flex h-9 items-center rounded-md border border-input px-3 text-sm">₹ 20,000</div></div>
        <div class="space-y-1.5"><label class="text-xs font-medium">Promise date</label><div class="flex h-9 items-center rounded-md border border-input px-3 text-sm">25/11/2026</div></div>
      </div>
      <div class="space-y-1.5"><label class="text-xs font-medium">Notes</label><div class="h-20 rounded-md border border-input p-3 text-sm">Salary on 20th. Will pay ₹20,000 through the bank link by 25 Nov; balance next month.</div></div>
      <div class="flex items-center gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground"><i data-lucide="bell" class="h-4 w-4 text-primary"></i>You'll be reminded on the due date. If it's missed, it goes to your manager.</div>
      <button class="h-9 w-full rounded-md bg-primary text-sm font-medium text-primary-foreground">Save &amp; next borrower</button>
    </div>
  </div>
</div>""")

# ── NUMBER POOL (Admin → Settings → Calling numbers; today's count only, never a limit) ──
nums = [("022 XXXX 4501", True, 96), ("022 XXXX 4502", True, 88), ("022 XXXX 4503", True, 91), ("022 XXXX 4505", False, 64), ("022 XXXX 4509", False, 58),
        ("022 XXXX 4512", False, 61), ("022 XXXX 4515", False, 55), ("022 XXXX 4518", False, 60), ("022 XXXX 4521", False, 57), ("022 XXXX 4544", True, 84)]
rows = "".join(f'<tr><td class="px-4 py-2.5 font-mono">{n}</td><td class="px-3"><span class="inline-flex h-5 w-9 rounded-full p-0.5 {"bg-primary" if m else "bg-muted"}"><span class="block h-4 w-4 rounded-full bg-white {"ml-auto" if m else ""}"></span></span></td><td class="px-3 text-xs">{"Manual Dial" if m else "Call Queue · portfolios"}</td><td class="px-4 text-right text-xs text-muted-foreground">{c} calls today</td></tr>' for n, m, c in nums)
page("58-number-pool", {"role": "admin", "active": "System Settings", "title": "Calling numbers · SamvadX"}, f"""<div class="mx-auto max-w-5xl space-y-4">
  <div><h1 class="text-xl font-semibold tracking-tight">System Settings</h1><p class="text-xs text-muted-foreground">How SamvadX works for your whole company</p></div>
  <div class="rounded-xl border border-border bg-card">
    <div class="flex items-center justify-between border-b border-border px-4 py-3"><div><div class="text-sm font-semibold">Calling numbers</div><div class="text-xs text-muted-foreground">Your company's dedicated numbers. Mark the ones kept for Manual Dial; managers pick the rest for each portfolio.</div></div><span class="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">10 numbers · 4 for Manual Dial</span></div>
    <table class="w-full text-sm"><thead><tr class="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground"><th class="px-4 py-2.5 font-medium">Number</th><th class="px-3 py-2.5 font-medium">Manual Dial</th><th class="px-3 py-2.5 font-medium">Used for</th><th class="px-4 py-2.5 text-right font-medium">Today</th></tr></thead><tbody class="divide-y divide-border">{rows}</tbody></table>
    <div class="m-4 flex items-center gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground"><i data-lucide="refresh-cw" class="h-4 w-4 text-primary"></i>Calls rotate automatically to the least-used number. Each number belongs to your company only.</div>
  </div>
</div>""")

print("generated")
