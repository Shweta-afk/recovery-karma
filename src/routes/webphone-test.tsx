// Isolated test route for the WebRTC (SIP.js) webphone: /webphone-test
//
// A standalone harness to validate SkyCRM's browser calling once the vendor enables WebRTC and
// sends the WSS endpoint — deliberately NOT wired into the agent dialer yet. Open it, click
// "Connect & Register", and confirm the extension registers from the browser (no softphone).
// Until VITE_SKYCRM_WSS_URL is set it shows a "not configured" card, so the route is safe now.

import { createFileRoute } from "@tanstack/react-router";
import { WebphonePanel } from "@/components/telephony/webphone-panel";

function WebphoneTestPage() {
  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-2xl font-bold">WebRTC Webphone — Test Harness</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Browser-based SIP calling via SIP.js (SkyCRM Phase 2 — no desktop softphone). Standalone
          page for validating registration and calls before wiring into the agent dialer.
        </p>
        <WebphonePanel />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/webphone-test")({
  component: WebphoneTestPage,
});
