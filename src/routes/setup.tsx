import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2, AlertCircle, Eye, EyeOff, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { supabase } from "@/lib/supabase";
import { PLATFORM_SUBDOMAIN, addressFor, subdomainFromHostname } from "@/lib/company-address";

const RESEND_COOLDOWN_SECONDS = 45;
const PENDING_SETUP_KEY_PREFIX = "samvadx-pending-setup:";

// Internal bootstrap tool for spinning up a new customer's first admin account — not a
// hardened public signup page (no rate limiting, no CAPTCHA), but the admin email IS verified:
// before createCompany ever runs, the caller has to prove they own adminEmail by entering a
// one-time code Supabase emails to it (signInWithOtp + verifyOtp below) OR by clicking the
// confirmation link in the same email — see setup-confirm.tsx for the link path. That page
// runs in a fresh tab with no React state, so companyName/adminName are cached to localStorage
// (never the password) right before the email is sent, keyed by email, so the link path can
// prefill them. Keep this unlinked from anything customer-facing; it's reached only via the
// low-key link on the login page.
export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [{ title: "Set up a company · SamvadX" }],
  }),
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"details" | "otp">("details");
  const [companyName, setCompanyName] = useState("");
  const [gstin, setGstin] = useState("");
  const [gstUnregistered, setGstUnregistered] = useState(false);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);

  // New companies sign up on the platform address, never on an existing company's address:
  // their users will sign in there until a superadmin assigns their own (company-address.ts).
  useEffect(() => {
    const here = subdomainFromHostname(window.location.hostname);
    if (here && here !== PLATFORM_SUBDOMAIN) {
      window.location.replace(`https://${addressFor(PLATFORM_SUBDOMAIN)}/setup`);
    }
  }, []);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const sendOtp = async (email: string) => {
    // Cache the non-secret form fields so setup-confirm.tsx can prefill them if the caller
    // verifies by clicking the emailed link instead of typing the code — that page opens in a
    // browser tab with no React state of its own. Never cache the password.
    try {
      localStorage.setItem(
        `${PENDING_SETUP_KEY_PREFIX}${email}`,
        JSON.stringify({ companyName, gstin, gstUnregistered, adminName, savedAt: Date.now() }),
      );
    } catch {
      // localStorage can throw in private-browsing/blocked-storage contexts — the link path
      // just falls back to blank fields the caller re-types, so this is safe to ignore.
    }

    // shouldCreateUser: true both sends the code and (for a brand-new email) provisions the
    // unconfirmed auth user it belongs to — createCompany confirms it owns that account and
    // sets its real password only after the code below is verified. emailRedirectTo points the
    // email's link at the confirm page for callers who click it instead of typing the code.
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}/setup-confirm`,
      },
    });
    if (otpErr) throw otpErr;
  };

  const handleDetailsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await sendOtp(adminEmail.trim().toLowerCase());
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setStep("otp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the verification code.");
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0 || loading) return;
    setLoading(true);
    setError(null);
    try {
      await sendOtp(adminEmail.trim().toLowerCase());
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend the verification code.");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const email = adminEmail.trim().toLowerCase();
      const { data: verifyData, error: verifyErr } = await supabase.auth.verifyOtp({
        email,
        token: otp,
        type: "email",
      });
      if (verifyErr || !verifyData.session) {
        setError(verifyErr?.message ?? "That code didn't work — check it and try again.");
        setLoading(false);
        return;
      }

      // Dynamically imported so server-only code never ships in the eager client bundle —
      // same convention as src/lib/dialer/use-dialer-run.ts's server-mode dial calls.
      const { createCompany } = await import("@/lib/setup-actions.server");
      const result = await createCompany({
        data: {
          companyName,
          gstin,
          gstUnregistered,
          adminName,
          adminEmail: email,
          adminPassword,
          accessToken: verifyData.session.access_token,
        },
      });

      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }

      // verifyOtp already signed this browser in — no separate signInWithPassword needed.
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
          {step === "details" ? (
            <>
              <CardHeader className="space-y-1">
                <h2 className="text-xl font-semibold text-foreground">Set up a new company</h2>
                <p className="text-sm text-muted-foreground">
                  Creates the company and its first admin account.
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleDetailsSubmit} className="space-y-4">
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
                      pattern="[0-9]{2}[A-Za-z]{5}[0-9]{4}[A-Za-z][1-9A-Za-z][Zz][0-9A-Za-z]"
                      title="15 characters, e.g. 27AAPFU0939F1ZV"
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
                    <Label htmlFor="adminEmail">Your work email</Label>
                    <Input
                      id="adminEmail"
                      type="email"
                      placeholder="priya@yourcompany.in"
                      value={adminEmail}
                      onChange={(e) => setAdminEmail(e.target.value)}
                      required
                      autoComplete="email"
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
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Send verification code"
                    )}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader className="space-y-1">
                <div className="flex items-center gap-2 text-foreground">
                  <Mail className="h-5 w-5 text-primary" />
                  <h2 className="text-xl font-semibold">Verify your email</h2>
                </div>
                <p className="text-sm text-muted-foreground">
                  Enter the 8-digit code we sent to{" "}
                  <span className="font-medium">{adminEmail}</span>, or click the confirmation link
                  in that same email — either one works.
                </p>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleOtpSubmit} className="space-y-4">
                  <div className="flex justify-center">
                    {/* Supabase's signup-confirmation email_otp is 8 digits, not the 6 most
                        passwordless-login docs describe — confirmed against a real sent code. */}
                    <InputOTP maxLength={8} value={otp} onChange={setOtp} autoFocus>
                      <InputOTPGroup>
                        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                          <InputOTPSlot key={i} index={i} />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>

                  {error && (
                    <Alert variant="destructive" className="py-2">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription className="text-sm">{error}</AlertDescription>
                    </Alert>
                  )}

                  <Button type="submit" className="w-full" disabled={loading || otp.length !== 8}>
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Verify & create company"
                    )}
                  </Button>

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => {
                        setStep("details");
                        setOtp("");
                        setError(null);
                      }}
                      className="hover:text-foreground hover:underline"
                    >
                      Change email
                    </button>
                    <button
                      type="button"
                      onClick={handleResend}
                      disabled={resendCooldown > 0 || loading}
                      className="hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
                    >
                      {resendCooldown > 0 ? `Resend code (${resendCooldown}s)` : "Resend code"}
                    </button>
                  </div>
                </form>
              </CardContent>
            </>
          )}
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Already have a company?{" "}
          <a href="/login" className="text-primary hover:underline">
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}
