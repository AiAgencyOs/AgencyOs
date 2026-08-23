export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  ai: {
    Tables: {
      agent_handoff_targets: {
        Row: {
          from_agent: string
          to_agent: string
        }
        Insert: {
          from_agent: string
          to_agent: string
        }
        Update: {
          from_agent?: string
          to_agent?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_handoff_targets_from_agent_fkey"
            columns: ["from_agent"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "agent_handoff_targets_to_agent_fkey"
            columns: ["to_agent"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent_key: string
          cache_read_tokens: number
          cache_write_tokens: number
          correlation_id: string | null
          cost_minor: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          input: Json | null
          input_tokens: number
          model: string | null
          organization_id: string
          output: Json | null
          output_tokens: number
          prompt_hash: string | null
          prompt_key: string | null
          prompt_version: string | null
          started_at: string | null
          status: string
          step_count: number
          subject_id: string | null
          subject_type: string | null
          trigger: string
          updated_at: string
          work_class: string | null
        }
        Insert: {
          agent_key: string
          cache_read_tokens?: number
          cache_write_tokens?: number
          correlation_id?: string | null
          cost_minor?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json | null
          input_tokens?: number
          model?: string | null
          organization_id: string
          output?: Json | null
          output_tokens?: number
          prompt_hash?: string | null
          prompt_key?: string | null
          prompt_version?: string | null
          started_at?: string | null
          status?: string
          step_count?: number
          subject_id?: string | null
          subject_type?: string | null
          trigger: string
          updated_at?: string
          work_class?: string | null
        }
        Update: {
          agent_key?: string
          cache_read_tokens?: number
          cache_write_tokens?: number
          correlation_id?: string | null
          cost_minor?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input?: Json | null
          input_tokens?: number
          model?: string | null
          organization_id?: string
          output?: Json | null
          output_tokens?: number
          prompt_hash?: string | null
          prompt_key?: string | null
          prompt_version?: string | null
          started_at?: string | null
          status?: string
          step_count?: number
          subject_id?: string | null
          subject_type?: string | null
          trigger?: string
          updated_at?: string
          work_class?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
        ]
      }
      agent_steps: {
        Row: {
          cost_minor: number
          created_at: string
          error: string | null
          id: string
          kind: string
          latency_ms: number | null
          organization_id: string
          request: Json | null
          response: Json | null
          run_id: string
          seq: number
          tokens_in: number
          tokens_out: number
        }
        Insert: {
          cost_minor?: number
          created_at?: string
          error?: string | null
          id?: string
          kind: string
          latency_ms?: number | null
          organization_id: string
          request?: Json | null
          response?: Json | null
          run_id: string
          seq: number
          tokens_in?: number
          tokens_out?: number
        }
        Update: {
          cost_minor?: number
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          latency_ms?: number | null
          organization_id?: string
          request?: Json | null
          response?: Json | null
          run_id?: string
          seq?: number
          tokens_in?: number
          tokens_out?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_steps_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_verifiers: {
        Row: {
          producer: string
          verifier: string
        }
        Insert: {
          producer: string
          verifier: string
        }
        Update: {
          producer?: string
          verifier?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_verifiers_producer_fkey"
            columns: ["producer"]
            isOneToOne: true
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "agent_verifiers_verifier_fkey"
            columns: ["verifier"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
        ]
      }
      agents: {
        Row: {
          autonomy_level: string
          created_at: string
          default_effort: string
          default_model: string
          definition_version: string | null
          description: string | null
          disabled_reason: string | null
          display_name: string
          enabled: boolean
          key: string
          last_validated_at: string | null
          max_cost_minor: number
          max_steps: number
          updated_at: string
        }
        Insert: {
          autonomy_level?: string
          created_at?: string
          default_effort?: string
          default_model: string
          definition_version?: string | null
          description?: string | null
          disabled_reason?: string | null
          display_name: string
          enabled?: boolean
          key: string
          last_validated_at?: string | null
          max_cost_minor?: number
          max_steps?: number
          updated_at?: string
        }
        Update: {
          autonomy_level?: string
          created_at?: string
          default_effort?: string
          default_model?: string
          definition_version?: string | null
          description?: string | null
          disabled_reason?: string | null
          display_name?: string
          enabled?: boolean
          key?: string
          last_validated_at?: string | null
          max_cost_minor?: number
          max_steps?: number
          updated_at?: string
        }
        Relationships: []
      }
      cost_ledger: {
        Row: {
          agent_key: string
          cost_minor: number
          created_at: string
          day: string
          id: number
          input_tokens: number
          model: string
          organization_id: string
          output_tokens: number
          runs: number
          updated_at: string
        }
        Insert: {
          agent_key: string
          cost_minor?: number
          created_at?: string
          day: string
          id?: number
          input_tokens?: number
          model: string
          organization_id: string
          output_tokens?: number
          runs?: number
          updated_at?: string
        }
        Update: {
          agent_key?: string
          cost_minor?: number
          created_at?: string
          day?: string
          id?: number
          input_tokens?: number
          model?: string
          organization_id?: string
          output_tokens?: number
          runs?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_ledger_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
        ]
      }
      handoffs: {
        Row: {
          accepted_at: string | null
          artifacts: Json
          completed_at: string | null
          constraints: Json
          context: Json
          correlation_id: string
          created_at: string
          decisions: Json
          depth: number
          from_agent: string
          id: string
          objective: string
          organization_id: string
          project_id: string | null
          requested_action: string | null
          requirements: Json
          sla_at: string | null
          state: Json
          status: string
          subject_id: string | null
          subject_type: string | null
          task_id: string | null
          to_agent: string
          unresolved: Json
          verification: Json | null
        }
        Insert: {
          accepted_at?: string | null
          artifacts?: Json
          completed_at?: string | null
          constraints?: Json
          context?: Json
          correlation_id: string
          created_at?: string
          decisions?: Json
          depth?: number
          from_agent: string
          id?: string
          objective: string
          organization_id: string
          project_id?: string | null
          requested_action?: string | null
          requirements?: Json
          sla_at?: string | null
          state?: Json
          status?: string
          subject_id?: string | null
          subject_type?: string | null
          task_id?: string | null
          to_agent: string
          unresolved?: Json
          verification?: Json | null
        }
        Update: {
          accepted_at?: string | null
          artifacts?: Json
          completed_at?: string | null
          constraints?: Json
          context?: Json
          correlation_id?: string
          created_at?: string
          decisions?: Json
          depth?: number
          from_agent?: string
          id?: string
          objective?: string
          organization_id?: string
          project_id?: string | null
          requested_action?: string | null
          requirements?: Json
          sla_at?: string | null
          state?: Json
          status?: string
          subject_id?: string | null
          subject_type?: string | null
          task_id?: string | null
          to_agent?: string
          unresolved?: Json
          verification?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "handoffs_from_agent_fkey"
            columns: ["from_agent"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "handoffs_to_agent_fkey"
            columns: ["to_agent"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
        ]
      }
      memory_records: {
        Row: {
          authored_by_agent: string | null
          confidence: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          fact: string
          id: string
          kind: string
          organization_id: string
          review_at: string | null
          scope: string
          scope_id: string | null
          source_id: string | null
          source_kind: string | null
          superseded_by: string | null
          updated_at: string
        }
        Insert: {
          authored_by_agent?: string | null
          confidence?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          fact: string
          id?: string
          kind: string
          organization_id: string
          review_at?: string | null
          scope: string
          scope_id?: string | null
          source_id?: string | null
          source_kind?: string | null
          superseded_by?: string | null
          updated_at?: string
        }
        Update: {
          authored_by_agent?: string | null
          confidence?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          fact?: string
          id?: string
          kind?: string
          organization_id?: string
          review_at?: string | null
          scope?: string
          scope_id?: string | null
          source_id?: string | null
          source_kind?: string | null
          superseded_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_records_authored_by_agent_fkey"
            columns: ["authored_by_agent"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "memory_records_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "memory_records"
            referencedColumns: ["id"]
          },
        ]
      }
      models: {
        Row: {
          capabilities: string[]
          context_tokens: number | null
          created_at: string
          input_cost_minor_per_mtok: number | null
          model_id: string
          organization_id: string
          output_cost_minor_per_mtok: number | null
          provider: string
          status: string
          updated_at: string
        }
        Insert: {
          capabilities?: string[]
          context_tokens?: number | null
          created_at?: string
          input_cost_minor_per_mtok?: number | null
          model_id: string
          organization_id: string
          output_cost_minor_per_mtok?: number | null
          provider: string
          status?: string
          updated_at?: string
        }
        Update: {
          capabilities?: string[]
          context_tokens?: number | null
          created_at?: string
          input_cost_minor_per_mtok?: number | null
          model_id?: string
          organization_id?: string
          output_cost_minor_per_mtok?: number | null
          provider?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      routing_policies: {
        Row: {
          admin_override_model: string | null
          category: string
          created_at: string
          optimise_for: string
          organization_id: string
          preferred_models: string[]
          updated_at: string
        }
        Insert: {
          admin_override_model?: string | null
          category: string
          created_at?: string
          optimise_for?: string
          organization_id: string
          preferred_models?: string[]
          updated_at?: string
        }
        Update: {
          admin_override_model?: string | null
          category?: string
          created_at?: string
          optimise_for?: string
          organization_id?: string
          preferred_models?: string[]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      recall: {
        Args: { p_limit?: number; p_scope: string; p_scope_id?: string }
        Returns: {
          authored_by_agent: string | null
          confidence: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          fact: string
          id: string
          kind: string
          organization_id: string
          review_at: string | null
          scope: string
          scope_id: string | null
          source_id: string | null
          source_kind: string | null
          superseded_by: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "memory_records"
          isOneToOne: false
          isSetofReturn: true
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  approvals: {
    Tables: {
      approval_policies: {
        Row: {
          active: boolean
          audience: string
          created_at: string
          id: string
          min_amount_minor: number
          note: string | null
          organization_id: string
          required_role: string
          sla_hours: number
          subject_type: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          audience?: string
          created_at?: string
          id?: string
          min_amount_minor?: number
          note?: string | null
          organization_id: string
          required_role: string
          sla_hours: number
          subject_type: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          audience?: string
          created_at?: string
          id?: string
          min_amount_minor?: number
          note?: string | null
          organization_id?: string
          required_role?: string
          sla_hours?: number
          subject_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      approval_requests: {
        Row: {
          amount_minor: number | null
          audience: string
          client_contact_id: string | null
          correlation_id: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          escalated_from: string | null
          evidence_ref: string | null
          id: string
          organization_id: string
          payload: Json | null
          policy_id: string | null
          reference: string | null
          requested_by_id: string | null
          requested_by_type: string
          required_role: string
          sla_due_at: string
          state: string
          subject_id: string
          subject_type: string
          summary: string | null
        }
        Insert: {
          amount_minor?: number | null
          audience?: string
          client_contact_id?: string | null
          correlation_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          escalated_from?: string | null
          evidence_ref?: string | null
          id?: string
          organization_id: string
          payload?: Json | null
          policy_id?: string | null
          reference?: string | null
          requested_by_id?: string | null
          requested_by_type: string
          required_role: string
          sla_due_at: string
          state?: string
          subject_id: string
          subject_type: string
          summary?: string | null
        }
        Update: {
          amount_minor?: number | null
          audience?: string
          client_contact_id?: string | null
          correlation_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          escalated_from?: string | null
          evidence_ref?: string | null
          id?: string
          organization_id?: string
          payload?: Json | null
          policy_id?: string | null
          reference?: string | null
          requested_by_id?: string | null
          requested_by_type?: string
          required_role?: string
          sla_due_at?: string
          state?: string
          subject_id?: string
          subject_type?: string
          summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "approval_requests_escalated_from_fkey"
            columns: ["escalated_from"]
            isOneToOne: false
            referencedRelation: "approval_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "approval_requests_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "approval_policies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      cancel_request: {
        Args: { p_reason?: string; p_request_id: string }
        Returns: {
          outcome: string
          state: string
        }[]
      }
      decide_approval: {
        Args: {
          p_client_contact_id?: string
          p_decision: string
          p_evidence_ref?: string
          p_note?: string
          p_request_id: string
        }
        Returns: {
          decided_at: string
          outcome: string
          request_id: string
          state: string
        }[]
      }
      expire_overdue: {
        Args: { p_limit?: number }
        Returns: {
          escalation_id: string
          expired_id: string
          organization_id: string
          subject_type: string
        }[]
      }
      new_reference: { Args: never; Returns: string }
      request_approval: {
        Args: {
          p_amount_minor?: number
          p_audience?: string
          p_correlation_id?: string
          p_organization_id: string
          p_payload?: Json
          p_requested_by_id?: string
          p_requested_by_type: string
          p_subject_id: string
          p_subject_type: string
          p_summary?: string
        }
        Returns: {
          outcome: string
          request_id: string
          required_role: string
          sla_due_at: string
          state: string
        }[]
      }
      resolve_policy: {
        Args: {
          p_amount_minor?: number
          p_organization_id: string
          p_subject_type: string
        }
        Returns: {
          active: boolean
          audience: string
          created_at: string
          id: string
          min_amount_minor: number
          note: string | null
          organization_id: string
          required_role: string
          sla_hours: number
          subject_type: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "approval_policies"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_policy: {
        Args: {
          p_audience?: string
          p_min_amount_minor: number
          p_note?: string
          p_required_role: string
          p_sla_hours: number
          p_subject_type: string
        }
        Returns: {
          outcome: string
          policy_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  audit: {
    Tables: {
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: string
          after: Json | null
          before: Json | null
          correlation_id: string | null
          created_at: string
          id: number
          ip: unknown
          organization_id: string
          subject_id: string | null
          subject_type: string
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type: string
          after?: Json | null
          before?: Json | null
          correlation_id?: string | null
          created_at?: string
          id?: number
          ip?: unknown
          organization_id: string
          subject_id?: string | null
          subject_type: string
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: string
          after?: Json | null
          before?: Json | null
          correlation_id?: string | null
          created_at?: string
          id?: number
          ip?: unknown
          organization_id?: string
          subject_id?: string | null
          subject_type?: string
          user_agent?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  core: {
    Tables: {
      alert_state: {
        Row: {
          key: string
          last_sent_at: string
          signature: string
          updated_at: string
        }
        Insert: {
          key: string
          last_sent_at?: string
          signature: string
          updated_at?: string
        }
        Update: {
          key?: string
          last_sent_at?: string
          signature?: string
          updated_at?: string
        }
        Relationships: []
      }
      canonical_events: {
        Row: {
          emitted_as: string | null
          name: string
          position: number
        }
        Insert: {
          emitted_as?: string | null
          name: string
          position: number
        }
        Update: {
          emitted_as?: string | null
          name?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "canonical_events_emitted_as_fkey"
            columns: ["emitted_as"]
            isOneToOne: false
            referencedRelation: "event_types"
            referencedColumns: ["type"]
          },
        ]
      }
      client_accounts: {
        Row: {
          billing_email: string | null
          created_at: string
          currency: string
          id: string
          name: string
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          billing_email?: string | null
          created_at?: string
          currency?: string
          id?: string
          name: string
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          billing_email?: string | null
          created_at?: string
          currency?: string
          id?: string
          name?: string
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_accounts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      client_users: {
        Row: {
          client_account_id: string
          created_at: string
          id: string
          organization_id: string
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          client_account_id: string
          created_at?: string
          id?: string
          organization_id: string
          role?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          client_account_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_users_client_account_id_fkey"
            columns: ["client_account_id"]
            isOneToOne: false
            referencedRelation: "client_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_users_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_users_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      cron_heartbeat: {
        Row: {
          last_tick_at: string
          singleton: boolean
          ticks: number
        }
        Insert: {
          last_tick_at?: string
          singleton?: boolean
          ticks?: number
        }
        Update: {
          last_tick_at?: string
          singleton?: boolean
          ticks?: number
        }
        Relationships: []
      }
      event_types: {
        Row: {
          canonical: string | null
          description: string
          type: string
        }
        Insert: {
          canonical?: string | null
          description: string
          type: string
        }
        Update: {
          canonical?: string | null
          description?: string
          type?: string
        }
        Relationships: []
      }
      jobs: {
        Row: {
          attempts: number
          correlation_id: string | null
          created_at: string
          dedupe_key: string | null
          id: string
          kind: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          organization_id: string
          payload: Json
          priority: number
          run_at: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          correlation_id?: string | null
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          organization_id: string
          payload?: Json
          priority?: number
          run_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          correlation_id?: string | null
          created_at?: string
          dedupe_key?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          organization_id?: string
          payload?: Json
          priority?: number
          run_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          role: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          agent_answers_clients: boolean
          agent_writes_follow_ups: boolean
          created_at: string
          currency: string
          id: string
          name: string
          reactivation_pilot_enabled: boolean
          settings: Json
          slug: string
          timezone: string | null
          updated_at: string
        }
        Insert: {
          agent_answers_clients?: boolean
          agent_writes_follow_ups?: boolean
          created_at?: string
          currency?: string
          id?: string
          name: string
          reactivation_pilot_enabled?: boolean
          settings?: Json
          slug: string
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          agent_answers_clients?: boolean
          agent_writes_follow_ups?: boolean
          created_at?: string
          currency?: string
          id?: string
          name?: string
          reactivation_pilot_enabled?: boolean
          settings?: Json
          slug?: string
          timezone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      outbox_events: {
        Row: {
          attempts: number
          correlation_id: string | null
          created_at: string
          dead_at: string | null
          id: number
          organization_id: string
          payload: Json
          published_at: string | null
          subject_id: string | null
          subject_type: string | null
          type: string
        }
        Insert: {
          attempts?: number
          correlation_id?: string | null
          created_at?: string
          dead_at?: string | null
          id?: number
          organization_id: string
          payload?: Json
          published_at?: string | null
          subject_id?: string | null
          subject_type?: string | null
          type: string
        }
        Update: {
          attempts?: number
          correlation_id?: string | null
          created_at?: string
          dead_at?: string | null
          id?: number
          organization_id?: string
          payload?: Json
          published_at?: string | null
          subject_id?: string | null
          subject_type?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "outbox_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          actor_type: string
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          actor_type?: string
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          actor_type?: string
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      audit_invoker_writes_without_policy: {
        Args: never
        Returns: {
          op: string
          target: string
          writer: string
        }[]
      }
      audit_untenanted_write_policies: {
        Args: never
        Returns: {
          op: string
          policy_name: string
          roles: string
          target: string
        }[]
      }
      bootstrap_first_owner: { Args: { p_user_id: string }; Returns: string }
      can_manage_delivery: { Args: never; Returns: boolean }
      can_write: { Args: never; Returns: boolean }
      claim_agent_job: {
        Args: { p_kinds: string[]; p_worker_id: string }
        Returns: {
          attempts: number
          correlation_id: string | null
          created_at: string
          dedupe_key: string | null
          id: string
          kind: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          organization_id: string
          payload: Json
          priority: number
          run_at: string
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_alert: {
        Args: { p_cooldown_hours?: number; p_key: string; p_signature: string }
        Returns: string
      }
      claim_jobs: {
        Args: { p_batch_size?: number; p_kind: string; p_worker_id: string }
        Returns: {
          attempts: number
          correlation_id: string | null
          created_at: string
          dedupe_key: string | null
          id: string
          kind: string
          last_error: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          organization_id: string
          payload: Json
          priority: number
          run_at: string
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      clear_alert: { Args: { p_key: string }; Returns: boolean }
      cron_heartbeat_age_seconds: { Args: never; Returns: number }
      current_client_account_id: { Args: never; Returns: string }
      current_organization_id: { Args: never; Returns: string }
      current_user_role: { Args: never; Returns: string }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      emit_event: {
        Args: {
          p_correlation_id?: string
          p_organization_id: string
          p_payload?: Json
          p_subject_id: string
          p_subject_type: string
          p_type: string
        }
        Returns: number
      }
      event_coverage: {
        Args: never
        Returns: {
          canonical: string
          emitted_as: string
          state: string
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      is_client: { Args: never; Returns: boolean }
      is_internal: { Args: never; Returns: boolean }
      is_owner: { Args: never; Returns: boolean }
      operational_backlog: {
        Args: never
        Returns: {
          dead_events: number
          dead_jobs: number
          oldest_dead_at: string
          oldest_overdue_due_at: string
          oldest_unpublished_at: string
          overdue_approvals: number
          stalled_jobs: number
          stuck_queued_jobs: number
          unpublished_events: number
        }[]
      }
      reap_stalled_jobs: { Args: { stall_timeout?: string }; Returns: number }
      record_audit: {
        Args: {
          p_action: string
          p_after?: Json
          p_before?: Json
          p_correlation_id?: string
          p_organization_id: string
          p_subject_id: string
          p_subject_type: string
        }
        Returns: undefined
      }
      record_cron_tick: { Args: never; Returns: string }
      release_alert: {
        Args: { p_claimed_at: string; p_key: string }
        Returns: boolean
      }
      requeue_job: {
        Args: { p_job_id: string }
        Returns: {
          attempts: number
          job_status: string
          outcome: string
        }[]
      }
      security_posture: { Args: never; Returns: Json }
      set_agency_timezone: {
        Args: { p_organization_id: string; p_timezone: string }
        Returns: {
          outcome: string
        }[]
      }
      set_organization_name: {
        Args: { p_name: string; p_organization_id: string }
        Returns: {
          outcome: string
        }[]
      }
      set_organization_setting: {
        Args: { p_key: string; p_organization_id: string; p_value: string }
        Returns: {
          outcome: string
        }[]
      }
      set_reactivation_pilot: {
        Args: { p_enabled: boolean; p_organization_id: string }
        Returns: {
          outcome: string
        }[]
      }
      shares_organization: {
        Args: { target_user_id: string }
        Returns: boolean
      }
      unfrozen_org_tables: {
        Args: never
        Returns: {
          org_table: string
        }[]
      }
      unguarded_org_fks: {
        Args: never
        Returns: {
          child: string
          fk_column: string
          parent: string
        }[]
      }
      wedged_follow_ups: {
        Args: never
        Returns: {
          oldest_due_at: string
          reason: string
          wedged: number
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  crm: {
    Tables: {
      check_in_briefs: {
        Row: {
          created_at: string
          drafted_by: string | null
          drafted_by_agent: string | null
          handover_id: string
          id: string
          organization_id: string
          project_id: string
        }
        Insert: {
          created_at?: string
          drafted_by?: string | null
          drafted_by_agent?: string | null
          handover_id: string
          id?: string
          organization_id: string
          project_id: string
        }
        Update: {
          created_at?: string
          drafted_by?: string | null
          drafted_by_agent?: string | null
          handover_id?: string
          id?: string
          organization_id?: string
          project_id?: string
        }
        Relationships: []
      }
      check_in_points: {
        Row: {
          brief_id: string
          created_at: string
          id: string
          kind: string
          maintenance_item_id: string | null
          note: string
          organization_id: string
        }
        Insert: {
          brief_id: string
          created_at?: string
          id?: string
          kind: string
          maintenance_item_id?: string | null
          note: string
          organization_id: string
        }
        Update: {
          brief_id?: string
          created_at?: string
          id?: string
          kind?: string
          maintenance_item_id?: string | null
          note?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "check_in_points_brief_id_fkey"
            columns: ["brief_id"]
            isOneToOne: false
            referencedRelation: "check_in_briefs"
            referencedColumns: ["id"]
          },
        ]
      }
      communication_consent: {
        Row: {
          channel: string
          contact_id: string
          created_at: string
          note: string | null
          organization_id: string
          recorded_at: string
          recorded_by: string | null
          source: string | null
          status: string
          updated_at: string
        }
        Insert: {
          channel: string
          contact_id: string
          created_at?: string
          note?: string | null
          organization_id: string
          recorded_at?: string
          recorded_by?: string | null
          source?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          channel?: string
          contact_id?: string
          created_at?: string
          note?: string | null
          organization_id?: string
          recorded_at?: string
          recorded_by?: string | null
          source?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "communication_consent_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          client_account_id: string | null
          company: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          job_title: string | null
          notes: string | null
          organization_id: string
          phone: string | null
          preferred_language: string | null
          preferred_language_set_by: string | null
          updated_at: string
        }
        Insert: {
          client_account_id?: string | null
          company?: string | null
          created_at?: string
          email?: string | null
          full_name: string
          id?: string
          job_title?: string | null
          notes?: string | null
          organization_id: string
          phone?: string | null
          preferred_language?: string | null
          preferred_language_set_by?: string | null
          updated_at?: string
        }
        Update: {
          client_account_id?: string | null
          company?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          job_title?: string | null
          notes?: string | null
          organization_id?: string
          phone?: string | null
          preferred_language?: string | null
          preferred_language_set_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_client_account_id_fkey"
            columns: ["client_account_id"]
            isOneToOne: false
            referencedRelation: "client_relationship_facts"
            referencedColumns: ["client_account_id"]
          },
        ]
      }
      conversation_messages: {
        Row: {
          author_id: string | null
          author_type: string
          authored_by_agent: string | null
          body: string
          conversation_id: string
          created_at: string
          external_ref: string | null
          id: string
          intent: string | null
          intent_by_agent: string | null
          language: string | null
          media_description: string | null
          media_read_at: string | null
          media_read_by_agent: string | null
          metadata: Json
          occurred_at: string
          organization_id: string
          seq: number
        }
        Insert: {
          author_id?: string | null
          author_type: string
          authored_by_agent?: string | null
          body: string
          conversation_id: string
          created_at?: string
          external_ref?: string | null
          id?: string
          intent?: string | null
          intent_by_agent?: string | null
          language?: string | null
          media_description?: string | null
          media_read_at?: string | null
          media_read_by_agent?: string | null
          metadata?: Json
          occurred_at?: string
          organization_id: string
          seq: number
        }
        Update: {
          author_id?: string | null
          author_type?: string
          authored_by_agent?: string | null
          body?: string
          conversation_id?: string
          created_at?: string
          external_ref?: string | null
          id?: string
          intent?: string | null
          intent_by_agent?: string | null
          language?: string | null
          media_description?: string | null
          media_read_at?: string | null
          media_read_by_agent?: string | null
          metadata?: Json
          occurred_at?: string
          organization_id?: string
          seq?: number
        }
        Relationships: [
          {
            foreignKeyName: "conversation_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          agent_paused_at: string | null
          agent_paused_reason: string | null
          channel: string
          client_account_id: string | null
          contact_id: string | null
          created_at: string
          external_ref: string | null
          id: string
          inbound_number_id: string | null
          kind: string
          lead_id: string | null
          organization_id: string
          project_id: string | null
          status: string
          title: string | null
          updated_at: string
        }
        Insert: {
          agent_paused_at?: string | null
          agent_paused_reason?: string | null
          channel?: string
          client_account_id?: string | null
          contact_id?: string | null
          created_at?: string
          external_ref?: string | null
          id?: string
          inbound_number_id?: string | null
          kind?: string
          lead_id?: string | null
          organization_id: string
          project_id?: string | null
          status?: string
          title?: string | null
          updated_at?: string
        }
        Update: {
          agent_paused_at?: string | null
          agent_paused_reason?: string | null
          channel?: string
          client_account_id?: string | null
          contact_id?: string | null
          created_at?: string
          external_ref?: string | null
          id?: string
          inbound_number_id?: string | null
          kind?: string
          lead_id?: string | null
          organization_id?: string
          project_id?: string | null
          status?: string
          title?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_client_account_id_fkey"
            columns: ["client_account_id"]
            isOneToOne: false
            referencedRelation: "client_relationship_facts"
            referencedColumns: ["client_account_id"]
          },
          {
            foreignKeyName: "conversations_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_up_sends: {
        Row: {
          attempt: number
          created_at: string
          decided_at: string
          id: string
          message_id: string | null
          organization_id: string
          outcome: string
          scheduled_for: string
          sequence_id: string
          suppression_reason: string | null
        }
        Insert: {
          attempt: number
          created_at?: string
          decided_at?: string
          id?: string
          message_id?: string | null
          organization_id: string
          outcome: string
          scheduled_for: string
          sequence_id: string
          suppression_reason?: string | null
        }
        Update: {
          attempt?: number
          created_at?: string
          decided_at?: string
          id?: string
          message_id?: string | null
          organization_id?: string
          outcome?: string
          scheduled_for?: string
          sequence_id?: string
          suppression_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "follow_up_sends_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "conversation_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_sends_sequence_id_fkey"
            columns: ["sequence_id"]
            isOneToOne: false
            referencedRelation: "follow_up_sequences"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_up_sequences: {
        Row: {
          attempts_sent: number
          contact_id: string | null
          conversation_id: string | null
          correlation_id: string
          created_at: string
          drafted_at: string | null
          drafted_body: string | null
          drafted_by_agent: string | null
          drafted_language: string | null
          escalated_at: string | null
          id: string
          last_block_reason: string | null
          last_evaluated_at: string | null
          last_sent_at: string | null
          next_due_at: string | null
          organization_id: string
          situation_key: string
          status: string
          stop_reason: string | null
          subject_id: string
          subject_type: string
          triggered_at: string
          updated_at: string
        }
        Insert: {
          attempts_sent?: number
          contact_id?: string | null
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          drafted_at?: string | null
          drafted_body?: string | null
          drafted_by_agent?: string | null
          drafted_language?: string | null
          escalated_at?: string | null
          id?: string
          last_block_reason?: string | null
          last_evaluated_at?: string | null
          last_sent_at?: string | null
          next_due_at?: string | null
          organization_id: string
          situation_key: string
          status?: string
          stop_reason?: string | null
          subject_id: string
          subject_type: string
          triggered_at: string
          updated_at?: string
        }
        Update: {
          attempts_sent?: number
          contact_id?: string | null
          conversation_id?: string | null
          correlation_id?: string
          created_at?: string
          drafted_at?: string | null
          drafted_body?: string | null
          drafted_by_agent?: string | null
          drafted_language?: string | null
          escalated_at?: string | null
          id?: string
          last_block_reason?: string | null
          last_evaluated_at?: string | null
          last_sent_at?: string | null
          next_due_at?: string | null
          organization_id?: string
          situation_key?: string
          status?: string
          stop_reason?: string | null
          subject_id?: string
          subject_type?: string
          triggered_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_up_sequences_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_up_sequences_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batches: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          organization_id: string
          source_label: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          organization_id: string
          source_label: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          organization_id?: string
          source_label?: string
        }
        Relationships: []
      }
      import_records: {
        Row: {
          auto_importable: boolean
          batch_id: string
          classification: string
          committed_at: string | null
          committed_contact_id: string | null
          committed_lead_id: string | null
          created_at: string
          display_name: string
          id: string
          matched_contact_id: string | null
          message_count: number
          organization_id: string
          phone: string | null
          source_label: string
        }
        Insert: {
          auto_importable?: boolean
          batch_id: string
          classification: string
          committed_at?: string | null
          committed_contact_id?: string | null
          committed_lead_id?: string | null
          created_at?: string
          display_name: string
          id?: string
          matched_contact_id?: string | null
          message_count?: number
          organization_id: string
          phone?: string | null
          source_label: string
        }
        Update: {
          auto_importable?: boolean
          batch_id?: string
          classification?: string
          committed_at?: string | null
          committed_contact_id?: string | null
          committed_lead_id?: string | null
          created_at?: string
          display_name?: string
          id?: string
          matched_contact_id?: string | null
          message_count?: number
          organization_id?: string
          phone?: string | null
          source_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_records_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_records_committed_contact_id_fkey"
            columns: ["committed_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_records_committed_lead_id_fkey"
            columns: ["committed_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_records_matched_contact_id_fkey"
            columns: ["matched_contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_activities: {
        Row: {
          actor_id: string | null
          actor_type: string
          body: string | null
          created_at: string
          id: string
          kind: string
          lead_id: string
          metadata: Json
          occurred_at: string
          organization_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_type?: string
          body?: string | null
          created_at?: string
          id?: string
          kind: string
          lead_id: string
          metadata?: Json
          occurred_at?: string
          organization_id: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          body?: string | null
          created_at?: string
          id?: string
          kind?: string
          lead_id?: string
          metadata?: Json
          occurred_at?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          assigned_to: string | null
          contact_id: string | null
          converted_at: string | null
          created_at: string
          deleted_at: string | null
          disqualified_reason: string | null
          id: string
          in_reactivation_pilot: boolean
          next_follow_up_at: string | null
          organization_id: string
          qualification: Json
          qualified_at: string | null
          requirements: Json
          score: number | null
          score_reasons: Json | null
          source: string
          source_ref: string | null
          status: string
          summary: string | null
          tags: string[]
          title: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          contact_id?: string | null
          converted_at?: string | null
          created_at?: string
          deleted_at?: string | null
          disqualified_reason?: string | null
          id?: string
          in_reactivation_pilot?: boolean
          next_follow_up_at?: string | null
          organization_id: string
          qualification?: Json
          qualified_at?: string | null
          requirements?: Json
          score?: number | null
          score_reasons?: Json | null
          source?: string
          source_ref?: string | null
          status?: string
          summary?: string | null
          tags?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          contact_id?: string | null
          converted_at?: string | null
          created_at?: string
          deleted_at?: string | null
          disqualified_reason?: string | null
          id?: string
          in_reactivation_pilot?: boolean
          next_follow_up_at?: string | null
          organization_id?: string
          qualification?: Json
          qualified_at?: string | null
          requirements?: Json
          score?: number | null
          score_reasons?: Json | null
          source?: string
          source_ref?: string | null
          status?: string
          summary?: string | null
          tags?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "leads_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_items: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          kind: string
          organization_id: string
          position: number
          title: string
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          kind: string
          organization_id: string
          position?: number
          title: string
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          organization_id?: string
          position?: number
          title?: string
          updated_at?: string
          url?: string
        }
        Relationships: []
      }
      qualification_coverage: {
        Row: {
          area: string
          conversation_id: string
          created_at: string
          id: string
          lead_id: string
          organization_id: string
          quote: string
          read_by_agent: string | null
        }
        Insert: {
          area: string
          conversation_id: string
          created_at?: string
          id?: string
          lead_id: string
          organization_id: string
          quote: string
          read_by_agent?: string | null
        }
        Update: {
          area?: string
          conversation_id?: string
          created_at?: string
          id?: string
          lead_id?: string
          organization_id?: string
          quote?: string
          read_by_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qualification_coverage_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qualification_coverage_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      requirement_versions: {
        Row: {
          conversation_id: string
          created_at: string
          created_by: string | null
          generated_by_run_id: string | null
          id: string
          organization_id: string
          payload: Json
          source: string
          source_job_id: string | null
          source_message_count: number | null
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          conversation_id: string
          created_at?: string
          created_by?: string | null
          generated_by_run_id?: string | null
          id?: string
          organization_id: string
          payload?: Json
          source: string
          source_job_id?: string | null
          source_message_count?: number | null
          status?: string
          updated_at?: string
          version: number
        }
        Update: {
          conversation_id?: string
          created_at?: string
          created_by?: string | null
          generated_by_run_id?: string | null
          id?: string
          organization_id?: string
          payload?: Json
          source?: string
          source_job_id?: string | null
          source_message_count?: number | null
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "requirement_versions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      client_relationship_facts: {
        Row: {
          client_account_id: string | null
          client_name: string | null
          first_project_at: string | null
          last_project_at: string | null
          maintenance_items_open: number | null
          net_received_minor: number | null
          organization_id: string | null
          payments_received_minor: number | null
          payments_refunded_minor: number | null
          projects_completed: number | null
          projects_total: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      add_lead_to_reactivation_pilot: {
        Args: { p_lead_id: string }
        Returns: {
          outcome: string
        }[]
      }
      awaits_media_reading: {
        Args: { p_media_read_at: string; p_metadata: Json }
        Returns: boolean
      }
      commit_import_record: {
        Args: { p_record_id: string }
        Returns: {
          contact_id: string
          lead_id: string
          outcome: string
        }[]
      }
      due_follow_up_sequences: {
        Args: { p_limit?: number }
        Returns: {
          attempts_sent: number
          contact_id: string
          conversation_id: string
          correlation_id: string
          organization_id: string
          sequence_id: string
          situation_key: string
          subject_id: string
          subject_type: string
          triggered_at: string
        }[]
      }
      ensure_client_account_conversation: {
        Args: { p_contact_id?: string; p_project_id: string }
        Returns: string
      }
      escalate_follow_up_sequence: {
        Args: { p_reason: string; p_sequence_id: string }
        Returns: boolean
      }
      hand_conversation_to_a_person: {
        Args: { p_conversation: string; p_reason: string }
        Returns: boolean
      }
      ingest_group_message: {
        Args: {
          p_body: string
          p_external_ref: string
          p_from: string
          p_group_id: string
          p_occurred_at?: string
          p_phone_number_id: string
        }
        Returns: {
          conversation_id: string
          message_id: string
          message_seq: number
          organization_id: string
          status: string
        }[]
      }
      ingest_whatsapp_message: {
        Args: {
          p_body: string
          p_caption?: string
          p_external_ref: string
          p_from: string
          p_media_id?: string
          p_media_type?: string
          p_occurred_at?: string
          p_phone_number_id: string
          p_profile_name?: string
        }
        Returns: {
          contact_id: string
          conversation_id: string
          job_id: string
          lead_id: string
          message_id: string
          message_seq: number
          organization_id: string
          status: string
        }[]
      }
      insert_requirement_version: {
        Args: {
          p_conversation_id: string
          p_generated_by_run_id?: string
          p_organization_id: string
          p_payload: Json
          p_source: string
          p_source_job_id?: string
          p_source_message_count?: number
          p_status: string
        }
        Returns: {
          id: string
          version: number
        }[]
      }
      lead_attention: {
        Args: { p_limit?: number; p_organization_id?: string }
        Returns: {
          lead_id: string
          reason: string
          status: string
          title: string
          waiting_since: string
        }[]
      }
      link_internal_recipient: {
        Args: { p_organization_id: string; p_phone: string; p_title?: string }
        Returns: {
          conversation_id: string
          outcome: string
        }[]
      }
      link_whatsapp_group: {
        Args: {
          p_external_ref: string
          p_kind: string
          p_organization_id: string
          p_project_id?: string
          p_title?: string
        }
        Returns: {
          conversation_id: string
          outcome: string
        }[]
      }
      mark_outbound_delivery: {
        Args: {
          p_error?: string
          p_message_id: string
          p_provider_ref?: string
          p_status: string
        }
        Returns: boolean
      }
      observe_follow_up_candidates: {
        Args: { p_limit?: number }
        Returns: {
          contact_id: string
          conversation_id: string
          organization_id: string
          situation_key: string
          subject_id: string
          subject_type: string
          triggered_at: string
        }[]
      }
      reactivation_priority: {
        Args: { p_limit?: number; p_organization_id?: string }
        Returns: {
          contact_id: string
          last_active_at: string
          lead_id: string
          phone: string
          tier: number
          tier_name: string
        }[]
      }
      record_delivery_receipt: {
        Args: {
          p_occurred_at?: string
          p_phone_number_id: string
          p_provider_ref: string
          p_status: string
        }
        Returns: string
      }
      remove_lead_from_reactivation_pilot: {
        Args: { p_lead_id: string }
        Returns: {
          outcome: string
        }[]
      }
      resume_agent_replies: {
        Args: { p_conversation: string }
        Returns: boolean
      }
      returning_clients: {
        Args: { p_since?: string }
        Returns: {
          last_message: string
          lead_id: string
          lead_status: string
          messages: number
          title: string
        }[]
      }
      sales_funnel: {
        Args: { p_from?: string; p_organization_id?: string; p_to?: string }
        Returns: {
          budget_known: number
          engaged: number
          hours_to_first_quote: number
          hours_to_first_reply: number
          hours_to_won: number
          leads: number
          lost: number
          negotiating: number
          qualified: number
          quoted: number
          requirements_accepted: number
          responded: number
          won: number
        }[]
      }
      send_outbound_message: {
        Args: {
          p_author_id?: string
          p_body: string
          p_conversation_id: string
          p_external_ref: string
          p_media_filename?: string
          p_media_type?: string
        }
        Returns: {
          delivery: string
          from_phone_number_id: string
          message_id: string
          outcome: string
          recipient_type: string
          seq: number
          to_phone: string
        }[]
      }
      start_follow_up_sequence: {
        Args: {
          p_contact_id?: string
          p_conversation_id?: string
          p_organization_id: string
          p_situation_key: string
          p_subject_id: string
          p_subject_type: string
          p_triggered_at: string
        }
        Returns: {
          created: boolean
          sequence_id: string
        }[]
      }
      states_a_price: { Args: { p_body: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  finance: {
    Tables: {
      invoice_items: {
        Row: {
          amount_minor: number
          created_at: string
          description: string
          id: string
          invoice_id: string
          organization_id: string
          position: number
          quantity: number
          tax_rate_bp: number
          unit_price_minor: number
        }
        Insert: {
          amount_minor?: number
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          organization_id: string
          position?: number
          quantity?: number
          tax_rate_bp?: number
          unit_price_minor?: number
        }
        Update: {
          amount_minor?: number
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          organization_id?: string
          position?: number
          quantity?: number
          tax_rate_bp?: number
          unit_price_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          client_account_id: string
          created_at: string
          currency: string
          due_at: string | null
          id: string
          issued_at: string | null
          milestone_id: string | null
          notes: string | null
          number: string
          organization_id: string
          paid_at: string | null
          paid_minor: number
          project_id: string | null
          provider_ref: string | null
          status: string
          subtotal_minor: number
          tax_minor: number
          total_minor: number
          updated_at: string
          verified_minor: number
        }
        Insert: {
          client_account_id: string
          created_at?: string
          currency?: string
          due_at?: string | null
          id?: string
          issued_at?: string | null
          milestone_id?: string | null
          notes?: string | null
          number: string
          organization_id: string
          paid_at?: string | null
          paid_minor?: number
          project_id?: string | null
          provider_ref?: string | null
          status?: string
          subtotal_minor?: number
          tax_minor?: number
          total_minor?: number
          updated_at?: string
          verified_minor?: number
        }
        Update: {
          client_account_id?: string
          created_at?: string
          currency?: string
          due_at?: string | null
          id?: string
          issued_at?: string | null
          milestone_id?: string | null
          notes?: string | null
          number?: string
          organization_id?: string
          paid_at?: string | null
          paid_minor?: number
          project_id?: string | null
          provider_ref?: string | null
          status?: string
          subtotal_minor?: number
          tax_minor?: number
          total_minor?: number
          updated_at?: string
          verified_minor?: number
        }
        Relationships: []
      }
      payment_accounts: {
        Row: {
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          id: string
          instructions: Json
          kind: string
          label: string
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          instructions?: Json
          kind: string
          label: string
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          instructions?: Json
          kind?: string
          label?: string
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      payment_submissions: {
        Row: {
          account_id: string | null
          amount_minor: number
          created_at: string
          currency: string
          id: string
          invoice_id: string
          method: string
          organization_id: string
          paid_at: string | null
          payer_name: string | null
          payment_id: string | null
          proof_url: string | null
          reference: string | null
          rejected_reason: string | null
          status: string
          submitted_at: string
          submitted_by: string | null
          submitted_by_agent: string | null
          updated_at: string
          verification_evidence: string | null
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          account_id?: string | null
          amount_minor: number
          created_at?: string
          currency?: string
          id?: string
          invoice_id: string
          method: string
          organization_id: string
          paid_at?: string | null
          payer_name?: string | null
          payment_id?: string | null
          proof_url?: string | null
          reference?: string | null
          rejected_reason?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          submitted_by_agent?: string | null
          updated_at?: string
          verification_evidence?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          account_id?: string | null
          amount_minor?: number
          created_at?: string
          currency?: string
          id?: string
          invoice_id?: string
          method?: string
          organization_id?: string
          paid_at?: string | null
          payer_name?: string | null
          payment_id?: string | null
          proof_url?: string | null
          reference?: string | null
          rejected_reason?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          submitted_by_agent?: string | null
          updated_at?: string
          verification_evidence?: string | null
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_submissions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "payment_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_submissions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_submissions_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_minor: number
          captured_at: string | null
          created_at: string
          currency: string
          id: string
          invoice_id: string
          organization_id: string
          provider: string
          provider_payment_id: string
          status: string
          updated_at: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          amount_minor: number
          captured_at?: string | null
          created_at?: string
          currency?: string
          id?: string
          invoice_id: string
          organization_id: string
          provider?: string
          provider_payment_id: string
          status: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          amount_minor?: number
          captured_at?: string | null
          created_at?: string
          currency?: string
          id?: string
          invoice_id?: string
          organization_id?: string
          provider?: string
          provider_payment_id?: string
          status?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_items: {
        Row: {
          amount_minor: number
          created_at: string
          finding: string
          id: string
          organization_id: string
          payment_id: string | null
          reason: string | null
          reconciliation_id: string
          reference: string | null
          statement_date: string
          statement_line: string
        }
        Insert: {
          amount_minor: number
          created_at?: string
          finding: string
          id?: string
          organization_id: string
          payment_id?: string | null
          reason?: string | null
          reconciliation_id: string
          reference?: string | null
          statement_date: string
          statement_line: string
        }
        Update: {
          amount_minor?: number
          created_at?: string
          finding?: string
          id?: string
          organization_id?: string
          payment_id?: string | null
          reason?: string | null
          reconciliation_id?: string
          reference?: string | null
          statement_date?: string
          statement_line?: string
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_items_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_items_reconciliation_id_fkey"
            columns: ["reconciliation_id"]
            isOneToOne: false
            referencedRelation: "reconciliations"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliations: {
        Row: {
          account_id: string | null
          closed_at: string | null
          closed_by: string | null
          id: string
          opened_at: string
          opened_by: string | null
          organization_id: string
          period_end: string
          period_start: string
          source: string
          status: string
        }
        Insert: {
          account_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          id?: string
          opened_at?: string
          opened_by?: string | null
          organization_id: string
          period_end: string
          period_start: string
          source: string
          status?: string
        }
        Update: {
          account_id?: string | null
          closed_at?: string | null
          closed_by?: string | null
          id?: string
          opened_at?: string
          opened_by?: string | null
          organization_id?: string
          period_end?: string
          period_start?: string
          source?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "reconciliations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "payment_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      refunds: {
        Row: {
          amount_minor: number
          approval_request_id: string | null
          created_at: string
          id: string
          invoice_id: string
          organization_id: string
          provider: string
          provider_refund_id: string | null
          reason: string
          recorded_at: string | null
          recorded_by: string | null
          requested_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount_minor: number
          approval_request_id?: string | null
          created_at?: string
          id?: string
          invoice_id: string
          organization_id: string
          provider?: string
          provider_refund_id?: string | null
          reason: string
          recorded_at?: string | null
          recorded_by?: string | null
          requested_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount_minor?: number
          approval_request_id?: string | null
          created_at?: string
          id?: string
          invoice_id?: string
          organization_id?: string
          provider?: string
          provider_refund_id?: string | null
          reason?: string
          recorded_at?: string | null
          recorded_by?: string | null
          requested_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "refunds_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      blocking_invoice_number: {
        Args: { p_organization_id: string; p_project_id: string }
        Returns: string
      }
      create_milestone_invoice: {
        Args: {
          p_client_account_id: string
          p_currency: string
          p_due_at?: string
          p_lines: Json
          p_milestone_id: string
          p_notes?: string
          p_number: string
          p_organization_id: string
          p_project_id: string
          p_subtotal_minor: number
          p_tax_minor: number
          p_total_minor: number
        }
        Returns: {
          invoice_id: string
          number: string
          outcome: string
        }[]
      }
      issue_invoice: {
        Args: { p_due_at?: string; p_invoice_id: string }
        Returns: {
          invoice_status: string
          outcome: string
        }[]
      }
      mark_overdue_invoices: {
        Args: { p_limit?: number }
        Returns: {
          invoice_id: string
          invoice_number: string
          organization_id: string
        }[]
      }
      net_received_minor: { Args: { p_invoice_id: string }; Returns: number }
      net_verified_minor: { Args: { p_invoice_id: string }; Returns: number }
      next_unlocked_milestone: {
        Args: { p_organization_id: string; p_project_id: string }
        Returns: string
      }
      propose_match: {
        Args: { p_item_id: string }
        Returns: {
          candidates: number
          outcome: string
          payment_id: string
        }[]
      }
      record_manual_payment: {
        Args: {
          p_amount_minor: number
          p_captured_at: string
          p_invoice_id: string
          p_method: string
          p_provider_payment_id: string
        }
        Returns: {
          captured_before_minor: number
          invoice_status: string
          outcome: string
          paid_after_minor: number
          payment_id: string
          status_after: string
          unlocked_milestone_id: string
        }[]
      }
      record_refund: {
        Args: {
          p_provider_refund_id: string
          p_recorded_by?: string
          p_refund_id: string
        }
        Returns: {
          net_received: number
          outcome: string
          refund_id: string
        }[]
      }
      request_refund: {
        Args: {
          p_amount_minor: number
          p_invoice_id: string
          p_reason: string
          p_requested_by?: string
        }
        Returns: {
          net_received: number
          outcome: string
          refund_id: string
          request_id: string
        }[]
      }
      verify_payment: {
        Args: { p_payment_id: string; p_verified_by: string }
        Returns: {
          invoice_id: string
          outcome: string
          status_after: string
          unlocked_milestone_id: string
          verified_after_minor: number
        }[]
      }
      verify_payment_submission: {
        Args: {
          p_approve?: boolean
          p_evidence: string
          p_reason?: string
          p_submission_id: string
          p_verified_by: string
        }
        Returns: {
          outcome: string
          status: string
        }[]
      }
      void_invoice: {
        Args: { p_invoice_id: string; p_note: string }
        Returns: {
          captured_minor: number
          invoice_status: string
          outcome: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  projects: {
    Tables: {
      change_requests: {
        Row: {
          approval_request_id: string | null
          classification: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          effort_hours: number | null
          evidence_message_id: string | null
          id: string
          impact_notes: string | null
          organization_id: string
          project_id: string
          proposal_id: string | null
          requested: string
          requested_by: string | null
          resulting_scope_version_id: string | null
          scope_version_id: string
          source: string
          status: string
          timeline_days: number | null
          updated_at: string
        }
        Insert: {
          approval_request_id?: string | null
          classification?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          effort_hours?: number | null
          evidence_message_id?: string | null
          id?: string
          impact_notes?: string | null
          organization_id: string
          project_id: string
          proposal_id?: string | null
          requested: string
          requested_by?: string | null
          resulting_scope_version_id?: string | null
          scope_version_id: string
          source?: string
          status?: string
          timeline_days?: number | null
          updated_at?: string
        }
        Update: {
          approval_request_id?: string | null
          classification?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          effort_hours?: number | null
          evidence_message_id?: string | null
          id?: string
          impact_notes?: string | null
          organization_id?: string
          project_id?: string
          proposal_id?: string | null
          requested?: string
          requested_by?: string | null
          resulting_scope_version_id?: string | null
          scope_version_id?: string
          source?: string
          status?: string
          timeline_days?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "change_requests_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_requests_resulting_scope_version_id_fkey"
            columns: ["resulting_scope_version_id"]
            isOneToOne: false
            referencedRelation: "scope_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_requests_scope_version_id_fkey"
            columns: ["scope_version_id"]
            isOneToOne: false
            referencedRelation: "scope_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      completion_records: {
        Row: {
          blocking_defects: number
          client_accepted_at: string | null
          client_account_id: string
          completed_at: string
          completed_by: string | null
          created_at: string
          handover_delivered_at: string | null
          id: string
          invoiced_minor: number
          known_limitations: string | null
          open_defects: number
          organization_id: string
          override_reason: string | null
          project_id: string
          scope_version: number | null
          scope_version_id: string | null
          verified_minor: number
          warranty_note: string | null
        }
        Insert: {
          blocking_defects?: number
          client_accepted_at?: string | null
          client_account_id: string
          completed_at: string
          completed_by?: string | null
          created_at?: string
          handover_delivered_at?: string | null
          id?: string
          invoiced_minor?: number
          known_limitations?: string | null
          open_defects?: number
          organization_id: string
          override_reason?: string | null
          project_id: string
          scope_version?: number | null
          scope_version_id?: string | null
          verified_minor?: number
          warranty_note?: string | null
        }
        Update: {
          blocking_defects?: number
          client_accepted_at?: string | null
          client_account_id?: string
          completed_at?: string
          completed_by?: string | null
          created_at?: string
          handover_delivered_at?: string | null
          id?: string
          invoiced_minor?: number
          known_limitations?: string | null
          open_defects?: number
          organization_id?: string
          override_reason?: string | null
          project_id?: string
          scope_version?: number | null
          scope_version_id?: string | null
          verified_minor?: number
          warranty_note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "completion_records_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "completion_records_scope_version_id_fkey"
            columns: ["scope_version_id"]
            isOneToOne: false
            referencedRelation: "scope_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      deliverables: {
        Row: {
          approval_request_id: string | null
          artifact_url: string | null
          changelog: string | null
          created_at: string
          created_by: string | null
          id: string
          kind: string
          known_issues: string | null
          module_id: string | null
          organization_id: string
          project_id: string
          status: string
          test_access_method: string | null
          title: string
          updated_at: string
          version: number
        }
        Insert: {
          approval_request_id?: string | null
          artifact_url?: string | null
          changelog?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          known_issues?: string | null
          module_id?: string | null
          organization_id: string
          project_id: string
          status?: string
          test_access_method?: string | null
          title: string
          updated_at?: string
          version: number
        }
        Update: {
          approval_request_id?: string | null
          artifact_url?: string | null
          changelog?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          known_issues?: string | null
          module_id?: string | null
          organization_id?: string
          project_id?: string
          status?: string
          test_access_method?: string | null
          title?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "deliverables_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliverables_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      features: {
        Row: {
          created_at: string
          description: string | null
          id: string
          module_id: string
          name: string
          organization_id: string
          position: number
          project_id: string
          requirement_version_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          module_id: string
          name: string
          organization_id: string
          position?: number
          project_id: string
          requirement_version_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          module_id?: string
          name?: string
          organization_id?: string
          position?: number
          project_id?: string
          requirement_version_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "features_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "features_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      handover_items: {
        Row: {
          created_at: string
          handover_id: string
          id: string
          kind: string
          label: string
          notes: string | null
          organization_id: string
          reference: string | null
          transfer_method: string | null
        }
        Insert: {
          created_at?: string
          handover_id: string
          id?: string
          kind: string
          label: string
          notes?: string | null
          organization_id: string
          reference?: string | null
          transfer_method?: string | null
        }
        Update: {
          created_at?: string
          handover_id?: string
          id?: string
          kind?: string
          label?: string
          notes?: string | null
          organization_id?: string
          reference?: string | null
          transfer_method?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handover_items_handover_id_fkey"
            columns: ["handover_id"]
            isOneToOne: false
            referencedRelation: "handovers"
            referencedColumns: ["id"]
          },
        ]
      }
      handover_requirements: {
        Row: {
          created_at: string
          drafted_by_agent: string | null
          handover_id: string
          id: string
          kind: string
          label: string
          organization_id: string
          reason: string
        }
        Insert: {
          created_at?: string
          drafted_by_agent?: string | null
          handover_id: string
          id?: string
          kind: string
          label: string
          organization_id: string
          reason: string
        }
        Update: {
          created_at?: string
          drafted_by_agent?: string | null
          handover_id?: string
          id?: string
          kind?: string
          label?: string
          organization_id?: string
          reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "handover_requirements_handover_id_fkey"
            columns: ["handover_id"]
            isOneToOne: false
            referencedRelation: "handovers"
            referencedColumns: ["id"]
          },
        ]
      }
      handovers: {
        Row: {
          accepted_at: string | null
          approval_request_id: string | null
          created_at: string
          delivered_at: string | null
          delivered_by: string | null
          id: string
          organization_id: string
          project_id: string
          status: string
          summary: string | null
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          approval_request_id?: string | null
          created_at?: string
          delivered_at?: string | null
          delivered_by?: string | null
          id?: string
          organization_id: string
          project_id: string
          status?: string
          summary?: string | null
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          approval_request_id?: string | null
          created_at?: string
          delivered_at?: string | null
          delivered_by?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          status?: string
          summary?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handovers_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_items: {
        Row: {
          change_request_id: string | null
          client_account_id: string
          closed_at: string | null
          closed_by: string | null
          coverage: string | null
          created_at: string
          description: string | null
          id: string
          organization_id: string
          plan_id: string | null
          project_id: string
          raised_at: string
          raised_by: string | null
          status: string
          ticket_type: string | null
          title: string
          updated_at: string
          upsell_signal_id: string | null
        }
        Insert: {
          change_request_id?: string | null
          client_account_id: string
          closed_at?: string | null
          closed_by?: string | null
          coverage?: string | null
          created_at?: string
          description?: string | null
          id?: string
          organization_id: string
          plan_id?: string | null
          project_id: string
          raised_at?: string
          raised_by?: string | null
          status?: string
          ticket_type?: string | null
          title: string
          updated_at?: string
          upsell_signal_id?: string | null
        }
        Update: {
          change_request_id?: string | null
          client_account_id?: string
          closed_at?: string | null
          closed_by?: string | null
          coverage?: string | null
          created_at?: string
          description?: string | null
          id?: string
          organization_id?: string
          plan_id?: string | null
          project_id?: string
          raised_at?: string
          raised_by?: string | null
          status?: string
          ticket_type?: string | null
          title?: string
          updated_at?: string
          upsell_signal_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_items_change_request_id_fkey"
            columns: ["change_request_id"]
            isOneToOne: false
            referencedRelation: "change_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_items_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "maintenance_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_plans: {
        Row: {
          accepted_at: string | null
          accepted_proposal_id: string | null
          billing_model: string
          bug_fix_coverage: string | null
          client_account_id: string
          coverage: string | null
          created_at: string
          created_by: string | null
          emergency_policy: string | null
          ended_reason: string | null
          ends_on: string | null
          escalation: string | null
          excluded_work: string | null
          id: string
          included_support: string | null
          included_tasks: string | null
          minor_change_allowance: string | null
          monitoring: string | null
          name: string
          organization_id: string
          project_id: string
          renewal_terms: string | null
          reporting: string | null
          response_targets: string | null
          starts_on: string | null
          status: string
          support_hours: string | null
          updated_at: string
          version: number
        }
        Insert: {
          accepted_at?: string | null
          accepted_proposal_id?: string | null
          billing_model: string
          bug_fix_coverage?: string | null
          client_account_id: string
          coverage?: string | null
          created_at?: string
          created_by?: string | null
          emergency_policy?: string | null
          ended_reason?: string | null
          ends_on?: string | null
          escalation?: string | null
          excluded_work?: string | null
          id?: string
          included_support?: string | null
          included_tasks?: string | null
          minor_change_allowance?: string | null
          monitoring?: string | null
          name: string
          organization_id: string
          project_id: string
          renewal_terms?: string | null
          reporting?: string | null
          response_targets?: string | null
          starts_on?: string | null
          status?: string
          support_hours?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          accepted_at?: string | null
          accepted_proposal_id?: string | null
          billing_model?: string
          bug_fix_coverage?: string | null
          client_account_id?: string
          coverage?: string | null
          created_at?: string
          created_by?: string | null
          emergency_policy?: string | null
          ended_reason?: string | null
          ends_on?: string | null
          escalation?: string | null
          excluded_work?: string | null
          id?: string
          included_support?: string | null
          included_tasks?: string | null
          minor_change_allowance?: string | null
          monitoring?: string | null
          name?: string
          organization_id?: string
          project_id?: string
          renewal_terms?: string | null
          reporting?: string | null
          response_targets?: string | null
          starts_on?: string | null
          status?: string
          support_hours?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_plans_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      milestones: {
        Row: {
          amount_minor: number
          created_at: string
          currency: string
          description: string | null
          due_on: string | null
          id: string
          met_at: string | null
          name: string
          organization_id: string
          payment_percent: number | null
          position: number
          project_id: string
          requires_deliverable_id: string | null
          status: string
          updated_at: string
          visibility: string
        }
        Insert: {
          amount_minor?: number
          created_at?: string
          currency?: string
          description?: string | null
          due_on?: string | null
          id?: string
          met_at?: string | null
          name: string
          organization_id: string
          payment_percent?: number | null
          position?: number
          project_id: string
          requires_deliverable_id?: string | null
          status?: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          amount_minor?: number
          created_at?: string
          currency?: string
          description?: string | null
          due_on?: string | null
          id?: string
          met_at?: string | null
          name?: string
          organization_id?: string
          payment_percent?: number | null
          position?: number
          project_id?: string
          requires_deliverable_id?: string | null
          status?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "milestones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "milestones_requires_deliverable_id_fkey"
            columns: ["requires_deliverable_id"]
            isOneToOne: false
            referencedRelation: "deliverables"
            referencedColumns: ["id"]
          },
        ]
      }
      modules: {
        Row: {
          created_at: string
          description: string | null
          due_on: string | null
          id: string
          name: string
          organization_id: string
          owner_id: string | null
          position: number
          project_id: string
          requirement_version_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          due_on?: string | null
          id?: string
          name: string
          organization_id: string
          owner_id?: string | null
          position?: number
          project_id: string
          requirement_version_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          due_on?: string | null
          id?: string
          name?: string
          organization_id?: string
          owner_id?: string | null
          position?: number
          project_id?: string
          requirement_version_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "modules_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_baseline: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          key: string
          label: string
          organization_id: string
          position: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          key: string
          label: string
          organization_id: string
          position: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          key?: string
          label?: string
          organization_id?: string
          position?: number
          updated_at?: string
        }
        Relationships: []
      }
      onboarding_items: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          created_at: string
          id: string
          key: string
          label: string
          note: string | null
          organization_id: string
          position: number
          project_id: string
          status: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          key: string
          label: string
          note?: string | null
          organization_id: string
          position: number
          project_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          id?: string
          key?: string
          label?: string
          note?: string | null
          organization_id?: string
          position?: number
          project_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_items_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          budget_minor: number | null
          client_account_id: string
          code: string | null
          completed_at: string | null
          completion_override_reason: string | null
          created_at: string
          currency: string
          deleted_at: string | null
          delivery_lead_id: string | null
          description: string | null
          ends_on: string | null
          id: string
          name: string
          opportunity_id: string | null
          organization_id: string
          production_ready_at: string | null
          proposal_id: string | null
          start_override_reason: string | null
          started_at: string | null
          starts_on: string | null
          status: string
          updated_at: string
          visibility: string
        }
        Insert: {
          budget_minor?: number | null
          client_account_id: string
          code?: string | null
          completed_at?: string | null
          completion_override_reason?: string | null
          created_at?: string
          currency?: string
          deleted_at?: string | null
          delivery_lead_id?: string | null
          description?: string | null
          ends_on?: string | null
          id?: string
          name: string
          opportunity_id?: string | null
          organization_id: string
          production_ready_at?: string | null
          proposal_id?: string | null
          start_override_reason?: string | null
          started_at?: string | null
          starts_on?: string | null
          status?: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          budget_minor?: number | null
          client_account_id?: string
          code?: string | null
          completed_at?: string | null
          completion_override_reason?: string | null
          created_at?: string
          currency?: string
          deleted_at?: string | null
          delivery_lead_id?: string | null
          description?: string | null
          ends_on?: string | null
          id?: string
          name?: string
          opportunity_id?: string | null
          organization_id?: string
          production_ready_at?: string | null
          proposal_id?: string | null
          start_override_reason?: string | null
          started_at?: string | null
          starts_on?: string | null
          status?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: []
      }
      scope_items: {
        Row: {
          acceptance_criteria: string | null
          created_at: string
          detail: string | null
          feature_id: string | null
          id: string
          inclusion: string
          organization_id: string
          position: number
          scope_version_id: string
          title: string
        }
        Insert: {
          acceptance_criteria?: string | null
          created_at?: string
          detail?: string | null
          feature_id?: string | null
          id?: string
          inclusion?: string
          organization_id: string
          position?: number
          scope_version_id: string
          title: string
        }
        Update: {
          acceptance_criteria?: string | null
          created_at?: string
          detail?: string | null
          feature_id?: string | null
          id?: string
          inclusion?: string
          organization_id?: string
          position?: number
          scope_version_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "scope_items_feature_id_fkey"
            columns: ["feature_id"]
            isOneToOne: false
            referencedRelation: "features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scope_items_scope_version_id_fkey"
            columns: ["scope_version_id"]
            isOneToOne: false
            referencedRelation: "scope_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      scope_versions: {
        Row: {
          change_request_id: string | null
          created_at: string
          created_by: string | null
          frozen_at: string | null
          id: string
          organization_id: string
          project_id: string
          requirement_version_id: string | null
          source: string
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          change_request_id?: string | null
          created_at?: string
          created_by?: string | null
          frozen_at?: string | null
          id?: string
          organization_id: string
          project_id: string
          requirement_version_id?: string | null
          source?: string
          status?: string
          updated_at?: string
          version: number
        }
        Update: {
          change_request_id?: string | null
          created_at?: string
          created_by?: string | null
          frozen_at?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          requirement_version_id?: string | null
          source?: string
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "scope_versions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      screen_scope_items: {
        Row: {
          created_at: string
          organization_id: string
          scope_item_id: string
          screen_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          scope_item_id: string
          screen_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          scope_item_id?: string
          screen_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "screen_scope_items_scope_item_id_fkey"
            columns: ["scope_item_id"]
            isOneToOne: false
            referencedRelation: "scope_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screen_scope_items_screen_id_fkey"
            columns: ["screen_id"]
            isOneToOne: false
            referencedRelation: "screens"
            referencedColumns: ["id"]
          },
        ]
      }
      screens: {
        Row: {
          accessibility_notes: string | null
          actions: string | null
          created_at: string
          created_by: string | null
          deliverable_id: string | null
          entry_point: string | null
          exit_action: string | null
          has_empty_state: boolean
          has_error_state: boolean
          has_loading_state: boolean
          has_success_state: boolean
          id: string
          name: string
          organization_id: string
          permission_behaviour: string | null
          project_id: string
          purpose: string | null
          required_data: string | null
          responsive_behaviour: string | null
          screen_key: string
          status: string
          updated_at: string
          user_role: string
          validation: string | null
        }
        Insert: {
          accessibility_notes?: string | null
          actions?: string | null
          created_at?: string
          created_by?: string | null
          deliverable_id?: string | null
          entry_point?: string | null
          exit_action?: string | null
          has_empty_state?: boolean
          has_error_state?: boolean
          has_loading_state?: boolean
          has_success_state?: boolean
          id?: string
          name: string
          organization_id: string
          permission_behaviour?: string | null
          project_id: string
          purpose?: string | null
          required_data?: string | null
          responsive_behaviour?: string | null
          screen_key: string
          status?: string
          updated_at?: string
          user_role: string
          validation?: string | null
        }
        Update: {
          accessibility_notes?: string | null
          actions?: string | null
          created_at?: string
          created_by?: string | null
          deliverable_id?: string | null
          entry_point?: string | null
          exit_action?: string | null
          has_empty_state?: boolean
          has_error_state?: boolean
          has_loading_state?: boolean
          has_success_state?: boolean
          id?: string
          name?: string
          organization_id?: string
          permission_behaviour?: string | null
          project_id?: string
          purpose?: string | null
          required_data?: string | null
          responsive_behaviour?: string | null
          screen_key?: string
          status?: string
          updated_at?: string
          user_role?: string
          validation?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "screens_deliverable_id_fkey"
            columns: ["deliverable_id"]
            isOneToOne: false
            referencedRelation: "deliverables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "screens_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string | null
          completed_at: string | null
          created_at: string
          description: string | null
          due_on: string | null
          estimate_hours: number | null
          feature_id: string | null
          id: string
          milestone_id: string | null
          module_id: string | null
          organization_id: string
          priority: string
          project_id: string
          requirement_version_id: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_on?: string | null
          estimate_hours?: number | null
          feature_id?: string | null
          id?: string
          milestone_id?: string | null
          module_id?: string | null
          organization_id: string
          priority?: string
          project_id: string
          requirement_version_id?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assignee_id?: string | null
          completed_at?: string | null
          created_at?: string
          description?: string | null
          due_on?: string | null
          estimate_hours?: number | null
          feature_id?: string | null
          id?: string
          milestone_id?: string | null
          module_id?: string | null
          organization_id?: string
          priority?: string
          project_id?: string
          requirement_version_id?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_feature_id_fkey"
            columns: ["feature_id"]
            isOneToOne: false
            referencedRelation: "features"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_milestone_id_fkey"
            columns: ["milestone_id"]
            isOneToOne: false
            referencedRelation: "milestones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      account_health_signals: {
        Args: { p_client_account_id: string }
        Returns: {
          signal: string
          value: string
        }[]
      }
      add_deliverable: {
        Args: {
          p_artifact_url?: string
          p_changelog?: string
          p_created_by?: string
          p_kind: string
          p_known_issues?: string
          p_module_id?: string
          p_project_id: string
          p_test_access_method?: string
          p_title: string
        }
        Returns: {
          deliverable_id: string
          outcome: string
          version: number
        }[]
      }
      apply_change_request: {
        Args: { p_change_request_id: string }
        Returns: {
          outcome: string
          scope_version_id: string
          version: number
        }[]
      }
      break_down_requirement: {
        Args: {
          p_breakdown: Json
          p_project_id: string
          p_requirement_version_id: string
        }
        Returns: {
          features: number
          modules: number
          outcome: string
          tasks: number
        }[]
      }
      classify_change_request: {
        Args: {
          p_change_request_id: string
          p_classification: string
          p_effort_hours?: number
          p_impact_notes?: string
          p_timeline_days?: number
        }
        Returns: {
          outcome: string
          status: string
        }[]
      }
      complete_project: {
        Args: { p_override_reason?: string; p_project_id: string }
        Returns: {
          outcome: string
          overridden: boolean
          project_status: string
          unmet: string[]
        }[]
      }
      completion_readiness: {
        Args: { p_project_id: string }
        Returns: {
          client_accepted: boolean
          handover_delivered: boolean
          no_blocking_defects: boolean
          payment_verified: boolean
        }[]
      }
      completion_summary: {
        Args: { p_project_id: string }
        Returns: {
          budget_minor: number
          completed_at: string
          defects_open: number
          defects_total: number
          deliverables: number
          duration_days: number
          final_version: string
          handover_status: string
          invoiced_minor: number
          milestones_met: number
          milestones_total: number
          name: string
          outstanding_minor: number
          paid_minor: number
          project_id: string
          revisions: number
          started_at: string
          status: string
        }[]
      }
      decide_change_request: {
        Args: {
          p_approve: boolean
          p_change_request_id: string
          p_proposal_id?: string
        }
        Returns: {
          outcome: string
          status: string
        }[]
      }
      deliver_handover: {
        Args: { p_delivered_by?: string; p_handover_id: string }
        Returns: {
          outcome: string
          outstanding_minor: number
          request_id: string
          status: string
        }[]
      }
      freeze_scope_version: {
        Args: { p_scope_version_id: string }
        Returns: {
          items: number
          outcome: string
          superseded: string
        }[]
      }
      install_default_onboarding_baseline: {
        Args: { p_organization_id: string }
        Returns: number
      }
      mark_production_ready: {
        Args: { p_project_id: string }
        Returns: {
          outcome: string
          unmet: string[]
        }[]
      }
      module_progress: {
        Args: { p_project_id: string }
        Returns: {
          module_id: string
          name: string
          open_defects: number
          status: string
          tasks_done: number
          tasks_total: number
        }[]
      }
      open_scope_version: {
        Args: {
          p_change_request_id?: string
          p_project_id: string
          p_requirement_version_id?: string
          p_source?: string
        }
        Returns: {
          outcome: string
          scope_version_id: string
          version: number
        }[]
      }
      production_readiness: {
        Args: { p_project_id: string }
        Returns: {
          build_approved: boolean
          no_open_blockers: boolean
          no_open_majors: boolean
        }[]
      }
      replace_payment_plan: {
        Args: { p_milestones: Json; p_project_id: string }
        Returns: {
          blocking_number: string
          milestone_count: number
          outcome: string
        }[]
      }
      requirement_coverage: {
        Args: { p_project_id: string }
        Returns: {
          features: number
          modules: number
          requirement_version_id: string
          tasks: number
          tasks_done: number
          version: number
        }[]
      }
      seed_onboarding: {
        Args: { p_project_id: string }
        Returns: {
          items: number
          outcome: string
        }[]
      }
      set_onboarding_item: {
        Args: {
          p_actor?: string
          p_item_id: string
          p_note?: string
          p_status: string
        }
        Returns: {
          done: number
          outcome: string
          status: string
          total: number
        }[]
      }
      start_project: {
        Args: { p_override_reason?: string; p_project_id: string }
        Returns: {
          outcome: string
          overridden: boolean
          project_status: string
          unmet: string[]
        }[]
      }
      start_readiness: {
        Args: { p_project_id: string }
        Returns: {
          advance_verified: boolean
          group_linked: boolean
          requirement_approved: boolean
        }[]
      }
      submit_change_request: {
        Args: {
          p_evidence_message_id?: string
          p_project_id: string
          p_requested: string
          p_source?: string
        }
        Returns: {
          change_request_id: string
          outcome: string
        }[]
      }
      submit_deliverable: {
        Args: {
          p_deliverable_id: string
          p_requested_by?: string
          p_summary?: string
        }
        Returns: {
          outcome: string
          request_id: string
          status: string
        }[]
      }
      sync_deliverable_decision: {
        Args: { p_deliverable_id: string }
        Returns: string
      }
      sync_handover_acceptance: {
        Args: { p_handover_id: string }
        Returns: string
      }
      ui_coverage: {
        Args: { p_project_id: string }
        Returns: {
          blocking: boolean
          flag: string
          subject: string
          subject_id: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bootstrap_first_owner: { Args: { p_user_id: string }; Returns: string }
      health_check: { Args: never; Returns: Json }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  qa: {
    Tables: {
      defects: {
        Row: {
          actual: string | null
          assignee_id: string | null
          created_at: string
          deliverable_id: string | null
          environment: string | null
          evidence_url: string | null
          expected: string | null
          id: string
          organization_id: string
          project_id: string
          reported_by: string | null
          reproduction: string
          resolution: string | null
          severity: string
          status: string
          title: string
          updated_at: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          actual?: string | null
          assignee_id?: string | null
          created_at?: string
          deliverable_id?: string | null
          environment?: string | null
          evidence_url?: string | null
          expected?: string | null
          id?: string
          organization_id: string
          project_id: string
          reported_by?: string | null
          reproduction: string
          resolution?: string | null
          severity: string
          status?: string
          title: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          actual?: string | null
          assignee_id?: string | null
          created_at?: string
          deliverable_id?: string | null
          environment?: string | null
          evidence_url?: string | null
          expected?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          reported_by?: string | null
          reproduction?: string
          resolution?: string | null
          severity?: string
          status?: string
          title?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      test_plan_items: {
        Row: {
          category: string
          created_at: string
          critical_path: boolean
          id: string
          organization_id: string
          plan_id: string
          reason: string
          scope_item_id: string
        }
        Insert: {
          category: string
          created_at?: string
          critical_path?: boolean
          id?: string
          organization_id: string
          plan_id: string
          reason: string
          scope_item_id: string
        }
        Update: {
          category?: string
          created_at?: string
          critical_path?: boolean
          id?: string
          organization_id?: string
          plan_id?: string
          reason?: string
          scope_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_plan_items_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "test_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      test_plans: {
        Row: {
          created_at: string
          drafted_by: string | null
          drafted_by_agent: string | null
          id: string
          organization_id: string
          project_id: string
          scope_version_id: string
        }
        Insert: {
          created_at?: string
          drafted_by?: string | null
          drafted_by_agent?: string | null
          id?: string
          organization_id: string
          project_id: string
          scope_version_id: string
        }
        Update: {
          created_at?: string
          drafted_by?: string | null
          drafted_by_agent?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          scope_version_id?: string
        }
        Relationships: []
      }
      test_runs: {
        Row: {
          created_at: string
          deliverable_id: string
          evidence_url: string | null
          executed_at: string
          executed_by: string | null
          executed_by_agent: string | null
          failed: number
          id: string
          organization_id: string
          passed: number
          project_id: string
          skipped: number
          suite: string
          total: number
        }
        Insert: {
          created_at?: string
          deliverable_id: string
          evidence_url?: string | null
          executed_at?: string
          executed_by?: string | null
          executed_by_agent?: string | null
          failed: number
          id?: string
          organization_id: string
          passed: number
          project_id: string
          skipped?: number
          suite: string
          total: number
        }
        Update: {
          created_at?: string
          deliverable_id?: string
          evidence_url?: string | null
          executed_at?: string
          executed_by?: string | null
          executed_by_agent?: string | null
          failed?: number
          id?: string
          organization_id?: string
          passed?: number
          project_id?: string
          skipped?: number
          suite?: string
          total?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      blocking_defects: {
        Args: { p_deliverable_id: string }
        Returns: {
          id: string
          severity: string
          title: string
        }[]
      }
      project_quality: {
        Args: { p_project_id: string }
        Returns: {
          open_blockers: number
          open_majors: number
          open_minors: number
          total: number
          unverified: number
        }[]
      }
      release_gates: {
        Args: { p_project_id: string }
        Returns: {
          detail: string
          gate: string
          state: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  sales: {
    Tables: {
      objections: {
        Row: {
          answered_by: string | null
          concern: string
          created_at: string
          id: string
          kind: string
          lead_id: string
          message_id: string | null
          next_action: string | null
          organization_id: string
          outcome: string | null
          proposal_id: string | null
          raised_by_agent: string | null
          response: string | null
          round: number
          updated_at: string
        }
        Insert: {
          answered_by?: string | null
          concern: string
          created_at?: string
          id?: string
          kind: string
          lead_id: string
          message_id?: string | null
          next_action?: string | null
          organization_id: string
          outcome?: string | null
          proposal_id?: string | null
          raised_by_agent?: string | null
          response?: string | null
          round: number
          updated_at?: string
        }
        Update: {
          answered_by?: string | null
          concern?: string
          created_at?: string
          id?: string
          kind?: string
          lead_id?: string
          message_id?: string | null
          next_action?: string | null
          organization_id?: string
          outcome?: string | null
          proposal_id?: string | null
          raised_by_agent?: string | null
          response?: string | null
          round?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "objections_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      opportunities: {
        Row: {
          client_account_id: string | null
          closed_at: string | null
          created_at: string
          currency: string
          expected_close_on: string | null
          id: string
          lead_id: string | null
          lost_category: string | null
          lost_reason: string | null
          name: string
          organization_id: string
          owner_id: string | null
          stage: string
          updated_at: string
          value_minor: number
        }
        Insert: {
          client_account_id?: string | null
          closed_at?: string | null
          created_at?: string
          currency?: string
          expected_close_on?: string | null
          id?: string
          lead_id?: string | null
          lost_category?: string | null
          lost_reason?: string | null
          name: string
          organization_id: string
          owner_id?: string | null
          stage?: string
          updated_at?: string
          value_minor?: number
        }
        Update: {
          client_account_id?: string | null
          closed_at?: string | null
          created_at?: string
          currency?: string
          expected_close_on?: string | null
          id?: string
          lead_id?: string | null
          lost_category?: string | null
          lost_reason?: string | null
          name?: string
          organization_id?: string
          owner_id?: string | null
          stage?: string
          updated_at?: string
          value_minor?: number
        }
        Relationships: []
      }
      proposal_items: {
        Row: {
          amount_minor: number
          created_at: string
          description: string
          id: string
          organization_id: string
          position: number
          proposal_id: string
          quantity: number
          unit_price_minor: number
        }
        Insert: {
          amount_minor?: number
          created_at?: string
          description: string
          id?: string
          organization_id: string
          position?: number
          proposal_id: string
          quantity?: number
          unit_price_minor?: number
        }
        Update: {
          amount_minor?: number
          created_at?: string
          description?: string
          id?: string
          organization_id?: string
          position?: number
          proposal_id?: string
          quantity?: number
          unit_price_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "proposal_items_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
        ]
      }
      proposals: {
        Row: {
          approval_request_id: string | null
          body: string | null
          conversation_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          decided_at: string | null
          discount_minor: number
          generated_by_run_id: string | null
          id: string
          opportunity_id: string
          organization_id: string
          requirement_version_id: string | null
          responded_by_contact_id: string | null
          response_note: string | null
          sent_at: string | null
          sent_message_ref: string | null
          status: string
          subtotal_minor: number
          tax_minor: number
          title: string
          total_minor: number
          updated_at: string
          valid_until: string | null
          version: number
        }
        Insert: {
          approval_request_id?: string | null
          body?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          decided_at?: string | null
          discount_minor?: number
          generated_by_run_id?: string | null
          id?: string
          opportunity_id: string
          organization_id: string
          requirement_version_id?: string | null
          responded_by_contact_id?: string | null
          response_note?: string | null
          sent_at?: string | null
          sent_message_ref?: string | null
          status?: string
          subtotal_minor?: number
          tax_minor?: number
          title: string
          total_minor?: number
          updated_at?: string
          valid_until?: string | null
          version?: number
        }
        Update: {
          approval_request_id?: string | null
          body?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          decided_at?: string | null
          discount_minor?: number
          generated_by_run_id?: string | null
          id?: string
          opportunity_id?: string
          organization_id?: string
          requirement_version_id?: string | null
          responded_by_contact_id?: string | null
          response_note?: string | null
          sent_at?: string | null
          sent_message_ref?: string | null
          status?: string
          subtotal_minor?: number
          tax_minor?: number
          title?: string
          total_minor?: number
          updated_at?: string
          valid_until?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "proposals_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["id"]
          },
        ]
      }
      upsell_signals: {
        Row: {
          client_account_id: string
          created_at: string
          detected_at: string
          evidence: Json
          id: string
          kind: string
          note: string | null
          organization_id: string
          project_id: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          client_account_id: string
          created_at?: string
          detected_at?: string
          evidence?: Json
          id?: string
          kind: string
          note?: string | null
          organization_id: string
          project_id: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          client_account_id?: string
          created_at?: string
          detected_at?: string
          evidence?: Json
          id?: string
          kind?: string
          note?: string | null
          organization_id?: string
          project_id?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      add_proposal_item: {
        Args: {
          p_description: string
          p_position?: number
          p_proposal_id: string
          p_quantity?: number
          p_unit_price_minor?: number
        }
        Returns: {
          item_id: string
          outcome: string
          subtotal_minor: number
          total_minor: number
        }[]
      }
      detect_upsell_signals: {
        Args: { p_limit?: number }
        Returns: {
          signal_id: string
          signal_kind: string
          signal_project_id: string
        }[]
      }
      draft_proposal: {
        Args: {
          p_body?: string
          p_created_by?: string
          p_generated_by_run_id?: string
          p_opportunity_id: string
          p_requirement_version_id?: string
          p_title: string
          p_valid_until?: string
        }
        Returns: {
          outcome: string
          proposal_id: string
          superseded: string
          version: number
        }[]
      }
      lapse_overdue_proposals: {
        Args: { p_limit?: number }
        Returns: {
          lapsed_id: string
          opportunity_id: string
          organization_id: string
        }[]
      }
      lost_reasons: {
        Args: { p_from?: string; p_organization_id?: string; p_to?: string }
        Returns: {
          deals: number
          lost_category: string
          share: number
        }[]
      }
      record_proposal_response: {
        Args: {
          p_contact_id?: string
          p_note?: string
          p_proposal_id: string
          p_response: string
        }
        Returns: {
          decided_at: string
          outcome: string
          status: string
        }[]
      }
      send_proposal: {
        Args: {
          p_conversation_id?: string
          p_message_ref?: string
          p_proposal_id: string
        }
        Returns: {
          outcome: string
          sent_at: string
          status: string
        }[]
      }
      set_opportunity_terms: {
        Args: {
          p_expected_close_on?: string
          p_name?: string
          p_opportunity_id: string
          p_value_minor?: number
        }
        Returns: {
          expected_close_on: string
          name: string
          outcome: string
          value_minor: number
        }[]
      }
      set_proposal_pricing: {
        Args: {
          p_discount_minor?: number
          p_proposal_id: string
          p_tax_minor?: number
        }
        Returns: {
          discount_minor: number
          outcome: string
          subtotal_minor: number
          tax_minor: number
          total_minor: number
        }[]
      }
      submit_proposal: {
        Args: {
          p_proposal_id: string
          p_requested_by?: string
          p_summary?: string
        }
        Returns: {
          outcome: string
          request_id: string
          status: string
        }[]
      }
      sync_proposal_decision: {
        Args: { p_proposal_id: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  ai: {
    Enums: {},
  },
  approvals: {
    Enums: {},
  },
  audit: {
    Enums: {},
  },
  core: {
    Enums: {},
  },
  crm: {
    Enums: {},
  },
  finance: {
    Enums: {},
  },
  projects: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
  qa: {
    Enums: {},
  },
  sales: {
    Enums: {},
  },
} as const

