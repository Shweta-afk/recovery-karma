# Archived: Tata Tele SmartFlo integration docs (July 2026)

These 8 files document the Tata SmartFlo telephony integration — planning, environment setup,
staging, production deployment, on-call runbook, and QA checklist — built out over "Week 3" of
a 3-week roadmap in late July 2026.

**Tata SmartFlo was fully removed from the codebase on 2026-08-06.** The user's call: "nothing
we did was working and aligning with our goals." All Tata-specific code (`tata-provider.ts`,
`tata-dialer-actions.server.ts`, `tata-campaign-dialog.tsx`, the Tata CDR-polling fallback) was
deleted outright rather than rewritten against a new vendor.

**Exotel is the current production telephony provider.** None of the setup/deployment/runbook
steps in these files apply to it — see the top-level `CLAUDE.md` for current, accurate
telephony architecture, environment variables, and deployment info.

Kept here for historical reference only (e.g. if a future telephony vendor evaluation wants to
see what was tried and documented last time), not as active guidance.
