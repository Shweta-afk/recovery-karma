import { supabase } from './supabase';
import type { Debtor } from './mock-debtors';

export async function fetchDebtorsByAgent(agentId: string): Promise<Debtor[]> {
  // Get agent's assigned portfolios
  const { data: portfolios, error: portfolioError } = await supabase
    .from('agent_portfolios')
    .select('portfolio_id')
    .eq('agent_id', agentId);

  if (portfolioError || !portfolios || portfolios.length === 0) {
    console.warn('No portfolios assigned to agent:', agentId);
    return [];
  }

  const portfolioIds = portfolios.map(p => p.portfolio_id);

  // Fetch debtors from assigned portfolios
  const { data, error } = await supabase
    .from('debtors')
    .select(`
      id,
      name,
      phone_primary,
      loan_amount,
      dpd,
      ai_score,
      ai_score_reason,
      last_contacted_at,
      portfolios(name)
    `)
    .in('portfolio_id', portfolioIds)
    .eq('status', 'active')
    .order('ai_score', { ascending: false })
    .limit(200);

  if (error) {
    console.error('Error fetching debtors:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row: any) => ({
    id: row.id,
    name: row.name,
    phone: row.phone_primary,
    loanAmount: Number(row.loan_amount) || 0,
    dpd: row.dpd || 0,
    aiScore: row.ai_score || 0,
    scoreReason: row.ai_score_reason || '',
    lastContacted: row.last_contacted_at ? new Date(row.last_contacted_at).toISOString().split('T')[0] : null,
    portfolio: row.portfolios?.name || 'Unknown Portfolio',
    language: 'Hindi',
  })) as Debtor[];
}

export async function fetchDebtors(clientId?: string): Promise<Debtor[]> {
  // Fallback to fetching all active debtors (no agent filter)
  const { data, error } = await supabase
    .from('debtors')
    .select(`
      id,
      name,
      phone_primary,
      loan_amount,
      dpd,
      ai_score,
      ai_score_reason,
      last_contacted_at,
      portfolios(name)
    `)
    .eq('status', 'active')
    .order('ai_score', { ascending: false })
    .limit(100);

  if (error) {
    console.error('Error fetching debtors from Supabase:', error);
    return [];
  }

  if (!data) return [];

  return data.map((row: any) => ({
    id: row.id,
    name: row.name,
    phone: row.phone_primary,
    loanAmount: Number(row.loan_amount) || 0,
    dpd: row.dpd || 0,
    aiScore: row.ai_score || 0,
    scoreReason: row.ai_score_reason || '',
    lastContacted: row.last_contacted_at ? new Date(row.last_contacted_at).toISOString().split('T')[0] : null,
    portfolio: row.portfolios?.name || 'Unknown Portfolio',
    language: 'Hindi',
  })) as Debtor[];
}

export async function fetchDebtorHistory(debtorId: string) {
  // Fetch call logs
  const { data: callLogs } = await supabase
    .from('call_logs')
    .select(`
      id,
      created_at,
      call_type,
      outcome,
      duration_seconds,
      raw_notes,
      ai_notes,
      promise_amount,
      promise_date,
      agents(name)
    `)
    .eq('debtor_id', debtorId)
    .order('created_at', { ascending: false });

  // Fetch messages
  const { data: messages } = await supabase
    .from('messages')
    .select(`
      id,
      sent_at,
      channel,
      direction,
      content,
      status,
      template_name,
      agents(name)
    `)
    .eq('debtor_id', debtorId)
    .order('sent_at', { ascending: false });

  // Fetch payments
  const { data: payments } = await supabase
    .from('payments')
    .select(`
      id,
      created_at,
      amount,
      payment_method,
      status,
      payment_type,
      received_at
    `)
    .eq('debtor_id', debtorId)
    .order('created_at', { ascending: false });

  // Fetch disputes
  const { data: disputes } = await supabase
    .from('disputes')
    .select(`
      id,
      created_at,
      dispute_type,
      debtor_reason,
      agent_notes,
      status,
      agents(name)
    `)
    .eq('debtor_id', debtorId)
    .order('created_at', { ascending: false });

  return {
    callLogs: callLogs || [],
    messages: messages || [],
    payments: payments || [],
    disputes: disputes || [],
  };
}

export async function fetchDebtorDetails(debtorId: string) {
  const { data } = await supabase
    .from('debtors')
    .select(`
      *,
      portfolios(name, lender_name),
      agents(name, email)
    `)
    .eq('id', debtorId)
    .single();

  return data;
}

export async function logCallOutcome(
  debtorId: string,
  agentId: string,
  outcome: 'paid' | 'promised' | 'refused' | 'no_answer' | 'voicemail' | 'dispute' | 'callback' | 'wrong_number' | 'deceased' | 'escalated',
  notes: string,
  promiseAmount?: number,
  promiseDate?: string,
  durationSeconds?: number
) {
  const { data, error } = await supabase
    .from('call_logs')
    .insert([
      {
        debtor_id: debtorId,
        agent_id: agentId,
        call_type: 'human',
        outcome,
        raw_notes: notes,
        promise_amount: promiseAmount || null,
        promise_date: promiseDate || null,
        duration_seconds: durationSeconds || 0,
      },
    ])
    .select();

  if (error) {
    console.error('Error logging call:', error);
    return null;
  }

  return data?.[0];
}

export async function fetchDebtorStats(): Promise<{
  callsMade: number;
  target: number;
  outcomes: { paid: number; promised: number; refused: number; noAnswer: number };
}> {
  // For now, return mock stats. Can be extended to calculate from call_logs
  return {
    callsMade: 0,
    target: 80,
    outcomes: {
      paid: 0,
      promised: 0,
      refused: 0,
      noAnswer: 0,
    },
  };
}
