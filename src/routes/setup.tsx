import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/lib/supabase";

// Internal bootstrap tool for spinning up a new customer's first admin account — not a
// hardened public signup page (no email verification, no rate limiting, no CAPTCHA). Keep
// this unlinked from anything customer-facing; it's reached only via the low-key link on
// the login page.
export const Route = createFileRoute("/setup")({
  head: () => ({
    meta: [{ title: "Set up a company · SamvadX" }],
  }),
  component: SetupPage,
});

function SetupPage() {
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Dynamically imported so server-only code never ships in the eager client bundle —
      // same convention as src/lib/dialer/use-dialer-run.ts's server-mode dial calls.
      const { createCompany } = await import("@/lib/setup-actions.server");
      const result = await createCompany({
        data: { companyName, adminName, adminEmail, adminPassword },
      });

      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }

      // Sign straight in with the account just created rather than bouncing back to /login.
      const { error: loginError } = await supabase.auth.signInWithPassword({
        email: adminEmail,
        password: adminPassword,
      });
      if (loginError) {
        setError(`Company created, but sign-in failed: ${loginError.message}. Try signing in manually.`);
        setLoading(false);
        return;
      }

      navigate({ to: "/admin" });
    } catch (err) {
      // A thrown/rejected call (network blip talking to the server function or Supabase)
      // must still clear the spinner — otherwise the form hangs forever with no feedback.
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 inline-flex w-fit rounded-md bg-white px-3 py-1.5">
          <img src="/logo.png" alt="SamvadX" className="h-6 w-auto object-contain" />
        </div>

        <Card className="border-border shadow-sm">
          <CardHeader className="space-y-1">
            <h2 className="text-xl font-semibold text-foreground">Set up a new company</h2>
            <p className="text-sm text-muted-foreground">
              Creates the company and its first admin account.
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
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
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
