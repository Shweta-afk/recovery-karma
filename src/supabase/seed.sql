-- ============================================================
-- RecoveryAI — seed data
-- Run AFTER schema.sql.
-- Replace the three placeholder UUIDs marked <<<REPLACE>>> with
-- real Supabase auth.users UUIDs once you've created those users
-- in Authentication → Users in the Supabase dashboard.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 0.  Disable RLS for seeding, re-enable at the end
-- ────────────────────────────────────────────────────────────
SET LOCAL row_security = off;

-- ────────────────────────────────────────────────────────────
-- 1.  CLIENT
-- ────────────────────────────────────────────────────────────
INSERT INTO clients (id, company_name, plan) VALUES
  ('a1000000-0000-0000-0000-000000000001',
   'Axiotta Risk Management Pvt Ltd',
   'growth');

-- ────────────────────────────────────────────────────────────
-- 2.  AGENTS
--     Replace the auth_user_id values with real UUIDs from
--     Supabase Auth → Users after creating those accounts.
-- ────────────────────────────────────────────────────────────
INSERT INTO agents (id, auth_user_id, client_id, name, email, role, daily_target) VALUES
  (
    'b1000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',   -- <<<REPLACE>>> rahul's auth.users UUID
    'a1000000-0000-0000-0000-000000000001',
    'Rahul Sharma',
    'rahul.sharma@axiotta.in',
    'manager',
    100
  ),
  (
    'b1000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000002',   -- <<<REPLACE>>> priya's auth.users UUID
    'a1000000-0000-0000-0000-000000000001',
    'Priya Patel',
    'priya.patel@axiotta.in',
    'agent',
    80
  ),
  (
    'b1000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000003',   -- <<<REPLACE>>> amit's auth.users UUID
    'a1000000-0000-0000-0000-000000000001',
    'Amit Verma',
    'amit.verma@axiotta.in',
    'agent',
    80
  );

-- ────────────────────────────────────────────────────────────
-- 3.  PORTFOLIOS
-- ────────────────────────────────────────────────────────────
INSERT INTO portfolios
  (id, client_id, name, lender_name, product_type, priority, total_accounts, scored_accounts, uploaded_by) VALUES
  (
    'c1000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'HDFC Personal Loans Q2',
    'HDFC Bank',
    'personal_loan',
    'high',
    10,
    10,
    'b1000000-0000-0000-0000-000000000001'
  ),
  (
    'c1000000-0000-0000-0000-000000000002',
    'a1000000-0000-0000-0000-000000000001',
    'Bajaj Auto Q1',
    'Bajaj Finance',
    'vehicle_loan',
    'medium',
    5,
    5,
    'b1000000-0000-0000-0000-000000000001'
  );

-- ────────────────────────────────────────────────────────────
-- 4.  DEBTORS  (15 records)
-- ────────────────────────────────────────────────────────────
INSERT INTO debtors (
  id, client_id, portfolio_id, assigned_agent_id,
  name, phone_primary, phone_alternate, email,
  loan_amount, outstanding_balance, emi_amount,
  dpd, lender, product_type, loan_reference,
  ai_score, ai_score_reason, risk_flags,
  recommended_channel, best_contact_time, suggested_tone,
  status, last_contacted_at, score_updated_at
) VALUES

-- 1 — Sanjay Kulkarni · DPD 8 · high score · HDFC
(
  'd1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'Sanjay Kulkarni', '+91 98201 44312', '+91 98201 44313',
  'sanjay.kulkarni@gmail.com',
  350000.00, 318500.00, 9800.00,
  8, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2024-00182',
  9,
  'Salary credited 3 days ago. High UPI activity. Picked up last 2 calls. Strong PTP intent.',
  ARRAY[]::TEXT[],
  'call', 'morning', 'firm',
  'active', NOW() - INTERVAL '1 day', NOW() - INTERVAL '6 hours'
),

