import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, UserMinus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getAccessToken } from "@/lib/access-token";
import { useAuth, homeRouteForRole } from "@/lib/auth";
import {
  createSalesUser,
  listSalesTeam,
  setSalesUserActive,
  type SalesPerson,
} from "@/lib/sales.server";

export const Route = createFileRoute("/sales/team")({
  head: () => ({ meta: [{ title: "Sales Team · SamvadX" }] }),
  component: SalesTeamPage,
});

function SalesTeamPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [people, setPeople] = useState<SalesPerson[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!loading && user && user.role !== "superadmin") {
      navigate({ to: homeRouteForRole(user.role) });
    }
  }, [user, loading, navigate]);

  const reload = useCallback(async () => {
    try {
      const token = await getAccessToken();
      const r = await listSalesTeam({ data: { accessToken: token } });
      setPeople(r.people);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggle(id: string, active: boolean) {
    try {
      const token = await getAccessToken();
      await setSalesUserActive({ data: { accessToken: token, id, active } });
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading || !user || user.role !== "superadmin") {
    return null;
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sales Team</h1>
          <p className="text-xs text-muted-foreground">
            SamvadX's own sales team. These accounts are separate from any company user.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add salesperson
        </Button>
      </header>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">People</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Phone</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loadingList ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
                  </td>
                </tr>
              ) : people.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    Nobody added yet. Click "Add salesperson" to create the first login.
                  </td>
                </tr>
              ) : (
                people.map((p) => (
                  <tr key={p.id} className="hover:bg-accent/30">
                    <td className="px-3 py-2 font-medium text-foreground">{p.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">{p.email}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{p.phone ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Badge variant="outline" className={p.is_active ? "border-success/40 text-success" : "border-muted-foreground/30 text-muted-foreground"}>
                        {p.is_active ? "Active" : "Deactivated"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {p.is_active ? (
                        <Button size="sm" variant="outline" className="gap-1" onClick={() => toggle(p.id, false)}>
                          <UserMinus className="h-3.5 w-3.5" /> Deactivate
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="gap-1" onClick={() => toggle(p.id, true)}>
                          <UserPlus className="h-3.5 w-3.5" /> Reactivate
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <AddSalespersonDialog open={adding} onClose={() => setAdding(false)} onCreated={reload} />
    </div>
  );
}

function AddSalespersonDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!form.name.trim() || !form.email.trim() || form.password.length < 8) {
      toast.error("Name, email and a password of 8+ characters are required.");
      return;
    }
    setBusy(true);
    try {
      const token = await getAccessToken();
      const r = await createSalesUser({
        data: {
          accessToken: token,
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || null,
          password: form.password,
        },
      });
      if (!r.ok) {
        toast.error(r.error);
      } else {
        toast.success("Salesperson added");
        setForm({ name: "", email: "", phone: "", password: "" });
        await onCreated();
        onClose();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add salesperson</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            A new login for the sales portal. The password is required; sign-in will also ask for an emailed code, like admins.
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Name</span>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="h-8 text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Email</span>
            <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="h-8 text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Phone</span>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="h-8 text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">Password</span>
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="h-8 text-xs" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
