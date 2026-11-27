import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";

// Bootstrap tool for creating the first salesperson — modeled on /superadmin-setup. Once at
// least one sales_users row exists, this page refuses and a superadmin must create the next
// one from /sales/team. Keep this route unlinked from anything customer-facing.
export const Route = createFileRoute("/sales-setup")({
  head: () => ({ meta: [{ title: "Set up sales · SamvadX" }] }),
  component: SalesSetupPage,
});

function SalesSetupPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapSecret, setBootstrapSecret] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // Dynamic import keeps server-only code out of the eager client bundle.
      const { createSalesUser } = await import("@/lib/sales.server");
      // A superadmin already signed in here can create another salesperson once the table has
      // one — same pattern as /superadmin-setup.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const result = await createSalesUser({
        data: {
          name,
          email,
          phone: phone || null,
          password,
          accessToken: session?.access_token,
          bootstrapSecret,
        },
      });
      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }
      const { error: loginErr } = await supabase.auth.signInWithPassword({ email, password });
      if (loginErr) {
        setError(
          `Salesperson created, but sign-in failed: ${loginErr.message}. You can sign in from /login.`,
        );
        setLoading(false);
        return;
      }
      navigate({ to: "/sales" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 inline-flex w-fit rounded-md px-4 py-2 dark:bg-white">
          <img src="/logo.png" alt="SamvadX" className="h-10 w-auto object-contain" />
        </div>
        <Card>
          <CardHeader className="space-y-1">
            <h2 className="text-xl font-semibold">Set up sales</h2>
            <p className="text-sm text-muted-foreground">
              Creates the first login for SamvadX's sales portal.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Your name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Priya Singh" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="priya@samvadx.com" autoComplete="email" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="bootstrap-secret">Setup key</Label>
                <Input
                  id="bootstrap-secret"
                  type="password"
                  value={bootstrapSecret}
                  onChange={(e) => setBootstrapSecret(e.target.value)}
                  placeholder="Only needed for the very first salesperson"
                  autoComplete="off"
                />
              </div>
              {error && (
                <Alert variant="destructive" className="py-2">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-sm">{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create salesperson"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