-- 2 — Meena Subramaniam · DPD 23 · decent score · HDFC
(
  'd1000000-0000-0000-0000-000000000002',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'Meena Subramaniam', '+91 94442 88102', NULL,
  'meena.s@outlook.com',
  220000.00, 198000.00, 7200.00,
  23, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2024-00291',
  8,
  'Responded to WhatsApp. Promised payment in 3 days. First default — clean prior history.',
  ARRAY[]::TEXT[],
  'whatsapp', 'evening', 'empathetic',
  'active', NOW() - INTERVAL '2 days', NOW() - INTERVAL '5 hours'
),

-- 3 — Deepak Thakur · DPD 45 · mid score · HDFC
(
  'd1000000-0000-0000-0000-000000000003',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'Deepak Thakur', '+91 99871 55023', '+91 98765 55023',
  NULL,
  480000.00, 451200.00, 14500.00,
  45, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2023-01847',
  6,
  'Broke one PTP. Picks up calls occasionally. Mentioned job change as reason for delay.',
  ARRAY['broken_ptp']::TEXT[],
  'call', 'afternoon', 'empathetic',
  'active', NOW() - INTERVAL '4 days', NOW() - INTERVAL '5 hours'
),

-- 4 — Kavitha Nair · DPD 62 · low score · HDFC
(
  'd1000000-0000-0000-0000-000000000004',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000003',
  'Kavitha Nair', '+91 91762 30041', NULL,
  'kavitha.nair@yahoo.in',
  175000.00, 168700.00, 5800.00,
  62, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2023-02104',
  4,
  'Phone frequently switched off. Alternate number invalid. Dispute raised on interest amount.',
  ARRAY['dispute_raised','unreachable']::TEXT[],
  'sms', 'any', 'formal',
  'dispute', NOW() - INTERVAL '8 days', NOW() - INTERVAL '5 hours'
),

-- 5 — Arjun Singhania · DPD 90 · very low score · HDFC
(
  'd1000000-0000-0000-0000-000000000005',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000003',
  'Arjun Singhania', '+91 98000 12345', NULL,
  NULL,
  500000.00, 495000.00, 16200.00,
  90, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2023-00903',
  2,
  'Legal notice issued. No engagement for 45 days. Address verification failed.',
  ARRAY['legal_notice','broken_ptp','unreachable']::TEXT[],
  'bot', 'any', 'formal',
  'legal', NOW() - INTERVAL '20 days', NOW() - INTERVAL '5 hours'
),

-- 6 — Pooja Deshmukh · DPD 12 · high score · HDFC
(
  'd1000000-0000-0000-0000-000000000006',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'Pooja Deshmukh', '+91 99320 76180', '+91 99320 76181',
  'pooja.deshmukh@gmail.com',
  280000.00, 261400.00, 8900.00,
  12, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2024-00447',
  9,
  'Auto-debit failure due to bank maintenance. Manually confirmed will retry today. Low risk.',
  ARRAY[]::TEXT[],
  'whatsapp', 'morning', 'friendly',
  'active', NOW() - INTERVAL '1 day', NOW() - INTERVAL '4 hours'
),

-- 7 — Ravi Krishnamurthy · DPD 38 · mid score · HDFC
(
  'd1000000-0000-0000-0000-000000000007',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000003',
  'Ravi Krishnamurthy', '+91 97778 54321', NULL,
  'ravi.k@rediffmail.com',
  400000.00, 378000.00, 12100.00,
  38, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2023-01562',
  7,
  'Negotiating settlement. Requested manager callback. Partial payment likely.',
  ARRAY['settlement_requested']::TEXT[],
  'call', 'evening', 'empathetic',
  'active', NOW() - INTERVAL '3 days', NOW() - INTERVAL '4 hours'
),

-- 8 — Sunita Agarwal · paid · HDFC
(
  'd1000000-0000-0000-0000-000000000008',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'Sunita Agarwal', '+91 98765 43210', NULL,
  'sunita.agarwal@gmail.com',
  150000.00, 0.00, 5100.00,
  0, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2024-00113',
  10,
  'Full payment received via UPI. Account closed.',
  ARRAY[]::TEXT[],
  'whatsapp', 'any', 'friendly',
  'paid', NOW() - INTERVAL '1 day', NOW() - INTERVAL '4 hours'
),

