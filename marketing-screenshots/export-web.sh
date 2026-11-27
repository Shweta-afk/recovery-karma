#!/bin/bash
# Turns png/*.png into website-ready shots/ files: 2000x1250 .webp, named the way samvadx.com's
# gallery.js expects (<key>-light.webp / <key>-dark.webp), plus the Insights crop as .jpg.
set -euo pipefail
cd "$(dirname "$0")"
OUT=website-shots
rm -rf "$OUT" && mkdir -p "$OUT"

# png name (without -light/-dark) -> website file key
MAP="
01-login:login
02-agent-dashboard:agent-dash
03-call-queue:agent-queue
04-live-call:agent-call
05-productive-dial:mgr-dialer
06-borrower-profile:mgr-borrower
07-insights:insights-lookup
08-manager-dashboard:mgr-team
09-live-calls:mgr-live
10-portfolio-overview:mgr-portfolio
11-portfolio-upload:mgr-upload
12-auditor-review:auditor-review
13-auditor-overview:auditor-overview
14-reports:admin-reports
15-feedback-file:feedback-by-loan
16-admin-users:admin-users
17-activity-history:call-history
18-billing:admin-billing
19-manual-dial:agent-manual-dial
20-dialer-setup:mgr-dialer-setup
21-escalations:mgr-escalations
22-assign-accounts:mgr-assign
23-my-call-reviews:agent-reviews
24-review-thread:auditor-thread
25-teams-targets:admin-targets
26-org-settings:admin-settings
27-compliance-check:compliance-predial
28-device-signout:compliance-device
29-archive-history:compliance-archive
30-purge-certificate:compliance-purge
31-lookup-by-loan:insights-by-loan
32-cibil-consent:insights-cibil
33-insights-wallet:insights-wallet
34-insights-outcome:insights-outcome
35-drr-report:reports-drr
36-auditor-reports:auditor-reports
37-feedback-datewise:feedback-datewise
38-payments:mgr-payments
39-admin-overview:admin-overview
"
for row in $MAP; do
  src=${row%%:*}; key=${row##*:}
  for m in light dark; do
    [ -f "png/$src-$m.png" ] || { echo "missing png/$src-$m.png"; continue; }
    cwebp -quiet -q 82 -resize 2000 1250 "png/$src-$m.png" -o "$OUT/$key-$m.webp"
  done
done

# Insights result panel, shown as an overlay on the borrower-profile slide (ins-crop-<mode>.jpg).
for m in light dark; do
  ffmpeg -loglevel error -y -i "png/07-insights-$m.png" -vf "crop=1440:860:1352:430,scale=1200:-1" -q:v 3 "$OUT/ins-crop-$m.jpg"
done
ls "$OUT" | wc -l
