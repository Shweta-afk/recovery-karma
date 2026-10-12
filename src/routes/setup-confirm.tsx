import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2, AlertCircle, Eye, EyeOff, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/lib/supabase";

const PENDING_SETUP_KEY_PREFIX = "samvadx-pending-setup:";

// Landing page for the "click the link" alternative to setup.tsx's OTP code. Supabase's
// confirmation email link redirects here with the session in the URL hash (emailRedirectTo,
// set in setup.tsx's sendOtp) — supabase-js parses that automatically on load, so by the time
// getSession() below resolves, the browser is already signed in as the just-confirmed user.
// This page is a fresh tab with none of setup.tsx's React state, so it re-collects company
// name / admin name (prefilled from the localStorage cache setup.tsx wrote before sending the
// email, if the link is opened in the same browser) and the password (never cached), then
// calls the exact same createCompany action the OTP path calls.
export const Route = createFileRoute("/setup-confirm")({
  head: () => ({
    meta: [{ title: "Confirm your email · SamvadX" }],
  }),
  component: SetupConfirmPage,
});

function SetupConfirmPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [gstin, setGstin] = useState("");
  const [gstUnregistered, setGstUnregistered] = useState(false);
  const [adminName, setAdminName] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const confirmedEmail = session?.user?.email;
      if (!session || !confirmedEmail || !session.user.email_confirmed_at) {
        setStatus("invalid");
        return;
      }
      setEmail(confirmedEmail);
      setAccessToken(session.access_token);

      try {
        const key = `${PENDING_SETUP_KEY_PREFIX}${confirmedEmail}`;
        const cached = localStorage.getItem(key);
        if (cached) {
          const parsed = JSON.parse(cached) as {
            companyName?: string;
            gstin?: string;
            gstUnregistered?: boolean;
            adminName?: string;
          };
          setCompanyName(parsed.companyName ?? "");
          setGstin(parsed.gstin ?? "");
          setGstUnregistered(!!parsed.gstUnregistered);
          setAdminName(parsed.adminName ?? "");
          localStorage.removeItem(key);
        }
      } catch {
        // Missing/corrupt cache (private browsing, a different browser, cleared storage) just
        // means blank fields the caller re-types — not fatal.
      }

      setStatus("ready");
    })();
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // Dynamically imported so server-only code never ships in the eager client bundle —
      // same convention setup.tsx follows for this same import.
      const { createCompany } = await import("@/lib/setup-actions.server");
      const result = await createCompany({
        data: {
          companyName,
          gstin,
          gstUnregistered,
          adminName,
          adminEmail: email,
          adminPassword,
          accessToken,
        },
      });
      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }
      // getSession() above already left this browser signed in — no separate sign-in needed.
      navigate({ to: "/admin" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 inline-flex w-fit rounded-md px-4 py-2 dark:bg-white">
          <img src="/logo.png" alt="SamvadX" className="h-10 w-auto object-contain" />
        </div>

        <Card className="border-border shadow-sm">
          {status === "checking" ? (
            <CardContent className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Confirming your email…
            </CardContent>
          ) : status === "invalid" ? (
            <>
              <CardHeader className="space-y-1">
                <h2 className="text-xl font-semibold text-foreground">Link expired or invalid</h2>
                <p className="text-sm text-muted-foreground">
                  This confirmation link didn't work — it may have already been used or expired.
                </p>
              </CardHeader>
              <CardContent>
                <Button className="w-full" onClick={() => navigate({ to: "/setup" })}>
                  Start over
                </Button>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="space-y-1">
                <div className="flex items-center gap-2 text-foreground">
                  <CheckCircle2 className="h-5 w-5 text-primary" />
                  <h2 className="text-xl font-semibold">Email confirmed</h2>
                </div>
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium">{email}</span> is verified. Finish setting up your
                  company.
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="companyName">Company name</Label>
                    <Input
                      id="companyName"
                      placeholder="Acme Recoveries Pvt Ltd"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="gstin">Company GSTIN</Label>
                    <Input
                      id="gstin"
                      placeholder="27AAPFU0939F1ZV"
                      value={gstin}
                      onChange={(e) => setGstin(e.target.value.toUpperCase())}
                      maxLength={15}
                      required={!gstUnregistered}
                      disabled={gstUnregistered}
                      className="font-mono uppercase"
                    />
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={gstUnregistered}
                        onChange={(e) => {
                          setGstUnregistered(e.target.checked);
                          if (e.target.checked) setGstin("");
                        }}
                      />
                      Our company is not registered for GST
                    </label>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="adminName">Your name</Label>
                    <Input
                      id="adminName"
                      placeholder="Priya Singh"
                      value={adminName}
                      onChange={(e) => setAdminName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="adminPassword">Password</Label>
                    <div className="relative">
                      <Input
                        id="adminPassword"
                        type={showPassword ? "text" : "password"}
                        placeholder="At least 8 characters"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        required
                        minLength={8}
                        autoComplete="new-password"
                        className="pr-9"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showPassword ? "Hide password" : "Show password"}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <Alert variant="destructive" className="py-2">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="text-sm">{error}</AlertDescription>
                    </Alert>
                  )}

                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create company"}
                  </Button>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