-- 9 — Nikhil Bhatt · DPD 55 · mid score · HDFC
(
  'd1000000-0000-0000-0000-000000000009',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000003',
  'Nikhil Bhatt', '+91 91111 22334', '+91 91111 22335',
  NULL,
  320000.00, 307200.00, 10400.00,
  55, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2023-01783',
  5,
  'Responds to SMS but avoids calls. Salary delayed this month per his own statement.',
  ARRAY['low_contact_rate']::TEXT[],
  'sms', 'afternoon', 'empathetic',
  'active', NOW() - INTERVAL '5 days', NOW() - INTERVAL '3 hours'
),

-- 10 — Fatima Sheikh · DPD 5 · high score · HDFC
(
  'd1000000-0000-0000-0000-000000000010',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'Fatima Sheikh', '+91 98234 56780', NULL,
  'fatima.s@gmail.com',
  95000.00, 91200.00, 3800.00,
  5, 'HDFC Bank', 'personal_loan', 'HDFC-PL-2024-00598',
  9,
  'Strong UPI activity. First minor delay. Likely technical ECS failure only.',
  ARRAY[]::TEXT[],
  'whatsapp', 'morning', 'friendly',
  'active', NOW() - INTERVAL '12 hours', NOW() - INTERVAL '3 hours'
),

-- 11 — Suresh Yadav · DPD 18 · good score · Bajaj Auto
(
  'd1000000-0000-0000-0000-000000000011',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000002',
  'Suresh Yadav', '+91 95555 10203', NULL,
  NULL,
  85000.00, 72350.00, 3200.00,
  18, 'Bajaj Finance', 'vehicle_loan', 'BJFIN-VL-2024-00341',
  8,
  'Bike loan. Promised payment Friday. Regular salary earner. Good prior repayment history.',
  ARRAY[]::TEXT[],
  'call', 'evening', 'empathetic',
  'active', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 hours'
),

-- 12 — Lakshmi Pillai · DPD 74 · low score · Bajaj Auto
(
  'd1000000-0000-0000-0000-000000000012',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000003',
  'Lakshmi Pillai', '+91 94443 20910', '+91 94443 20911',
  'lakshmi.p@yahoo.com',
  120000.00, 116400.00, 4100.00,
  74, 'Bajaj Finance', 'vehicle_loan', 'BJFIN-VL-2023-01204',
  3,
  'Broken 2 PTPs. Vehicle possibly sold. Field visit recommended.',
  ARRAY['broken_ptp','field_visit_required']::TEXT[],
  'call', 'morning', 'formal',
  'active', NOW() - INTERVAL '10 days', NOW() - INTERVAL '2 hours'
),

-- 13 — Manish Tiwari · DPD 31 · mid score · Bajaj Auto
(
  'd1000000-0000-0000-0000-000000000013',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000002',
  'Manish Tiwari', '+91 99990 88776', NULL,
  NULL,
  68000.00, 61200.00, 2600.00,
  31, 'Bajaj Finance', 'vehicle_loan', 'BJFIN-VL-2023-01877',
  7,
  'Seasonal income drop (farmer). Spoke for 8 min last call. High intent but cash flow issue.',
  ARRAY['seasonal_income']::TEXT[],
  'call', 'morning', 'empathetic',
  'active', NOW() - INTERVAL '4 days', NOW() - INTERVAL '2 hours'
),

-- 14 — Anita Menon · settled · Bajaj Auto
(
  'd1000000-0000-0000-0000-000000000014',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000003',
  'Anita Menon', '+91 93300 44556', NULL,
  'anita.menon@gmail.com',
  110000.00, 0.00, 3900.00,
  0, 'Bajaj Finance', 'vehicle_loan', 'BJFIN-VL-2023-00988',
  10,
  'Settlement accepted at 85% of outstanding. Paid via NEFT. Account closed.',
  ARRAY[]::TEXT[],
  'whatsapp', 'any', 'friendly',
  'settled', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 hour'
),

