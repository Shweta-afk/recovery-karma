// Shared by Superadmin → Health Check and the Overview banner (2026-11-20).
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@/lib/access-token";
import { getHealthReport, type HealthReport } from "@/lib/health-checks.server";
import type { Severity } from "@/lib/health-checks";

export function SeverityIcon({ s, className = "h-4 w-4" }: { s: Severity; className?: string }) {
  if (s === "bad") return <XCircle className={`${className} text-red-600`} />;
  if (s === "warn") return <AlertTriangle className={`${className} text-amber-500`} />;
  return <CheckCircle2 className={`${className} text-emerald-600`} />;
}

/** Load the health report for one IST day (today by default). Shared with the Overview banner. */
export function useHealthReport(day?: string) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await getHealthReport({ data: { accessToken: await getAccessToken(), day } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run the health check");
    } finally {
      setLoading(false);
    }
  }, [day]);
  useEffect(() => {
    void load();
  }, [load]);
  return { report, loading, error, reload: load };
}
