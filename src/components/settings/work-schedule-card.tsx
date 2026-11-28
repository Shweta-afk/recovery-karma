import { useState } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getAccessToken } from "@/lib/access-token";
import { errorText } from "@/lib/app-error";
import { getFixedBreak, getWorkShift, setFixedBreak, setWorkShift } from "@/lib/agent-time-stats";
import { validateWorkSchedule } from "@/lib/work-schedule";
import { saveWorkSchedule } from "@/lib/work-schedule.server";

/** Admin → Settings: the company's shift and fixed break. Every agent's signed-in, idle, break
 *  and call time is counted inside the shift, with the fixed break left out. */
export function WorkScheduleCard() {
  const s0 = getWorkShift();
  const b0 = getFixedBreak();
  const [shiftStart, setShiftStart] = useState(s0.start);
  const [shiftEnd, setShiftEnd] = useState(s0.end);
  const [hasBreak, setHasBreak] = useState(!!b0);
  const [breakStart, setBreakStart] = useState(b0?.start ?? "13:00");
  const [breakEnd, setBreakEnd] = useState(b0?.end ?? "14:00");
  const [busy, setBusy] = useState(false);

  const input = {
    shiftStart,
    shiftEnd,
    breakStart: hasBreak ? breakStart : null,
    breakEnd: hasBreak ? breakEnd : null,
  };
  const problem = validateWorkSchedule(input);

  async function save() {
    setBusy(true);
    try {
      await saveWorkSchedule({ data: { accessToken: await getAccessToken(), ...input } });
      setWorkShift({ start: shiftStart, end: shiftEnd });
      setFixedBreak(hasBreak ? { start: breakStart, end: breakEnd } : null);
      toast.success("Shift saved. Agents' screens pick it up within a couple of minutes.");
    } catch (e) {
      toast.error(errorText(e, "Could not save the shift"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-border pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          Shift &amp; break
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">
            Shift starts
            <Input
              type="time"
              value={shiftStart}
              onChange={(e) => setShiftStart(e.target.value)}
              className="w-32"
            />
          </label>
          <label className="text-xs">
            Shift ends
            <Input
              type="time"
              value={shiftEnd}
              onChange={(e) => setShiftEnd(e.target.value)}
              className="w-32"
            />
          </label>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch checked={hasBreak} onCheckedChange={setHasBreak} />
          Fixed break for everyone (e.g. lunch)
        </div>
        {hasBreak && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs">
              Break starts
              <Input
                type="time"
                value={breakStart}
                onChange={(e) => setBreakStart(e.target.value)}
                className="w-32"
              />
            </label>
            <label className="text-xs">
              Break ends
              <Input
                type="time"
                value={breakEnd}
                onChange={(e) => setBreakEnd(e.target.value)}
                className="w-32"
              />
            </label>
          </div>
        )}
        {problem && <p className="text-xs text-destructive">{problem}</p>}
        <p className="text-xs text-muted-foreground">
          All times IST. Signed-in, idle, break and call time for every agent is counted only inside
          the shift; the fixed break is left out and shown on its own. Applies to every report and
          screen, including past days. Calling hours are separate (below).
        </p>
        <Button size="sm" onClick={save} disabled={busy || !!problem}>
          {busy ? "Saving…" : "Save shift"}
        </Button>
      </CardContent>
    </Card>
  );
}
