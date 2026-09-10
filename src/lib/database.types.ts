// GENERATED FILE — do not edit by hand.
//
// Produced by `bun run gen:types` from the live database's PostgREST schema.
// Re-run it after any migration that adds or changes a column, and commit the result.
//
// Generated from 29 tables.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      _rls_ddl_audit: {
        Row: {
          id: number;
          occurred_at: string;
          db_user: string | null;
          app_name: string | null;
          client_addr: string | null;
          command_tag: string | null;
          object_identity: string | null;
          auth_agent_id_lang: string | null;
          agents_select_ok: boolean | null;
        };
        Insert: {
          id: number;
          occurred_at?: string;
          db_user?: string | null;
          app_name?: string | null;
          client_addr?: string | null;
          command_tag?: string | null;
          object_identity?: string | null;
          auth_agent_id_lang?: string | null;
          agents_select_ok?: boolean | null;
        };
        Update: {
          id?: number;
          occurred_at?: string;
          db_user?: string | null;
          app_name?: string | null;
          client_addr?: string | null;
          command_tag?: string | null;
          object_identity?: string | null;
          auth_agent_id_lang?: string | null;
          agents_select_ok?: boolean | null;
        };
        Relationships: [];
      };
      agent_status_log: {
        Row: {
          id: string;
          client_id: string;
          agent_id: string;
          status: string;
          started_at: string;
          ended_at: string | null;
        };
        Insert: {
          id?: string;
          client_id: string;
          agent_id: string;
          status: string;
          started_at?: string;
          ended_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string;
          agent_id?: string;
          status?: string;
          started_at?: string;
          ended_at?: string | null;
        };
        Relationships: [];
      };
      agents: {
        Row: {
          id: string;
          auth_user_id: string | null;
          client_id: string | null;
          name: string;
          email: string;
          role: string;
          daily_target: number | null;
          is_active: boolean | null;
          created_at: string | null;
          agent_phone: string | null;
          provider_agent_id: string | null;
          agent_code: string | null;
          session_nonce: string | null;
        };
        Insert: {
          id?: string;
          auth_user_id?: string | null;
          client_id?: string | null;
          name: string;
          email: string;
          role?: string;
          daily_target?: number | null;
          is_active?: boolean | null;
          created_at?: string | null;
          agent_phone?: string | null;
          provider_agent_id?: string | null;
          agent_code?: string | null;
          session_nonce?: string | null;
        };
        Update: {
          id?: string;
          auth_user_id?: string | null;
          client_id?: string | null;
          name?: string;
          email?: string;
          role?: string;
          daily_target?: number | null;
          is_active?: boolean | null;
          created_at?: string | null;
          agent_phone?: string | null;
          provider_agent_id?: string | null;
          agent_code?: string | null;
          session_nonce?: string | null;
        };
        Relationships: [];
      };
      call_logs: {
        Row: {
          id: string;
          debtor_id: string | null;
          agent_id: string | null;
          call_type: string | null;
          outcome: string | null;
          promise_amount: number | null;
          promise_date: string | null;
          callback_datetime: string | null;
          duration_seconds: number | null;
          raw_notes: string | null;
          ai_notes: string | null;
          recording_url: string | null;
          created_at: string | null;
          contact_name: string | null;
          contact_phone: string | null;
          provider_call_id: string | null;
          sentiment: string | null;
          audited_by: string | null;
          audited_at: string | null;
          promise_time: string | null;
          outcome_reason: string | null;
          ai_transcript: string | null;
          ai_agent_tone: string | null;
          ai_debtor_tone: string | null;
          ai_sentiment: string | null;
          ai_sentiment_confidence: number | null;
          ai_sentiment_reasoning: string | null;
          ai_sentiment_analyzed_at: string | null;
          dial_mode: string | null;
          callback_date: string | null;
          callback_time: string | null;
          ring_seconds: number | null;
          wrap_seconds: number | null;
        };
        Insert: {
          id?: string;
          debtor_id?: string | null;
          agent_id?: string | null;
          call_type?: string | null;
          outcome?: string | null;
          promise_amount?: number | null;
          promise_date?: string | null;
          callback_datetime?: string | null;
          duration_seconds?: number | null;
          raw_notes?: string | null;
          ai_notes?: string | null;
          recording_url?: string | null;
          created_at?: string | null;
          contact_name?: string | null;
          contact_phone?: string | null;
          provider_call_id?: string | null;
          sentiment?: string | null;
          audited_by?: string | null;
          audited_at?: string | null;
          promise_time?: string | null;
          outcome_reason?: string | null;
          ai_transcript?: string | null;
          ai_agent_tone?: string | null;
          ai_debtor_tone?: string | null;
          ai_sentiment?: string | null;
          ai_sentiment_confidence?: number | null;
          ai_sentiment_reasoning?: string | null;
          ai_sentiment_analyzed_at?: string | null;
          dial_mode?: string | null;
          callback_date?: string | null;
          callback_time?: string | null;
          ring_seconds?: number | null;
          wrap_seconds?: number | null;
        };
        Update: {
          id?: string;
          debtor_id?: string | null;
          agent_id?: string | null;
          call_type?: string | null;
          outcome?: string | null;
          promise_amount?: number | null;
          promise_date?: string | null;
          callback_datetime?: string | null;
          duration_seconds?: number | null;
          raw_notes?: string | null;
          ai_notes?: string | null;
          recording_url?: string | null;
          created_at?: string | null;
          contact_name?: string | null;
          contact_phone?: string | null;
          provider_call_id?: string | null;
          sentiment?: string | null;
          audited_by?: string | null;
          audited_at?: string | null;
          promise_time?: string | null;
          outcome_reason?: string | null;
          ai_transcript?: string | null;
          ai_agent_tone?: string | null;
          ai_debtor_tone?: string | null;
          ai_sentiment?: string | null;
          ai_sentiment_confidence?: number | null;
          ai_sentiment_reasoning?: string | null;
          ai_sentiment_analyzed_at?: string | null;
          dial_mode?: string | null;
          callback_date?: string | null;
          callback_time?: string | null;
          ring_seconds?: number | null;
          wrap_seconds?: number | null;
        };
        Relationships: [];
      };
      clients: {
        Row: {
          id: string;
          company_name: string;
          plan: string | null;
          created_at: string | null;
          status: string;
          verified_at: string | null;
          verified_by: string | null;
          subdomain: string | null;
          max_agents: number | null;
          max_managers: number | null;
        };
        Insert: {
          id?: string;
          company_name: string;
          plan?: string | null;
          created_at?: string | null;
          status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
          subdomain?: string | null;
          max_agents?: number | null;
          max_managers?: number | null;
        };
        Update: {
          id?: string;
          company_name?: string;
          plan?: string | null;
          created_at?: string | null;
          status?: string;
          verified_at?: string | null;
          verified_by?: string | null;
          subdomain?: string | null;
          max_agents?: number | null;
          max_managers?: number | null;
        };
        Relationships: [];
      };
      debtor_traces: {
        Row: {
          id: string;
          client_id: string;
          debtor_id: string;
          service_id: string;
          requested_by: string | null;
          state: string;
          http_status: number | null;
          provider_status: string | null;
          billable: boolean;
          cost: number;
          transaction_id: string | null;
          response: Json | null;
          error: string | null;
          created_at: string;
          completed_at: string | null;
        };
        Insert: {
          id?: string;
          client_id: string;
          debtor_id: string;
          service_id: string;
          requested_by?: string | null;
          state?: string;
          http_status?: number | null;
          provider_status?: string | null;
          billable?: boolean;
          cost?: number;
          transaction_id?: string | null;
          response?: Json | null;
          error?: string | null;
          created_at?: string;
          completed_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string;
          debtor_id?: string;
          service_id?: string;
          requested_by?: string | null;
          state?: string;
          http_status?: number | null;
          provider_status?: string | null;
          billable?: boolean;
          cost?: number;
          transaction_id?: string | null;
          response?: Json | null;
          error?: string | null;
          created_at?: string;
          completed_at?: string | null;
        };
        Relationships: [];
      };
      debtors: {
        Row: {
          id: string;
          client_id: string | null;
          portfolio_id: string | null;
          assigned_agent_id: string | null;
          name: string;
          phone_primary: string;
          phone_alternate: string | null;
          email: string | null;
          loan_amount: number | null;
          outstanding_balance: number | null;
          emi_amount: number | null;
          dpd: number | null;
          lender: string | null;
          product_type: string | null;
          loan_reference: string | null;
          ai_score: number | null;
          ai_score_reason: string | null;
          risk_flags: string[] | null;
          recommended_channel: string | null;
          best_contact_time: string | null;
          suggested_tone: string | null;
          status: string | null;
          last_contacted_at: string | null;
          score_updated_at: string | null;
          created_at: string | null;
          extra: Json | null;
          alt_phones: string[];
          retained_from_portfolio_id: string | null;
          principal_amount: number | null;
          product_code: string | null;
        };
        Insert: {
          id?: string;
          client_id?: string | null;
          portfolio_id?: string | null;
          assigned_agent_id?: string | null;
          name: string;
          phone_primary: string;
          phone_alternate?: string | null;
          email?: string | null;
          loan_amount?: number | null;
          outstanding_balance?: number | null;
          emi_amount?: number | null;
          dpd?: number | null;
          lender?: string | null;
          product_type?: string | null;
          loan_reference?: string | null;
          ai_score?: number | null;
          ai_score_reason?: string | null;
          risk_flags?: string[] | null;
          recommended_channel?: string | null;
          best_contact_time?: string | null;
          suggested_tone?: string | null;
          status?: string | null;
          last_contacted_at?: string | null;
          score_updated_at?: string | null;
          created_at?: string | null;
          extra?: Json | null;
          alt_phones?: string[];
          retained_from_portfolio_id?: string | null;
          principal_amount?: number | null;
          product_code?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string | null;
          portfolio_id?: string | null;
          assigned_agent_id?: string | null;
          name?: string;
          phone_primary?: string;
          phone_alternate?: string | null;
          email?: string | null;
          loan_amount?: number | null;
          outstanding_balance?: number | null;
          emi_amount?: number | null;
          dpd?: number | null;
          lender?: string | null;
          product_type?: string | null;
          loan_reference?: string | null;
          ai_score?: number | null;
          ai_score_reason?: string | null;
          risk_flags?: string[] | null;
          recommended_channel?: string | null;
          best_contact_time?: string | null;
          suggested_tone?: string | null;
          status?: string | null;
          last_contacted_at?: string | null;
          score_updated_at?: string | null;
          created_at?: string | null;
          extra?: Json | null;
          alt_phones?: string[];
          retained_from_portfolio_id?: string | null;
          principal_amount?: number | null;
          product_code?: string | null;
        };
        Relationships: [];
      };
      disputes: {
        Row: {
          id: string;
          debtor_id: string | null;
          raised_by: string | null;
          dispute_type: string | null;
          debtor_reason: string | null;
          agent_notes: string | null;
          status: string | null;
          resolved_by: string | null;
          resolved_at: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          debtor_id?: string | null;
          raised_by?: string | null;
          dispute_type?: string | null;
          debtor_reason?: string | null;
          agent_notes?: string | null;
          status?: string | null;
          resolved_by?: string | null;
          resolved_at?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          debtor_id?: string | null;
          raised_by?: string | null;
          dispute_type?: string | null;
          debtor_reason?: string | null;
          agent_notes?: string | null;
          status?: string | null;
          resolved_by?: string | null;
          resolved_at?: string | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      escalations: {
        Row: {
          id: string;
          client_id: string | null;
          debtor_id: string | null;
          reason: string | null;
          priority: string | null;
          notes: string | null;
          agent_id: string | null;
          resolved: boolean | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          client_id?: string | null;
          debtor_id?: string | null;
          reason?: string | null;
          priority?: string | null;
          notes?: string | null;
          agent_id?: string | null;
          resolved?: boolean | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string | null;
          debtor_id?: string | null;
          reason?: string | null;
          priority?: string | null;
          notes?: string | null;
          agent_id?: string | null;
          resolved?: boolean | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      live_calls: {
        Row: {
          id: string;
          client_id: string;
          agent_id: string;
          debtor_id: string | null;
          provider_call_id: string | null;
          phase: string;
          dial_mode: string | null;
          contact_name: string | null;
          contact_phone: string | null;
          loan_reference: string | null;
          started_at: string;
          last_seen_at: string;
          ended_at: string | null;
        };
        Insert: {
          id?: string;
          client_id: string;
          agent_id: string;
          debtor_id?: string | null;
          provider_call_id?: string | null;
          phase: string;
          dial_mode?: string | null;
          contact_name?: string | null;
          contact_phone?: string | null;
          loan_reference?: string | null;
          started_at?: string;
          last_seen_at?: string;
          ended_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string;
          agent_id?: string;
          debtor_id?: string | null;
          provider_call_id?: string | null;
          phase?: string;
          dial_mode?: string | null;
          contact_name?: string | null;
          contact_phone?: string | null;
          loan_reference?: string | null;
          started_at?: string;
          last_seen_at?: string;
          ended_at?: string | null;
        };
        Relationships: [];
      };
      mapping_templates: {
        Row: {
          id: string;
          client_id: string | null;
          lender: string;
          lender_label: string | null;
          fingerprint: string;
          mapping: Json;
          use_count: number | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          client_id?: string | null;
          lender: string;
          lender_label?: string | null;
          fingerprint: string;
          mapping: Json;
          use_count?: number | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string | null;
          lender?: string;
          lender_label?: string | null;
          fingerprint?: string;
          mapping?: Json;
          use_count?: number | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          debtor_id: string | null;
          agent_id: string | null;
          channel: string;
          direction: string;
          template_name: string | null;
          content: string;
          status: string | null;
          payment_link_url: string | null;
          razorpay_link_id: string | null;
          sent_at: string | null;
        };
        Insert: {
          id?: string;
          debtor_id?: string | null;
          agent_id?: string | null;
          channel: string;
          direction: string;
          template_name?: string | null;
          content: string;
          status?: string | null;
          payment_link_url?: string | null;
          razorpay_link_id?: string | null;
          sent_at?: string | null;
        };
        Update: {
          id?: string;
          debtor_id?: string | null;
          agent_id?: string | null;
          channel?: string;
          direction?: string;
          template_name?: string | null;
          content?: string;
          status?: string | null;
          payment_link_url?: string | null;
          razorpay_link_id?: string | null;
          sent_at?: string | null;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          client_id: string | null;
          to_agent_id: string | null;
          from_name: string;
          message: string;
          read: boolean | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          client_id?: string | null;
          to_agent_id?: string | null;
          from_name: string;
          message: string;
          read?: boolean | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string | null;
          to_agent_id?: string | null;
          from_name?: string;
          message?: string;
          read?: boolean | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      payments: {
        Row: {
          id: string;
          debtor_id: string | null;
          agent_id: string | null;
          amount: number;
          payment_method: string | null;
          razorpay_payment_id: string | null;
          razorpay_link_id: string | null;
          status: string | null;
          payment_type: string | null;
          notes: string | null;
          received_at: string | null;
          created_at: string | null;
          source: string;
        };
        Insert: {
          id?: string;
          debtor_id?: string | null;
          agent_id?: string | null;
          amount: number;
          payment_method?: string | null;
          razorpay_payment_id?: string | null;
          razorpay_link_id?: string | null;
          status?: string | null;
          payment_type?: string | null;
          notes?: string | null;
          received_at?: string | null;
          created_at?: string | null;
          source?: string;
        };
        Update: {
          id?: string;
          debtor_id?: string | null;
          agent_id?: string | null;
          amount?: number;
          payment_method?: string | null;
          razorpay_payment_id?: string | null;
          razorpay_link_id?: string | null;
          status?: string | null;
          payment_type?: string | null;
          notes?: string | null;
          received_at?: string | null;
          created_at?: string | null;
          source?: string;
        };
        Relationships: [];
      };
      portfolio_agent_targets: {
        Row: {
          id: string;
          client_id: string | null;
          portfolio_id: string;
          agent_id: string;
          target_amount: number | null;
          target_accounts: number | null;
          created_at: string | null;
          updated_at: string | null;
        };
        Insert: {
          id?: string;
          client_id?: string | null;
          portfolio_id: string;
          agent_id: string;
          target_amount?: number | null;
          target_accounts?: number | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string | null;
          portfolio_id?: string;
          agent_id?: string;
          target_amount?: number | null;
          target_accounts?: number | null;
          created_at?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      portfolios: {
        Row: {
          id: string;
          client_id: string | null;
          name: string;
          lender_name: string | null;
          product_type: string | null;
          priority: string | null;
          total_accounts: number | null;
          scored_accounts: number | null;
          uploaded_by: string | null;
          uploaded_at: string | null;
          settings: Json | null;
          team_id: string | null;
          manager_id: string | null;
          replaces_portfolio_id: string | null;
          closed_at: string | null;
          end_date: string | null;
        };
        Insert: {
          id?: string;
          client_id?: string | null;
          name: string;
          lender_name?: string | null;
          product_type?: string | null;
          priority?: string | null;
          total_accounts?: number | null;
          scored_accounts?: number | null;
          uploaded_by?: string | null;
          uploaded_at?: string | null;
          settings?: Json | null;
          team_id?: string | null;
          manager_id?: string | null;
          replaces_portfolio_id?: string | null;
          closed_at?: string | null;
          end_date?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string | null;
          name?: string;
          lender_name?: string | null;
          product_type?: string | null;
          priority?: string | null;
          total_accounts?: number | null;
          scored_accounts?: number | null;
          uploaded_by?: string | null;
          uploaded_at?: string | null;
          settings?: Json | null;
          team_id?: string | null;
          manager_id?: string | null;
          replaces_portfolio_id?: string | null;
          closed_at?: string | null;
          end_date?: string | null;
        };
        Relationships: [];
      };
      profilex_actual_wallet: {
        Row: {
          id: string;
          balance: number;
          low_balance_threshold: number;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          balance?: number;
          low_balance_threshold?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          id?: string;
          balance?: number;
          low_balance_threshold?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      profilex_company_wallets: {
        Row: {
          client_id: string;
          balance: number;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          client_id: string;
          balance?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          client_id?: string;
          balance?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      profilex_master_wallet: {
        Row: {
          id: string;
          balance: number;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: string;
          balance?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          id?: string;
          balance?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      profilex_settings: {
        Row: {
          client_id: string;
          enabled: boolean;
          monthly_budget: number;
          hit_ttl_hours: number;
          miss_ttl_hours: number;
          rate_card: Json;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          client_id: string;
          enabled?: boolean;
          monthly_budget?: number;
          hit_ttl_hours?: number;
          miss_ttl_hours?: number;
          rate_card: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          client_id?: string;
          enabled?: boolean;
          monthly_budget?: number;
          hit_ttl_hours?: number;
          miss_ttl_hours?: number;
          rate_card?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      profilex_wallet_ledger: {
        Row: {
          id: string;
          scope: string;
          client_id: string | null;
          manager_id: string | null;
          amount: number;
          note: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          scope: string;
          client_id?: string | null;
          manager_id?: string | null;
          amount: number;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          scope?: string;
          client_id?: string | null;
          manager_id?: string | null;
          amount?: number;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      profilex_wallets: {
        Row: {
          manager_id: string;
          client_id: string;
          balance: number;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          manager_id: string;
          client_id: string;
          balance?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          manager_id?: string;
          client_id?: string;
          balance?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      ptp_escalations: {
        Row: {
          id: string;
          debtor_id: string;
          ptp_date: string;
          level: string;
          escalated_at: string | null;
          case_type: string;
        };
        Insert: {
          id?: string;
          debtor_id: string;
          ptp_date: string;
          level: string;
          escalated_at?: string | null;
          case_type?: string;
        };
        Update: {
          id?: string;
          debtor_id?: string;
          ptp_date?: string;
          level?: string;
          escalated_at?: string | null;
          case_type?: string;
        };
        Relationships: [];
      };
      reminders: {
        Row: {
          id: string;
          client_id: string | null;
          agent_id: string | null;
          debtor_id: string | null;
          kind: string | null;
          amount: number | null;
          due_date: string;
          due_time: string | null;
          message: string | null;
          notified: boolean | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          client_id?: string | null;
          agent_id?: string | null;
          debtor_id?: string | null;
          kind?: string | null;
          amount?: number | null;
          due_date: string;
          due_time?: string | null;
          message?: string | null;
          notified?: boolean | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string | null;
          agent_id?: string | null;
          debtor_id?: string | null;
          kind?: string | null;
          amount?: number | null;
          due_date?: string;
          due_time?: string | null;
          message?: string | null;
          notified?: boolean | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      retention_requests: {
        Row: {
          id: string;
          debtor_id: string;
          portfolio_id: string;
          requested_by: string | null;
          reason: string | null;
          status: string;
          reviewed_by: string | null;
          reviewed_at: string | null;
          sent_to_bank_at: string | null;
          carried_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          debtor_id: string;
          portfolio_id: string;
          requested_by?: string | null;
          reason?: string | null;
          status?: string;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          sent_to_bank_at?: string | null;
          carried_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          debtor_id?: string;
          portfolio_id?: string;
          requested_by?: string | null;
          reason?: string | null;
          status?: string;
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          sent_to_bank_at?: string | null;
          carried_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      settlement_requests: {
        Row: {
          id: string;
          debtor_id: string | null;
          requested_by: string | null;
          approved_by: string | null;
          original_amount: number | null;
          proposed_amount: number | null;
          agent_notes: string | null;
          status: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          debtor_id?: string | null;
          requested_by?: string | null;
          approved_by?: string | null;
          original_amount?: number | null;
          proposed_amount?: number | null;
          agent_notes?: string | null;
          status?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          debtor_id?: string | null;
          requested_by?: string | null;
          approved_by?: string | null;
          original_amount?: number | null;
          proposed_amount?: number | null;
          agent_notes?: string | null;
          status?: string | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
      superadmins: {
        Row: {
          id: string;
          auth_user_id: string | null;
          name: string;
          email: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          auth_user_id?: string | null;
          name: string;
          email: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          auth_user_id?: string | null;
          name?: string;
          email?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      team_agents: {
        Row: {
          team_id: string;
          agent_id: string;
        };
        Insert: {
          team_id: string;
          agent_id: string;
        };
        Update: {
          team_id?: string;
          agent_id?: string;
        };
        Relationships: [];
      };
      teams: {
        Row: {
          id: string;
          client_id: string | null;
          name: string;
          manager_id: string | null;
          created_at: string | null;
        };
        Insert: {
          id?: string;
          client_id?: string | null;
          name: string;
          manager_id?: string | null;
          created_at?: string | null;
        };
        Update: {
          id?: string;
          client_id?: string | null;
          name?: string;
          manager_id?: string | null;
          created_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: { [view: string]: { Row: Record<string, unknown>; Relationships: [] } };
    Functions: { [fn: string]: { Args: Record<string, unknown>; Returns: unknown } };
    Enums: { [name: string]: string };
    CompositeTypes: { [name: string]: Record<string, unknown> };
  };
}