-- 15 — Girish Pandey · DPD 150 · very low score · Bajaj Auto
(
  'd1000000-0000-0000-0000-000000000015',
  'a1000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000003',
  'Girish Pandey', '+91 88001 99823', NULL,
  NULL,
  52000.00, 51480.00, 2100.00,
  150, 'Bajaj Finance', 'vehicle_loan', 'BJFIN-VL-2022-03341',
  1,
  'NPA. No response in 90 days. Legal proceedings initiated. Vehicle RC traced.',
  ARRAY['npa','legal_notice','unreachable']::TEXT[],
  'bot', 'any', 'formal',
  'legal', NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 hour'
);

-- ────────────────────────────────────────────────────────────
-- 5.  CALL LOGS  (10 records)
-- ────────────────────────────────────────────────────────────
INSERT INTO call_logs (
  id, debtor_id, agent_id, call_type,
  outcome, promise_amount, promise_date, callback_datetime,
  duration_seconds, raw_notes, ai_notes
) VALUES

(
  'e1000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001',   -- Sanjay Kulkarni
  'b1000000-0000-0000-0000-000000000002',   -- Priya
  'human', 'promised',
  318500.00, CURRENT_DATE + 2, NULL,
  312,
  'Debtor picked up immediately. Said salary credited, will pay full EMI by 25th via UPI. Tone: cooperative.',
  'High confidence PTP. Salary credit signal confirmed via UPI activity. Recommend follow-up WhatsApp link on 24th.'
),

(
  'e1000000-0000-0000-0000-000000000002',
  'd1000000-0000-0000-0000-000000000002',   -- Meena Subramaniam
  'b1000000-0000-0000-0000-000000000002',   -- Priya
  'human', 'promised',
  198000.00, CURRENT_DATE + 3, NULL,
  187,
  'First call attempt. Very polite. Said husband handles finances, will discuss and revert. Asked for WhatsApp message.',
  'Soft PTP. Low risk of breakage. Recommend WhatsApp confirmation and payment link.'
),

(
  'e1000000-0000-0000-0000-000000000003',
  'd1000000-0000-0000-0000-000000000003',   -- Deepak Thakur
  'b1000000-0000-0000-0000-000000000002',   -- Priya
  'human', 'callback',
  NULL, NULL, NOW() + INTERVAL '2 days 18 hours',
  95,
  'Said he has changed jobs. New salary expected in 10 days. Requested callback. Previous PTP broken.',
  'Medium confidence. New job claim unverified. Mark broken PTP flag. Escalate if second PTP missed.'
),

(
  'e1000000-0000-0000-0000-000000000004',
  'd1000000-0000-0000-0000-000000000004',   -- Kavitha Nair
  'b1000000-0000-0000-0000-000000000003',   -- Amit
  'human', 'dispute',
  NULL, NULL, NULL,
  243,
  'Debtor disputed the outstanding amount. Claims payment of ₹45,000 was made in March — not reflected. Wants bank statement.',
  'Legitimate dispute possible. Verify March payment in system. Raise formal dispute ticket. Pause collections.'
),

(
  'e1000000-0000-0000-0000-000000000005',
  'd1000000-0000-0000-0000-000000000005',   -- Arjun Singhania
  'b1000000-0000-0000-0000-000000000003',   -- Amit
  'human', 'no_answer',
  NULL, NULL, NULL,
  0,
  'Phone rings then disconnects. Third attempt this week.',
  'Persistent no-answer pattern. Recommend legal track escalation and field agent visit.'
),

(
  'e1000000-0000-0000-0000-000000000006',
  'd1000000-0000-0000-0000-000000000006',   -- Pooja Deshmukh
  'b1000000-0000-0000-0000-000000000002',   -- Priya
  'human', 'promised',
  261400.00, CURRENT_DATE + 1, NULL,
  204,
  'Debtor was aware of the missed ECS. Apologised, said bank maintenance issue. Will retry NEFT today.',
  'Low risk. Confirmed bank fault. High probability of same-day payment. Send UPI link on WhatsApp.'
),

