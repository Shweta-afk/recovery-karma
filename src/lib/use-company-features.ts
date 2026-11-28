import { useEffect, useState } from "react";
import { getAccessToken } from "./access-token";
import { getMyFeatures } from "./company-features.server";
import { NO_FEATURES, type CompanyFeatures } from "./company-features";

// One fetch per page load, shared by every component that asks.
let cached: CompanyFeatures | null = null;
let pending: Promise<CompanyFeatures> | null = null;

function load(): Promise<CompanyFeatures> {
  pending ??= (async () => {
    try {
      cached = await getMyFeatures({ data: { accessToken: await getAccessToken() } });
    } catch {
      cached = NO_FEATURES;
    }
    return cached;
  })();
  return pending;
}

/** This company's sellable features; everything off until loaded. */
export function useCompanyFeatures(): CompanyFeatures & { loaded: boolean } {
  const [f, setF] = useState<CompanyFeatures | null>(cached);
  useEffect(() => {
    if (cached) return;
    let live = true;
    void load().then((v) => live && setF(v));
    return () => {
      live = false;
    };
  }, []);
  return { ...(f ?? NO_FEATURES), loaded: f !== null };
}
