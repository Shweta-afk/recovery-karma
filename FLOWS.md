# RecoveryAI — Key User Flows

## 1. Agent makes a call

```
Call Queue page
  → Agent clicks "Call" on a queue row
  → startCall(debtor): phase = "ringing", dialer panel slides up
  → 3s setTimeout: phase = "connected"
     → debtor data strip shown (5 cols: name/loan, outstanding, DPD, language, POS)
     → script panel available (collapsible, auto-fills name+amount)
     → mute / hold / transfer controls active
  → Agent clicks "End Call"
  → phase = "ended", disposition form opens inline
  → Agent selects outcome, fills notes / PTP date / settlement amount
  → "Submit" pressed:
       if outcome == dispute OR escalate checkbox:
         → EscalationModal opens (reason buttons, priority, pre-filled notes)
         → on confirm: escalation logged, call closed
       else:
         → call logged to history, panel dismissed
```

View can be toggled between panel (bottom bar) and modal (Dialog) at any point mid-call without losing state.

---

## 2. Agent views a debtor profile

```
Call Queue page  OR  Debtors page
  → Click debtor name (queue) or debtor card (debtors page)
  → Right-side Sheet drawer opens: DebtorProfileSheet
  → 5 tabs:
       Overview   — loan details, EMI schedule, key stats
       Calls      — full call history with RecordingPlayer per row
       Messages   — chat-bubble view of SMS/WhatsApp/IVR history
       Payments   — payment history for this debtor
       Disputes   — open/closed dispute records
```

---

## 3. Manager uploads a portfolio

```
Manager → Upload page
  → Drag-and-drop or file picker: Excel (.xlsx) file
  → System parses rows into Debtor records
  → Validation step (missing fields, DPD calc, duplicate IDs)
  → Confirmed rows written to D1
  → Portfolio appears in Manager → Assignment for agent mapping
```

---

## 4. Escalation workflow

```
During disposition (any call that ends with a dispute/threshold breach):
  → "Escalate" checkbox checked OR outcome = "dispute"
  → EscalationModal opens:
       Debtor context strip (name, loan, outstanding, DPD)
       8 reason buttons (Disputes Ownership, Legal Notice, etc.)
       Priority: Normal / Urgent / Critical
       Pre-filled notes (editable)
  → Submit → success screen → modal closes, call logged with escalation flag
```

---

## 5. PTP follow-up tracker

```
Call Queue page → PTP Tracker tab
  → Shows all open PTPs sorted by daysLeft (today first)
  → Filter pills: All / Today / Tomorrow / This Week / Overdue
  → Each row has "Call" button → triggers startCall() for that debtor
  → "Overdue risk" badge shown when daysLeft == 0
```

---

## 6. Recording playback

```
Debtor Profile → Calls tab
  OR  Call Queue → PTP Tracker (historical rows)
  → Each call row has a play button (PlayCircle icon)
  → Click → RecordingPlayer expands inline:
       Animated progress bar (simulated)
       MM:SS counter (self-managing setInterval, cleaned up on unmount)
       Stop button to cancel
  → Only one recording plays at a time (playingId state tracks active row)
```

---

## 7. AI-handled calls

```
AI Bot dials debtors autonomously (off-screen process)
  → Outcomes written to D1 with aiHandled=true
  → Appear in Call Queue with "AI" badge (violet)
  → Agent reviews AI outcomes in queue
  → If AI escalated → shows in queue with escalated status, agent takes over
```

---

## 8. Agent status management

```
Dashboard header → Status widget (top-right)
  → Dropdown: Available / On Break / Lunch / Training / Offline
  → Selection updates local state (real implementation: POST to presence API)
  → Status dot changes colour in header
  → Manager view (manager.index) shows real-time agent availability grid
```