(
  'e1000000-0000-0000-0000-000000000007',
  'd1000000-0000-0000-0000-000000000007',   -- Ravi Krishnamurthy
  'b1000000-0000-0000-0000-000000000001',   -- Rahul (manager took the escalation)
  'human', 'promised',
  200000.00, CURRENT_DATE + 7, NULL,
  540,
  'Long call. Debtor requesting 40% waiver. Explained policy. Agreed to settlement discussion. Manager callback requested.',
  'Settlement likely at 15–20% waiver. Flag for approval. High value recovery opportunity.'
),

(
  'e1000000-0000-0000-0000-000000000008',
  'd1000000-0000-0000-0000-000000000011',   -- Suresh Yadav
  'b1000000-0000-0000-0000-000000000002',   -- Priya
  'human', 'promised',
  72350.00, CURRENT_DATE + 4, NULL,
  166,
  'Debtor confirmed bike still in use. Salary coming Friday. Will pay full overdue amount.',
  'Strong PTP. Short call, confident tone. Send payment link 30 min before ECS window.'
),

(
  'e1000000-0000-0000-0000-000000000009',
  'd1000000-0000-0000-0000-000000000012',   -- Lakshmi Pillai
  'b1000000-0000-0000-0000-000000000003',   -- Amit
  'human', 'refused',
  NULL, NULL, NULL,
  78,
  'Debtor aggressive. Said vehicle was already surrendered. Denies owing anything. Call ended abruptly.',
  'Possible vehicle surrender dispute. Verify repo records. Escalate to legal if not in system.'
),

(
  'e1000000-0000-0000-0000-000000000010',
  'd1000000-0000-0000-0000-000000000013',   -- Manish Tiwari
  'b1000000-0000-0000-0000-000000000002',   -- Priya
  'human', 'promised',
  30000.00, CURRENT_DATE + 10, NULL,
  482,
  'Rabi crop harvest upcoming in 10 days. Debtor very cooperative. Agreed to partial ₹30k now, rest post-harvest.',
  'Genuine seasonal cash flow. Accept partial payment. Schedule next call post-harvest date.'
);

-- ────────────────────────────────────────────────────────────
-- 6.  MESSAGES  (5 WhatsApp outbound records)
-- ────────────────────────────────────────────────────────────
INSERT INTO messages (
  id, debtor_id, agent_id, channel, direction,
  template_name, content, status, payment_link_url, sent_at
) VALUES

(
  'f1000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001',   -- Sanjay Kulkarni
  'b1000000-0000-0000-0000-000000000002',
  'whatsapp', 'outbound',
  'emi_reminder_hindi',
  'Namaste Sanjay ji, aapka HDFC Personal Loan EMI ₹9,800 due hai. Kripya 25 June tak UPI se payment karein. Link: https://pay.recoveryai.in/d1000000',
  'read',
  'https://pay.recoveryai.in/d1000000',
  NOW() - INTERVAL '2 hours'
),

(
  'f1000000-0000-0000-0000-000000000002',
  'd1000000-0000-0000-0000-000000000002',   -- Meena Subramaniam
  'b1000000-0000-0000-0000-000000000002',
  'whatsapp', 'outbound',
  'ptp_confirmation_english',
  'Dear Meena, thank you for your commitment to pay ₹7,200 by 25 June. Here is your secure payment link: https://pay.recoveryai.in/d1000000-2. Please reach out if you need assistance.',
  'delivered',
  'https://pay.recoveryai.in/d1000000-2',
  NOW() - INTERVAL '1 hour'
),

(
  'f1000000-0000-0000-0000-000000000003',
  'd1000000-0000-0000-0000-000000000006',   -- Pooja Deshmukh
  'b1000000-0000-0000-0000-000000000002',
  'whatsapp', 'outbound',
  'emi_reminder_hindi',
  'Hi Pooja ji, aapka EMI ₹8,900 auto-debit fail hua. Kripya aaj NEFT ya UPI se payment karein. Link: https://pay.recoveryai.in/d1000000-6',
  'read',
  'https://pay.recoveryai.in/d1000000-6',
  NOW() - INTERVAL '3 hours'
),

