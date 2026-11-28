// Admin → Settings → Shift & break: writes clients.shift_* / fixed_break_* for the caller's
// company. Every agent's time figures are counted inside that shift, with the break cut out.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller } from "./supabase-admin.server";
import { validateWorkSchedule } from "./work-schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns newer than generated types
const db = () => getSupabaseAdmin() as any;
const hhmm = z.string().max(5);

export const saveWorkSchedule = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        shiftStart: hhmm,
        shiftEnd: hhmm,
        breakStart: hhmm.nullable(),
        breakEnd: hhmm.nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const c = await verifyCaller(data.accessToken);
    if (!c) throw new Error("Not authenticated");
    if (c.role !== "admin") throw new Error("Only admins can change the shift");
    const bad = validateWorkSchedule(data);
    if (bad) throw new Error(bad);
    const noBreak = !data.breakStart || !data.breakEnd;
    const { error } = await db()
      .from("clients")
      .update({
        shift_start: data.shiftStart,
        shift_end: data.shiftEnd,
        fixed_break_start: noBreak ? null : data.breakStart,
        fixed_break_end: noBreak ? null : data.breakEnd,
      })
      .eq("id", c.clientId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
