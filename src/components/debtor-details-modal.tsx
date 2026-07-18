import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Phone, MessageCircle, IndianRupee, AlertTriangle } from "lucide-react";
import { fetchDebtorHistory, fetchDebtorDetails, logCallOutcome } from "@/lib/fetch-debtors";
import { formatINR } from "@/lib/mock-debtors";
import type { Debtor } from "@/lib/mock-debtors";

interface DebtorDetailsModalProps {
  debtor: Debtor | null;
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCallLogged?: () => void;
}

export function DebtorDetailsModal({
  debtor,
  agentId,
  open,
  onOpenChange,
  onCallLogged,
}: DebtorDetailsModalProps) {
  const [history, setHistory] = useState<any>(null);
  const [details, setDetails] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [showCallDialog, setShowCallDialog] = useState(false);
  const [callOutcome, setCallOutcome] = useState<string>("");
  const [callNotes, setCallNotes] = useState("");
  const [promiseAmount, setPromiseAmount] = useState("");
  const [promiseDate, setPromiseDate] = useState("");
  const [logging, setLogging] = useState(false);

  useEffect(() => {
    if (debtor && open) {
      setLoading(true);
      Promise.all([
        fetchDebtorHistory(debtor.id),
        fetchDebtorDetails(debtor.id),
      ])
        .then(([hist, det]) => {
          setHistory(hist);
          setDetails(det);
        })
        .finally(() => setLoading(false));
    }
  }, [debtor, open]);

  const handleLogCall = async () => {
    if (!debtor || !callOutcome) return;

    setLogging(true);
    try {
      const result = await logCallOutcome(
        debtor.id,
        agentId,
        callOutcome as any,
        callNotes,
        callOutcome === "promised" ? Number(promiseAmount) : undefined,
        callOutcome === "promised" ? promiseDate : undefined
      );

      if (result) {
        // Refresh history
        const newHistory = await fetchDebtorHistory(debtor.id);
        setHistory(newHistory);

        // Reset form
        setCallOutcome("");
        setCallNotes("");
        setPromiseAmount("");
        setPromiseDate("");
        setShowCallDialog(false);

        onCallLogged?.();
      }
    } finally {
      setLogging(false);
    }
  };

  if (!debtor) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl">
              {debtor.name}
              <span className="ml-3 text-sm font-normal text-muted-foreground">
                {debtor.id}
              </span>
            </DialogTitle>
          </DialogHeader>

          {loading ? (
            <div className="py-8 text-center text-muted-foreground">
              Loading debtor history...
            </div>
          ) : (
            <div className="space-y-6">
              {/* Summary */}
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4 p-4 bg-muted rounded-lg">
                <div>
                  <div className="text-xs text-muted-foreground">Loan Amount</div>
                  <div className="font-semibold">{formatINR(debtor.loanAmount)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">DPD</div>
                  <div className="font-semibold text-orange-600">{debtor.dpd} days</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">AI Score</div>
                  <div className="font-semibold text-green-600">{debtor.aiScore}/10</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Portfolio</div>
                  <div className="font-semibold text-sm">{debtor.portfolio}</div>
                </div>
              </div>

              {/* Tabs */}
              <Tabs defaultValue="calls" className="w-full">
                <TabsList className="w-full">
                  <TabsTrigger value="calls">Calls</TabsTrigger>
                  <TabsTrigger value="messages">Messages</TabsTrigger>
                  <TabsTrigger value="payments">Payments</TabsTrigger>
                  <TabsTrigger value="disputes">Disputes</TabsTrigger>
                </TabsList>

                {/* Call History */}
                <TabsContent value="calls" className="space-y-4">
                  <Button
                    onClick={() => setShowCallDialog(true)}
                    className="w-full gap-2"
                  >
                    <Phone className="h-4 w-4" />
                    Log New Call
                  </Button>

                  {history?.callLogs && history.callLogs.length > 0 ? (
                    <div className="space-y-3">
                      {history.callLogs.map((call: any) => (
                        <div key={call.id} className="border rounded-lg p-3">
                          <div className="flex justify-between items-start mb-2">
                            <div className="font-medium text-sm">
                              {call.agents?.name} · {new Date(call.created_at).toLocaleDateString()}
                            </div>
                            <Badge variant="outline">{call.outcome}</Badge>
                          </div>
                          {call.raw_notes && (
                            <p className="text-sm text-foreground/80 mb-2">
                              {call.raw_notes}
                            </p>
                          )}
                          {call.promise_amount && (
                            <div className="text-xs text-muted-foreground">
                              Promised {formatINR(call.promise_amount)} by{" "}
                              {new Date(call.promise_date).toLocaleDateString()}
                            </div>
                          )}
                          {call.duration_seconds > 0 && (
                            <div className="text-xs text-muted-foreground">
                              Duration: {Math.floor(call.duration_seconds / 60)}m{" "}
                              {call.duration_seconds % 60}s
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center text-muted-foreground py-8">
                      No call history. Click "Log New Call" to record an interaction.
                    </div>
                  )}
                </TabsContent>

                {/* Messages */}
                <TabsContent value="messages" className="space-y-4">
                  {history?.messages && history.messages.length > 0 ? (
                    <div className="space-y-3">
                      {history.messages.map((msg: any) => (
                        <div
                          key={msg.id}
                          className={`border rounded-lg p-3 ${
                            msg.direction === "outbound" ? "bg-blue-50" : "bg-gray-50"
                          }`}
                        >
                          <div className="flex justify-between items-start mb-2">
                            <div className="flex items-center gap-2">
                              <MessageCircle className="h-4 w-4" />
                              <span className="font-medium text-sm">{msg.channel}</span>
                              <Badge variant="outline" className="text-xs">
                                {msg.direction === "outbound" ? "Sent" : "Received"}
                              </Badge>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {new Date(msg.sent_at).toLocaleDateString()}
                            </span>
                          </div>
                          <p className="text-sm">{msg.content}</p>
                          {msg.status && (
                            <div className="text-xs text-muted-foreground mt-2">
                              Status: {msg.status}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center text-muted-foreground py-8">
                      No messages sent yet.
                    </div>
                  )}
                </TabsContent>

                {/* Payments */}
                <TabsContent value="payments" className="space-y-4">
                  {history?.payments && history.payments.length > 0 ? (
                    <div className="space-y-3">
                      {history.payments.map((payment: any) => (
                        <div key={payment.id} className="border rounded-lg p-3">
                          <div className="flex justify-between items-start mb-2">
                            <div className="flex items-center gap-2">
                              <IndianRupee className="h-4 w-4" />
                              <span className="font-medium">
                                {formatINR(Number(payment.amount))}
                              </span>
                            </div>
                            <Badge
                              variant={
                                payment.status === "completed" ? "default" : "outline"
                              }
                            >
                              {payment.status}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground space-y-1">
                            <div>
                              {payment.payment_type} · {payment.payment_method}
                            </div>
                            <div>
                              {new Date(
                                payment.received_at || payment.created_at
                              ).toLocaleDateString()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center text-muted-foreground py-8">
                      No payments received yet.
                    </div>
                  )}
                </TabsContent>

                {/* Disputes */}
                <TabsContent value="disputes" className="space-y-4">
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
                    <div className="flex gap-2 text-sm text-yellow-800">
                      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      <div>
                        <div className="font-medium">Risk Flags</div>
                        <div className="text-xs mt-1">
                          {details?.risk_flags && details.risk_flags.length > 0
                            ? details.risk_flags.join(", ")
                            : "No risk flags"}
                        </div>
                      </div>
                    </div>
                  </div>

                  {history?.disputes && history.disputes.length > 0 ? (
                    <div className="space-y-3">
                      {history.disputes.map((dispute: any) => (
                        <div
                          key={dispute.id}
                          className="border border-red-200 rounded-lg p-3 bg-red-50"
                        >
                          <div className="flex justify-between items-start mb-2">
                            <Badge variant="destructive">{dispute.dispute_type}</Badge>
                            <Badge variant="outline">{dispute.status}</Badge>
                          </div>
                          {dispute.debtor_reason && (
                            <div className="text-sm mb-2">
                              <div className="text-xs text-muted-foreground">
                                Debtor says:
                              </div>
                              <p>{dispute.debtor_reason}</p>
                            </div>
                          )}
                          {dispute.agent_notes && (
                            <div className="text-sm">
                              <div className="text-xs text-muted-foreground">
                                Agent notes:
                              </div>
                              <p>{dispute.agent_notes}</p>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center text-muted-foreground py-8">
                      No disputes raised.
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Call Logging Dialog */}
      <AlertDialog open={showCallDialog} onOpenChange={setShowCallDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Log Call for {debtor?.name}</AlertDialogTitle>
            <AlertDialogDescription>
              Record the outcome and notes from this call interaction.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="outcome">Call Outcome *</Label>
              <Select value={callOutcome} onValueChange={setCallOutcome}>
                <SelectTrigger id="outcome">
                  <SelectValue placeholder="Select outcome..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="promised">Promise to Pay (PTP)</SelectItem>
                  <SelectItem value="paid">Full Payment Received</SelectItem>
                  <SelectItem value="refused">Refused to Pay</SelectItem>
                  <SelectItem value="no_answer">No Answer</SelectItem>
                  <SelectItem value="voicemail">Voicemail</SelectItem>
                  <SelectItem value="callback">Callback Requested</SelectItem>
                  <SelectItem value="dispute">Dispute Raised</SelectItem>
                  <SelectItem value="wrong_number">Wrong Number</SelectItem>
                  <SelectItem value="escalated">Escalated</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {callOutcome === "promised" && (
              <>
                <div>
                  <Label htmlFor="amount">Promised Amount</Label>
                  <Input
                    id="amount"
                    type="number"
                    placeholder="₹"
                    value={promiseAmount}
                    onChange={(e) => setPromiseAmount(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="date">Promise Date</Label>
                  <Input
                    id="date"
                    type="date"
                    value={promiseDate}
                    onChange={(e) => setPromiseDate(e.target.value)}
                  />
                </div>
              </>
            )}

            <div>
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                placeholder="What did the debtor say? Any important details?"
                value={callNotes}
                onChange={(e) => setCallNotes(e.target.value)}
                className="h-24"
              />
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLogCall}
              disabled={!callOutcome || logging}
            >
              {logging ? "Saving..." : "Save Call"}
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