(
  'f1000000-0000-0000-0000-000000000004',
  'd1000000-0000-0000-0000-000000000011',   -- Suresh Yadav
  'b1000000-0000-0000-0000-000000000002',
  'whatsapp', 'outbound',
  'payment_link_send',
  'Dear Suresh ji, aapka bike loan EMI ₹3,200 due hai. Payment link bhej raha hoon — https://pay.recoveryai.in/d1000000-11. Friday tak pay karein, penalty se bachein.',
  'delivered',
  'https://pay.recoveryai.in/d1000000-11',
  NOW() - INTERVAL '4 hours'
),

(
  'f1000000-0000-0000-0000-000000000005',
  'd1000000-0000-0000-0000-000000000007',   -- Ravi Krishnamurthy
  'b1000000-0000-0000-0000-000000000001',   -- Rahul (manager)
  'whatsapp', 'outbound',
  'settlement_offer',
  'Dear Ravi ji, as discussed, we can consider a settlement on your outstanding of ₹3,78,000. Please call us at 1800-XXX-XXXX by 28 June to confirm your intent. Settlement is time-limited.',
  'read',
  NULL,
  NOW() - INTERVAL '6 hours'
);

-- ────────────────────────────────────────────────────────────
-- 7.  PAYMENTS  (3 records: 2 completed, 1 pending)
-- ────────────────────────────────────────────────────────────
INSERT INTO payments (
  id, debtor_id, agent_id,
  amount, payment_method, razorpay_payment_id, razorpay_link_id,
  status, payment_type, notes, received_at
) VALUES

-- Sunita Agarwal — full payment completed (HDFC)
(
  'a2000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000008',   -- Sunita Agarwal
  'b1000000-0000-0000-0000-000000000002',
  150000.00, 'upi',
  'pay_QaBcDeFgHiJkLm', 'plink_QaBcDeUPI001',
  'completed', 'full',
  'Full outstanding cleared via UPI. EMI account to be closed.',
  NOW() - INTERVAL '1 day'
),

-- Anita Menon — settlement payment completed (Bajaj)
(
  'a2000000-0000-0000-0000-000000000002',
  'd1000000-0000-0000-0000-000000000014',   -- Anita Menon
  'b1000000-0000-0000-0000-000000000001',   -- Rahul approved the settlement
  93500.00, 'netbanking',
  'pay_QaBcDeFgNFT002', NULL,
  'completed', 'settlement',
  'Settlement at 85% of ₹1,10,000 outstanding. Approved by manager Rahul Sharma. NEFT confirmation UTR: HDFC2026061900234.',
  NOW() - INTERVAL '3 days'
),

-- Manish Tiwari — partial payment pending (Bajaj)
(
  'a2000000-0000-0000-0000-000000000003',
  'd1000000-0000-0000-0000-000000000013',   -- Manish Tiwari
  'b1000000-0000-0000-0000-000000000002',
  30000.00, 'link',
  NULL, 'plink_QaBcDeBAJ003',
  'pending', 'partial',
  'Partial payment link sent. Debtor confirmed will pay post crop harvest. Follow up on ' || TO_CHAR(CURRENT_DATE + 10, 'DD Mon YYYY') || '.',
  NULL  -- not yet received
);

-- ────────────────────────────────────────────────────────────
-- 8.  Re-enable RLS
-- ────────────────────────────────────────────────────────────
SET LOCAL row_security = on;

-- ────────────────────────────────────────────────────────────
-- 9.  Verification queries (run manually to check)
-- ────────────────────────────────────────────────────────────
-- SELECT COUNT(*) FROM debtors;           -- expect 15
-- SELECT COUNT(*) FROM call_logs;         -- expect 10
-- SELECT COUNT(*) FROM messages;          -- expect  5
-- SELECT COUNT(*) FROM payments;          -- expect  3
-- SELECT name, role FROM agents;          -- expect 3 rows
-- SELECT name, lender_name FROM portfolios;  -- expect 2 rows
