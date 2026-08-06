import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in · SamvadX" },
      {
        name: "description",
        content:
          "Sign in to SamvadX, the collections operations platform for Indian loan recovery teams.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setError(null);

    const { error: loginError, user: loggedInUser } = await login(email, password);

    if (loginError) {
      setError(loginError);
      setLoading(false);
      return;
    }

    // Redirect based on role
    setTimeout(() => {
      const role = loggedInUser?.role ?? user?.role;
      if (role === "admin") navigate({ to: "/admin" });
      else if (role === "manager") navigate({ to: "/manager" });
      else navigate({ to: "/dashboard" });
    }, 150);
  };

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Left brand panel */}
      <div className="relative hidden w-1/2 flex-col justify-between bg-[var(--brand-navy)] p-12 text-white lg:flex">
        <div className="inline-flex w-fit rounded-md bg-white px-4 py-2">
          <img src="/logo.png" alt="SamvadX" className="h-10 w-auto object-contain" />
        </div>

        <div className="space-y-5">
          <h1 className="text-3xl font-semibold leading-tight">India's modern platform for NBFCs &amp; ARCs.</h1>
          <p className="max-w-md text-sm text-white/70">
            Run compliant outbound calling, SMS &amp; UPI collection workflows from one operator
            console. Built for RBI fair-practice guidelines.
          </p>
          <ul className="space-y-2 text-sm text-white/80">
            <li>• AI-assisted call queue prioritisation</li>
            <li>• Bharat-ready: 12 Indian languages, UPI &amp; eNACH</li>
            <li>• Audit logs &amp; recordings for every conversation</li>
          </ul>
        </div>

        <div className="space-y-0.5">
          <p className="text-xs text-white/40">© 2026 SamvadX Technologies Pvt. Ltd.</p>
          <p className="text-xs italic text-white/40">Powered by Axiotta Technologies Private Limited</p>
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex w-full items-center justify-center px-4 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 inline-flex w-fit rounded-md px-4 py-2 dark:bg-white lg:hidden">
            <img src="/logo.png" alt="SamvadX" className="h-10 w-auto object-contain" />
          </div>

          <Card className="border-border shadow-sm">
            <CardHeader className="space-y-1">
              <h2 className="text-xl font-semibold text-foreground">Sign in to your workspace</h2>
              <p className="text-sm text-muted-foreground">Enter your work email to continue.</p>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Work email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="agent@yourcompany.in"
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
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
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
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Protected by enterprise SSO. RBI compliant.
          </p>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            <a href="/setup" className="text-primary hover:underline">
              Set up a new company
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
