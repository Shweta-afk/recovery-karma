#!/bin/bash
# Copies the light-mode PNGs into the brochure/manual set under the requested file names.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$HOME/Downloads/samvadx-brochure-screenshots"
mkdir -p "$OUT" && rm -f "$OUT"/*.png
MAP="
agent-dashboard:02-agent-dashboard
agent-performance:41-agent-performance
agent-outcomes:42-agent-outcomes
agent-ptp-followups:43-agent-ptp-followups
agent-portfolio-health:44-agent-portfolio-health
agent-monthly-trend:45-agent-monthly-trend
agent-time-effort:46-agent-time-effort
mgr-dashboard:08-manager-dashboard
mgr-by-agent:47-mgr-by-agent
mgr-dial-mode:48-mgr-dial-mode
mgr-call-log:49-mgr-call-log
mgr-call-audit:50-mgr-call-audit
admin-company-reports:14-reports
admin-settlements-disputes:51-admin-settlements
admin-disputes:52-admin-disputes
admin-recovery:53-admin-recovery
admin-archive-history:29-archive-history
auditor-reports:54-auditor-reports
feedback-file:55-feedback-file-form
insights-lookup-by-loan:31-lookup-by-loan
insights-outcome:34-insights-outcome
insights-charges:33-insights-wallet
date-control:56-date-control
login:01-login
agent-call-queue:03-call-queue
agent-on-call:04-live-call
agent-manual-dial:19-manual-dial
agent-disposition-form:57-agent-disposition-form
portfolio-upload:11-portfolio-upload
number-pool:58-number-pool
feedback-by-loan:60-feedback-by-loan
feedback-datewise:61-feedback-datewise
feedback-cc-report:62-feedback-cc-report
feedback-summary:63-feedback-summary
auditor-audit-feedback:64-auditor-audit-feedback
auditor-fatal-errors:65-auditor-fatal-errors
auditor-ai-vs-auditor:66-auditor-ai-vs-auditor
auditor-scorecards:67-auditor-scorecards
"
for row in $MAP; do
  cp "png/${row##*:}-light.png" "$OUT/${row%%:*}.png"
done
ls "$OUT" | wc -l
