import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/lib/supabase";

// Bootstrap tool for creating a superadmin account. Unlike /setup (which stays open forever
// for any new company), createSuperadmin locks itself down once the first superadmin exists —
// a superadmin reaches every company on the platform, so this can't be a standing open door.
// Keep it unlinked from anything customer-facing regardless.
export const Route = createFileRoute("/superadmin-setup")({
  head: () => ({
    meta: [{ title: "Set up superadmin · SamvadX" }],
  }),
  component: SuperadminSetupPage,
});

function SuperadminSetupPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Dynamically imported so server-only code never ships in the eager client bundle — same
      // convention as setup.tsx's createCompany call.
      const { createSuperadmin } = await import("@/lib/superadmin-actions.server");

      // If a superadmin is already signed in on this browser, send their token along — that's
      // what lets an EXISTING superadmin create another one once the table isn't empty.
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const result = await createSuperadmin({
        data: { name, email, password, accessToken: session?.access_token },
      });

      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }

      const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });
      if (loginError) {
        setError(
          `Superadmin created, but sign-in failed: ${loginError.message}. Try signing in manually.`,
        );
        setLoading(false);
        return;
      }

      navigate({ to: "/superadmin" });
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
          <CardHeader className="space-y-1">
            <h2 className="text-xl font-semibold text-foreground">Set up a superadmin</h2>
            <p className="text-sm text-muted-foreground">
              Creates a platform-wide superadmin account, spanning every company.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Your name</Label>
                <Input
                  id="name"
                  placeholder="Priya Singh"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="priya@samvadx.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
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
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create superadmin"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
