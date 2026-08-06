import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  UserPlus,
  Search,
  MoreHorizontal,
  ShieldCheck,
  Crown,
  User,
  Loader2,
  AlertCircle,
  RefreshCw,
  Mail,
  Trash2,
  ChevronDown,
  Check,
  X,
  Copy,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { refreshRoster } from "@/lib/team-store";
import type { Role } from "@/lib/auth";

export const Route = createFileRoute("/admin/users")({
  head: () => ({ meta: [{ title: "User Management · SamvadX Admin" }] }),
  component: AdminUsersPage,
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentRow {
  id: string; // agents.id (PK)
  auth_user_id: string | null; // links to auth.users — null until an admin links a real login
  name: string;
  email: string;
  role: Role;
  agent_phone: string | null; // Phone/extension registered with the telephony provider
  provider_agent_id: string | null; // Provider's internal agent ID
  created_at: string;
}

const ROLE_META: Record<Role, { label: string; icon: typeof User; cls: string }> = {
  agent: { label: "Agent", icon: User, cls: "bg-muted text-muted-foreground border-border" },
  manager: {
    label: "Manager",
    icon: Crown,
    cls: "bg-amber-500/10 text-amber-600 border-amber-400/20",
  },
  admin: { label: "Admin", icon: ShieldCheck, cls: "bg-primary/10 text-primary border-primary/20" },
};

// ─── Page ─────────────────────────────────────────────────────────────────────

function AdminUsersPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [showInvite, setShowInvite] = useState(false);
  const [editAgent, setEditAgent] = useState<AgentRow | null>(null);
  const [resetAgent, setResetAgent] = useState<AgentRow | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("agents")
      .select("id, auth_user_id, name, email, role, agent_phone, provider_agent_id, created_at")
      .order("created_at", { ascending: false });

    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    setAgents((data as AgentRow[]) ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = agents.filter((a) => {
    if (roleFilter !== "all" && a.role !== roleFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q);
    }
    return true;
  });

  const roleCount = (r: Role) => agents.filter((a) => a.role === r).length;

  const handleRoleChange = async (agent: AgentRow, newRole: Role) => {
    const { error: err } = await supabase
      .from("agents")
      .update({ role: newRole })
      .eq("id", agent.id);

    if (err) {
      toast.error("Failed to update role: " + err.message);
      return;
    }
    setAgents((prev) => prev.map((a) => (a.id === agent.id ? { ...a, role: newRole } : a)));
    toast.success(`${agent.name} is now ${newRole}`);
    refreshRoster();
  };

  const handleDelete = async (agent: AgentRow) => {
    if (!confirm(`Remove ${agent.name} from the system?`)) return;
    const { error: err } = await supabase.from("agents").delete().eq("id", agent.id);

    if (err) {
      toast.error("Failed to remove: " + err.message);
      return;
    }
    setAgents((prev) => prev.filter((a) => a.id !== agent.id));
    toast.success(`${agent.name} removed`);
    refreshRoster();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between animate-in fade-in slide-in-from-top-4 duration-500">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">User Management</h1>
          <p className="text-sm text-muted-foreground">
            Manage all agents, managers and admins. Role changes take effect on next login.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button className="gap-1.5" onClick={() => setShowInvite(true)}>
            <UserPlus className="h-4 w-4" />
            Invite User
          </Button>
        </div>
      </div>

      {/* Role summary */}
      <div className="grid grid-cols-3 gap-4">
        {(["agent", "manager", "admin"] as Role[]).map((r) => {
          const meta = ROLE_META[r];
          return (
            <Card
              key={r}
              className={cn(
                "cursor-pointer transition-all border-2",
                roleFilter === r ? "border-primary" : "border-transparent hover:border-border",
              )}
              onClick={() => setRoleFilter((prev) => (prev === r ? "all" : r))}
            >
              <CardContent className="flex items-center gap-3 pt-4 pb-4">
                <div
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg border",
                    meta.cls,
                  )}
                >
                  <meta.icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-2xl font-bold text-foreground">{roleCount(r)}</div>
                  <div className="text-xs text-muted-foreground capitalize">{meta.label}s</div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
        {roleFilter !== "all" && (
          <Badge
            variant="secondary"
            className="gap-1 cursor-pointer"
            onClick={() => setRoleFilter("all")}
          >
            {roleFilter} <X className="h-3 w-3" />
          </Badge>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          {filtered.length} user{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={load} className="ml-auto h-6 text-xs">
            Retry
          </Button>
        </div>
      )}

      {/* Users table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading users…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center">
              <User className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
              <p className="text-sm font-medium text-foreground">No users found</p>
              <p className="text-xs text-muted-foreground mt-1">
                {search || roleFilter !== "all"
                  ? "Try adjusting your filters."
                  : "Invite your first user to get started."}
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/20">
                    <th className="py-3 pl-4 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      User
                    </th>
                    <th className="py-3 px-3 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground w-32">
                      Role
                    </th>
                    <th className="py-3 px-3 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground hidden sm:table-cell">
                      Joined
                    </th>
                    <th className="py-3 pr-4 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((agent) => (
                    <UserRow
                      key={agent.id}
                      agent={agent}
                      onRoleChange={handleRoleChange}
                      onEdit={() => setEditAgent(agent)}
                      onResetPassword={() => setResetAgent(agent)}
                      onDelete={handleDelete}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <InviteDialog
        open={showInvite}
        onClose={() => setShowInvite(false)}
        onInvited={load}
        managers={agents.filter((a) => a.role === "manager")}
      />
      {editAgent && (
        <EditUserDialog agent={editAgent} onClose={() => setEditAgent(null)} onSaved={load} />
      )}
      {resetAgent && (
        <ResetPasswordDialog agent={resetAgent} onClose={() => setResetAgent(null)} />
      )}
    </div>
  );
}

// ─── User row ─────────────────────────────────────────────────────────────────

function UserRow({
  agent,
  onRoleChange,
  onEdit,
  onResetPassword,
  onDelete,
}: {
  agent: AgentRow;
  onRoleChange: (a: AgentRow, r: Role) => void;
  onEdit: () => void;
  onResetPassword: () => void;
  onDelete: (a: AgentRow) => void;
}) {
  const meta = ROLE_META[agent.role];
  const initials = agent.name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const joined = new Date(agent.created_at).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return (
    <tr className="hover:bg-muted/20 transition-colors">
      {/* Name + email */}
      <td className="py-3 pl-4">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold text-muted-foreground shrink-0">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground truncate">{agent.name}</span>
              {!agent.auth_user_id && (
                <Badge
                  variant="outline"
                  className="text-[9px] px-1.5 py-0 h-4 border-amber-400/40 text-amber-600"
                >
                  Pending login
                </Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">{agent.email}</div>
          </div>
        </div>
      </td>

      {/* Role selector */}
      <td className="py-3 px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-all hover:opacity-80",
                meta.cls,
              )}
            >
              <meta.icon className="h-2.5 w-2.5" />
              {meta.label}
              <ChevronDown className="h-2.5 w-2.5 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36">
            {(["agent", "manager", "admin"] as Role[]).map((r) => {
              const rm = ROLE_META[r];
              return (
                <DropdownMenuItem
                  key={r}
                  onClick={() => onRoleChange(agent, r)}
                  className={cn("text-xs gap-2", agent.role === r && "font-medium")}
                >
                  <rm.icon className="h-3 w-3" />
                  <span>{rm.label}</span>
                  {agent.role === r && <Check className="h-3 w-3 ml-auto" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>

      {/* Joined date */}
      <td className="py-3 px-3 text-xs text-muted-foreground hidden sm:table-cell">{joined}</td>

      {/* Actions */}
      <td className="py-3 pr-4">
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={onEdit} className="text-xs gap-2">
                <User className="h-3.5 w-3.5" />
                Edit Details
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  navigator.clipboard?.writeText(agent.email);
                  toast.success("Email copied");
                }}
                className="text-xs gap-2"
              >
                <Mail className="h-3.5 w-3.5" />
                Copy Email
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onResetPassword} className="text-xs gap-2">
                <KeyRound className="h-3.5 w-3.5" />
                {agent.auth_user_id ? "Reset Password" : "Create Login"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(agent)}
                className="text-xs gap-2 text-destructive focus:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove User
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
}

// ─── Invite dialog ─────────────────────────────────────────────────────────────

function InviteDialog({
  open,
  onClose,
  onInvited,
  managers,
}: {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
  managers: AgentRow[];
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [managerId, setManagerId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // Set once the invite succeeds — switches the dialog into the one-time credential view.
  // There's no email infra to deliver a password any other way, so this is the only handoff.
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(
    null,
  );

  const reset = () => {
    setName("");
    setEmail("");
    setRole("agent");
    setManagerId("");
    setCreated(null);
  };

  const handleInvite = async () => {
    if (!name || !email) {
      toast.error("Fill all fields");
      return;
    }
    setSaving(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      toast.error("Your session has expired — please sign in again.");
      setSaving(false);
      return;
    }

    // Dynamically imported so server-only code never ships in the eager client bundle —
    // same convention as src/lib/dialer/use-dialer-run.ts's server-mode dial calls.
    const { inviteUser } = await import("@/lib/user-admin-actions.server");
    const result = await inviteUser({
      data: {
        accessToken: session.access_token,
        name,
        email,
        role,
        managerId: role === "agent" && managerId ? managerId : undefined,
      },
    });

    setSaving(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    refreshRoster();
    onInvited();
    setCreated({ name: result.name, email: result.email, password: result.temporaryPassword });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          reset();
        }
      }}
    >
      <DialogContent className="max-w-sm">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-primary" />
                {created.name} is ready to sign in
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <p className="text-xs text-muted-foreground">
                This password is shown once — share it with {created.name} securely. They can sign
                in immediately at <span className="font-medium text-foreground">{created.email}</span>.
              </p>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <code className="flex-1 text-sm font-mono">{created.password}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    navigator.clipboard?.writeText(created.password);
                    toast.success("Password copied");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button
                size="sm"
                onClick={() => {
                  onClose();
                  reset();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite New User</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Full Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  placeholder="Priya Singh"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">
                  Work Email <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="email"
                  placeholder="priya@yourcompany.in"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Role</Label>
                <Select
                  value={role}
                  onValueChange={(v) => {
                    setRole(v as Role);
                    if (v !== "agent") setManagerId("");
                  }}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">Agent</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {role === "agent" && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Reports to (optional)</Label>
                  <Select value={managerId || "none"} onValueChange={(v) => setManagerId(v === "none" ? "" : v)}>
                    <SelectTrigger className="h-9 text-sm">
                      <SelectValue placeholder="No manager" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No manager</SelectItem>
                      {managers.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Puts this agent on the manager's team, so the manager sees them right away.
                  </p>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground pt-1">
                Creates a real login immediately — the password is shown once on the next screen.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleInvite}
                disabled={saving || !name || !email}
                className="gap-1.5"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <UserPlus className="h-3.5 w-3.5" />
                )}
                Invite
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit user dialog ──────────────────────────────────────────────────────────

function EditUserDialog({
  agent,
  onClose,
  onSaved,
}: {
  agent: AgentRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState<Role>(agent.role);
  const [agentPhone, setAgentPhone] = useState(agent.agent_phone ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("agents")
      .update({
        name,
        role,
        agent_phone: agentPhone.trim() || null,
      })
      .eq("id", agent.id);

    if (error) {
      // 23505 = unique_violation — agents_client_phone_unique (see the 20260805 migration).
      toast.error(
        error.code === "23505"
          ? "That phone number is already assigned to another agent — each agent needs their own."
          : error.message,
      );
      setSaving(false);
      return;
    }
    toast.success("User updated");
    refreshRoster();
    onSaved();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label className="text-xs">Full Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Email</Label>
            <Input value={agent.email} disabled className="opacity-60" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              Agent Number (Exotel)
              {role === "agent" && <span className="text-destructive"> *</span>}
            </Label>
            <Input
              placeholder="e.g., +919876543210 or extension"
              value={agentPhone}
              onChange={(e) => setAgentPhone(e.target.value)}
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Whatever click-to-call rings for this agent — their personal number, or their
              Exotel extension if they're set up as a user on the account (no personal phone
              rings; calls come into the extension instead). Must match exactly what's
              configured for them in the Exotel dashboard → Users, and must be unique — no two
              agents can share one.
            </p>
            {role === "agent" && !agentPhone.trim() && (
              <p className="text-[11px] text-destructive">
                Without this, manual dial falls back to a placeholder that rings no one.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !name}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Reset password dialog ──────────────────────────────────────────────────────

function ResetPasswordDialog({ agent, onClose }: { agent: AgentRow; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const hasLogin = !!agent.auth_user_id;

  const handleReset = async () => {
    setSaving(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      toast.error("Your session has expired — please sign in again.");
      setSaving(false);
      return;
    }

    const { resetUserPassword } = await import("@/lib/user-admin-actions.server");
    const result = await resetUserPassword({
      data: { accessToken: session.access_token, agentId: agent.id },
    });

    setSaving(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setPassword(result.temporaryPassword);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        {password ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-primary" />
                New password for {agent.name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-1">
              <p className="text-xs text-muted-foreground">
                Their old password no longer works. This is shown once — share it with{" "}
                {agent.name} securely.
              </p>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <code className="flex-1 text-sm font-mono">{password}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={() => {
                    navigator.clipboard?.writeText(password);
                    toast.success("Password copied");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{hasLogin ? "Reset password?" : "Create a login?"}</DialogTitle>
            </DialogHeader>
            <p className="py-1 text-xs text-muted-foreground">
              {hasLogin
                ? `This immediately invalidates ${agent.name}'s current password and issues a new one-time password.`
                : `${agent.name} doesn't have a login yet — this creates one and issues a one-time password for ${agent.email}.`}
            </p>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleReset} disabled={saving} className="gap-1.5">
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <KeyRound className="h-3.5 w-3.5" />
                )}
                {hasLogin ? "Reset Password" : "Create Login"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
