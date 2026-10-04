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
      agent_policy_refusals: {
        Row: {
          agent_key: string
          created_at: string
          id: string
          kind: string
          organization_id: string
          project_id: string | null
          reason: string
          run_id: string | null
          tool_key: string | null
          updated_at: string
        }
        Insert: {
          agent_key: string
          created_at?: string
          id?: string
          kind: string
          organization_id: string
          project_id?: string | null
          reason: string
          run_id?: string | null
          tool_key?: string | null
          updated_at?: string
        }
        Update: {
          agent_key?: string
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string
          project_id?: string | null
          reason?: string
          run_id?: string | null
          tool_key?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_policy_refusals_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "agent_policy_refusals_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_project_assignments: {
        Row: {
          active: boolean
          agent_key: string
          assigned_by: string | null
          created_at: string
          id: string
          organization_id: string
          project_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          agent_key: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          organization_id: string
          project_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          agent_key?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          organization_id?: string
          project_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_project_assignments_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
        ]
      }
      agent_routing_overrides: {
        Row: {
          agent_key: string
          category: string
          created_at: string
          id: string
          note: string | null
          organization_id: string
          preferred_models: string[]
          set_by: string | null
          updated_at: string
        }
        Insert: {
          agent_key: string
          category: string
          created_at?: string
          id?: string
          note?: string | null
          organization_id: string
          preferred_models: string[]
          set_by?: string | null
          updated_at?: string
        }
        Update: {
          agent_key?: string
          category?: string
          created_at?: string
          id?: string
          note?: string | null
          organization_id?: string
          preferred_models?: string[]
          set_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_routing_overrides_agent_key_fkey"
            columns: ["agent_key"]
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
          latency_ms: number | null
          model: string | null
          organization_id: string
          output: Json | null
          output_tokens: number
          phase: number | null
          project_id: string | null
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
          latency_ms?: number | null
          model?: string | null
          organization_id: string
          output?: Json | null
          output_tokens?: number
          phase?: number | null
          project_id?: string | null
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
          latency_ms?: number | null
          model?: string | null
          organization_id?: string
          output?: Json | null
          output_tokens?: number
          phase?: number | null
          project_id?: string | null
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
      agent_tool_permissions: {
        Row: {
          agent_key: string
          allowed: boolean
          created_at: string
          id: string
          note: string | null
          organization_id: string
          tool_key: string
          updated_at: string
        }
        Insert: {
          agent_key: string
          allowed?: boolean
          created_at?: string
          id?: string
          note?: string | null
          organization_id: string
          tool_key: string
          updated_at?: string
        }
        Update: {
          agent_key?: string
          allowed?: boolean
          created_at?: string
          id?: string
          note?: string | null
          organization_id?: string
          tool_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_tool_permissions_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
          },
        ]
      }
      agent_validations: {
        Row: {
          agent_key: string
          created_at: string
          findings: Json
          id: string
          organization_id: string
          outcome: string
          registry_revision: string
          updated_at: string
          validated_at: string
          validated_by: string | null
        }
        Insert: {
          agent_key: string
          created_at?: string
          findings?: Json
          id?: string
          organization_id: string
          outcome: string
          registry_revision: string
          updated_at?: string
          validated_at?: string
          validated_by?: string | null
        }
        Update: {
          agent_key?: string
          created_at?: string
          findings?: Json
          id?: string
          organization_id?: string
          outcome?: string
          registry_revision?: string
          updated_at?: string
          validated_at?: string
          validated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_validations_agent_key_fkey"
            columns: ["agent_key"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["key"]
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
          allowed_work_classes: string[]
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
          allowed_work_classes?: string[]
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
          allowed_work_classes?: string[]
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
          provider: string | null
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
          provider?: string | null
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
          provider?: string | null
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
      fallback_chains: {
        Row: {
          created_at: string
          model_ids: string[]
          organization_id: string
          updated_at: string
          updated_by: string | null
          work_class: string
        }
        Insert: {
          created_at?: string
          model_ids?: string[]
          organization_id: string
          updated_at?: string
          updated_by?: string | null
          work_class: string
        }
        Update: {
          created_at?: string
          model_ids?: string[]
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
          work_class?: string
        }
        Relationships: []
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
      model_budgets: {
        Row: {
          created_at: string
          model_id: string
          monthly_cap_minor: number
          organization_id: string
          set_by: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          model_id: string
          monthly_cap_minor: number
          organization_id: string
          set_by?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          model_id?: string
          monthly_cap_minor?: number
          organization_id?: string
          set_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      provider_budgets: {
        Row: {
          created_at: string
          monthly_cap_minor: number
          organization_id: string
          provider: string
          set_by: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          monthly_cap_minor: number
          organization_id: string
          provider: string
          set_by?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          monthly_cap_minor?: number
          organization_id?: string
          provider?: string
          set_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      provider_credentials: {
        Row: {
          auth_tag: string
          ciphertext: string
          created_at: string
          iv: string
          provider: string
          updated_at: string
          updated_by: string
        }
        Insert: {
          auth_tag: string
          ciphertext: string
          created_at?: string
          iv: string
          provider: string
          updated_at?: string
          updated_by: string
        }
        Update: {
          auth_tag?: string
          ciphertext?: string
          created_at?: string
          iv?: string
          provider?: string
          updated_at?: string
          updated_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_credentials_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
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
      model_budget_status: {
        Row: {
          model_id: string | null
          monthly_cap_minor: number | null
          organization_id: string | null
          spent_minor: number | null
          updated_at: string | null
        }
        Relationships: []
      }
      provider_budget_status: {
        Row: {
          monthly_cap_minor: number | null
          organization_id: string | null
          provider: string | null
          spent_minor: number | null
          updated_at: string | null
        }
        Relationships: []
      }
      spend_by_project: {
        Row: {
          cost_minor: number | null
          input_tokens: number | null
          last_run_at: string | null
          organization_id: string | null
          output_tokens: number | null
          project_id: string | null
          runs: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      attach_meeting_summary_to_memory: {
        Args: { p_meeting_id: string; p_project_id: string }
        Returns: {
          outcome: string
          memory_id: string | null
          lead_id: string | null
        }[]
      }
      project_usage_by_phase: {
        Args: { p_project_id: string }
        Returns: {
          cost_minor: number
          input_tokens: number
          output_tokens: number
          // Nullable: a run attributed to this project whose phase is not
          // knowable comes back as its own row.
          phase: number | null
          runs: number
        }[]
      }
      provider_credential_status: {
        Args: Record<PropertyKey, never>
        Returns: {
          configured: boolean
          provider: string
          updated_at: string | null
        }[]
      }
      recall: {
        Args: {
          p_limit?: number
          p_organization_id?: string
          p_scope: string
          p_scope_id?: string
        }
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
      record_agent_policy_refusal: {
        Args: {
          p_agent_key: string
          p_kind: string
          p_organization_id: string
          p_project_id?: string
          p_reason: string
          p_run_id?: string
          p_tool_key?: string
        }
        Returns: string
      }
      revoke_provider_credential: {
        Args: { p_provider: string }
        Returns: {
          outcome: string
        }[]
      }
      set_agent_caps: {
        Args: {
          p_agent_key: string
          p_max_cost_minor: number
          p_max_steps: number
        }
        Returns: {
          outcome: string
        }[]
      }
      set_agent_project_assignment: {
        Args: {
          p_active: boolean
          p_agent_key: string
          p_project_id: string
        }
        Returns: {
          outcome: string
        }[]
      }
      set_agent_routing_override: {
        Args: {
          p_agent_key: string
          p_category: string
          p_note?: string
          p_preferred_models: string[]
        }
        Returns: {
          outcome: string
        }[]
      }
      add_model: {
        Args: {
          p_capabilities?: string[]
          p_context_tokens?: number
          p_input_cost_minor_per_mtok?: number
          p_model_id: string
          p_output_cost_minor_per_mtok?: number
          p_provider: string
        }
        Returns: {
          outcome: string
        }[]
      }
      record_embedding_usage: {
        Args: {
          p_cost_minor: number
          p_input_tokens: number
          p_model: string
          p_organization_id: string
          p_provider: string
        }
        Returns: undefined
      }
      record_query_embedding_usage: {
        Args: {
          p_cost_minor: number
          p_input_tokens: number
          p_model: string
          p_provider: string
        }
        Returns: undefined
      }
      semantic_budget_allows: {
        Args: {
          p_model: string
          p_provider: string
        }
        Returns: boolean
      }
      provider_spend_this_month: {
        Args: {
          p_organization_id: string
          p_provider: string
        }
        Returns: number
      }
      replay_run: {
        Args: {
          p_reason: string
          p_run_id: string
        }
        Returns: {
          outcome: string
          job_id: string | null
        }[]
      }
      retire_model: {
        Args: {
          p_model_id: string
          p_reason: string
        }
        Returns: {
          outcome: string
        }[]
      }
      set_agent_work_classes: {
        Args: {
          p_agent_key: string
          p_work_classes: string[]
        }
        Returns: {
          outcome: string
        }[]
      }
      set_fallback_chain: {
        Args: {
          p_model_ids: string[]
          p_work_class: string
        }
        Returns: {
          outcome: string
        }[]
      }
      set_model_budget: {
        Args: {
          p_model_id: string
          p_monthly_cap_minor: number | null
        }
        Returns: {
          outcome: string
        }[]
      }
      model_spend_this_month: {
        Args: {
          p_model_id: string
          p_organization_id: string
        }
        Returns: number
      }
      set_provider_budget: {
        Args: {
          p_monthly_cap_minor: number | null
          p_provider: string
        }
        Returns: {
          outcome: string
        }[]
      }
      set_agent_status: {
        Args: {
          p_agent_key: string
          p_enabled: boolean
          p_reason?: string
        }
        Returns: {
          outcome: string
        }[]
      }
      set_agent_tool_permission: {
        Args: {
          p_agent_key: string
          p_allowed: boolean
          p_note?: string
          p_tool_key: string
        }
        Returns: {
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
      log_audit_export: {
        Args: { p_filters: Json; p_row_count: number }
        Returns: { outcome: string }[]
      }
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
      search_embeddings: {
        Row: {
          content_hash: string
          embedding: number[]
          entity_id: string
          entity_type: string
          model: string
          norm: number
          organization_id: string
          updated_at: string
        }
        Insert: {
          content_hash: string
          embedding: number[]
          entity_id: string
          entity_type: string
          model: string
          norm: number
          organization_id: string
          updated_at?: string
        }
        Update: {
          content_hash?: string
          embedding?: number[]
          entity_id?: string
          entity_type?: string
          model?: string
          norm?: number
          organization_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      semantic_search_state: {
        Row: {
          cursors: Json
          done: number
          enabled: boolean
          last_run_at: string | null
          model: string | null
          note: string | null
          organization_id: string
          passes: Json
          requested_at: string | null
          requested_by: string | null
          status: string
          total: number
          updated_at: string
        }
        Insert: {
          cursors?: Json
          done?: number
          enabled?: boolean
          last_run_at?: string | null
          model?: string | null
          note?: string | null
          organization_id: string
          passes?: Json
          requested_at?: string | null
          requested_by?: string | null
          status?: string
          total?: number
          updated_at?: string
        }
        Update: {
          cursors?: Json
          done?: number
          enabled?: boolean
          last_run_at?: string | null
          model?: string | null
          note?: string | null
          organization_id?: string
          passes?: Json
          requested_at?: string | null
          requested_by?: string | null
          status?: string
          total?: number
          updated_at?: string
        }
        Relationships: []
      }
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
      alerts: {
        Row: {
          acknowledge_reason: string | null
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          fingerprint: string
          first_seen_at: string
          id: string
          last_seen_at: string
          occurrences: number
          organization_id: string
          severity: string
          source: string
          summary: string
          updated_at: string
        }
        Insert: {
          acknowledge_reason?: string | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          fingerprint: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          organization_id: string
          severity: string
          source: string
          summary: string
          updated_at?: string
        }
        Update: {
          acknowledge_reason?: string | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          fingerprint?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          occurrences?: number
          organization_id?: string
          severity?: string
          source?: string
          summary?: string
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
          billing_address: string | null
          billing_email: string | null
          created_at: string
          currency: string
          gstin: string | null
          id: string
          legal_name: string | null
          name: string
          organization_id: string
          owner_id: string | null
          pan: string | null
          status: string
          tags: string[]
          updated_at: string
        }
        Insert: {
          billing_address?: string | null
          billing_email?: string | null
          created_at?: string
          currency?: string
          gstin?: string | null
          id?: string
          legal_name?: string | null
          name: string
          organization_id: string
          owner_id?: string | null
          pan?: string | null
          status?: string
          tags?: string[]
          updated_at?: string
        }
        Update: {
          billing_address?: string | null
          billing_email?: string | null
          created_at?: string
          currency?: string
          gstin?: string | null
          id?: string
          legal_name?: string | null
          name?: string
          organization_id?: string
          owner_id?: string | null
          pan?: string | null
          status?: string
          tags?: string[]
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
          {
            foreignKeyName: "client_accounts_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      client_account_members: {
        Row: {
          client_account_id: string
          created_at: string
          id: string
          organization_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          client_account_id: string
          created_at?: string
          id?: string
          organization_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          client_account_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_account_members_client_account_id_fkey"
            columns: ["client_account_id"]
            isOneToOne: false
            referencedRelation: "client_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_account_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_account_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      client_notes: {
        Row: {
          body: string
          client_account_id: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          body: string
          client_account_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          client_account_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_notes_client_account_id_fkey"
            columns: ["client_account_id"]
            isOneToOne: false
            referencedRelation: "client_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_notes_organization_id_fkey"
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
      create_drafts: {
        Row: {
          created_at: string
          draft: Json
          id: string
          kind: string
          organization_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          draft?: Json
          id?: string
          kind: string
          organization_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          draft?: Json
          id?: string
          kind?: string
          organization_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "create_drafts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "create_drafts_user_id_fkey"
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
      escalations: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          from_user: string
          id: string
          organization_id: string
          reason: string
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          state: string
          subject_key: string
          subject_type: string
          title: string
          to_role: string
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          from_user: string
          id?: string
          organization_id: string
          reason: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          state?: string
          subject_key: string
          subject_type: string
          title: string
          to_role: string
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          from_user?: string
          id?: string
          organization_id?: string
          reason?: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          state?: string
          subject_key?: string
          subject_type?: string
          title?: string
          to_role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "escalations_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalations_from_user_fkey"
            columns: ["from_user"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalations_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          attempts: number
          cancel_reason: string | null
          cancel_requested_at: string | null
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
          cancel_reason?: string | null
          cancel_requested_at?: string | null
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
          cancel_reason?: string | null
          cancel_requested_at?: string | null
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
      secret_credentials: {
        Row: {
          auth_tag: string
          ciphertext: string
          created_at: string
          expires_on: string | null
          hint: string | null
          iv: string
          last_verified_at: string | null
          last_verified_detail: string | null
          last_verified_ok: boolean | null
          slot: string
          updated_at: string
          updated_by: string
        }
        Insert: {
          auth_tag: string
          ciphertext: string
          created_at?: string
          expires_on?: string | null
          hint?: string | null
          iv: string
          last_verified_at?: string | null
          last_verified_detail?: string | null
          last_verified_ok?: boolean | null
          slot: string
          updated_at?: string
          updated_by: string
        }
        Update: {
          auth_tag?: string
          ciphertext?: string
          created_at?: string
          expires_on?: string | null
          hint?: string | null
          iv?: string
          last_verified_at?: string | null
          last_verified_detail?: string | null
          last_verified_ok?: boolean | null
          slot?: string
          updated_at?: string
          updated_by?: string
        }
        Relationships: []
      }
      kill_switches: {
        Row: {
          active: boolean
          created_at: string
          organization_id: string
          reason: string | null
          set_at: string | null
          set_by: string | null
          switch: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          organization_id: string
          reason?: string | null
          set_at?: string | null
          set_by?: string | null
          switch: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          organization_id?: string
          reason?: string | null
          set_at?: string | null
          set_by?: string | null
          switch?: string
          updated_at?: string
        }
        Relationships: []
      }
      member_cost_rates: {
        Row: {
          created_at: string
          currency: string
          effective_from: string
          hourly_cost_minor: number
          id: string
          note: string | null
          organization_id: string
          set_by: string
          user_id: string
        }
        Insert: {
          created_at?: string
          currency?: string
          effective_from: string
          hourly_cost_minor: number
          id?: string
          note?: string | null
          organization_id: string
          set_by: string
          user_id: string
        }
        Update: {
          created_at?: string
          currency?: string
          effective_from?: string
          hourly_cost_minor?: number
          id?: string
          note?: string | null
          organization_id?: string
          set_by?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "member_cost_rates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_cost_rates_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "member_cost_rates_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          department: string | null
          id: string
          organization_id: string
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          department?: string | null
          id?: string
          organization_id: string
          role: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          department?: string | null
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
      membership_roles: {
        Row: {
          created_at: string
          granted_by: string | null
          id: string
          membership_id: string
          organization_id: string
          role: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          id?: string
          membership_id: string
          organization_id: string
          role: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          id?: string
          membership_id?: string
          organization_id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "membership_roles_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_state_events: {
        Row: {
          assigned_to: string | null
          created_at: string
          event: string
          from_state: string | null
          id: string
          item_key: string
          note: string | null
          organization_id: string
          snoozed_until: string | null
          to_state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          event: string
          from_state?: string | null
          id?: string
          item_key: string
          note?: string | null
          organization_id: string
          snoozed_until?: string | null
          to_state: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          event?: string
          from_state?: string | null
          id?: string
          item_key?: string
          note?: string | null
          organization_id?: string
          snoozed_until?: string | null
          to_state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_state_events_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_state_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_state_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_states: {
        Row: {
          assigned_to: string | null
          created_at: string
          id: string
          item_key: string
          note: string | null
          organization_id: string
          snoozed_until: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          item_key: string
          note?: string | null
          organization_id: string
          snoozed_until?: string | null
          state?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          id?: string
          item_key?: string
          note?: string | null
          organization_id?: string
          snoozed_until?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_states_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_states_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_states_user_id_fkey"
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
          default_design_reviewer_id: string | null
          default_sac: string | null
          gst_state_code: string | null
          gstin: string | null
          id: string
          invoice_reminder_interval_days: number
          invoice_reminders_enabled: boolean
          name: string
          reactivation_pilot_enabled: boolean
          settings: Json
          slug: string
          timezone: string | null
          updated_at: string
          wake_runner_on_inbound: boolean
        }
        Insert: {
          agent_answers_clients?: boolean
          agent_writes_follow_ups?: boolean
          created_at?: string
          currency?: string
          default_design_reviewer_id?: string | null
          default_sac?: string | null
          gst_state_code?: string | null
          gstin?: string | null
          id?: string
          name: string
          invoice_reminder_interval_days?: number
          invoice_reminders_enabled?: boolean
          reactivation_pilot_enabled?: boolean
          settings?: Json
          slug: string
          timezone?: string | null
          updated_at?: string
          wake_runner_on_inbound?: boolean
        }
        Update: {
          agent_answers_clients?: boolean
          agent_writes_follow_ups?: boolean
          created_at?: string
          currency?: string
          default_design_reviewer_id?: string | null
          default_sac?: string | null
          gst_state_code?: string | null
          gstin?: string | null
          id?: string
          name?: string
          invoice_reminder_interval_days?: number
          invoice_reminders_enabled?: boolean
          reactivation_pilot_enabled?: boolean
          settings?: Json
          slug?: string
          timezone?: string | null
          updated_at?: string
          wake_runner_on_inbound?: boolean
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
      recent_commands: {
        Row: {
          command_key: string
          created_at: string
          href: string | null
          id: string
          label: string
          last_used_at: string
          organization_id: string
          updated_at: string
          use_count: number
          user_id: string
        }
        Insert: {
          command_key: string
          created_at?: string
          href?: string | null
          id?: string
          label: string
          last_used_at?: string
          organization_id: string
          updated_at?: string
          use_count?: number
          user_id: string
        }
        Update: {
          command_key?: string
          created_at?: string
          href?: string | null
          id?: string
          label?: string
          last_used_at?: string
          organization_id?: string
          updated_at?: string
          use_count?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recent_commands_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recent_commands_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      overrides: {
        Row: {
          actor_id: string | null
          created_at: string
          expires_at: string | null
          id: string
          kind: string
          organization_id: string
          reason: string
          subject_id: string | null
          subject_type: string
          updated_at: string
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          kind: string
          organization_id: string
          reason: string
          subject_id?: string | null
          subject_type: string
          updated_at?: string
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          kind?: string
          organization_id?: string
          reason?: string
          subject_id?: string | null
          subject_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      saved_searches: {
        Row: {
          created_at: string
          filters: Json
          id: string
          last_used_at: string
          name: string | null
          organization_id: string
          query: string
          updated_at: string
          use_count: number
          user_id: string
        }
        Insert: {
          created_at?: string
          filters?: Json
          id?: string
          last_used_at?: string
          name?: string | null
          organization_id: string
          query: string
          updated_at?: string
          use_count?: number
          user_id: string
        }
        Update: {
          created_at?: string
          filters?: Json
          id?: string
          last_used_at?: string
          name?: string | null
          organization_id?: string
          query?: string
          updated_at?: string
          use_count?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_searches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "saved_searches_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_views: {
        Row: {
          created_at: string
          id: string
          name: string
          organization_id: string
          page: string
          query: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          organization_id: string
          page: string
          query?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          organization_id?: string
          page?: string
          query?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_views_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "saved_views_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          created_at: string
          current_organization_id: string | null
          date_format: string
          digest: string
          locale: string
          notification_email: boolean
          notification_whatsapp: boolean
          timezone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          current_organization_id?: string | null
          date_format?: string
          digest?: string
          locale?: string
          notification_email?: boolean
          notification_whatsapp?: boolean
          timezone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          current_organization_id?: string | null
          date_format?: string
          digest?: string
          locale?: string
          notification_email?: boolean
          notification_whatsapp?: boolean
          timezone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_current_organization_id_fkey"
            columns: ["current_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
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
      requeue_job_with_reason: {
        Args: { p_job_id: string; p_reason: string }
        Returns: {
          attempts: number
          job_status: string
          outcome: string
        }[]
      }
      delete_search_embeddings: {
        Args: {
          p_entity_ids: string[]
          p_entity_type: string
          p_organization_id: string
        }
        Returns: number
      }
      request_semantic_backfill: {
        Args: {
          p_model: string
          p_total: number
        }
        Returns: {
          outcome: string
        }[]
      }
      semantic_search: {
        Args: {
          p_candidate_cap?: number
          p_limit?: number
          p_min_score?: number
          p_model: string
          p_query: number[]
          p_types?: string[]
        }
        Returns: {
          entity_id: string
          entity_type: string
          score: number
        }[]
      }
      semantic_visible_types: {
        Args: Record<PropertyKey, never>
        Returns: string[]
      }
      stop_semantic_indexing: {
        Args: Record<PropertyKey, never>
        Returns: {
          outcome: string
        }[]
      }
      upsert_search_embeddings: {
        Args: {
          p_model: string
          p_organization_id: string
          p_rows: Json
        }
        Returns: number
      }
      acknowledge_escalation: {
        Args: {
          p_escalation_id: string
          p_note?: string
          p_organization_id: string
          p_state: string
        }
        Returns: {
          outcome: string
        }[]
      }
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
      cancel_job: {
        Args: { p_job_id: string; p_reason: string }
        Returns: {
          job_status: string
          outcome: string
        }[]
      }
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
      escalate: {
        Args: {
          p_organization_id: string
          p_reason: string
          p_subject_key: string
          p_subject_type: string
          p_title: string
          p_to_role: string
        }
        Returns: {
          escalation_id: string
          outcome: string
        }[]
      }
      event_coverage: {
        Args: never
        Returns: {
          canonical: string
          emitted_as: string
          state: string
        }[]
      }
      gstin_check_character: {
        Args: { p_first14: string }
        Returns: string
      }
      is_admin: { Args: never; Returns: boolean }
      is_client: { Args: never; Returns: boolean }
      is_internal: { Args: never; Returns: boolean }
      is_owner: { Args: never; Returns: boolean }
      grant_secondary_role: {
        Args: { p_membership_id: string; p_role: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      revoke_secondary_role: {
        Args: { p_membership_id: string; p_role: string }
        Returns: {
          outcome: string
        }[]
      }
      set_client_account_team: {
        Args: { p_client_account_id: string; p_user_ids: string[] }
        Returns: { outcome: string }[]
      }
      set_membership_status: {
        Args: { p_membership_id: string; p_status: string }
        Returns: {
          outcome: string
        }[]
      }
      set_member_cost_rate: {
        Args: {
          p_effective_from: string
          p_hourly_cost_minor: number
          p_note?: string
          p_user_id: string
        }
        Returns: {
          outcome: string
          rate_id: string | null
        }[]
      }
      set_notification_state: {
        Args: {
          p_assigned_to?: string
          p_item_keys: string[]
          p_note?: string
          p_organization_id: string
          p_snoozed_until?: string
          p_state: string
        }
        Returns: {
          outcome: string
        }[]
      }
      list_my_organizations: {
        Args: never
        Returns: {
          is_current: boolean
          name: string
          organization_id: string
          role: string
        }[]
      }
      list_membership_roles: {
        Args: { p_organization_id: string }
        Returns: {
          created_at: string
          granted_by: string | null
          membership_id: string
          role: string
        }[]
      }
      operational_backlog: {
        Args: never
        Returns: {
          dead_events: number
          dead_jobs: number
          oldest_dead_at: string
          oldest_overdue_due_at: string
          oldest_unannounced_at: string
          oldest_unpublished_at: string
          oldest_waiting_on_admin_at: string
          overdue_approvals: number
          sends_waiting_on_admin: number
          sends_waiting_on_reply: number
          stalled_jobs: number
          stuck_queued_jobs: number
          unannounced_approvals: number
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
      set_default_design_reviewer: {
        Args: { p_user_id: string | null }
        Returns: {
          outcome: string
          seeded: number
        }[]
      }
      set_agency_timezone: {
        Args: { p_organization_id: string; p_timezone: string }
        Returns: {
          outcome: string
        }[]
      }
      set_member_department: {
        Args: { p_department: string; p_user_id: string }
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
      set_own_preferences: {
        Args: {
          p_date_format: string
          p_digest: string
          p_locale: string
          p_notification_email: boolean
          p_notification_whatsapp: boolean
          p_timezone: string
        }
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
      set_gst_identity: {
        Args: { p_default_sac: string | null; p_gstin: string | null; p_organization_id: string; p_state_code: string | null }
        Returns: {
          outcome: string
        }[]
      }
      set_invoice_reminder_policy: {
        Args: { p_enabled: boolean; p_interval_days: number; p_organization_id: string }
        Returns: {
          outcome: string
        }[]
      }
      set_wake_runner_on_inbound: {
        Args: { p_enabled: boolean; p_organization_id: string }
        Returns: {
          outcome: string
        }[]
      }
      shares_organization: {
        Args: { target_user_id: string }
        Returns: boolean
      }
      switch_organization: {
        Args: { p_organization_id: string }
        Returns: {
          outcome: string
        }[]
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
      update_client_account: {
        Args: {
          p_billing_address?: string | null
          p_client_account_id: string
          p_gstin?: string | null
          p_legal_name?: string | null
          p_name: string
          p_pan?: string | null
        }
        Returns: { outcome: string }[]
      }
      acknowledge_alert: {
        Args: {
          p_alert_id: string
          p_reason: string
        }
        Returns: {
          outcome: string
        }[]
      }
      cancel_running_job: {
        Args: {
          p_job_id: string
          p_reason: string
        }
        Returns: {
          outcome: string
          job_status: string | null
        }[]
      }
      holds_role: {
        Args: {
          p_role: string
        }
        Returns: boolean
      }
      org_paused: {
        Args: {
          p_organization_id: string
          p_switch: string
        }
        Returns: boolean
      }
      raise_alert: {
        Args: {
          p_fingerprint: string
          p_organization_id: string
          p_severity: string
          p_source: string
          p_summary: string
        }
        Returns: string
      }
      record_manual_override: {
        Args: {
          p_expires_at?: string
          p_kind: string
          p_reason: string
          p_subject_id?: string
          p_subject_type: string
        }
        Returns: {
          outcome: string
          id: string | null
        }[]
      }
      publish_quotation_clause: {
        Args: {
          p_body: string
          p_key: string
        }
        Returns: {
          outcome: string
          version: number | null
        }[]
      }
      list_quotation_clauses: {
        Args: never
        Returns: {
          body: string
          clause_key: string
          created_by: string
          created_by_name: string | null
          effective_from: string
          version: number
        }[]
      }
      store_secret: {
        Args: {
          p_auth_tag: string
          p_ciphertext: string
          p_expires_on?: string | null
          p_hint?: string | null
          p_iv: string
          p_slot: string
        }
        Returns: {
          outcome: string
        }[]
      }
      revoke_secret: {
        Args: {
          p_slot: string
        }
        Returns: {
          outcome: string
        }[]
      }
      secret_status: {
        Args: never
        Returns: {
          expires_on: string | null
          hint: string | null
          last_verified_at: string | null
          last_verified_detail: string | null
          last_verified_ok: boolean | null
          slot: string
          updated_at: string
          updated_by: string
          updated_by_name: string | null
        }[]
      }
      record_secret_check: {
        Args: {
          p_detail?: string | null
          p_ok: boolean
          p_slot: string
        }
        Returns: {
          outcome: string
        }[]
      }
      set_kill_switch: {
        Args: {
          p_active: boolean
          p_reason: string
          p_switch: string
        }
        Returns: {
          outcome: string
        }[]
      }
      settle_cancelled_job: {
        Args: {
          p_job_id: string
          p_run_id?: string
        }
        Returns: undefined
      }
      update_own_profile: {
        Args: { p_avatar_url: string; p_full_name: string }
        Returns: {
          outcome: string
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
      outreach_settings: {
        Row: {
          organization_id: string
          sender_name: string | null
          postal_address: string | null
          reply_to: string | null
          cold_basis_enabled: boolean
          daily_cap: number
          bounce_pause_percent: number
          first_send_on: string | null
          updated_by: string | null
          updated_at: string
        }
        Insert: {
          organization_id: string
          sender_name?: string | null
          postal_address?: string | null
          reply_to?: string | null
          cold_basis_enabled?: boolean
          daily_cap?: number
          bounce_pause_percent?: number
          first_send_on?: string | null
          updated_by?: string | null
          updated_at?: string
        }
        Update: {
          organization_id?: string
          sender_name?: string | null
          postal_address?: string | null
          reply_to?: string | null
          cold_basis_enabled?: boolean
          daily_cap?: number
          bounce_pause_percent?: number
          first_send_on?: string | null
          updated_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      email_suppressions: {
        Row: {
          id: string
          organization_id: string
          email: string
          reason: string
          source: string
          note: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          email: string
          reason: string
          source: string
          note?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          email?: string
          reason?: string
          source?: string
          note?: string | null
          created_by?: string | null
          created_at?: string
        }
        Relationships: []
      }
      outreach_prospects: {
        Row: {
          id: string
          organization_id: string
          email: string
          full_name: string | null
          company: string | null
          job_title: string | null
          website: string | null
          language: string
          tags: string[]
          provenance: string
          lawful_basis: string
          contact_id: string | null
          lead_id: string | null
          status: string
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          email: string
          full_name?: string | null
          company?: string | null
          job_title?: string | null
          website?: string | null
          language?: string
          tags?: string[]
          provenance: string
          lawful_basis: string
          contact_id?: string | null
          lead_id?: string | null
          status?: string
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          email?: string
          full_name?: string | null
          company?: string | null
          job_title?: string | null
          website?: string | null
          language?: string
          tags?: string[]
          provenance?: string
          lawful_basis?: string
          contact_id?: string | null
          lead_id?: string | null
          status?: string
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_templates: {
        Row: {
          id: string
          organization_id: string
          name: string
          language: string
          subject: string
          body: string
          status: string
          created_by: string | null
          approved_by: string | null
          approved_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          name: string
          language?: string
          subject: string
          body: string
          status?: string
          created_by?: string | null
          approved_by?: string | null
          approved_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          name?: string
          language?: string
          subject?: string
          body?: string
          status?: string
          created_by?: string | null
          approved_by?: string | null
          approved_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
      email_campaigns: {
        Row: {
          id: string
          organization_id: string
          name: string
          audience: Json
          status: string
          recipient_count: number | null
          paused_reason: string | null
          created_by: string
          approved_by: string | null
          approved_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          name: string
          audience?: Json
          status?: string
          recipient_count?: number | null
          paused_reason?: string | null
          created_by: string
          approved_by?: string | null
          approved_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          name?: string
          audience?: Json
          status?: string
          recipient_count?: number | null
          paused_reason?: string | null
          created_by?: string
          approved_by?: string | null
          approved_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_campaign_steps: {
        Row: {
          id: string
          organization_id: string
          campaign_id: string
          step_number: number
          template_id: string
          delay_days: number
        }
        Insert: {
          id?: string
          organization_id: string
          campaign_id: string
          step_number: number
          template_id: string
          delay_days: number
        }
        Update: {
          id?: string
          organization_id?: string
          campaign_id?: string
          step_number?: number
          template_id?: string
          delay_days?: number
        }
        Relationships: []
      }
      email_campaign_recipients: {
        Row: {
          id: string
          organization_id: string
          campaign_id: string
          prospect_id: string
          email: string
          step_number: number
          status: string
          refusal_reason: string | null
          next_send_at: string
          last_error: string | null
          attempts: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          campaign_id: string
          prospect_id: string
          email: string
          step_number?: number
          status?: string
          refusal_reason?: string | null
          next_send_at?: string
          last_error?: string | null
          attempts?: number
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          campaign_id?: string
          prospect_id?: string
          email?: string
          step_number?: number
          status?: string
          refusal_reason?: string | null
          next_send_at?: string
          last_error?: string | null
          attempts?: number
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_outreach_sends: {
        Row: {
          id: string
          organization_id: string
          campaign_id: string
          recipient_id: string
          step_number: number
          email: string
          status: string
          message_ref: string | null
          error: string | null
          reserved_at: string
          sent_at: string | null
        }
        Insert: {
          id?: string
          organization_id: string
          campaign_id: string
          recipient_id: string
          step_number: number
          email: string
          status?: string
          message_ref?: string | null
          error?: string | null
          reserved_at?: string
          sent_at?: string | null
        }
        Update: {
          id?: string
          organization_id?: string
          campaign_id?: string
          recipient_id?: string
          step_number?: number
          email?: string
          status?: string
          message_ref?: string | null
          error?: string | null
          reserved_at?: string
          sent_at?: string | null
        }
        Relationships: []
      }
      announcement_templates: {
        Row: {
          active: boolean
          audience: string
          body_template: string
          created_at: string
          created_by: string | null
          id: string
          kind: string
          name: string
          organization_id: string
          title_template: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          audience: string
          body_template: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          name: string
          organization_id: string
          title_template: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          audience?: string
          body_template?: string
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          name?: string
          organization_id?: string
          title_template?: string
          updated_at?: string
        }
        Relationships: []
      }
      delivery_retry_reasons: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          original_id: string
          reason: string
          requested_by: string | null
          retry_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          original_id: string
          reason: string
          requested_by?: string | null
          retry_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          original_id?: string
          reason?: string
          requested_by?: string | null
          retry_id?: string | null
        }
        Relationships: []
      }
      outbound_emails: {
        Row: {
          body: string
          client_account_id: string | null
          created_at: string
          error: string | null
          id: string
          kind: string
          message_ref: string | null
          organization_id: string
          project_id: string | null
          retry_of: string | null
          retry_reason: string | null
          sent_by: string | null
          status: string
          subject: string
          to_address: string
          transport: string | null
        }
        Insert: {
          body: string
          client_account_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          message_ref?: string | null
          organization_id: string
          project_id?: string | null
          retry_of?: string | null
          retry_reason?: string | null
          sent_by?: string | null
          status: string
          subject: string
          to_address: string
          transport?: string | null
        }
        Update: {
          body?: string
          client_account_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          message_ref?: string | null
          organization_id?: string
          project_id?: string | null
          retry_of?: string | null
          retry_reason?: string | null
          sent_by?: string | null
          status?: string
          subject?: string
          to_address?: string
          transport?: string | null
        }
        Relationships: []
      }
      announcements: {
        Row: {
          client_account_id: string | null
          milestone_id: string | null
          project_id: string | null
          source: string
          template_id: string | null
          scheduled_for: string | null
          archived_at: string | null
          audience: string
          body: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          published_at: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          client_account_id?: string | null
          milestone_id?: string | null
          project_id?: string | null
          source?: string
          template_id?: string | null
          scheduled_for?: string | null
          archived_at?: string | null
          audience: string
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          published_at?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          client_account_id?: string | null
          milestone_id?: string | null
          project_id?: string | null
          source?: string
          template_id?: string | null
          scheduled_for?: string | null
          archived_at?: string | null
          audience?: string
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          published_at?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcements_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_recipients: {
        Row: {
          campaign_id: string
          claimed_at: string | null
          client_account_id: string | null
          conversation_id: string | null
          created_at: string
          decided_at: string | null
          id: string
          lead_id: string | null
          message_id: string | null
          organization_id: string
          reason: string | null
          status: string
          updated_at: string
        }
        Insert: {
          campaign_id: string
          claimed_at?: string | null
          client_account_id?: string | null
          conversation_id?: string | null
          created_at?: string
          decided_at?: string | null
          id?: string
          lead_id?: string | null
          message_id?: string | null
          organization_id: string
          reason?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          campaign_id?: string
          claimed_at?: string | null
          client_account_id?: string | null
          conversation_id?: string | null
          created_at?: string
          decided_at?: string | null
          id?: string
          lead_id?: string | null
          message_id?: string | null
          organization_id?: string
          reason?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          scheduled_for: string | null
          approved_at: string | null
          approved_by: string | null
          audience: Json
          cancelled_reason: string | null
          created_at: string
          created_by: string | null
          failed_count: number
          finished_at: string | null
          id: string
          name: string
          organization_id: string
          recipients_count: number
          refused_count: number
          sent_count: number
          started_at: string | null
          status: string
          template_id: string
          updated_at: string
        }
        Insert: {
          scheduled_for?: string | null
          approved_at?: string | null
          approved_by?: string | null
          audience?: Json
          cancelled_reason?: string | null
          created_at?: string
          created_by?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          name: string
          organization_id: string
          recipients_count?: number
          refused_count?: number
          sent_count?: number
          started_at?: string | null
          status?: string
          template_id: string
          updated_at?: string
        }
        Update: {
          scheduled_for?: string | null
          approved_at?: string | null
          approved_by?: string | null
          audience?: Json
          cancelled_reason?: string | null
          created_at?: string
          created_by?: string | null
          failed_count?: number
          finished_at?: string | null
          id?: string
          name?: string
          organization_id?: string
          recipients_count?: number
          refused_count?: number
          sent_count?: number
          started_at?: string | null
          status?: string
          template_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_templates"
            referencedColumns: ["id"]
          },
        ]
      }
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
          retry_count: number
          retry_of: string | null
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
          retry_count?: number
          retry_of?: string | null
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
          retry_count?: number
          retry_of?: string | null
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
          {
            foreignKeyName: "conversation_messages_retry_of_fkey"
            columns: ["retry_of"]
            isOneToOne: false
            referencedRelation: "conversation_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      conversation_summaries: {
        Row: {
          conversation_id: string
          created_at: string
          organization_id: string
          summary: string
          through_seq: number
          updated_at: string
          written_by_agent: string | null
        }
        Insert: {
          conversation_id: string
          created_at?: string
          organization_id: string
          summary: string
          through_seq: number
          updated_at?: string
          written_by_agent?: string | null
        }
        Update: {
          conversation_id?: string
          created_at?: string
          organization_id?: string
          summary?: string
          through_seq?: number
          updated_at?: string
          written_by_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversation_summaries_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: true
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
      deferred_sends: {
        Row: {
          blocked_on: string
          conversation_id: string
          counterpart_digits: string
          created_at: string
          deferred_at: string
          id: string
          job_id: string
          organization_id: string
          reason: string
          updated_at: string
          woken_at: string | null
        }
        Insert: {
          blocked_on?: string
          conversation_id: string
          counterpart_digits: string
          created_at?: string
          deferred_at?: string
          id?: string
          job_id: string
          organization_id: string
          reason: string
          updated_at?: string
          woken_at?: string | null
        }
        Update: {
          blocked_on?: string
          conversation_id?: string
          counterpart_digits?: string
          created_at?: string
          deferred_at?: string
          id?: string
          job_id?: string
          organization_id?: string
          reason?: string
          updated_at?: string
          woken_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deferred_sends_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
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
      import_messages: {
        Row: {
          body: string
          created_at: string
          direction: string
          id: string
          kind: string
          occurred_at_local: string
          ordinal: number
          organization_id: string
          record_id: string
        }
        Insert: {
          body: string
          created_at?: string
          direction: string
          id?: string
          kind?: string
          occurred_at_local: string
          ordinal: number
          organization_id: string
          record_id: string
        }
        Update: {
          body?: string
          created_at?: string
          direction?: string
          id?: string
          kind?: string
          occurred_at_local?: string
          ordinal?: number
          organization_id?: string
          record_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_messages_record_id_fkey"
            columns: ["record_id"]
            isOneToOne: false
            referencedRelation: "import_records"
            referencedColumns: ["id"]
          },
        ]
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
      lead_files: {
        Row: {
          added_at: string
          added_by: string | null
          carried_at: string | null
          carried_to_project_id: string | null
          id: string
          lead_id: string
          organization_id: string
          title: string
          url: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          carried_at?: string | null
          carried_to_project_id?: string | null
          id?: string
          lead_id: string
          organization_id: string
          title: string
          url: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          carried_at?: string | null
          carried_to_project_id?: string | null
          id?: string
          lead_id?: string
          organization_id?: string
          title?: string
          url?: string
        }
        Relationships: []
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
      budget_bands: {
        Row: {
          bands: Json
          organization_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          bands: Json
          organization_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          bands?: Json
          organization_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      leads: {
        Row: {
          assigned_to: string | null
          campaign_headline: string | null
          campaign_source_id: string | null
          campaign_source_type: string | null
          campaign_source_url: string | null
          contact_id: string | null
          converted_at: string | null
          created_at: string
          deleted_at: string | null
          disqualified_reason: string | null
          heat_override: string | null
          heat_override_at: string | null
          heat_override_by: string | null
          heat_override_computed: string | null
          heat_override_reason: string | null
          id: string
          in_reactivation_pilot: boolean
          merged_at: string | null
          merged_into_lead_id: string | null
          next_follow_up_at: string | null
          nurture_reason: string | null
          organization_id: string
          qualification: Json
          qualified_at: string | null
          requirements: Json
          score: number | null
          score_inputs: Json | null
          score_override: number | null
          score_override_at: string | null
          score_override_by: string | null
          score_override_reason: string | null
          score_reasons: Json | null
          scored_at: string | null
          service: string | null
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
          campaign_headline?: string | null
          campaign_source_id?: string | null
          campaign_source_type?: string | null
          campaign_source_url?: string | null
          contact_id?: string | null
          converted_at?: string | null
          created_at?: string
          deleted_at?: string | null
          disqualified_reason?: string | null
          heat_override?: string | null
          heat_override_at?: string | null
          heat_override_by?: string | null
          heat_override_computed?: string | null
          heat_override_reason?: string | null
          id?: string
          in_reactivation_pilot?: boolean
          merged_at?: string | null
          merged_into_lead_id?: string | null
          next_follow_up_at?: string | null
          nurture_reason?: string | null
          organization_id: string
          qualification?: Json
          qualified_at?: string | null
          requirements?: Json
          score?: number | null
          score_inputs?: Json | null
          score_override?: number | null
          score_override_at?: string | null
          score_override_by?: string | null
          score_override_reason?: string | null
          score_reasons?: Json | null
          scored_at?: string | null
          service?: string | null
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
          campaign_headline?: string | null
          campaign_source_id?: string | null
          campaign_source_type?: string | null
          campaign_source_url?: string | null
          contact_id?: string | null
          converted_at?: string | null
          created_at?: string
          deleted_at?: string | null
          disqualified_reason?: string | null
          heat_override?: string | null
          heat_override_at?: string | null
          heat_override_by?: string | null
          heat_override_computed?: string | null
          heat_override_reason?: string | null
          id?: string
          in_reactivation_pilot?: boolean
          merged_at?: string | null
          merged_into_lead_id?: string | null
          next_follow_up_at?: string | null
          nurture_reason?: string | null
          organization_id?: string
          qualification?: Json
          qualified_at?: string | null
          requirements?: Json
          score?: number | null
          score_inputs?: Json | null
          score_override?: number | null
          score_override_at?: string | null
          score_override_by?: string | null
          score_override_reason?: string | null
          score_reasons?: Json | null
          scored_at?: string | null
          service?: string | null
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
          {
            foreignKeyName: "leads_merged_into_lead_id_fkey"
            columns: ["merged_into_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      meeting_evidence: {
        Row: {
          artifact_ref: string | null
          body: string | null
          byte_size: number | null
          created_at: string
          file_name: string | null
          id: string
          kind: string
          lead_id: string
          media_type: string | null
          meeting_id: string
          organization_id: string
          storage_path: string | null
          uploaded_at: string
          uploaded_by: string | null
          visibility: string
        }
        Insert: {
          artifact_ref?: string | null
          body?: string | null
          byte_size?: number | null
          created_at?: string
          file_name?: string | null
          id?: string
          kind: string
          lead_id: string
          media_type?: string | null
          meeting_id: string
          organization_id: string
          storage_path?: string | null
          uploaded_at?: string
          uploaded_by?: string | null
          visibility?: string
        }
        Update: {
          artifact_ref?: string | null
          body?: string | null
          byte_size?: number | null
          created_at?: string
          file_name?: string | null
          id?: string
          kind?: string
          lead_id?: string
          media_type?: string | null
          meeting_id?: string
          organization_id?: string
          storage_path?: string | null
          uploaded_at?: string
          uploaded_by?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "meeting_evidence_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meeting_evidence_meeting_id_fkey"
            columns: ["meeting_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          }
        ]
      }
      meetings: {
        Row: {
          availability_read_at: string | null
          availability_source: string | null
          booked_at: string | null
          booked_mode: string | null
          booking_key: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          completed_at: string | null
          completed_by: string | null
          confirmed_end_at: string | null
          confirmed_start_at: string | null
          contact_id: string | null
          conversation_id: string | null
          created_at: string
          created_by: string | null
          duration_minutes: number | null
          id: string
          lead_id: string
          meeting_url: string | null
          opportunity_id: string | null
          organization_id: string
          outcome: string | null
          project_id: string | null
          proposed_slots: Json | null
          provider: string | null
          provider_event_id: string | null
          purpose: string | null
          requested_message_id: string | null
          requested_mode: string
          requested_start_at: string | null
          requested_window_end: string | null
          status: string
          supersedes_id: string | null
          timezone: string | null
          updated_at: string
        }
        Insert: {
          availability_read_at?: string | null
          availability_source?: string | null
          booked_at?: string | null
          booked_mode?: string | null
          booking_key?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          completed_by?: string | null
          confirmed_end_at?: string | null
          confirmed_start_at?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          duration_minutes?: number | null
          id?: string
          lead_id: string
          meeting_url?: string | null
          opportunity_id?: string | null
          organization_id: string
          outcome?: string | null
          project_id?: string | null
          proposed_slots?: Json | null
          provider?: string | null
          provider_event_id?: string | null
          purpose?: string | null
          requested_message_id?: string | null
          requested_mode: string
          requested_start_at?: string | null
          requested_window_end?: string | null
          status?: string
          supersedes_id?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          availability_read_at?: string | null
          availability_source?: string | null
          booked_at?: string | null
          booked_mode?: string | null
          booking_key?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          completed_by?: string | null
          confirmed_end_at?: string | null
          confirmed_start_at?: string | null
          contact_id?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          duration_minutes?: number | null
          id?: string
          lead_id?: string
          meeting_url?: string | null
          opportunity_id?: string | null
          organization_id?: string
          outcome?: string | null
          project_id?: string | null
          proposed_slots?: Json | null
          provider?: string | null
          provider_event_id?: string | null
          purpose?: string | null
          requested_message_id?: string | null
          requested_mode?: string
          requested_start_at?: string | null
          requested_window_end?: string | null
          status?: string
          supersedes_id?: string | null
          timezone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "meetings_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_requested_message_id_fkey"
            columns: ["requested_message_id"]
            isOneToOne: false
            referencedRelation: "conversation_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "meetings_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "meetings"
            referencedColumns: ["id"]
          }
        ]
      }
      outreach_limits: {
        Row: {
          cooldown_days: number
          created_at: string
          organization_id: string
          per_contact_per_day: number
          per_contact_per_week: number
          per_organization_per_day: number
          unanswered_before_cooldown: number
          updated_at: string
        }
        Insert: {
          cooldown_days?: number
          created_at?: string
          organization_id: string
          per_contact_per_day?: number
          per_contact_per_week?: number
          per_organization_per_day?: number
          unanswered_before_cooldown?: number
          updated_at?: string
        }
        Update: {
          cooldown_days?: number
          created_at?: string
          organization_id?: string
          per_contact_per_day?: number
          per_contact_per_week?: number
          per_organization_per_day?: number
          unanswered_before_cooldown?: number
          updated_at?: string
        }
        Relationships: []
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
      requirement_links: {
        Row: {
          created_at: string
          deliverable_id: string | null
          id: string
          linked_by: string | null
          note: string | null
          organization_id: string
          quotation_id: string | null
          requirement_version_id: string
          target_id: string | null
          target_type: string
          task_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          deliverable_id?: string | null
          id?: string
          linked_by?: string | null
          note?: string | null
          organization_id: string
          quotation_id?: string | null
          requirement_version_id: string
          target_id?: string | null
          target_type: string
          task_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          deliverable_id?: string | null
          id?: string
          linked_by?: string | null
          note?: string | null
          organization_id?: string
          quotation_id?: string | null
          requirement_version_id?: string
          target_id?: string | null
          target_type?: string
          task_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "requirement_links_requirement_version_id_fkey"
            columns: ["requirement_version_id"]
            isOneToOne: false
            referencedRelation: "requirement_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      requirement_question_sends: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          message_id: string
          organization_id: string
          question: string
          question_index: number
          requirement_version_id: string
          sent_at: string
          sent_by: string | null
          updated_at: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          message_id: string
          organization_id: string
          question: string
          question_index: number
          requirement_version_id: string
          sent_at?: string
          sent_by?: string | null
          updated_at?: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          message_id?: string
          organization_id?: string
          question?: string
          question_index?: number
          requirement_version_id?: string
          sent_at?: string
          sent_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "requirement_question_sends_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirement_question_sends_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "conversation_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirement_question_sends_requirement_version_id_fkey"
            columns: ["requirement_version_id"]
            isOneToOne: false
            referencedRelation: "requirement_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      requirement_versions: {
        Row: {
          confirmation_message_id: string | null
          conversation_id: string
          created_at: string
          created_by: string | null
          generated_by_run_id: string | null
          id: string
          organization_id: string
          payload: Json
          sent_for_confirmation_at: string | null
          source: string
          source_job_id: string | null
          source_message_count: number | null
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          confirmation_message_id?: string | null
          conversation_id: string
          created_at?: string
          created_by?: string | null
          generated_by_run_id?: string | null
          id?: string
          organization_id: string
          payload?: Json
          sent_for_confirmation_at?: string | null
          source: string
          source_job_id?: string | null
          source_message_count?: number | null
          status?: string
          updated_at?: string
          version: number
        }
        Update: {
          confirmation_message_id?: string | null
          conversation_id?: string
          created_at?: string
          created_by?: string | null
          generated_by_run_id?: string | null
          id?: string
          organization_id?: string
          payload?: Json
          sent_for_confirmation_at?: string | null
          source?: string
          source_job_id?: string | null
          source_message_count?: number | null
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "requirement_versions_confirmation_message_id_fkey"
            columns: ["confirmation_message_id"]
            isOneToOne: false
            referencedRelation: "conversation_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requirement_versions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      third_party_charges: {
        Row: {
          active: boolean
          charge: string
          checked_on: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          service: string
          source: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          charge: string
          checked_on?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          service: string
          source?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          charge?: string
          checked_on?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          service?: string
          source?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      whatsapp_template_versions: {
        Row: {
          active: boolean
          change_reason: string | null
          changed_by: string | null
          created_at: string
          id: string
          language_code: string
          organization_id: string
          parameters: string[]
          recorded_at: string
          status: string
          template_id: string
          template_name: string
          updated_at: string
        }
        Insert: {
          active: boolean
          change_reason?: string | null
          changed_by?: string | null
          created_at?: string
          id?: string
          language_code: string
          organization_id: string
          parameters?: string[]
          recorded_at?: string
          status: string
          template_id: string
          template_name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          change_reason?: string | null
          changed_by?: string | null
          created_at?: string
          id?: string
          language_code?: string
          organization_id?: string
          parameters?: string[]
          recorded_at?: string
          status?: string
          template_id?: string
          template_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_template_versions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_template_performance"
            referencedColumns: ["template_id"]
          },
          {
            foreignKeyName: "whatsapp_template_versions_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_templates: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          id: string
          language_code: string
          organization_id: string
          parameters: string[]
          situation_key: string
          status: string
          template_name: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          language_code: string
          organization_id: string
          parameters?: string[]
          situation_key: string
          status?: string
          template_name: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          language_code?: string
          organization_id?: string
          parameters?: string[]
          situation_key?: string
          status?: string
          template_name?: string
          updated_at?: string
        }
        Relationships: []
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
      whatsapp_template_performance: {
        Row: {
          active: boolean | null
          delivered: number | null
          failed: number | null
          language_code: string | null
          organization_id: string | null
          read: number | null
          replied: number | null
          sent: number | null
          situation_key: string | null
          status: string | null
          template_id: string | null
          template_name: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      set_outreach_settings: {
        Args: { p_bounce_pause_percent: number; p_cold_basis_enabled?: boolean; p_daily_cap: number; p_postal_address: string; p_reply_to: string; p_sender_name: string }
        Returns: {
          outcome: string | null
        }[]
      }
      suppress_email: {
        Args: { p_email: string; p_note?: string; p_reason: string }
        Returns: {
          outcome: string | null
        }[]
      }
      record_unsubscribe: {
        Args: { p_email: string; p_organization_id: string; p_source: string }
        Returns: {
          outcome: string | null
        }[]
      }
      add_outreach_prospects: {
        Args: { p_rows: Json }
        Returns: {
          inserted: number | null
          duplicates: number | null
          suppressed: number | null
          invalid: number | null
          problems: Json | null
        }[]
      }
      create_email_template: {
        Args: { p_body: string; p_language: string; p_name: string; p_subject: string }
        Returns: {
          outcome: string | null
          template_id: string | null
        }[]
      }
      approve_email_template: {
        Args: { p_template_id: string }
        Returns: {
          outcome: string | null
        }[]
      }
      retire_email_template: {
        Args: { p_template_id: string }
        Returns: {
          outcome: string | null
        }[]
      }
      create_email_campaign: {
        Args: { p_audience: Json; p_name: string; p_steps: Json }
        Returns: {
          outcome: string | null
          campaign_id: string | null
        }[]
      }
      outreach_audience: {
        Args: { p_audience: Json; p_organization_id: string }
        Returns: {
          prospect_id: string | null
          email: string | null
          reachable: boolean | null
          reason: string | null
        }[]
      }
      preview_email_campaign: {
        Args: { p_campaign_id: string }
        Returns: {
          reachable: number | null
          suppressed: number | null
          no_consent: number | null
          cold_not_enabled: number | null
        }[]
      }
      approve_email_campaign: {
        Args: { p_campaign_id: string }
        Returns: {
          outcome: string | null
          recipient_count: number | null
        }[]
      }
      set_email_campaign_state: {
        Args: { p_campaign_id: string; p_note?: string; p_to: string }
        Returns: {
          outcome: string | null
        }[]
      }
      mark_prospect_replied: {
        Args: { p_prospect_id: string }
        Returns: {
          outcome: string | null
        }[]
      }
      convert_prospect: {
        Args: { p_prospect_id: string }
        Returns: {
          outcome: string | null
          lead_id: string | null
        }[]
      }
      orgs_with_running_email_campaigns: {
        Args: never
        Returns: {
          organization_id: string | null
        }[]
      }
      outreach_cap_today: {
        Args: { p_organization_id: string }
        Returns: number
      }
      claim_outreach_sends: {
        Args: { p_limit: number; p_organization_id: string }
        Returns: {
          send_id: string | null
          recipient_id: string | null
          campaign_id: string | null
          step_number: number | null
          email: string | null
          first_name: string | null
          company: string | null
          language: string | null
          subject: string | null
          body: string | null
          sender_name: string | null
          postal_address: string | null
          reply_to: string | null
        }[]
      }
      record_outreach_result: {
        Args: { p_error: string; p_message_ref: string; p_outcome: string; p_send_id: string }
        Returns: {
          outcome: string | null
        }[]
      }
      publish_due_announcements: {
        Args: { p_limit?: number }
        Returns: {
          announcement_id: string
          organization_id: string
          title: string
        }[]
      }
      schedule_announcement: {
        Args: { p_announcement_id: string; p_scheduled_for: string | null }
        Returns: {
          outcome: string
        }[]
      }
      add_lead_to_reactivation_pilot: {
        Args: { p_lead_id: string }
        Returns: {
          outcome: string
        }[]
      }
      add_meeting_evidence_file: {
        Args: {
          p_byte_size?: number
          p_file_name: string
          p_kind: string
          p_media_type?: string
          p_meeting_id: string
          p_storage_path: string
          p_visibility: string
        }
        Returns: { evidence_id: string | null; lead_id: string | null; outcome: string }[]
      }
      add_meeting_evidence: {
        Args: {
          p_meeting_id: string
          p_kind: string
          p_body?: string
          p_visibility?: string
          p_artifact_ref?: string
          p_media_type?: string
          p_byte_size?: number
        }
        Returns: {
          outcome: string
          evidence_id: string | null
          lead_id: string | null
        }[]
      }
      announce_waiting_approvals: {
        Args: { p_organization_id: string }
        Returns: number
      }
      approve_campaign: {
        Args: { p_campaign_id: string; p_recipients: Json }
        Returns: {
          outcome: string
          recipients: number
        }[]
      }
      awaits_media_reading: {
        Args: { p_media_read_at: string; p_metadata: Json }
        Returns: boolean
      }
      book_meeting: {
        Args: {
          p_meeting_id: string
          p_booking_key: string
          p_start_at: string
          p_end_at: string
          p_timezone: string
          p_mode: string
          p_provider?: string
          p_provider_event_id?: string
          p_meeting_url?: string
          p_max_staleness_seconds?: number
        }
        Returns: {
          outcome: string
          meeting_id: string | null
        }[]
      }
      cancel_campaign: {
        Args: { p_campaign_id: string; p_reason: string }
        Returns: {
          outcome: string
          withdrawn: number
        }[]
      }
      cancel_meeting: {
        Args: { p_meeting_id: string; p_reason?: string }
        Returns: {
          outcome: string
          meeting_id: string | null
          lead_id: string | null
          provider_event_id: string | null
        }[]
      }
      claim_campaign_recipient: {
        Args: Record<PropertyKey, never>
        Returns: {
          recipient_id: string
          campaign_id: string
          organization_id: string
          lead_id: string | null
          conversation_id: string | null
          template_id: string
        }[]
      }
      clear_third_party_charge: {
        Args: { p_organization_id: string; p_service: string }
        Returns: {
          outcome: string
        }[]
      }
      clear_whatsapp_template: {
        Args: {
          p_language_code?: string
          p_organization_id: string
          p_situation_key: string
        }
        Returns: {
          outcome: string
        }[]
      }
      complete_meeting: {
        Args: { p_meeting_id: string; p_outcome?: string; p_note?: string }
        Returns: {
          outcome: string
          meeting_id: string | null
          lead_id: string | null
          evidence_id: string | null
          analysis: string | null
        }[]
      }
      commit_import_batch: {
        Args: { p_batch_id: string; p_limit?: number }
        Returns: {
          already: number
          committed: number
          outcome: string
          remaining: number
          skipped: number
          uncommitted: number
        }[]
      }
      commit_import_record: {
        Args: { p_record_id: string }
        Returns: {
          contact_id: string
          lead_id: string
          messages_imported: number
          messages_skipped: number
          outcome: string
        }[]
      }
      contact_relationship: { Args: { p_contact_id: string }; Returns: string }
      conversation_counterpart_digits: {
        Args: { p_conversation_id: string }
        Returns: string
      }
      create_campaign: {
        Args: { p_audience: Json; p_name: string; p_scheduled_for?: string | null; p_template_id: string }
        Returns: {
          outcome: string
          campaign_id: string | null
        }[]
      }
      decide_follow_up_sequence: {
        Args: { p_action: string; p_next_due_at?: string | null; p_reason: string; p_sequence_id: string }
        Returns: { outcome: string }[]
      }
      defer_send: {
        Args: {
          p_blocked_on?: string
          p_conversation_id: string
          p_job_id: string
          p_reason: string
          p_until?: string
        }
        Returns: string
      }
      due_follow_up_sequences: {
        Args: { p_limit?: number }
        Returns: {
          attempts_sent: number
          contact_id: string
          conversation_id: string
          correlation_id: string
          thread_paused_at: string | null
          organization_id: string
          sequence_id: string
          situation_key: string
          subject_id: string
          subject_type: string
          triggered_at: string
        }[]
      }
      enrol_reactivation_batch: {
        Args: { p_batch_id: string; p_limit?: number }
        Returns: {
          already_in: number
          enrolled: number
          no_consent: number
          not_contactable: number
          outcome: string
          remaining: number
          uncommitted: number
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
      import_relationship_preview: {
        Args: { p_batch_id: string }
        Returns: {
          contactable: boolean
          records: number
          relationship: string
        }[]
      }
      ingest_group_message: {
        Args: {
          p_body: string
          p_caption?: string
          p_external_ref: string
          p_from: string
          p_group_id: string
          p_media_id?: string
          p_media_type?: string
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
      add_lead_file: {
        Args: { p_lead_id: string; p_title: string; p_url: string }
        Returns: { file_id: string | null; outcome: string }[]
      }
      claim_lead_file_carry: {
        Args: { p_file_id: string; p_project_id: string }
        Returns: { outcome: string }[]
      }
      last_inbound_by_lead: {
        Args: Record<PropertyKey, never>
        Returns: { last_inbound_at: string | null; lead_id: string }[]
      }
      release_lead_file_carry: {
        Args: { p_file_id: string; p_project_id: string }
        Returns: { outcome: string }[]
      }
      remove_lead_file: {
        Args: { p_file_id: string }
        Returns: { outcome: string }[]
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
      lead_timeline: {
        Args: { p_lead_id: string }
        Returns: {
          actor_id: string | null
          actor_type: string
          evidence_id: string
          evidence_type: string
          event_type: string
          occurred_at: string
          summary: string | null
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
      mark_message_as_outreach: {
        Args: { p_message_id: string; p_template_id?: string }
        Returns: boolean
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
      merge_leads: {
        Args: { p_loser_lead_id: string; p_reason: string; p_winner_lead_id: string }
        Returns: {
          outcome: string
        }[]
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
      outreach_allowance: {
        Args: { p_conversation_id: string }
        Returns: string
      }
      outreach_limits_for: {
        Args: { p_organization_id: string }
        Returns: {
          cooldown_days: number
          created_at: string
          organization_id: string
          per_contact_per_day: number
          per_contact_per_week: number
          per_organization_per_day: number
          unanswered_before_cooldown: number
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "outreach_limits"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      note_availability_read: {
        Args: { p_meeting_id: string; p_availability_source: string; p_availability_read_at: string }
        Returns: {
          outcome: string
          meeting_id: string | null
        }[]
      }
      override_lead_score: {
        Args: { p_lead_id: string; p_reason: string; p_score?: number | null }
        Returns: { outcome: string }[]
      }
      override_lead_heat: {
        Args: { p_lead_id: string; p_label: string; p_reason: string; p_computed: string }
        Returns: { outcome: string }[]
      }
      set_budget_bands: {
        Args: { p_bands: Json }
        Returns: { outcome: string }[]
      }
      propose_meeting_slots: {
        Args: { p_meeting_id: string; p_slots: Json; p_availability_source: string; p_availability_read_at: string; p_duration_minutes: number }
        Returns: {
          outcome: string
          meeting_id: string | null
          lead_id: string | null
        }[]
      }
      project_group_title: {
        Args: { p_project_id: string }
        Returns: {
          missing: string[]
          title: string
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
      record_campaign_recipient: {
        Args: { p_message_id?: string; p_reason?: string; p_recipient_id: string; p_status: string }
        Returns: {
          outcome: string
          campaign_status: string | null
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
      save_announcement_template: {
        Args: { p_active?: boolean; p_audience: string; p_body_template: string; p_kind: string; p_name: string; p_template_id?: string; p_title_template: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      create_announcement: {
        Args: { p_audience: string; p_body: string; p_client_account_id?: string; p_project_id?: string; p_template_id?: string; p_title: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      draft_milestone_announcement: {
        Args: { p_milestone_id: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      requeue_failed_delivery: {
        Args: { p_original_id: string; p_reason: string; p_retry_id: string }
        Returns: {
          outcome: string
          retry_count: number | null
        }[]
      }
      record_outbound_email: {
        Args: { p_body: string; p_error?: string; p_kind: string; p_message_ref?: string; p_project_id?: string; p_retry_of?: string; p_retry_reason?: string; p_status: string; p_subject: string; p_to: string; p_transport?: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      record_delivery_retry: {
        Args: { p_original_id: string; p_retry_id: string }
        Returns: {
          outcome: string
          retry_count: number | null
        }[]
      }
      record_no_show: {
        Args: { p_meeting_id: string; p_note?: string }
        Returns: {
          outcome: string
          meeting_id: string | null
          lead_id: string | null
          evidence_id: string | null
        }[]
      }
      reschedule_meeting: {
        Args: { p_meeting_id: string; p_reason?: string; p_requested_start_at?: string; p_requested_window_end?: string; p_requested_mode?: string }
        Returns: {
          outcome: string
          meeting_id: string | null
          new_meeting_id: string | null
          lead_id: string | null
          provider_event_id: string | null
        }[]
      }
      relationship_admits_reengagement: {
        Args: { p_relationship: string }
        Returns: boolean
      }
      remove_lead_from_reactivation_pilot: {
        Args: { p_lead_id: string }
        Returns: {
          outcome: string
        }[]
      }
      request_meeting: {
        Args: {
          p_lead_id: string
          p_mode: string
          p_timezone: string
          p_purpose?: string | null
          p_conversation_id?: string | null
          p_requested_message_id?: string | null
          p_contact_id?: string | null
          p_opportunity_id?: string | null
          p_requested_start_at?: string | null
          p_requested_window_end?: string | null
          p_duration_minutes?: number | null
        }
        Returns: {
          outcome: string
          meeting_id: string | null
          lead_id: string | null
        }[]
      }
      request_meeting_analysis: {
        Args: { p_meeting_id: string }
        Returns: {
          outcome: string
          job_id: string | null
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
      link_requirement: {
        Args: { p_requirement_version_id: string; p_target_type: string; p_target_id: string; p_note?: string | null }
        Returns: {
          outcome: string
          link_id: string | null
        }[]
      }
      revise_requirement_version: {
        Args: { p_source_version_id: string; p_payload: Json }
        Returns: {
          outcome: string
          version_id: string | null
          version: number | null
          lead_id: string | null
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
      send_requirement_for_confirmation: {
        Args: { p_body: string; p_version_id: string }
        Returns: {
          message_id: string
          outcome: string
        }[]
      }
      send_requirement_question: {
        Args: { p_version_id: string; p_question_index: number; p_question: string; p_body: string }
        Returns: {
          outcome: string
          message_id: string | null
        }[]
      }
      set_announcement_status: {
        Args: {
          p_announcement_id: string
          p_organization_id: string
          p_status: string
        }
        Returns: {
          outcome: string
        }[]
      }
      set_lead_score: {
        Args: {
          p_inputs: Json
          p_lead_id: string
          p_reasons: Json
          p_score: number
        }
        Returns: {
          outcome: string
        }[]
      }
      set_third_party_charge: {
        Args: {
          p_charge: string
          p_checked_on?: string
          p_organization_id: string
          p_service: string
          p_source?: string
        }
        Returns: {
          charge_id: string
          outcome: string
        }[]
      }
      set_whatsapp_template: {
        Args: {
          p_language_code: string
          p_organization_id: string
          p_parameters?: string[]
          p_situation_key: string
          p_template_name: string
        }
        Returns: {
          outcome: string
          template_id: string
        }[]
      }
      set_whatsapp_template_status: {
        Args: {
          p_organization_id: string
          p_situation_key: string
          p_status: string
        }
        Returns: {
          outcome: string
          template_id: string
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
      template_for: {
        Args: {
          p_conversation_id: string
          p_organization_id: string
          p_situation_key: string
        }
        Returns: {
          language_code: string
          matched_language: boolean
          parameters: string[]
          template_id: string
          template_name: string
        }[]
      }
      wake_deferred_sends: {
        Args: { p_digits: string; p_organization_id: string }
        Returns: number
      }
      window_is_open: { Args: { p_conversation_id: string }; Returns: boolean }
      window_open_until: {
        Args: { p_conversation_id: string }
        Returns: string
      }
      window_state: { Args: { p_conversation_id: string }; Returns: string }
      withdraw_reactivation_batch: {
        Args: { p_batch_id: string }
        Returns: {
          outcome: string
          withdrawn: number
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
  finance: {
    Tables: {
      bank_statement_lines: {
        Row: {
          amount_minor: number
          created_at: string
          description: string
          id: string
          ignored_reason: string | null
          import_batch: string
          imported_by: string | null
          item_id: string | null
          line_no: number
          organization_id: string
          reconciliation_id: string
          reference: string | null
          source_filename: string | null
          statement_date: string
          status: string
          updated_at: string
        }
        Insert: {
          amount_minor: number
          created_at?: string
          description: string
          id?: string
          ignored_reason?: string | null
          import_batch: string
          imported_by?: string | null
          item_id?: string | null
          line_no: number
          organization_id: string
          reconciliation_id: string
          reference?: string | null
          source_filename?: string | null
          statement_date: string
          status?: string
          updated_at?: string
        }
        Update: {
          amount_minor?: number
          created_at?: string
          description?: string
          id?: string
          ignored_reason?: string | null
          import_batch?: string
          imported_by?: string | null
          item_id?: string | null
          line_no?: number
          organization_id?: string
          reconciliation_id?: string
          reference?: string | null
          source_filename?: string | null
          statement_date?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_statement_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "reconciliation_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_statement_lines_reconciliation_id_fkey"
            columns: ["reconciliation_id"]
            isOneToOne: false
            referencedRelation: "reconciliations"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount_minor: number
          category: string
          created_at: string
          currency: string
          description: string
          id: string
          incurred_on: string
          organization_id: string
          project_id: string | null
          receipt_file_name: string | null
          receipt_storage_path: string | null
          receipt_url: string | null
          recorded_by: string | null
          updated_at: string
          vendor: string | null
        }
        Insert: {
          amount_minor: number
          category: string
          created_at?: string
          currency?: string
          description: string
          id?: string
          incurred_on: string
          organization_id: string
          project_id?: string | null
          receipt_file_name?: string | null
          receipt_storage_path?: string | null
          receipt_url?: string | null
          recorded_by?: string | null
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          amount_minor?: number
          category?: string
          created_at?: string
          currency?: string
          description?: string
          id?: string
          incurred_on?: string
          organization_id?: string
          project_id?: string | null
          receipt_file_name?: string | null
          receipt_storage_path?: string | null
          receipt_url?: string | null
          recorded_by?: string | null
          updated_at?: string
          vendor?: string | null
        }
        Relationships: []
      }
      billing_profiles: {
        Row: {
          billing_address: string | null
          billing_state: string | null
          billing_state_code: string | null
          client_account_id: string
          confirmed_at: string
          confirmed_by: string | null
          created_at: string
          gstin: string | null
          id: string
          legal_name: string | null
          mode: string
          note: string | null
          organization_id: string
          project_id: string
          source: string
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          billing_address?: string | null
          billing_state?: string | null
          billing_state_code?: string | null
          client_account_id: string
          confirmed_at?: string
          confirmed_by?: string | null
          created_at?: string
          gstin?: string | null
          id?: string
          legal_name?: string | null
          mode: string
          note?: string | null
          organization_id: string
          project_id: string
          source: string
          status?: string
          updated_at?: string
          version: number
        }
        Update: {
          billing_address?: string | null
          billing_state?: string | null
          billing_state_code?: string | null
          client_account_id?: string
          confirmed_at?: string
          confirmed_by?: string | null
          created_at?: string
          gstin?: string | null
          id?: string
          legal_name?: string | null
          mode?: string
          note?: string | null
          organization_id?: string
          project_id?: string
          source?: string
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      gst_exports: {
        Row: {
          counts: Json
          created_at: string
          exported_by: string | null
          id: string
          kind: string
          omitted: Json
          organization_id: string
          period_label: string
          return_period: string
          updated_at: string
        }
        Insert: {
          counts?: Json
          created_at?: string
          exported_by?: string | null
          id?: string
          kind: string
          omitted?: Json
          organization_id: string
          period_label: string
          return_period: string
          updated_at?: string
        }
        Update: {
          counts?: Json
          created_at?: string
          exported_by?: string | null
          id?: string
          kind?: string
          omitted?: Json
          organization_id?: string
          period_label?: string
          return_period?: string
          updated_at?: string
        }
        Relationships: []
      }
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
      invoice_deliveries: {
        Row: {
          attempts: number
          channel: string
          conversation_id: string | null
          created_at: string
          delivered_at: string | null
          destination: string | null
          id: string
          invoice_id: string
          last_error: string | null
          message_ref: string | null
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          channel: string
          conversation_id?: string | null
          created_at?: string
          delivered_at?: string | null
          destination?: string | null
          id?: string
          invoice_id: string
          last_error?: string | null
          message_ref?: string | null
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          channel?: string
          conversation_id?: string | null
          created_at?: string
          delivered_at?: string | null
          destination?: string | null
          id?: string
          invoice_id?: string
          last_error?: string | null
          message_ref?: string | null
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_deliveries_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_deliveries_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_sends: {
        Row: {
          automatic: boolean
          channel: string
          conversation_id: string | null
          created_at: string
          id: string
          invoice_id: string
          kind: string
          message_ref: string | null
          note: string | null
          organization_id: string
          sent_at: string
          sent_by: string | null
          updated_at: string
        }
        Insert: {
          automatic?: boolean
          channel: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          invoice_id: string
          kind: string
          message_ref?: string | null
          note?: string | null
          organization_id: string
          sent_at?: string
          sent_by?: string | null
          updated_at?: string
        }
        Update: {
          automatic?: boolean
          channel?: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          invoice_id?: string
          kind?: string
          message_ref?: string | null
          note?: string | null
          organization_id?: string
          sent_at?: string
          sent_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_sends_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          kind: string
          maintenance_plan_id: string | null
          billing_profile_id: string | null
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
          kind?: string
          maintenance_plan_id?: string | null
          billing_profile_id?: string | null
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
          kind?: string
          maintenance_plan_id?: string | null
          billing_profile_id?: string | null
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
      expense_categories: {
        Row: {
          created_at: string
          id: string
          key: string
          label: string
          organization_id: string
          retired_at: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          label: string
          organization_id: string
          retired_at?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          label?: string
          organization_id?: string
          retired_at?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      report_exports: {
        Row: {
          created_at: string
          exported_by: string | null
          id: string
          kind: string
          organization_id: string
          period_label: string
          row_count: number
        }
        Insert: {
          created_at?: string
          exported_by?: string | null
          id?: string
          kind: string
          organization_id: string
          period_label: string
          row_count?: number
        }
        Update: {
          created_at?: string
          exported_by?: string | null
          id?: string
          kind?: string
          organization_id?: string
          period_label?: string
          row_count?: number
        }
        Relationships: []
      }
      payment_submissions: {
        Row: {
          evidence_request_note: string | null
          account_id: string | null
          amount_minor: number
          created_at: string
          currency: string
          id: string
          invoice_id: string
          method: string
          mismatch_note: string | null
          organization_id: string
          paid_at: string | null
          payer_name: string | null
          payment_id: string | null
          proof_file_name: string | null
          proof_storage_path: string | null
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
          evidence_request_note?: string | null
          account_id?: string | null
          amount_minor: number
          created_at?: string
          currency?: string
          id?: string
          invoice_id: string
          method: string
          mismatch_note?: string | null
          organization_id: string
          paid_at?: string | null
          payer_name?: string | null
          payment_id?: string | null
          proof_file_name?: string | null
          proof_storage_path?: string | null
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
          evidence_request_note?: string | null
          account_id?: string | null
          amount_minor?: number
          created_at?: string
          currency?: string
          id?: string
          invoice_id?: string
          method?: string
          mismatch_note?: string | null
          organization_id?: string
          paid_at?: string | null
          payer_name?: string | null
          payment_id?: string | null
          proof_file_name?: string | null
          proof_storage_path?: string | null
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
      period_reports: {
        Row: {
          created_at: string
          generated_at: string
          generated_by: string | null
          id: string
          invoice_count: number
          organization_id: string
          period_end: string
          period_label: string
          period_start: string
          snapshot: Json
        }
        Insert: {
          created_at?: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          invoice_count?: number
          organization_id: string
          period_end: string
          period_label: string
          period_start: string
          snapshot?: Json
        }
        Update: {
          created_at?: string
          generated_at?: string
          generated_by?: string | null
          id?: string
          invoice_count?: number
          organization_id?: string
          period_end?: string
          period_label?: string
          period_start?: string
          snapshot?: Json
        }
        Relationships: []
      }
      tax_period_locks: {
        Row: {
          created_at: string
          id: string
          locked_at: string
          locked_by: string | null
          note: string | null
          organization_id: string
          period_end: string
          period_report_id: string | null
          period_start: string
          unlock_reason: string | null
          unlocked_at: string | null
          unlocked_by: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          locked_at?: string
          locked_by?: string | null
          note?: string | null
          organization_id: string
          period_end: string
          period_report_id?: string | null
          period_start: string
          unlock_reason?: string | null
          unlocked_at?: string | null
          unlocked_by?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          locked_at?: string
          locked_by?: string | null
          note?: string | null
          organization_id?: string
          period_end?: string
          period_report_id?: string | null
          period_start?: string
          unlock_reason?: string | null
          unlocked_at?: string | null
          unlocked_by?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_change_request_invoice: {
        Args: {
          p_billing_profile_id?: string
          p_change_request_id: string
          p_currency: string
          p_due_at?: string
          p_lines: Json
          p_notes?: string
          p_number: string
          p_subtotal_minor: number
          p_tax_minor: number
          p_total_minor: number
        }
        Returns: {
          invoice_id: string | null
          number: string | null
          outcome: string
        }[]
      }
      claim_invoice_delivery: {
        Args: { p_channel: string; p_invoice_id: string }
        Returns: {
          attempts: number
          delivery_id: string | null
          outcome: string
        }[]
      }
      settle_invoice_delivery: {
        Args: {
          p_conversation_id?: string
          p_delivery_id: string
          p_destination?: string
          p_error?: string
          p_message_ref?: string
          p_status: string
        }
        Returns: string
      }
      claim_invoice_reminder: {
        Args: { p_conversation_id?: string; p_interval_days: number; p_invoice_id: string }
        Returns: {
          external_ref: string | null
          outcome: string
          send_id: string | null
        }[]
      }
      confirm_bank_line_match: {
        Args: { p_line_id: string; p_payment_id: string; p_reason?: string }
        Returns: {
          item_id: string | null
          outcome: string
        }[]
      }
      ignore_bank_line: {
        Args: { p_line_id: string; p_reason: string }
        Returns: {
          outcome: string
        }[]
      }
      import_bank_statement_lines: {
        Args: { p_lines: Json; p_reconciliation_id: string; p_source_filename?: string }
        Returns: {
          batch_id: string | null
          imported: number
          outcome: string
        }[]
      }
      observe_invoice_reminder_candidates: {
        Args: { p_limit?: number }
        Returns: {
          client_account_id: string
          currency: string
          due_at: string
          interval_days: number
          invoice_id: string
          invoice_number: string
          organization_id: string
          paid_minor: number
          project_id: string | null
          total_minor: number
        }[]
      }
      record_invoice_reminder_outcome: {
        Args: { p_note: string; p_send_id: string }
        Returns: boolean
      }
      close_reconciliation: {
        Args: { p_reconciliation_id: string }
        Returns: {
          outcome: string
          reconciliation_id: string | null
          unresolved: number
        }[]
      }
      confirm_billing_mode: {
        Args: { p_mode: string; p_note?: string; p_project_id: string; p_source?: string }
        Returns: {
          outcome: string
          profile_id: string | null
          version: number | null
        }[]
      }
      record_billing_details: {
        Args: {
          p_billing_address?: string
          p_billing_state?: string
          p_gstin?: string
          p_legal_name?: string
          p_project_id: string
        }
        Returns: {
          outcome: string
          profile_id: string | null
          version: number | null
        }[]
      }
      project_payment_progress: {
        Args: { p_project_id: string }
        Returns: {
          measurable: boolean
          milestones: number
          plan_total_percent: number | null
          verified_milestones: number
          verified_percent: number | null
        }[]
      }
      blocking_invoice_number: {
        Args: { p_organization_id: string; p_project_id: string }
        Returns: string
      }
      ai_cost_buckets: {
        Args: Record<PropertyKey, never>
        Returns: {
          agent_key: string
          cost_minor: number
          input_tokens: number
          month: string
          output_tokens: number
          project_id: string | null
          runs: number
        }[]
      }
      create_composed_invoice: {
        Args: {
          p_billing_profile_id?: string
          p_currency: string
          p_due_at?: string
          p_lines: Json
          p_notes?: string
          p_number: string
          p_project_id: string
          p_subtotal_minor: number
          p_tax_minor: number
          p_total_minor: number
        }
        Returns: {
          invoice_id: string | null
          number: string | null
          outcome: string
        }[]
      }
      request_payment_evidence: {
        Args: { p_note: string; p_submission_id: string }
        Returns: { outcome: string; status: string | null }[]
      }
      log_report_export: {
        Args: { p_kind: string; p_period_label: string; p_row_count: number }
        Returns: { outcome: string }[]
      }
      set_expense_category: {
        Args: { p_action: string; p_key: string; p_label: string }
        Returns: { category_key: string | null; outcome: string }[]
      }
      client_names: {
        Args: { p_ids?: string[] }
        Returns: { id: string; name: string }[]
      }
      set_invoice_numbering: {
        Args: { p_prefix: string; p_terms_days: string; p_terms_note: string }
        Returns: { outcome: string }[]
      }
      create_milestone_invoice: {
        Args: {
          p_billing_profile_id?: string
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
      issue_free_maintenance_invoice: {
        Args: { p_number: string; p_plan_id: string }
        Returns: {
          invoice_id: string | null
          number: string | null
          outcome: string
        }[]
      }
      generate_period_report: {
        Args: { p_label?: string; p_period_end: string; p_period_start: string }
        Returns: { id: string | null; invoice_count: number; outcome: string }[]
      }
      lock_tax_period: {
        Args: { p_note?: string; p_period_end: string; p_period_start: string; p_report_id?: string }
        Returns: {
          lock_id: string | null
          outcome: string
        }[]
      }
      open_reconciliation: {
        Args: { p_account_id?: string; p_period_end: string; p_period_start: string; p_source: string }
        Returns: {
          outcome: string
          reconciliation_id: string | null
        }[]
      }
      record_invoice_send: {
        Args: {
          p_channel: string
          p_conversation_id?: string
          p_invoice_id: string
          p_kind: string
          p_message_ref?: string
          p_note?: string
          p_sent_at?: string
        }
        Returns: {
          outcome: string
          send_id: string | null
        }[]
      }
      unlock_tax_period: {
        Args: { p_lock_id: string; p_reason: string }
        Returns: {
          lock_id: string | null
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
      design_reply_proposals: {
        Row: {
          id: string
          organization_id: string
          project_id: string
          phase_three_id: string
          share_id: string
          message_id: string
          conversation_id: string | null
          source: string
          intent: string
          client_words: string
          selected_theme_option_id: string | null
          selected_color_option_id: string | null
          reference_url: string | null
          reference_note: string | null
          confidence: number
          reasoning: string | null
          clarifying_question: string | null
          action: string
          status: string
          decision_id: string | null
          revision_id: string | null
          resolved_by: string | null
          resolved_at: string | null
          resolution_note: string | null
          created_at: string
        }
        Insert: {
          id?: string
          organization_id: string
          project_id: string
          phase_three_id: string
          share_id: string
          message_id: string
          conversation_id?: string | null
          source: string
          intent: string
          client_words: string
          selected_theme_option_id?: string | null
          selected_color_option_id?: string | null
          reference_url?: string | null
          reference_note?: string | null
          confidence: number
          reasoning?: string | null
          clarifying_question?: string | null
          action: string
          status?: string
          decision_id?: string | null
          revision_id?: string | null
          resolved_by?: string | null
          resolved_at?: string | null
          resolution_note?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          organization_id?: string
          project_id?: string
          phase_three_id?: string
          share_id?: string
          message_id?: string
          conversation_id?: string | null
          source?: string
          intent?: string
          client_words?: string
          selected_theme_option_id?: string | null
          selected_color_option_id?: string | null
          reference_url?: string | null
          reference_note?: string | null
          confidence?: number
          reasoning?: string | null
          clarifying_question?: string | null
          action?: string
          status?: string
          decision_id?: string | null
          revision_id?: string | null
          resolved_by?: string | null
          resolved_at?: string | null
          resolution_note?: string | null
          created_at?: string
        }
        Relationships: []
      }
      admin_design_decisions: {
        Row: {
          created_at: string
          decided_by: string
          decision: string
          design_review_id: string | null
          id: string
          option_version: number
          organization_id: string
          reason: string | null
          theme_option_id: string
        }
        Insert: {
          created_at?: string
          decided_by?: string
          decision?: string
          design_review_id?: string | null
          id?: string
          option_version?: number
          organization_id?: string
          reason?: string | null
          theme_option_id?: string
        }
        Update: {
          created_at?: string
          decided_by?: string
          decision?: string
          design_review_id?: string | null
          id?: string
          option_version?: number
          organization_id?: string
          reason?: string | null
          theme_option_id?: string
        }
        Relationships: []
      }
      calendar_feed_tokens: {
        Row: {
          created_at: string
          fetch_count: number
          id: string
          last_fetched_at: string | null
          organization_id: string
          project_id: string
          revoked_at: string | null
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          fetch_count?: number
          id?: string
          last_fetched_at?: string | null
          organization_id: string
          project_id: string
          revoked_at?: string | null
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          fetch_count?: number
          id?: string
          last_fetched_at?: string | null
          organization_id?: string
          project_id?: string
          revoked_at?: string | null
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_feed_tokens_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
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
          invoice_id: string | null
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
          invoice_id?: string | null
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
          invoice_id?: string | null
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
      client_design_decisions: {
        Row: {
          client_words: string
          conversation_id: string | null
          created_at: string
          decision: string
          evidence_ref: string | null
          id: string
          organization_id: string
          phase_three_id: string
          project_id: string
          recorded_by: string
          reference_note: string | null
          reference_url: string | null
          selected_color_option_id: string | null
          selected_theme_option_id: string | null
          share_id: string
        }
        Insert: {
          client_words?: string
          conversation_id?: string | null
          created_at?: string
          decision?: string
          evidence_ref?: string | null
          id?: string
          organization_id?: string
          phase_three_id?: string
          project_id?: string
          recorded_by?: string
          reference_note?: string | null
          reference_url?: string | null
          selected_color_option_id?: string | null
          selected_theme_option_id?: string | null
          share_id?: string
        }
        Update: {
          client_words?: string
          conversation_id?: string | null
          created_at?: string
          decision?: string
          evidence_ref?: string | null
          id?: string
          organization_id?: string
          phase_three_id?: string
          project_id?: string
          recorded_by?: string
          reference_note?: string | null
          reference_url?: string | null
          selected_color_option_id?: string | null
          selected_theme_option_id?: string | null
          share_id?: string
        }
        Relationships: []
      }
      client_design_shares: {
        Row: {
          channel: string
          conversation_id: string | null
          created_at: string
          evidence_ref: string
          id: string
          option_count: number
          organization_id: string
          phase_three_id: string
          project_id: string
          share_number: number
          shared_at: string
          shared_by: string
          shared_options: Json
        }
        Insert: {
          channel?: string
          conversation_id?: string | null
          created_at?: string
          evidence_ref?: string
          id?: string
          option_count?: number
          organization_id?: string
          phase_three_id?: string
          project_id?: string
          share_number?: number
          shared_at?: string
          shared_by?: string
          shared_options?: Json
        }
        Update: {
          channel?: string
          conversation_id?: string | null
          created_at?: string
          evidence_ref?: string
          id?: string
          option_count?: number
          organization_id?: string
          phase_three_id?: string
          project_id?: string
          share_number?: number
          shared_at?: string
          shared_by?: string
          shared_options?: Json
        }
        Relationships: []
      }
      color_options: {
        Row: {
          source: string
          accent_hex: string | null
          background_hex: string | null
          brand_source: string | null
          client_status: string
          contrast_notes: string | null
          created_at: string
          error_hex: string | null
          id: string
          option_index: number
          organization_id: string
          palette_name: string
          preview_asset_url: string | null
          primary_hex: string
          secondary_hex: string | null
          success_hex: string | null
          surface_hex: string | null
          text_primary_hex: string | null
          text_secondary_hex: string | null
          theme_option_id: string
          updated_at: string
          warning_hex: string | null
        }
        Insert: {
          source?: string
          accent_hex?: string | null
          background_hex?: string | null
          brand_source?: string | null
          client_status?: string
          contrast_notes?: string | null
          created_at?: string
          error_hex?: string | null
          id?: string
          option_index?: number
          organization_id?: string
          palette_name?: string
          preview_asset_url?: string | null
          primary_hex?: string
          secondary_hex?: string | null
          success_hex?: string | null
          surface_hex?: string | null
          text_primary_hex?: string | null
          text_secondary_hex?: string | null
          theme_option_id?: string
          updated_at?: string
          warning_hex?: string | null
        }
        Update: {
          source?: string
          accent_hex?: string | null
          background_hex?: string | null
          brand_source?: string | null
          client_status?: string
          contrast_notes?: string | null
          created_at?: string
          error_hex?: string | null
          id?: string
          option_index?: number
          organization_id?: string
          palette_name?: string
          preview_asset_url?: string | null
          primary_hex?: string
          secondary_hex?: string | null
          success_hex?: string | null
          surface_hex?: string | null
          text_primary_hex?: string | null
          text_secondary_hex?: string | null
          theme_option_id?: string
          updated_at?: string
          warning_hex?: string | null
        }
        Relationships: []
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
      project_files: {
        Row: {
          category: string
          content_type: string | null
          created_at: string
          deleted_at: string | null
          deleted_by: string | null
          description: string | null
          folder: string
          id: string
          organization_id: string
          parent_file_id: string | null
          project_id: string
          size_bytes: number | null
          storage_path: string | null
          title: string
          updated_at: string
          uploaded_by: string | null
          url: string | null
          version: number
        }
        Insert: {
          category?: string
          content_type?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          folder?: string
          id?: string
          organization_id: string
          parent_file_id?: string | null
          project_id: string
          size_bytes?: number | null
          storage_path?: string | null
          title: string
          updated_at?: string
          uploaded_by?: string | null
          url?: string | null
          version?: number
        }
        Update: {
          category?: string
          content_type?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          description?: string | null
          folder?: string
          id?: string
          organization_id?: string
          parent_file_id?: string | null
          project_id?: string
          size_bytes?: number | null
          storage_path?: string | null
          title?: string
          updated_at?: string
          uploaded_by?: string | null
          url?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_files_parent_file_id_fkey"
            columns: ["parent_file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_files_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      attached_files: {
        Row: {
          content_type: string | null
          created_at: string
          file_name: string
          id: string
          organization_id: string
          project_id: string
          size_bytes: number
          storage_path: string
          subject_id: string
          subject_kind: string
          uploaded_by: string | null
        }
        Insert: {
          content_type?: string | null
          created_at?: string
          file_name: string
          id?: string
          organization_id: string
          project_id: string
          size_bytes: number
          storage_path: string
          subject_id: string
          subject_kind: string
          uploaded_by?: string | null
        }
        Update: {
          content_type?: string | null
          created_at?: string
          file_name?: string
          id?: string
          organization_id?: string
          project_id?: string
          size_bytes?: number
          storage_path?: string
          subject_id?: string
          subject_kind?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      project_file_shares: {
        Row: {
          access_count: number
          created_at: string
          created_by: string | null
          expires_at: string
          file_id: string
          id: string
          last_accessed_at: string | null
          organization_id: string
          project_id: string
          revoked_at: string | null
          token: string
          updated_at: string
        }
        Insert: {
          access_count?: number
          created_at?: string
          created_by?: string | null
          expires_at: string
          file_id: string
          id?: string
          last_accessed_at?: string | null
          organization_id: string
          project_id: string
          revoked_at?: string | null
          token: string
          updated_at?: string
        }
        Update: {
          access_count?: number
          created_at?: string
          created_by?: string | null
          expires_at?: string
          file_id?: string
          id?: string
          last_accessed_at?: string | null
          organization_id?: string
          project_id?: string
          revoked_at?: string | null
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_file_shares_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_file_shares_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_templates: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          organization_id: string
          source_project_id: string | null
          template_items: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          organization_id: string
          source_project_id?: string | null
          template_items?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          organization_id?: string
          source_project_id?: string | null
          template_items?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_templates_source_project_id_fkey"
            columns: ["source_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_links: {
        Row: {
          added_by: string | null
          created_at: string
          id: string
          kind: string
          label: string
          organization_id: string
          project_id: string
          updated_at: string
          url: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          id?: string
          kind?: string
          label: string
          organization_id: string
          project_id: string
          updated_at?: string
          url: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          id?: string
          kind?: string
          label?: string
          organization_id?: string
          project_id?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_links_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      sprints: {
        Row: {
          closed_at: string | null
          closed_by: string | null
          created_at: string
          created_by: string | null
          id: string
          length_days: number
          name: string
          organization_id: string
          project_id: string
          starts_on: string
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          length_days: number
          name: string
          organization_id: string
          project_id: string
          starts_on: string
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          length_days?: number
          name?: string
          organization_id?: string
          project_id?: string
          starts_on?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sprints_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      scope_item_plans: {
        Row: {
          assignee_id: string | null
          organization_id: string
          priority: string | null
          scope_item_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          assignee_id?: string | null
          organization_id: string
          priority?: string | null
          scope_item_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          assignee_id?: string | null
          organization_id?: string
          priority?: string | null
          scope_item_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scope_item_plans_scope_item_id_fkey"
            columns: ["scope_item_id"]
            isOneToOne: true
            referencedRelation: "scope_items"
            referencedColumns: ["id"]
          },
        ]
      }
      scope_item_files: {
        Row: {
          created_at: string
          file_id: string
          id: string
          linked_by: string | null
          organization_id: string
          scope_item_id: string
        }
        Insert: {
          created_at?: string
          file_id: string
          id?: string
          linked_by?: string | null
          organization_id: string
          scope_item_id: string
        }
        Update: {
          created_at?: string
          file_id?: string
          id?: string
          linked_by?: string | null
          organization_id?: string
          scope_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scope_item_files_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "project_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scope_item_files_scope_item_id_fkey"
            columns: ["scope_item_id"]
            isOneToOne: false
            referencedRelation: "scope_items"
            referencedColumns: ["id"]
          },
        ]
      }
      phase_completions: {
        Row: {
          basis: Json
          completed_at: string
          completed_by: string | null
          id: string
          organization_id: string
          phase: number
          project_id: string
        }
        Insert: {
          basis?: Json
          completed_at?: string
          completed_by?: string | null
          id?: string
          organization_id: string
          phase: number
          project_id: string
        }
        Update: {
          basis?: Json
          completed_at?: string
          completed_by?: string | null
          id?: string
          organization_id?: string
          phase?: number
          project_id?: string
        }
        Relationships: []
      }
      project_defaults: {
        Row: {
          default_watch_phases: string[]
          organization_id: string
          standard_folders: Json
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          default_watch_phases?: string[]
          organization_id: string
          standard_folders?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          default_watch_phases?: string[]
          organization_id?: string
          standard_folders?: Json
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      project_folders: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          path: string
          project_id: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          path: string
          project_id: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          path?: string
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_folders_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_notes: {
        Row: {
          body: string | null
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          project_id: string
          title: string
          updated_at: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          project_id: string
          title: string
          updated_at?: string
        }
        Update: {
          body?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_notes_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      client_secrets: {
        Row: {
          auth_tag: string | null
          ciphertext: string | null
          created_at: string
          hint: string | null
          id: string
          iv: string | null
          kind: string
          label: string
          organization_id: string
          project_id: string
          revoked_at: string | null
          revoked_by: string | null
          stored_by: string
        }
        Insert: {
          auth_tag?: string | null
          ciphertext?: string | null
          created_at?: string
          hint?: string | null
          id?: string
          iv?: string | null
          kind?: string
          label: string
          organization_id: string
          project_id: string
          revoked_at?: string | null
          revoked_by?: string | null
          stored_by: string
        }
        Update: {
          auth_tag?: string | null
          ciphertext?: string | null
          created_at?: string
          hint?: string | null
          id?: string
          iv?: string | null
          kind?: string
          label?: string
          organization_id?: string
          project_id?: string
          revoked_at?: string | null
          revoked_by?: string | null
          stored_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_secrets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      phase_three_stop_resolutions: {
        Row: {
          created_at: string
          extra_rounds: number | null
          id: string
          note: string
          organization_id: string
          phase_three_id: string
          project_id: string
          resolution: string
          resolved_by: string
          resumed_state: string
          stop_reason: string | null
          stopped_state: string
        }
        Insert: {
          created_at?: string
          extra_rounds?: number | null
          id?: string
          note: string
          organization_id: string
          phase_three_id: string
          project_id: string
          resolution: string
          resolved_by: string
          resumed_state: string
          stop_reason?: string | null
          stopped_state: string
        }
        Update: {
          created_at?: string
          extra_rounds?: number | null
          id?: string
          note?: string
          organization_id?: string
          phase_three_id?: string
          project_id?: string
          resolution?: string
          resolved_by?: string
          resumed_state?: string
          stop_reason?: string | null
          stopped_state?: string
        }
        Relationships: []
      }
      project_default_assignees: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          project_id: string
          project_role: string
          set_by: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          project_id: string
          project_role: string
          set_by?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          project_id?: string
          project_role?: string
          set_by?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_default_assignees_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_members: {
        Row: {
          added_by: string | null
          created_at: string
          id: string
          organization_id: string
          project_id: string
          project_role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          id?: string
          organization_id: string
          project_id: string
          project_role?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          id?: string
          organization_id?: string
          project_id?: string
          project_role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_updates: {
        Row: {
          body: string
          conversation_id: string | null
          created_at: string
          id: string
          message_id: string | null
          organization_id: string
          project_id: string
          sent_by: string | null
          sent_to: string
          updated_at: string
        }
        Insert: {
          body: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          message_id?: string | null
          organization_id: string
          project_id: string
          sent_by?: string | null
          sent_to: string
          updated_at?: string
        }
        Update: {
          body?: string
          conversation_id?: string | null
          created_at?: string
          id?: string
          message_id?: string | null
          organization_id?: string
          project_id?: string
          sent_by?: string | null
          sent_to?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_updates_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_watchers: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          phases: string[]
          project_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          phases?: string[]
          project_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          phases?: string[]
          project_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_watchers_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      release_payment_overrides: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          overridden_by: string | null
          project_id: string
          reason: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          overridden_by?: string | null
          project_id: string
          reason: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          overridden_by?: string | null
          project_id?: string
          reason?: string
          updated_at?: string
        }
        Relationships: []
      }
      repositories: {
        Row: {
          created_at: string
          default_branch: string | null
          id: string
          name: string
          notes: string | null
          organization_id: string
          platform: string
          project_id: string
          review_url: string | null
          updated_at: string
          url: string
        }
        Insert: {
          created_at?: string
          default_branch?: string | null
          id?: string
          name: string
          notes?: string | null
          organization_id: string
          platform?: string
          project_id: string
          review_url?: string | null
          updated_at?: string
          url: string
        }
        Update: {
          created_at?: string
          default_branch?: string | null
          id?: string
          name?: string
          notes?: string | null
          organization_id?: string
          platform?: string
          project_id?: string
          review_url?: string | null
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "repositories_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      repository_links: {
        Row: {
          access_level: string
          merge_min_approvals: number
          merge_role: string
          workflow_file: string | null
          created_at: string
          default_branch: string
          id: string
          linked_by: string | null
          organization_id: string
          owner: string
          project_id: string
          provider: string
          repo: string
          updated_at: string
        }
        Insert: {
          access_level?: string
          merge_min_approvals?: number
          merge_role?: string
          workflow_file?: string | null
          created_at?: string
          default_branch?: string
          id?: string
          linked_by?: string | null
          organization_id: string
          owner: string
          project_id: string
          provider?: string
          repo: string
          updated_at?: string
        }
        Update: {
          access_level?: string
          merge_min_approvals?: number
          merge_role?: string
          workflow_file?: string | null
          created_at?: string
          default_branch?: string
          id?: string
          linked_by?: string | null
          organization_id?: string
          owner?: string
          project_id?: string
          provider?: string
          repo?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "repository_links_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      design_asset_links: {
        Row: {
          asset_id: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          screen_id: string | null
          ui_version_id: string | null
          updated_at: string
        }
        Insert: {
          asset_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          screen_id?: string | null
          ui_version_id?: string | null
          updated_at?: string
        }
        Update: {
          asset_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          screen_id?: string | null
          ui_version_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "design_asset_links_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "design_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_asset_links_screen_id_fkey"
            columns: ["screen_id"]
            isOneToOne: false
            referencedRelation: "screens"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "design_asset_links_ui_version_id_fkey"
            columns: ["ui_version_id"]
            isOneToOne: false
            referencedRelation: "ui_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      design_assets: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          origin: string
          parent_asset_id: string | null
          size_bytes: number | null
          status: string
          storage_path: string | null
          title: string | null
          updated_at: string
          uploaded_by: string | null
          version: number
          created_at: string
          id: string
          image_base64: string | null
          kind: string
          media_type: string
          model: string | null
          organization_id: string
          phase_three_id: string
          project_id: string
          prompt: string | null
          rights_note: string | null
          run_id: string | null
          source_context_version: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          origin?: string
          parent_asset_id?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
          version?: number
          created_at?: string
          id?: string
          image_base64?: string | null
          kind?: string
          media_type: string
          model?: string | null
          organization_id: string
          phase_three_id: string
          project_id: string
          prompt?: string | null
          rights_note?: string | null
          run_id?: string | null
          source_context_version: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          origin?: string
          parent_asset_id?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          title?: string | null
          updated_at?: string
          uploaded_by?: string | null
          version?: number
          created_at?: string
          id?: string
          image_base64?: string | null
          kind?: string
          media_type?: string
          model?: string | null
          organization_id?: string
          phase_three_id?: string
          project_id?: string
          prompt?: string | null
          rights_note?: string | null
          run_id?: string | null
          source_context_version?: string
        }
        Relationships: []
      }
      design_reviews: {
        Row: {
          comments: string | null
          created_at: string
          id: string
          option_version: number
          organization_id: string
          result: string
          reviewer_user_id: string
          theme_option_id: string
        }
        Insert: {
          comments?: string | null
          created_at?: string
          id?: string
          option_version?: number
          organization_id?: string
          result?: string
          reviewer_user_id?: string
          theme_option_id?: string
        }
        Update: {
          comments?: string | null
          created_at?: string
          id?: string
          option_version?: number
          organization_id?: string
          result?: string
          reviewer_user_id?: string
          theme_option_id?: string
        }
        Relationships: []
      }
      design_revisions: {
        Row: {
          admin_decision_id: string | null
          client_decision_id: string | null
          created_at: string
          design_review_id: string | null
          from_theme_option_id: string
          id: string
          opened_by: string | null
          organization_id: string
          origin: string
          phase_three_id: string
          project_id: string
          requested_changes: string
          round_number: number | null
          status: string
          to_theme_option_id: string | null
          updated_at: string
        }
        Insert: {
          admin_decision_id?: string | null
          client_decision_id?: string | null
          created_at?: string
          design_review_id?: string | null
          from_theme_option_id?: string
          id?: string
          opened_by?: string | null
          organization_id?: string
          origin?: string
          phase_three_id?: string
          project_id?: string
          requested_changes?: string
          round_number?: number | null
          status?: string
          to_theme_option_id?: string | null
          updated_at?: string
        }
        Update: {
          admin_decision_id?: string | null
          client_decision_id?: string | null
          created_at?: string
          design_review_id?: string | null
          from_theme_option_id?: string
          id?: string
          opened_by?: string | null
          organization_id?: string
          origin?: string
          phase_three_id?: string
          project_id?: string
          requested_changes?: string
          round_number?: number | null
          status?: string
          to_theme_option_id?: string | null
          updated_at?: string
        }
        Relationships: []
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
      group_setups: {
        Row: {
          conversation_id: string | null
          created_at: string
          created_at_whatsapp: string | null
          confirmed_by: string | null
          id: string
          mapped_at: string | null
          mapped_by: string | null
          members: Json
          note: string | null
          organization_id: string
          project_id: string
          requested_at: string
          state: string
          suggested_name: string | null
          suggested_name_missing: string[]
          updated_at: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          conversation_id?: string | null
          created_at?: string
          created_at_whatsapp?: string | null
          confirmed_by?: string | null
          id?: string
          mapped_at?: string | null
          mapped_by?: string | null
          members?: Json
          note?: string | null
          organization_id: string
          project_id: string
          requested_at?: string
          state?: string
          suggested_name?: string | null
          suggested_name_missing?: string[]
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          conversation_id?: string | null
          created_at?: string
          created_at_whatsapp?: string | null
          confirmed_by?: string | null
          id?: string
          mapped_at?: string | null
          mapped_by?: string | null
          members?: Json
          note?: string | null
          organization_id?: string
          project_id?: string
          requested_at?: string
          state?: string
          suggested_name?: string | null
          suggested_name_missing?: string[]
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_setups_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      group_team_defaults: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          id: string
          organization_id: string
          phone: string
          position: number
          role: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          id?: string
          organization_id: string
          phone: string
          position?: number
          role?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          id?: string
          organization_id?: string
          phone?: string
          position?: number
          role?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      phase_three: {
        Row: {
          blocked_reason: string | null
          client_revision_count: number
          client_revision_limit: number
          completed_at: string | null
          created_at: string
          designer_agent_key: string
          id: string
          organization_id: string
          phase_two_id: string
          pm_agent_key: string
          project_id: string
          reviewer_user_id: string | null
          started_at: string
          state: string
          updated_at: string
        }
        Insert: {
          blocked_reason?: string | null
          client_revision_count?: number
          client_revision_limit?: number
          completed_at?: string | null
          created_at?: string
          designer_agent_key?: string
          id?: string
          organization_id?: string
          phase_two_id?: string
          pm_agent_key?: string
          project_id?: string
          reviewer_user_id?: string | null
          started_at?: string
          state?: string
          updated_at?: string
        }
        Update: {
          blocked_reason?: string | null
          client_revision_count?: number
          client_revision_limit?: number
          completed_at?: string | null
          created_at?: string
          designer_agent_key?: string
          id?: string
          organization_id?: string
          phase_two_id?: string
          pm_agent_key?: string
          project_id?: string
          reviewer_user_id?: string | null
          started_at?: string
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      phase_three_handoffs: {
        Row: {
          client_decision_id: string
          color_option_id: string
          created_at: string
          figma_file_key: string | null
          figma_node_id: string | null
          figma_version: string | null
          id: string
          locked_at: string
          locked_by: string | null
          organization_id: string
          payload: Json
          phase_four_ready: boolean
          phase_three_id: string
          project_id: string
          readiness_note: string | null
          screen_baseline_id: string
          theme_option_id: string
          updated_at: string
        }
        Insert: {
          client_decision_id?: string
          color_option_id?: string
          created_at?: string
          figma_file_key?: string | null
          figma_node_id?: string | null
          figma_version?: string | null
          id?: string
          locked_at?: string
          locked_by?: string | null
          organization_id?: string
          payload?: Json
          phase_four_ready?: boolean
          phase_three_id?: string
          project_id?: string
          readiness_note?: string | null
          screen_baseline_id?: string
          theme_option_id?: string
          updated_at?: string
        }
        Update: {
          client_decision_id?: string
          color_option_id?: string
          created_at?: string
          figma_file_key?: string | null
          figma_node_id?: string | null
          figma_version?: string | null
          id?: string
          locked_at?: string
          locked_by?: string | null
          organization_id?: string
          payload?: Json
          phase_four_ready?: boolean
          phase_three_id?: string
          project_id?: string
          readiness_note?: string | null
          screen_baseline_id?: string
          theme_option_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      phase_two: {
        Row: {
          blocked_reason: string | null
          completed_at: string | null
          context_loaded_at: string | null
          created_at: string
          handoff_id: string
          id: string
          kickoff_at: string | null
          organization_id: string
          pm_agent_key: string | null
          project_id: string
          started_at: string
          state: string
          updated_at: string
        }
        Insert: {
          blocked_reason?: string | null
          completed_at?: string | null
          context_loaded_at?: string | null
          created_at?: string
          handoff_id: string
          id?: string
          kickoff_at?: string | null
          organization_id: string
          pm_agent_key?: string | null
          project_id: string
          started_at?: string
          state?: string
          updated_at?: string
        }
        Update: {
          blocked_reason?: string | null
          completed_at?: string | null
          context_loaded_at?: string | null
          created_at?: string
          handoff_id?: string
          id?: string
          kickoff_at?: string | null
          organization_id?: string
          pm_agent_key?: string | null
          project_id?: string
          started_at?: string
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      project_plans: {
        Row: {
          approval_note: string | null
          approved_at: string | null
          approved_by: string | null
          activated_at: string | null
          activated_by: string | null
          change_reason: string | null
          created_at: string
          created_by: string | null
          id: string
          objective: string | null
          organization_id: string
          project_id: string
          scope_version_id: string | null
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          approval_note?: string | null
          approved_at?: string | null
          approved_by?: string | null
          activated_at?: string | null
          activated_by?: string | null
          change_reason?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          objective?: string | null
          organization_id: string
          project_id: string
          scope_version_id?: string | null
          status?: string
          updated_at?: string
          version: number
        }
        Update: {
          approval_note?: string | null
          approved_at?: string | null
          approved_by?: string | null
          activated_at?: string | null
          activated_by?: string | null
          change_reason?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          objective?: string | null
          organization_id?: string
          project_id?: string
          scope_version_id?: string | null
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      plan_deliverables: {
        Row: {
          ambiguity_note: string | null
          applicable_phase: string
          created_at: string
          evidence_required: string
          id: string
          name: string
          organization_id: string
          owner_role: string | null
          plan_id: string
          position: number
          proposal_item_id: string | null
          readiness_criteria: string
          scope_item_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          ambiguity_note?: string | null
          applicable_phase: string
          created_at?: string
          evidence_required: string
          id?: string
          name: string
          organization_id: string
          owner_role?: string | null
          plan_id: string
          position?: number
          proposal_item_id?: string | null
          readiness_criteria: string
          scope_item_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          ambiguity_note?: string | null
          applicable_phase?: string
          created_at?: string
          evidence_required?: string
          id?: string
          name?: string
          organization_id?: string
          owner_role?: string | null
          plan_id?: string
          position?: number
          proposal_item_id?: string | null
          readiness_criteria?: string
          scope_item_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      plan_dependencies: {
        Row: {
          created_at: string
          description: string
          id: string
          kind: string
          needed_by_phase: string
          needed_by_window_end: string | null
          needed_by_window_start: string | null
          organization_id: string
          owner_role: string
          plan_id: string
          status: string
          timing_basis: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          kind: string
          needed_by_phase: string
          needed_by_window_end?: string | null
          needed_by_window_start?: string | null
          organization_id: string
          owner_role: string
          plan_id: string
          status?: string
          timing_basis?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          kind?: string
          needed_by_phase?: string
          needed_by_window_end?: string | null
          needed_by_window_start?: string | null
          organization_id?: string
          owner_role?: string
          plan_id?: string
          status?: string
          timing_basis?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      plan_notes: {
        Row: {
          created_at: string
          created_by: string | null
          escalation_path: string | null
          id: string
          kind: string
          organization_id: string
          owner_role: string | null
          plan_id: string
          statement: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          escalation_path?: string | null
          id?: string
          kind: string
          organization_id?: string
          owner_role?: string | null
          plan_id: string
          statement: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          escalation_path?: string | null
          id?: string
          kind?: string
          organization_id?: string
          owner_role?: string | null
          plan_id?: string
          statement?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      plan_milestones: {
        Row: {
          created_at: string
          gate_criteria: string
          id: string
          kind: string
          name: string
          organization_id: string
          payment_milestone_id: string | null
          phase: string
          plan_id: string
          position: number
          status: string
          target_window_end: string | null
          target_window_start: string | null
          timing_basis: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          gate_criteria: string
          id?: string
          kind: string
          name: string
          organization_id: string
          payment_milestone_id?: string | null
          phase: string
          plan_id: string
          position?: number
          status?: string
          target_window_end?: string | null
          target_window_start?: string | null
          timing_basis?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          gate_criteria?: string
          id?: string
          kind?: string
          name?: string
          organization_id?: string
          payment_milestone_id?: string | null
          phase?: string
          plan_id?: string
          position?: number
          status?: string
          target_window_end?: string | null
          target_window_start?: string | null
          timing_basis?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      plan_milestone_dependencies: {
        Row: {
          created_at: string
          dependency_id: string
          id: string
          milestone_id: string
          organization_id: string
        }
        Insert: {
          created_at?: string
          dependency_id: string
          id?: string
          milestone_id: string
          organization_id: string
        }
        Update: {
          created_at?: string
          dependency_id?: string
          id?: string
          milestone_id?: string
          organization_id?: string
        }
        Relationships: []
      }
      plan_clarifications: {
        Row: {
          answer: string | null
          answered_at: string | null
          answered_by: string | null
          answered_via: string | null
          asked_at: string | null
          asked_by: string | null
          change_request_id: string | null
          created_at: string
          deliverable_id: string | null
          id: string
          impact: string
          organization_id: string
          plan_id: string
          question: string
          resolved_at: string | null
          scope_item_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          answer?: string | null
          answered_at?: string | null
          answered_by?: string | null
          answered_via?: string | null
          asked_at?: string | null
          asked_by?: string | null
          change_request_id?: string | null
          created_at?: string
          deliverable_id?: string | null
          id?: string
          impact: string
          organization_id: string
          plan_id: string
          question: string
          resolved_at?: string | null
          scope_item_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          answer?: string | null
          answered_at?: string | null
          answered_by?: string | null
          answered_via?: string | null
          asked_at?: string | null
          asked_by?: string | null
          change_request_id?: string | null
          created_at?: string
          deliverable_id?: string | null
          id?: string
          impact?: string
          organization_id?: string
          plan_id?: string
          question?: string
          resolved_at?: string | null
          scope_item_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
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
      release_records: {
        Row: {
          created_at: string
          deployment_dependencies: Json
          id: string
          organization_id: string
          project_id: string
          rollback_plan: string | null
          smoke_checklist: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          deployment_dependencies?: Json
          id?: string
          organization_id: string
          project_id: string
          rollback_plan?: string | null
          smoke_checklist?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          deployment_dependencies?: Json
          id?: string
          organization_id?: string
          project_id?: string
          rollback_plan?: string | null
          smoke_checklist?: Json
          updated_at?: string
        }
        Relationships: []
      }
      release_verifications: {
        Row: {
          created_at: string
          deliverable_id: string | null
          environment: string
          evidence_url: string | null
          id: string
          notes: string | null
          organization_id: string
          outcome: string
          project_id: string
          verified_at: string
          verified_by: string | null
        }
        Insert: {
          created_at?: string
          deliverable_id?: string | null
          environment: string
          evidence_url?: string | null
          id?: string
          notes?: string | null
          organization_id: string
          outcome: string
          project_id: string
          verified_at?: string
          verified_by?: string | null
        }
        Update: {
          created_at?: string
          deliverable_id?: string | null
          environment?: string
          evidence_url?: string | null
          id?: string
          notes?: string | null
          organization_id?: string
          outcome?: string
          project_id?: string
          verified_at?: string
          verified_by?: string | null
        }
        Relationships: []
      }
      handovers: {
        Row: {
          deployment_dependencies: Json
          accepted_at: string | null
          approval_request_id: string | null
          created_at: string
          delivered_at: string | null
          delivered_by: string | null
          id: string
          organization_id: string
          project_id: string
          rollback_plan: string | null
          smoke_checklist: Json
          status: string
          summary: string | null
          updated_at: string
        }
        Insert: {
          deployment_dependencies?: Json
          accepted_at?: string | null
          approval_request_id?: string | null
          created_at?: string
          delivered_at?: string | null
          delivered_by?: string | null
          id?: string
          organization_id: string
          project_id: string
          rollback_plan?: string | null
          smoke_checklist?: Json
          status?: string
          summary?: string | null
          updated_at?: string
        }
        Update: {
          deployment_dependencies?: Json
          accepted_at?: string | null
          approval_request_id?: string | null
          created_at?: string
          delivered_at?: string | null
          delivered_by?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          rollback_plan?: string | null
          smoke_checklist?: Json
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
          entitlement: string | null
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
          entitlement?: string | null
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
          entitlement?: string | null
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
          archived_at: string | null
          archived_by: string | null
          budget_minor: number | null
          client_account_id: string
          code: string | null
          completed_at: string | null
          completion_override_reason: string | null
          created_at: string
          project_type: string | null
          technology: string[]
          tags: string[]
          currency: string
          default_assignee_id: string | null
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
          release_held_at: string | null
          release_held_by: string | null
          release_hold_reason: string | null
          start_override_reason: string | null
          started_at: string | null
          starts_on: string | null
          status: string
          status_changed_at: string | null
          status_reason: string | null
          template_id: string | null
          updated_at: string
          visibility: string
        }
        Insert: {
          archived_at?: string | null
          archived_by?: string | null
          budget_minor?: number | null
          client_account_id: string
          code?: string | null
          completed_at?: string | null
          completion_override_reason?: string | null
          created_at?: string
          project_type?: string | null
          technology?: string[]
          tags?: string[]
          currency?: string
          default_assignee_id?: string | null
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
          release_held_at?: string | null
          release_held_by?: string | null
          release_hold_reason?: string | null
          start_override_reason?: string | null
          started_at?: string | null
          starts_on?: string | null
          status?: string
          status_changed_at?: string | null
          status_reason?: string | null
          template_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Update: {
          archived_at?: string | null
          archived_by?: string | null
          budget_minor?: number | null
          client_account_id?: string
          code?: string | null
          completed_at?: string | null
          completion_override_reason?: string | null
          created_at?: string
          project_type?: string | null
          technology?: string[]
          tags?: string[]
          currency?: string
          default_assignee_id?: string | null
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
          release_held_at?: string | null
          release_held_by?: string | null
          release_hold_reason?: string | null
          start_override_reason?: string | null
          started_at?: string | null
          starts_on?: string | null
          status?: string
          status_changed_at?: string | null
          status_reason?: string | null
          template_id?: string | null
          updated_at?: string
          visibility?: string
        }
        Relationships: []
      }
      requirement_clarifications: {
        Row: {
          answer: string | null
          answered_at: string | null
          answered_by: string | null
          id: string
          impact: string
          organization_id: string
          project_id: string
          question: string
          raised_at: string
          raised_by: string | null
          scope_item_id: string
          status: string
        }
        Insert: {
          answer?: string | null
          answered_at?: string | null
          answered_by?: string | null
          id?: string
          impact: string
          organization_id: string
          project_id: string
          question: string
          raised_at?: string
          raised_by?: string | null
          scope_item_id: string
          status?: string
        }
        Update: {
          answer?: string | null
          answered_at?: string | null
          answered_by?: string | null
          id?: string
          impact?: string
          organization_id?: string
          project_id?: string
          question?: string
          raised_at?: string
          raised_by?: string | null
          scope_item_id?: string
          status?: string
        }
        Relationships: []
      }
      design_review_comments: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          organization_id: string
          project_id: string
          subject_id: string
          subject_type: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          organization_id: string
          project_id: string
          subject_id: string
          subject_type: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          organization_id?: string
          project_id?: string
          subject_id?: string
          subject_type?: string
        }
        Relationships: []
      }
      brand_rules: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          project_id: string
          rule: string
          title: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          project_id: string
          rule: string
          title: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          rule?: string
          title?: string
        }
        Relationships: []
      }
      environment_check_runs: {
        Row: {
          applied_at: string | null
          checks: string[]
          conclusion: string | null
          dispatch_key: string
          dispatched_at: string
          dispatched_by: string | null
          environment_id: string
          id: string
          organization_id: string
          project_id: string
          ref: string
          repository: string
          result_read_at: string | null
          run_id: number | null
          run_url: string | null
          status: string
          workflow_file: string
        }
        Insert: {
          applied_at?: string | null
          checks: string[]
          conclusion?: string | null
          dispatch_key: string
          dispatched_at?: string
          dispatched_by?: string | null
          environment_id: string
          id?: string
          organization_id: string
          project_id: string
          ref: string
          repository: string
          result_read_at?: string | null
          run_id?: number | null
          run_url?: string | null
          status?: string
          workflow_file: string
        }
        Update: {
          applied_at?: string | null
          checks?: string[]
          conclusion?: string | null
          dispatch_key?: string
          dispatched_at?: string
          dispatched_by?: string | null
          environment_id?: string
          id?: string
          organization_id?: string
          project_id?: string
          ref?: string
          repository?: string
          result_read_at?: string | null
          run_id?: number | null
          run_url?: string | null
          status?: string
          workflow_file?: string
        }
        Relationships: []
      }
      deliverable_details: {
        Row: {
          qa_decided_at: string | null
          qa_decided_by: string | null
          qa_evidence_url: string | null
          qa_note: string | null
          qa_status: string
          admin_decided_at: string | null
          admin_decided_by: string | null
          admin_note: string | null
          admin_status: string
          build_number: string | null
          commit_ref: string | null
          deliverable_id: string
          organization_id: string
          platform: string | null
          project_id: string
          rollback_note: string | null
          rollback_target_id: string | null
          updated_at: string
        }
        Insert: {
          qa_decided_at?: string | null
          qa_decided_by?: string | null
          qa_evidence_url?: string | null
          qa_note?: string | null
          qa_status?: string
          admin_decided_at?: string | null
          admin_decided_by?: string | null
          admin_note?: string | null
          admin_status?: string
          build_number?: string | null
          commit_ref?: string | null
          deliverable_id: string
          organization_id: string
          platform?: string | null
          project_id: string
          rollback_note?: string | null
          rollback_target_id?: string | null
          updated_at?: string
        }
        Update: {
          qa_decided_at?: string | null
          qa_decided_by?: string | null
          qa_evidence_url?: string | null
          qa_note?: string | null
          qa_status?: string
          admin_decided_at?: string | null
          admin_decided_by?: string | null
          admin_note?: string | null
          admin_status?: string
          build_number?: string | null
          commit_ref?: string | null
          deliverable_id?: string
          organization_id?: string
          platform?: string | null
          project_id?: string
          rollback_note?: string | null
          rollback_target_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      scope_item_comments: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          organization_id: string
          scope_item_id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          organization_id: string
          scope_item_id: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          organization_id?: string
          scope_item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scope_item_comments_scope_item_id_fkey"
            columns: ["scope_item_id"]
            isOneToOne: false
            referencedRelation: "scope_items"
            referencedColumns: ["id"]
          },
        ]
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
          approval_evidence_url: string | null
          approval_note: string | null
          approved_at: string | null
          approved_by: string | null
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
          approval_evidence_url?: string | null
          approval_note?: string | null
          approved_at?: string | null
          approved_by?: string | null
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
          approval_evidence_url?: string | null
          approval_note?: string | null
          approved_at?: string | null
          approved_by?: string | null
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
      screen_baselines: {
        Row: {
          blocked_reason: string | null
          change_reason: string | null
          created_at: string
          created_by: string | null
          finalized_at: string | null
          id: string
          organization_id: string
          project_id: string
          scope_version_id: string
          screen_count: number
          screens: Json
          status: string
          updated_at: string
          version: number
        }
        Insert: {
          blocked_reason?: string | null
          change_reason?: string | null
          created_at?: string
          created_by?: string | null
          finalized_at?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          scope_version_id?: string
          screen_count?: number
          screens?: Json
          status?: string
          updated_at?: string
          version?: number
        }
        Update: {
          blocked_reason?: string | null
          change_reason?: string | null
          created_at?: string
          created_by?: string | null
          finalized_at?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          scope_version_id?: string
          screen_count?: number
          screens?: Json
          status?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
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
          category: string | null
          qa_confirmed_at: string | null
          qa_confirmed_by: string | null
          components: string[]
          device_targets: string[]
          responsive_coverage: Json
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
          baseline_version: number | null
          dependencies: string | null
          design_state: string
          figma_url: string | null
          qa_status: string
          required_data: string | null
          required_sections: string | null
          responsive_behaviour: string | null
          screen_key: string
          status: string
          superseded_by: string | null
          updated_at: string
          user_role: string
          validation: string | null
        }
        Insert: {
          category?: string | null
          qa_confirmed_at?: string | null
          qa_confirmed_by?: string | null
          components?: string[]
          device_targets?: string[]
          responsive_coverage?: Json
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
          baseline_version?: number | null
          dependencies?: string | null
          design_state?: string
          figma_url?: string | null
          qa_status?: string
          required_data?: string | null
          required_sections?: string | null
          responsive_behaviour?: string | null
          screen_key: string
          status?: string
          superseded_by?: string | null
          updated_at?: string
          user_role: string
          validation?: string | null
        }
        Update: {
          category?: string | null
          qa_confirmed_at?: string | null
          qa_confirmed_by?: string | null
          components?: string[]
          device_targets?: string[]
          responsive_coverage?: Json
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
          baseline_version?: number | null
          dependencies?: string | null
          design_state?: string
          figma_url?: string | null
          qa_status?: string
          required_data?: string | null
          required_sections?: string | null
          responsive_behaviour?: string | null
          screen_key?: string
          status?: string
          superseded_by?: string | null
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
          {
            foreignKeyName: "screens_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "screens"
            referencedColumns: ["id"]
          },
        ]
      }
      task_attachments: {
        Row: {
          added_by: string | null
          created_at: string
          id: string
          kind: string
          organization_id: string
          task_id: string
          title: string
          updated_at: string
          url: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          id?: string
          kind?: string
          organization_id: string
          task_id: string
          title: string
          updated_at?: string
          url: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          id?: string
          kind?: string
          organization_id?: string
          task_id?: string
          title?: string
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_attachments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_checklist_items: {
        Row: {
          created_at: string
          done_at: string | null
          done_by: string | null
          id: string
          label: string
          organization_id: string
          position: number
          task_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          done_at?: string | null
          done_by?: string | null
          id?: string
          label: string
          organization_id: string
          position?: number
          task_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          done_at?: string | null
          done_by?: string | null
          id?: string
          label?: string
          organization_id?: string
          position?: number
          task_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_checklist_items_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_comments: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: string
          organization_id: string
          task_id: string
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: string
          organization_id: string
          task_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: string
          organization_id?: string
          task_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_comments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          cancel_reason: string | null
          archived_at: string | null
          blocker_type: string | null
          blocker_owner: string | null
          blocker_next_action: string | null
          origin: string
          verified_at: string | null
          verified_by: string | null
          verification_note: string | null
          start_on: string | null
          parent_task_id: string | null
          sprint_id: string | null
          labels: string[]
          ready_for_qa_at: string | null
          reopened_count: number
          started_at: string | null
          assignee_id: string | null
          blocked_at: string | null
          blocked_reason: string | null
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
          cancel_reason?: string | null
          archived_at?: string | null
          blocker_type?: string | null
          blocker_owner?: string | null
          blocker_next_action?: string | null
          origin?: string
          verified_at?: string | null
          verified_by?: string | null
          verification_note?: string | null
          start_on?: string | null
          parent_task_id?: string | null
          sprint_id?: string | null
          labels?: string[]
          ready_for_qa_at?: string | null
          reopened_count?: number
          started_at?: string | null
          assignee_id?: string | null
          blocked_at?: string | null
          blocked_reason?: string | null
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
          cancel_reason?: string | null
          archived_at?: string | null
          blocker_type?: string | null
          blocker_owner?: string | null
          blocker_next_action?: string | null
          origin?: string
          verified_at?: string | null
          verified_by?: string | null
          verification_note?: string | null
          start_on?: string | null
          parent_task_id?: string | null
          sprint_id?: string | null
          labels?: string[]
          ready_for_qa_at?: string | null
          reopened_count?: number
          started_at?: string | null
          assignee_id?: string | null
          blocked_at?: string | null
          blocked_reason?: string | null
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
            foreignKeyName: "tasks_sprint_id_fkey"
            columns: ["sprint_id"]
            isOneToOne: false
            referencedRelation: "sprints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_parent_task_id_fkey"
            columns: ["parent_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
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
      commit_links: {
        Row: {
          created_at: string
          id: string
          linked_by: string | null
          message: string | null
          organization_id: string
          project_id: string
          sha: string
          task_id: string
          updated_at: string
          url: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          linked_by?: string | null
          message?: string | null
          organization_id: string
          project_id: string
          sha: string
          task_id: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          linked_by?: string | null
          message?: string | null
          organization_id?: string
          project_id?: string
          sha?: string
          task_id?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "commit_links_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "commit_links_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      development_events: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          created_at: string
          detail: Json
          id: string
          kind: string
          organization_id: string
          project_id: string
          raised_by: string | null
          reason: string | null
          status: string
          task_id: string | null
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          detail?: Json
          id?: string
          kind: string
          organization_id: string
          project_id: string
          raised_by?: string | null
          reason?: string | null
          status?: string
          task_id?: string | null
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          created_at?: string
          detail?: Json
          id?: string
          kind?: string
          organization_id?: string
          project_id?: string
          raised_by?: string | null
          reason?: string | null
          status?: string
          task_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "development_events_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "development_events_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      git_actions: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          detail: Json
          id: string
          organization_id: string
          project_id: string
          reference: string
          repository: string
          task_id: string | null
          updated_at: string
          url: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          organization_id: string
          project_id: string
          reference: string
          repository: string
          task_id?: string | null
          updated_at?: string
          url?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          organization_id?: string
          project_id?: string
          reference?: string
          repository?: string
          task_id?: string | null
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "git_actions_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "git_actions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_layers: {
        Row: {
          created_at: string
          execution_order: number | null
          id: string
          layers: Json
          organization_id: string
          plan_deliverable_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          execution_order?: number | null
          id?: string
          layers?: Json
          organization_id: string
          plan_deliverable_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          execution_order?: number | null
          id?: string
          layers?: Json
          organization_id?: string
          plan_deliverable_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "plan_layers_plan_deliverable_id_fkey"
            columns: ["plan_deliverable_id"]
            isOneToOne: true
            referencedRelation: "plan_deliverables"
            referencedColumns: ["id"]
          },
        ]
      }
      task_dependencies: {
        Row: {
          created_at: string
          created_by: string | null
          depends_on_task_id: string
          id: string
          organization_id: string
          task_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          depends_on_task_id: string
          id?: string
          organization_id: string
          task_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          depends_on_task_id?: string
          id?: string
          organization_id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_dependencies_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_dependencies_depends_on_task_id_fkey"
            columns: ["depends_on_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_evidence: {
        Row: {
          created_at: string
          id: string
          kind: string
          note: string | null
          organization_id: string
          submitted_by: string | null
          task_id: string
          title: string
          updated_at: string
          url: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
          organization_id: string
          submitted_by?: string | null
          task_id: string
          title: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
          organization_id?: string
          submitted_by?: string | null
          task_id?: string
          title?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_evidence_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      time_logs: {
        Row: {
          created_at: string
          hours: number
          id: string
          logged_on: string
          note: string | null
          organization_id: string
          person_id: string
          project_id: string
          task_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          hours: number
          id?: string
          logged_on: string
          note?: string | null
          organization_id: string
          person_id: string
          project_id: string
          task_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          hours?: number
          id?: string
          logged_on?: string
          note?: string | null
          organization_id?: string
          person_id?: string
          project_id?: string
          task_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "time_logs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_logs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      design_activity: {
        Row: {
          action: string | null
          actor_id: string | null
          actor_type: string | null
          after: Json | null
          created_at: string | null
          id: number | null
          organization_id: string | null
          project_id: string | null
          subject_id: string | null
          subject_type: string | null
        }
        Relationships: []
      }
      time_log_costs: {
        Row: {
          cost_minor: number | null
          created_at: string | null
          hourly_cost_minor: number | null
          hours: number | null
          id: string | null
          logged_on: string | null
          note: string | null
          organization_id: string | null
          person_id: string | null
          project_id: string | null
          rate_currency: string | null
          rate_effective_from: string | null
          rate_missing: boolean | null
          task_id: string | null
        }
        Relationships: []
      }
      time_log_totals_by_person: {
        Row: {
          cost_minor: number | null
          entries: number | null
          hours: number | null
          last_logged_on: string | null
          organization_id: string | null
          person_id: string | null
          project_id: string | null
          uncosted_hours: number | null
        }
        Relationships: []
      }
      time_log_totals_by_project: {
        Row: {
          cost_minor: number | null
          entries: number | null
          hours: number | null
          last_logged_on: string | null
          organization_id: string | null
          people: number | null
          project_id: string | null
          uncosted_hours: number | null
        }
        Relationships: []
      }
      time_log_totals_by_task: {
        Row: {
          cost_minor: number | null
          entries: number | null
          hours: number | null
          last_logged_on: string | null
          organization_id: string | null
          project_id: string | null
          task_id: string | null
          uncosted_hours: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      agent_propose_design_reply: {
        Args: { p_action: string; p_clarifying_question: string; p_color_option_id: string; p_confidence: number; p_intent: string; p_message_id: string; p_reasoning: string; p_reference_note: string; p_reference_url: string; p_share_id: string; p_source: string; p_theme_option_id: string }
        Returns: {
          outcome: string | null
          proposal_id: string | null
          action: string | null
          status: string | null
        }[]
      }
      agent_apply_design_reply: {
        Args: { p_proposal_id: string }
        Returns: {
          outcome: string | null
          decision_id: string | null
          revision_id: string | null
        }[]
      }
      agent_mark_design_reply_asked: {
        Args: { p_proposal_id: string }
        Returns: {
          outcome: string | null
        }[]
      }
      accept_design_reply_proposal: {
        Args: { p_color_option_id?: string; p_proposal_id: string; p_theme_option_id?: string }
        Returns: {
          outcome: string | null
          decision_id: string | null
          revision_id: string | null
        }[]
      }
      dismiss_design_reply_proposal: {
        Args: { p_note: string; p_proposal_id: string }
        Returns: {
          outcome: string | null
        }[]
      }
      attach_file: {
        Args: {
          p_content_type?: string
          p_file_name: string
          p_size_bytes?: number
          p_storage_path: string
          p_subject_id: string
          p_subject_kind: string
        }
        Returns: { id: string | null; outcome: string; project_id: string | null }[]
      }
      raise_requirement_clarification: {
        Args: { p_impact: string; p_question: string; p_scope_item_id: string }
        Returns: { clarification_id: string | null; outcome: string }[]
      }
      answer_requirement_clarification: {
        Args: { p_answer: string; p_clarification_id: string }
        Returns: { outcome: string }[]
      }
      comment_on_design_review: {
        Args: { p_body: string; p_subject_id: string; p_subject_type: string }
        Returns: { comment_id: string | null; outcome: string }[]
      }
      set_screen_category: {
        Args: { p_category: string; p_screen_id: string }
        Returns: { outcome: string }[]
      }
      confirm_screen_qa: {
        Args: { p_screen_id: string }
        Returns: { outcome: string }[]
      }
      approve_screen: {
        Args: { p_screen_id: string }
        Returns: { detail: string | null; outcome: string }[]
      }
      add_brand_rule: {
        Args: { p_project_id: string; p_rule: string; p_title: string }
        Returns: { outcome: string; rule_id: string | null }[]
      }
      remove_brand_rule: {
        Args: { p_rule_id: string }
        Returns: { outcome: string }[]
      }
      set_deliverable_details: {
        Args: { p_build_number: string; p_commit_ref: string; p_deliverable_id: string; p_platform: string; p_rollback_note?: string; p_rollback_target_id?: string }
        Returns: { outcome: string }[]
      }
      decide_prototype_admin: {
        Args: { p_decision: string; p_deliverable_id: string; p_note?: string }
        Returns: { outcome: string }[]
      }
      prototype_send_gate: {
        Args: { p_deliverable_id: string }
        Returns: { admin_approved: boolean; qa_passed: boolean; qa_source: string }[]
      }
      send_prototype_for_client_review: {
        Args: { p_deliverable_id: string; p_override_reason?: string; p_summary?: string }
        Returns: { outcome: string; request_id: string | null; status: string | null }[]
      }
      approve_project_plan: {
        Args: { p_note?: string; p_plan_id: string }
        Returns: { outcome: string }[]
      }
      set_repository_policy: {
        Args: { p_access_level: string; p_merge_min_approvals: number; p_merge_role: string; p_project_id: string }
        Returns: { outcome: string }[]
      }
      record_prototype_qa_check: {
        Args: { p_evidence_url?: string; p_deliverable_id: string; p_note?: string; p_outcome: string }
        Returns: { outcome: string }[]
      }
      comment_on_scope_item: {
        Args: { p_body: string; p_scope_item_id: string }
        Returns: {
          comment_id: string
          outcome: string
        }[]
      }
      acknowledge_escalation: {
        Args: { p_event_id: string }
        Returns: { outcome: string }[]
      }
      escalate_blocker: {
        Args: { p_reason: string; p_task_id: string }
        Returns: { event_id: string; outcome: string }[]
      }
      request_client_dependency: {
        Args: { p_dependency_id: string; p_note?: string }
        Returns: { event_id: string; outcome: string }[]
      }
      link_commit: {
        Args: { p_message?: string; p_sha: string; p_task_id: string; p_url?: string }
        Returns: { link_id: string; outcome: string }[]
      }
      mark_design_asset_approved: {
        Args: { p_asset_id: string }
        Returns: { outcome: string }[]
      }
      mark_task_ready_for_qa: {
        Args: { p_task_id: string }
        Returns: { evidence_count: number; outcome: string }[]
      }
      plan_layers_valid: {
        Args: { p_layers: Json }
        Returns: boolean
      }
      promote_build: {
        Args: { p_deliverable_id: string; p_environment_id: string }
        Returns: { detail: string; outcome: string }[]
      }
      read_design_activity: {
        Args: { p_limit?: number; p_project_id: string }
        Returns: {
          action: string
          actor_id: string
          actor_name: string
          actor_type: string
          after: Json
          created_at: string
          id: number
          project_id: string
          subject_id: string
          subject_type: string
        }[]
      }
      record_color_variant: {
        Args: {
          p_accent_hex?: string
          p_contrast_notes?: string
          p_option_index: number
          p_palette_name: string
          p_primary_hex: string
          p_secondary_hex?: string
          p_theme_option_id: string
        }
        Returns: { color_option_id: string; outcome: string }[]
      }
      record_check_dispatch: {
        Args: { p_checks: string[]; p_dispatch_key: string; p_environment_id: string; p_ref: string; p_repository: string; p_workflow_file: string }
        Returns: { outcome: string; run_row_id: string | null }[]
      }
      record_check_run_result: {
        Args: { p_conclusion?: string; p_run_id?: number; p_run_row_id: string; p_run_url?: string; p_status: string }
        Returns: { outcome: string }[]
      }
      record_environment_check: {
        Args: { p_check: string; p_environment_id: string; p_evidence_url?: string; p_note?: string; p_ok: boolean }
        Returns: { outcome: string; readiness: Json }[]
      }
      record_git_action: {
        Args: {
          p_action: string
          p_detail?: Json
          p_project_id: string
          p_reference: string
          p_repository: string
          p_task_id?: string
          p_url?: string
        }
        Returns: { id: string; outcome: string }[]
      }
      record_theme_direction: {
        Args: { p_direction_summary: string; p_name: string; p_option_index: number; p_project_id: string }
        Returns: { outcome: string; theme_option_id: string }[]
      }
      record_uploaded_design_asset: {
        Args: {
          p_kind: string
          p_media_type: string
          p_parent_asset_id?: string
          p_licence?: string
          p_project_id: string
          p_size_bytes: number
          p_storage_path: string
          p_title: string
        }
        Returns: { asset_id: string; outcome: string; version: number }[]
      }
      reopen_task_from_defect: {
        Args: { p_defect_id: string; p_task_id: string }
        Returns: { outcome: string }[]
      }
      set_plan_layers: {
        Args: { p_execution_order?: number; p_layers: Json; p_plan_deliverable_id: string }
        Returns: { id: string; outcome: string }[]
      }
      set_prototype_platform: {
        Args: { p_artifact_id: string; p_platform: string }
        Returns: { outcome: string }[]
      }
      set_repository_workflow: {
        Args: { p_project_id: string; p_workflow_file: string }
        Returns: { outcome: string }[]
      }
      set_screen_states: {
        Args: {
          p_components?: string[]
          p_device_targets?: string[]
          p_has_empty_state: boolean
          p_has_error_state: boolean
          p_has_loading_state: boolean
          p_has_success_state: boolean
          p_responsive_coverage?: Json
          p_screen_id: string
          p_user_role?: string
        }
        Returns: { outcome: string }[]
      }
      start_qa_handoff: {
        Args: { p_project_id: string }
        Returns: { blocked: number; event_id: string; not_ready: number; outcome: string }[]
      }
      create_sprint: {
        Args: { p_length_days: number; p_name: string; p_project_id: string; p_starts_on: string }
        Returns: { outcome: string; sprint_id: string }[]
      }
      close_sprint: {
        Args: { p_sprint_id: string }
        Returns: { outcome: string }[]
      }
      place_task_in_sprint: {
        Args: { p_sprint_id: string; p_task_id: string }
        Returns: { outcome: string }[]
      }
      set_project_classification: {
        Args: { p_project_id: string; p_tags: string[]; p_technology: string[]; p_type: string }
        Returns: { outcome: string }[]
      }
      set_requirement_plan: {
        Args: { p_assignee_id: string; p_priority: string; p_scope_item_id: string }
        Returns: { outcome: string }[]
      }
      link_requirement_file: {
        Args: { p_file_id: string; p_scope_item_id: string }
        Returns: { outcome: string }[]
      }
      unlink_requirement_file: {
        Args: { p_file_id: string; p_scope_item_id: string }
        Returns: { outcome: string }[]
      }
      attach_meeting_to_project: {
        Args: { p_meeting_id: string; p_project_id: string }
        Returns: { outcome: string }[]
      }
      mark_task_agent_generated: {
        Args: { p_agent: boolean; p_task_id: string }
        Returns: { outcome: string }[]
      }
      verify_agent_task: {
        Args: { p_note: string; p_task_id: string }
        Returns: { outcome: string }[]
      }
      clone_project_template: {
        Args: { p_name: string; p_template_id: string }
        Returns: { outcome: string; template_id: string }[]
      }
      set_project_defaults: {
        Args: { p_folders: Json; p_watch_phases: string[] }
        Returns: { outcome: string }[]
      }
      complete_phase: {
        Args: { p_project_id: string; p_phase: number }
        Returns: { outcome: string; missing: string[] }[]
      }
      phase_readiness: {
        Args: { p_project_id: string; p_phase: number }
        Returns: { outcome: string; missing: string[]; facts: Json }[]
      }
      schedule_changes: {
        Args: { p_limit?: number; p_mine?: boolean; p_project_id?: string; p_since?: string }
        Returns: { actor_name: string | null; audit_id: number; changed_at: string; kind: string; label: string | null; now_on: string | null; project_id: string; project_name: string; subject_id: string; was_on: string | null }[]
      }
      project_activity: {
        Args: { p_limit?: number; p_project_id: string }
        Returns: { action: string; actor_name: string | null; actor_type: string; created_at: string; detail: string | null; id: number; subject_id: string | null; subject_type: string }[]
      }
      create_project_folder: {
        Args: { p_category: string; p_path: string; p_project_id: string }
        Returns: { folder_id: string; outcome: string }[]
      }
      file_into_folder: {
        Args: { p_file_id: string; p_path: string }
        Returns: { outcome: string }[]
      }
      add_project_note: {
        Args: { p_body?: string; p_project_id: string; p_title: string }
        Returns: { note_id: string; outcome: string }[]
      }
      remove_project_note: {
        Args: { p_note_id: string }
        Returns: { outcome: string }[]
      }
      set_task_schedule: {
        Args: { p_due_on: string; p_start_on: string; p_task_id: string }
        Returns: { outcome: string }[]
      }
      add_subtask: {
        Args: { p_assignee_id?: string; p_due_on?: string; p_parent_id: string; p_title: string }
        Returns: { outcome: string; task_id: string }[]
      }
      set_task_labels: {
        Args: { p_labels: string[]; p_task_id: string }
        Returns: { labels: string[]; outcome: string }[]
      }
      set_project_default_assignee: {
        Args: { p_project_id: string; p_project_role: string; p_user_id: string }
        Returns: { outcome: string }[]
      }
      task_cancellations: {
        Args: { p_limit?: number; p_since?: string }
        Returns: { actor_name: string | null; audit_id: number; changed_at: string; project_id: string; project_name: string; reason: string; task_id: string; task_title: string }[]
      }
      set_task_archived: {
        Args: { p_archived: boolean; p_task_id: string }
        Returns: { outcome: string }[]
      }
      add_project_member: {
        Args: { p_project_id: string; p_project_role: string; p_user_id: string }
        Returns: { member_id: string | null; outcome: string }[]
      }
      change_project_member_role: {
        Args: { p_member_id: string; p_project_role: string }
        Returns: { member_id: string | null; outcome: string }[]
      }
      remove_project_member: {
        Args: { p_member_id: string }
        Returns: { member_id: string | null; outcome: string }[]
      }
      set_project_fallback_assignee: {
        Args: { p_project_id: string; p_user_id: string }
        Returns: { outcome: string }[]
      }
      task_start_check: {
        Args: { p_task_id: string }
        Returns: { open_dependencies: number; reason: string | null; requirement_ok: boolean; startable: boolean }[]
      }
      project_role_refusal: {
        Args: { p_assignee: string; p_project_id: string }
        Returns: string
      }
      start_task: {
        Args: { p_task_id: string }
        Returns: { detail: string | null; outcome: string }[]
      }
      add_task_dependency: {
        Args: { p_depends_on_task_id: string; p_task_id: string }
        Returns: { outcome: string }[]
      }
      remove_task_dependency: {
        Args: { p_depends_on_task_id: string; p_task_id: string }
        Returns: { outcome: string }[]
      }
      is_roster_manager: {
        Args: never
        Returns: boolean
      }
      submit_prototype_to_qa: {
        Args: { p_artifact_id: string }
        Returns: { outcome: string }[]
      }
      submit_task_evidence: {
        Args: { p_kind: string; p_note?: string; p_task_id: string; p_title: string; p_url?: string }
        Returns: { evidence_id: string; outcome: string }[]
      }
      add_unpriced_milestone: {
        Args: {
          p_due_on?: string
          p_name: string
          p_project_id: string
        }
        Returns: {
          milestone_id: string | null
          outcome: string
        }[]
      }
      archive_project: {
        Args: {
          p_project_id: string
          p_reason?: string
        }
        Returns: {
          archived_at: string | null
          outcome: string
        }[]
      }
      record_scope_approval_evidence: {
        Args: {
          p_approved_by: string
          p_evidence_url?: string
          p_note?: string
          p_scope_version_id: string
        }
        Returns: {
          outcome: string
        }[]
      }
      resolve_calendar_feed: {
        Args: {
          p_token: string
        }
        Returns: {
          organization_id: string
          project_id: string
          project_name: string
        }[]
      }
      set_project_template: {
        Args: {
          p_project_id: string
          p_template_id?: string | null
        }
        Returns: {
          outcome: string
        }[]
      }
      final_payment_state: {
        Args: { p_project_id: string }
        Returns: {
          invoice_id: string | null
          invoice_number: string | null
          milestone_id: string | null
          milestone_name: string | null
          state: string
        }[]
      }
      override_release_payment: {
        Args: { p_project_id: string; p_reason: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      set_release_rollback_plan: {
        Args: { p_project_id: string; p_rollback_plan: string }
        Returns: {
          outcome: string
        }[]
      }
      set_release_smoke_item: {
        Args: { p_done: boolean; p_label: string; p_project_id: string; p_remove?: boolean }
        Returns: {
          outcome: string
        }[]
      }
      set_release_dependency: {
        Args: { p_label: string; p_project_id: string; p_remove?: boolean; p_status?: string }
        Returns: {
          outcome: string
        }[]
      }
      record_release_verification: {
        Args: { p_deliverable_id?: string; p_environment: string; p_evidence_url?: string; p_notes?: string; p_outcome: string; p_project_id: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      set_deployment_dependency: {
        Args: { p_handover_id: string; p_label: string; p_remove?: boolean; p_status?: string }
        Returns: {
          outcome: string
        }[]
      }
      account_health_signals: {
      link_repository: {
        Args: {
          p_default_branch?: string
          p_owner: string
          p_project_id: string
          p_repo: string
        }
        Returns: {
          id: string
          outcome: string
        }[]
      }
      unlink_repository: {
        Args: { p_project_id: string }
        Returns: {
          outcome: string
        }[]
      }
        Args: { p_client_account_id: string }
        Returns: {
          signal: string
          value: string
        }[]
      }
      add_scope_item: {
        Args: {
          p_acceptance_criteria?: string
          p_detail?: string
          p_feature_id?: string
          p_inclusion?: string
          p_scope_version_id: string
          p_title: string
        }
        Returns: {
          id: string
          outcome: string
        }[]
      }
      remove_scope_item: {
        Args: { p_scope_item_id: string }
        Returns: {
          outcome: string
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
      hold_release: {
        Args: { p_project_id: string; p_reason: string }
        Returns: {
          outcome: string
        }[]
      }
      install_default_onboarding_baseline: {
        Args: { p_organization_id: string }
        Returns: number
      }
      lift_release_hold: {
        Args: { p_project_id: string; p_reason: string }
        Returns: {
          outcome: string
        }[]
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
      resolve_file_share: {
        Args: { p_token: string }
        Returns: {
          content_type: string | null
          file_id: string
          storage_path: string
          title: string
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
      add_screen: {
        Args: {
          p_actions?: string
          p_dependencies?: string
          p_entry_point?: string
          p_exit_action?: string
          p_has_empty_state?: boolean
          p_has_error_state?: boolean
          p_has_loading_state?: boolean
          p_has_success_state?: boolean
          p_name: string
          p_project_id: string
          p_purpose?: string
          p_required_data?: string
          p_required_sections?: string
          p_scope_item_ids?: string[]
          p_screen_key: string
          p_user_role: string
        }
        Returns: {
          detail: string
          outcome: string
          screen_id: string
        }[]
      }
      merge_screens: {
        Args: {
          p_name: string
          p_purpose?: string
          p_screen_key: string
          p_source_ids: string[]
          p_user_role?: string
        }
        Returns: {
          detail: string
          outcome: string
          screen_id: string
        }[]
      }
      screen_list_closed_by: {
        Args: { p_project_id: string }
        Returns: string
      }
      set_screen_design_state: {
        Args: {
          p_design_state: string
          p_screen_id: string
        }
        Returns: {
          detail: string
          outcome: string
        }[]
      }
      split_screen: {
        Args: {
          p_parts: Json
          p_source_id: string
        }
        Returns: {
          detail: string
          outcome: string
          screen_ids: string[]
        }[]
      }
      submit_screen_for_qa: {
        Args: { p_screen_id: string }
        Returns: {
          detail: string
          outcome: string
          scope_item_ids: string[]
        }[]
      }
      set_dependency_status: {
        Args: { p_dependency_id: string; p_note?: string; p_status: string }
        Returns: {
          outcome: string
        }[]
      }
      set_handover_rollback_plan: {
        Args: {
          p_handover_id: string
          p_rollback_plan: string
        }
        Returns: {
          outcome: string
        }[]
      }
      set_handover_smoke_item: {
        Args: {
          p_done: boolean
          p_handover_id: string
          p_label: string
          p_remove?: boolean
        }
        Returns: {
          outcome: string
        }[]
      }
      confirm_group_created: {
        Args: { p_note?: string; p_setup_id: string }
        Returns: {
          outcome: string
        }[]
      }
      map_group: {
        Args: { p_conversation_id: string; p_setup_id: string }
        Returns: {
          outcome: string
        }[]
      }
      request_group_setup: {
        Args: { p_project_id: string }
        Returns: {
          outcome: string
          setup_id: string | null
        }[]
      }
      revise_group_setup: {
        Args: { p_members?: Json; p_setup_id: string; p_suggested_name?: string }
        Returns: {
          outcome: string
        }[]
      }
      theme_options: {
        Row: {
          source: string
          admin_status: string
          client_status: string
          created_at: string
          created_by: string | null
          direction_metadata: Json
          direction_summary: string
          figma_file_key: string | null
          figma_linked_at: string | null
          figma_linked_by: string | null
          figma_node_id: string | null
          figma_node_name: string | null
          figma_verified_at: string | null
          figma_page_id: string | null
          figma_version: string | null
          id: string
          internal_review_status: string
          name: string
          option_index: number
          organization_id: string
          origin: string
          phase_three_id: string
          preview_asset_url: string | null
          project_id: string
          revision_of: string | null
          source_context_version: string
          updated_at: string
          version: number
        }
        Insert: {
          source?: string
          admin_status?: string
          client_status?: string
          created_at?: string
          created_by?: string | null
          direction_metadata?: Json
          direction_summary?: string
          figma_file_key?: string | null
          figma_linked_at?: string | null
          figma_linked_by?: string | null
          figma_node_id?: string | null
          figma_node_name?: string | null
          figma_verified_at?: string | null
          figma_page_id?: string | null
          figma_version?: string | null
          id?: string
          internal_review_status?: string
          name?: string
          option_index?: number
          organization_id?: string
          origin?: string
          phase_three_id?: string
          preview_asset_url?: string | null
          project_id?: string
          revision_of?: string | null
          source_context_version?: string
          updated_at?: string
          version?: number
        }
        Update: {
          source?: string
          admin_status?: string
          client_status?: string
          created_at?: string
          created_by?: string | null
          direction_metadata?: Json
          direction_summary?: string
          figma_file_key?: string | null
          figma_linked_at?: string | null
          figma_linked_by?: string | null
          figma_node_id?: string | null
          figma_node_name?: string | null
          figma_verified_at?: string | null
          figma_page_id?: string | null
          figma_version?: string | null
          id?: string
          internal_review_status?: string
          name?: string
          option_index?: number
          organization_id?: string
          origin?: string
          phase_three_id?: string
          preview_asset_url?: string | null
          project_id?: string
          revision_of?: string | null
          source_context_version?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      verify_group: {
        Args: { p_setup_id: string }
        Returns: {
          outcome: string
        }[]
      }
      activate_project_plan: {
        Args: { p_plan_id: string }
        Returns: {
          outcome: string
          version: number | null
        }[]
      }
      add_plan_deliverable: {
        Args: {
          p_ambiguity_note?: string
          p_applicable_phase: string
          p_evidence_required: string
          p_name: string
          p_owner_role?: string
          p_plan_id: string
          p_position?: number
          p_proposal_item_id?: string
          p_readiness_criteria: string
          p_scope_item_id?: string
        }
        Returns: {
          deliverable_id: string | null
          outcome: string
        }[]
      }
      add_plan_dependency: {
        Args: {
          p_description: string
          p_kind: string
          p_needed_by_phase: string
          p_owner_role: string
          p_plan_id: string
          p_timing_basis?: string
          p_window_end?: string
          p_window_start?: string
        }
        Returns: {
          dependency_id: string | null
          outcome: string
        }[]
      }
      add_plan_note: {
        Args: {
          p_escalation_path?: string
          p_kind: string
          p_owner_role?: string
          p_plan_id: string
          p_statement: string
        }
        Returns: {
          note_id: string | null
          outcome: string
        }[]
      }
      refresh_phase_two_states: {
        Args: { p_limit?: number }
        Returns: number
      }
      agent_mark_clarification_asked: {
        Args: { p_clarification_id: string; p_message_id: string }
        Returns: string
      }
      agent_record_clarification_answer: {
        Args: { p_clarification_id: string; p_message_id: string }
        Returns: string
      }
      request_project_planning: {
        Args: { p_project_id: string }
        Returns: string
      }
      resolve_phase_three_stop: {
        Args: { p_extra_rounds?: number; p_note: string; p_phase_three_id: string; p_resolution: string }
        Returns: {
          outcome: string
          resumed_state: string | null
        }[]
      }
      store_client_secret: {
        Args: { p_auth_tag: string; p_ciphertext: string; p_hint?: string; p_iv: string; p_kind: string; p_label: string; p_project_id: string }
        Returns: {
          outcome: string
          secret_id: string | null
        }[]
      }
      client_secret_list: {
        Args: { p_project_id: string }
        Returns: {
          created_at: string
          hint: string | null
          id: string
          kind: string
          label: string
          revoked_at: string | null
          revoked_by_name: string | null
          stored_by_name: string | null
        }[]
      }
      reveal_client_secret: {
        Args: { p_secret_id: string }
        Returns: {
          auth_tag: string | null
          ciphertext: string | null
          iv: string | null
          label: string | null
          outcome: string
        }[]
      }
      revoke_client_secret: {
        Args: { p_secret_id: string }
        Returns: {
          outcome: string
        }[]
      }
      agent_draft_blueprint: {
        Args: { p_blueprint: Json; p_project_id: string }
        Returns: {
          outcome: string
          plan_id: string | null
        }[]
      }
      draft_project_plan: {
        Args: { p_change_reason?: string; p_objective?: string; p_project_id: string }
        Returns: {
          outcome: string
          plan_id: string | null
          version: number | null
        }[]
      }
      mark_clarification_asked: {
        Args: { p_clarification_id: string }
        Returns: {
          outcome: string
        }[]
      }
      raise_clarification: {
        Args: {
          p_deliverable_id?: string
          p_impact: string
          p_plan_id: string
          p_question: string
          p_scope_item_id?: string
        }
        Returns: {
          clarification_id: string | null
          outcome: string
        }[]
      }
      record_clarification_answer: {
        Args: { p_answer: string; p_answered_via?: string; p_clarification_id: string }
        Returns: {
          outcome: string
        }[]
      }
      resolve_clarification: {
        Args: { p_clarification_id: string }
        Returns: {
          outcome: string
        }[]
      }
      route_clarification_to_change_request: {
        Args: { p_change_request_id: string; p_clarification_id: string }
        Returns: {
          outcome: string
        }[]
      }
      outstanding_client_requests: {
        Args: { p_project_id: string }
        Returns: {
          ask_next: boolean
          item_id: string
          key: string
          label: string
          list_position: number
          status: string
          with_client: boolean
          with_us: boolean
        }[]
      }
      pre_kickoff_readiness: {
        Args: { p_project_id: string }
        Returns: {
          group_ready: boolean
          onboarding_settled: boolean
          payment_verified: boolean
          plan_ready: boolean
          ready: boolean
          unmet: string[]
        }[]
      }
      record_kickoff: {
        Args: { p_evidence_ref: string; p_project_id: string }
        Returns: {
          outcome: string
          unmet: string[]
        }[]
      }
      add_plan_milestone: {
        Args: {
          p_gate_criteria: string
          p_kind: string
          p_name: string
          p_payment_milestone_id?: string
          p_phase: string
          p_plan_id: string
          p_position?: number
          p_timing_basis?: string
          p_window_end?: string
          p_window_start?: string
        }
        Returns: {
          milestone_id: string | null
          outcome: string
        }[]
      }
      gate_plan_milestone: {
        Args: { p_dependency_id: string; p_milestone_id: string }
        Returns: {
          outcome: string
        }[]
      }
      add_team_default: {
        Args: { p_display_name: string; p_phone: string; p_position?: number; p_role?: string }
        Returns: {
          member_id: string | null
          outcome: string
        }[]
      }
      remove_team_default: {
        Args: { p_member_id: string }
        Returns: {
          outcome: string
        }[]
      }
      set_team_default_active: {
        Args: { p_active: boolean; p_member_id: string }
        Returns: {
          outcome: string
        }[]
      }
      start_phase_three: {
        Args: { p_project_id: string }
        Returns: {
          outcome: string
          phase_three_id: string | null
        }[]
      }
      start_phase_two: {
        Args: { p_project_id: string }
        Returns: {
          outcome: string
          phase_two_id: string | null
          handoff_id: string | null
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
      unfreeze_scope_version: {
        Args: { p_reason: string; p_version_id: string }
        Returns: {
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
          run_id: string | null
          actual: string | null
          assignee_id: string | null
          build_id: string | null
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
          task_id: string | null
          title: string
          updated_at: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          run_id?: string | null
          actual?: string | null
          assignee_id?: string | null
          build_id?: string | null
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
          task_id?: string | null
          title: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          run_id?: string | null
          actual?: string | null
          assignee_id?: string | null
          build_id?: string | null
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
          task_id?: string | null
          title?: string
          updated_at?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: []
      }
      test_run_evidence: {
        Row: {
          added_at: string
          added_by: string | null
          created_at: string
          id: string
          kind: string
          label: string | null
          organization_id: string
          run_id: string
          updated_at: string
          value: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          created_at?: string
          id?: string
          kind: string
          label?: string | null
          organization_id: string
          run_id: string
          updated_at?: string
          value: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          created_at?: string
          id?: string
          kind?: string
          label?: string | null
          organization_id?: string
          run_id?: string
          updated_at?: string
          value?: string
        }
        Relationships: []
      }
      test_coverage_waivers: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          plan_id: string
          reason: string
          scope_item_id: string
          waived_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          plan_id: string
          reason: string
          scope_item_id: string
          waived_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          plan_id?: string
          reason?: string
          scope_item_id?: string
          waived_by?: string | null
        }
        Relationships: []
      }
      device_configurations: {
        Row: {
          browser: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          organization_id: string
          os: string | null
          platform: string
          reason: string | null
          status: string
          updated_at: string
        }
        Insert: {
          browser?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          organization_id: string
          os?: string | null
          platform: string
          reason?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          browser?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          organization_id?: string
          os?: string | null
          platform?: string
          reason?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      defect_evidence: {
        Row: {
          added_at: string
          added_by: string | null
          created_at: string
          defect_id: string
          id: string
          kind: string
          organization_id: string
          updated_at: string
          value: string
        }
        Insert: {
          added_at?: string
          added_by?: string | null
          created_at?: string
          defect_id: string
          id?: string
          kind: string
          organization_id: string
          updated_at?: string
          value: string
        }
        Update: {
          added_at?: string
          added_by?: string | null
          created_at?: string
          defect_id?: string
          id?: string
          kind?: string
          organization_id?: string
          updated_at?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "defect_evidence_defect_id_fkey"
            columns: ["defect_id"]
            isOneToOne: false
            referencedRelation: "defects"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_results: {
        Row: {
          created_at: string
          id: string
          metric: string
          organization_id: string
          recorded_by: string | null
          run_id: string
          unit: string
          updated_at: string
          value: number
        }
        Insert: {
          created_at?: string
          id?: string
          metric: string
          organization_id: string
          recorded_by?: string | null
          run_id: string
          unit: string
          updated_at?: string
          value: number
        }
        Update: {
          created_at?: string
          id?: string
          metric?: string
          organization_id?: string
          recorded_by?: string | null
          run_id?: string
          unit?: string
          updated_at?: string
          value?: number
        }
        Relationships: []
      }
      performance_budgets: {
        Row: {
          created_at: string
          id: string
          lower_is_better: boolean
          metric: string
          organization_id: string
          project_id: string
          set_by: string | null
          target: number
          unit: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          lower_is_better?: boolean
          metric: string
          organization_id: string
          project_id: string
          set_by?: string | null
          target: number
          unit: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          lower_is_better?: boolean
          metric?: string
          organization_id?: string
          project_id?: string
          set_by?: string | null
          target?: number
          unit?: string
          updated_at?: string
        }
        Relationships: []
      }
      retest_assignments: {
        Row: {
          assigned_by: string | null
          created_at: string
          defect_id: string
          id: string
          note: string | null
          organization_id: string
          retester_id: string
          updated_at: string
        }
        Insert: {
          assigned_by?: string | null
          created_at?: string
          defect_id: string
          id?: string
          note?: string | null
          organization_id: string
          retester_id: string
          updated_at?: string
        }
        Update: {
          assigned_by?: string | null
          created_at?: string
          defect_id?: string
          id?: string
          note?: string | null
          organization_id?: string
          retester_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      stability_incidents: {
        Row: {
          created_at: string
          id: string
          opened_at: string
          opened_by: string | null
          organization_id: string
          project_id: string
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          summary: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          opened_at?: string
          opened_by?: string | null
          organization_id: string
          project_id: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity: string
          summary: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          opened_at?: string
          opened_by?: string | null
          organization_id?: string
          project_id?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          summary?: string
          updated_at?: string
        }
        Relationships: []
      }
      suite_schedules: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          cron: string
          deliverable_id: string
          id: string
          last_run_at: string | null
          last_run_id: string | null
          next_run_at: string | null
          organization_id: string
          project_id: string
          suite: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          cron: string
          deliverable_id: string
          id?: string
          last_run_at?: string | null
          last_run_id?: string | null
          next_run_at?: string | null
          organization_id: string
          project_id: string
          suite: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          cron?: string
          deliverable_id?: string
          id?: string
          last_run_at?: string | null
          last_run_id?: string | null
          next_run_at?: string | null
          organization_id?: string
          project_id?: string
          suite?: string
          updated_at?: string
        }
        Relationships: []
      }
      test_case_results: {
        Row: {
          created_at: string
          evidence_url: string | null
          executed_at: string
          executed_by: string | null
          id: string
          notes: string | null
          organization_id: string
          status: string
          test_plan_item_id: string
          test_run_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          evidence_url?: string | null
          executed_at?: string
          executed_by?: string | null
          id?: string
          notes?: string | null
          organization_id: string
          status: string
          test_plan_item_id: string
          test_run_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          evidence_url?: string | null
          executed_at?: string
          executed_by?: string | null
          id?: string
          notes?: string | null
          organization_id?: string
          status?: string
          test_plan_item_id?: string
          test_run_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "test_case_results_test_plan_item_id_fkey"
            columns: ["test_plan_item_id"]
            isOneToOne: false
            referencedRelation: "test_plan_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "test_case_results_test_run_id_fkey"
            columns: ["test_run_id"]
            isOneToOne: false
            referencedRelation: "test_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      test_plan_items: {
        Row: {
          category: string
          created_at: string
          critical_path: boolean
          expected_result: string | null
          id: string
          organization_id: string
          plan_id: string
          preconditions: string | null
          reason: string
          scope_item_id: string
          steps: string | null
          task_id: string | null
        }
        Insert: {
          category: string
          created_at?: string
          critical_path?: boolean
          expected_result?: string | null
          id?: string
          organization_id: string
          plan_id: string
          preconditions?: string | null
          reason: string
          scope_item_id: string
          steps?: string | null
          task_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          critical_path?: boolean
          expected_result?: string | null
          id?: string
          organization_id?: string
          plan_id?: string
          preconditions?: string | null
          reason?: string
          scope_item_id?: string
          steps?: string | null
          task_id?: string | null
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
          approved_at: string | null
          approved_by: string | null
          created_at: string
          drafted_by: string | null
          drafted_by_agent: string | null
          id: string
          organization_id: string
          project_id: string
          scope_version_id: string
          status: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          drafted_by?: string | null
          drafted_by_agent?: string | null
          id?: string
          organization_id: string
          project_id: string
          scope_version_id: string
          status?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          drafted_by?: string | null
          drafted_by_agent?: string | null
          id?: string
          organization_id?: string
          project_id?: string
          scope_version_id?: string
          status?: string
        }
        Relationships: []
      }
      test_runs: {
        Row: {
          environment: string | null
          tester_id: string | null
          blocked: number
          ended_at: string | null
          rerun_of: string | null
          started_at: string | null
          status: string
          browser: string | null
          created_at: string
          deliverable_id: string
          device: string | null
          evidence_url: string | null
          executed_at: string
          executed_by: string | null
          executed_by_agent: string | null
          failed: number
          id: string
          organization_id: string
          os: string | null
          passed: number
          perf_notes: string | null
          project_id: string
          skipped: number
          suite: string
          total: number
        }
        Insert: {
          environment?: string | null
          tester_id?: string | null
          blocked?: number
          ended_at?: string | null
          rerun_of?: string | null
          started_at?: string | null
          status?: string
          browser?: string | null
          created_at?: string
          deliverable_id: string
          device?: string | null
          evidence_url?: string | null
          executed_at?: string
          executed_by?: string | null
          executed_by_agent?: string | null
          failed: number
          id?: string
          organization_id: string
          os?: string | null
          passed: number
          perf_notes?: string | null
          project_id: string
          skipped?: number
          suite: string
          total: number
        }
        Update: {
          environment?: string | null
          tester_id?: string | null
          blocked?: number
          ended_at?: string | null
          rerun_of?: string | null
          started_at?: string | null
          status?: string
          browser?: string | null
          created_at?: string
          deliverable_id?: string
          device?: string | null
          evidence_url?: string | null
          executed_at?: string
          executed_by?: string | null
          executed_by_agent?: string | null
          failed?: number
          id?: string
          organization_id?: string
          os?: string | null
          passed?: number
          perf_notes?: string | null
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
      assign_retest: {
        Args: { p_defect_id: string; p_note?: string; p_retester_id: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      close_test_run: {
        Args: { p_blocked?: number; p_evidence_url?: string; p_failed: number; p_passed: number; p_perf_notes?: string; p_run_id: string; p_skipped?: number }
        Returns: {
          outcome: string
        }[]
      }
      fire_suite_schedule: {
        Args: { p_next_run_at: string; p_schedule_id: string }
        Returns: {
          outcome: string
          run_id: string | null
        }[]
      }
      open_test_run: {
        Args: { p_browser?: string; p_deliverable_id: string; p_device?: string; p_environment?: string; p_os?: string; p_rerun_of?: string; p_suite: string; p_tester_id?: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      rerun_test_run: {
        Args: { p_run_id: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      resolve_stability_incident: {
        Args: { p_incident_id: string; p_resolution: string }
        Returns: {
          outcome: string
        }[]
      }
      blocking_defects: {
        Args: { p_deliverable_id: string }
        Returns: {
          id: string
          severity: string
          title: string
        }[]
      }
      draft_test_plan: {
        Args: { p_scope_version_id: string }
        Returns: {
          id: string
          outcome: string
        }[]
      }
      add_test_plan_item: {
        Args: {
          p_category: string
          p_critical_path?: boolean
          p_expected_result?: string
          p_plan_id: string
          p_preconditions?: string
          p_reason: string
          p_scope_item_id: string
          p_steps?: string
        }
        Returns: {
          id: string
          outcome: string
        }[]
      }
      add_run_evidence: {
        Args: { p_kind: string; p_label?: string; p_run_id: string; p_value: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      update_test_plan_item: {
        Args: { p_critical_path: boolean; p_expected_result?: string; p_item_id: string; p_preconditions?: string; p_reason: string; p_steps?: string }
        Returns: {
          outcome: string
        }[]
      }
      waive_test_coverage: {
        Args: { p_plan_id: string; p_reason: string; p_scope_item_id: string }
        Returns: {
          outcome: string
        }[]
      }
      restore_test_coverage: {
        Args: { p_plan_id: string; p_scope_item_id: string }
        Returns: {
          outcome: string
        }[]
      }
      add_device_configuration: {
        Args: { p_browser?: string; p_name: string; p_os?: string; p_platform: string; p_reason?: string; p_status?: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      set_device_support: {
        Args: { p_device_id: string; p_reason?: string; p_status: string }
        Returns: {
          outcome: string
        }[]
      }
      add_defect_evidence: {
        Args: { p_defect_id: string; p_kind: string; p_value: string }
        Returns: {
          id: string | null
          outcome: string
        }[]
      }
      import_test_cases: {
        Args: { p_cases: Json; p_plan_id: string }
        Returns: {
          detail: string | null
          imported: number
          outcome: string
          row_number: number | null
        }[]
      }
      link_defect_build: {
        Args: { p_build_id?: string | null; p_defect_id: string }
        Returns: {
          outcome: string
        }[]
      }
      link_test_case_task: {
        Args: { p_task_id?: string | null; p_test_case_id: string }
        Returns: {
          outcome: string
        }[]
      }
      approve_test_plan: {
        Args: { p_plan_id: string }
        Returns: {
          outcome: string
        }[]
      }
      record_test_case_results: {
        Args: {
          p_results: Json
          p_test_run_id: string
        }
        Returns: {
          outcome: string
          recorded: number
        }[]
      }
      remove_test_plan_item: {
        Args: { p_item_id: string }
        Returns: {
          outcome: string
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
      record_test_run: {
        Args: {
          p_browser?: string
          p_deliverable_id: string
          p_device?: string
          p_environment?: string
          p_evidence_url?: string
          p_failed: number
          p_os?: string
          p_passed: number
          p_perf_notes?: string
          p_skipped?: number
          p_suite: string
          p_tester_id?: string
          p_total: number
        }
        Returns: {
          id: string
          outcome: string
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
      contracts: {
        Row: {
          client_account_id: string | null
          created_at: string
          created_by: string | null
          file_url: string | null
          id: string
          opportunity_id: string
          organization_id: string
          signed_on: string | null
          signer_name: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          client_account_id?: string | null
          created_at?: string
          created_by?: string | null
          file_url?: string | null
          id?: string
          opportunity_id: string
          organization_id: string
          signed_on?: string | null
          signer_name?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          client_account_id?: string | null
          created_at?: string
          created_by?: string | null
          file_url?: string | null
          id?: string
          opportunity_id?: string
          organization_id?: string
          signed_on?: string | null
          signer_name?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      approved_offers: {
        Row: {
          active: boolean
          condition: string
          created_at: string
          created_by: string
          discount_pct: number
          id: string
          label: string
          organization_id: string
          updated_at: string
          valid_until: string | null
        }
        Insert: {
          active?: boolean
          condition: string
          created_at?: string
          created_by: string
          discount_pct: number
          id?: string
          label: string
          organization_id: string
          updated_at?: string
          valid_until?: string | null
        }
        Update: {
          active?: boolean
          condition?: string
          created_at?: string
          created_by?: string
          discount_pct?: number
          id?: string
          label?: string
          organization_id?: string
          updated_at?: string
          valid_until?: string | null
        }
        Relationships: []
      }
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
          kind: string
          lead_id: string | null
          lost_category: string | null
          lost_reason: string | null
          name: string
          organization_id: string
          owner_id: string | null
          source_project_id: string | null
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
          kind?: string
          lead_id?: string | null
          lost_category?: string | null
          lost_reason?: string | null
          name: string
          organization_id: string
          owner_id?: string | null
          source_project_id?: string | null
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
          kind?: string
          lead_id?: string | null
          lost_category?: string | null
          lost_reason?: string | null
          name?: string
          organization_id?: string
          owner_id?: string | null
          source_project_id?: string | null
          stage?: string
          updated_at?: string
          value_minor?: number
        }
        Relationships: []
      }
      payment_milestones: {
        Row: {
          created_at: string
          id: string
          label: string
          organization_id: string
          pct: number
          position: number
          structure_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label: string
          organization_id: string
          pct: number
          position: number
          structure_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          organization_id?: string
          pct?: number
          position?: number
          structure_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_milestones_structure_id_fkey"
            columns: ["structure_id"]
            isOneToOne: false
            referencedRelation: "payment_structures"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_structures: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          id: string
          is_default: boolean
          max_amount_minor: number | null
          min_amount_minor: number | null
          name: string
          organization_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          is_default?: boolean
          max_amount_minor?: number | null
          min_amount_minor?: number | null
          name: string
          organization_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          id?: string
          is_default?: boolean
          max_amount_minor?: number | null
          min_amount_minor?: number | null
          name?: string
          organization_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      proposal_items: {
        Row: {
          amount_minor: number
          created_at: string
          description: string
          features: Json | null
          id: string
          organization_id: string
          position: number
          proposal_id: string
          quantity: number
          serves: Json | null
          unit_price_minor: number
        }
        Insert: {
          amount_minor?: number
          created_at?: string
          description: string
          features?: Json | null
          id?: string
          organization_id: string
          position?: number
          proposal_id: string
          quantity?: number
          serves?: Json | null
          unit_price_minor?: number
        }
        Update: {
          amount_minor?: number
          created_at?: string
          description?: string
          features?: Json | null
          id?: string
          organization_id?: string
          position?: number
          proposal_id?: string
          quantity?: number
          serves?: Json | null
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
          applied_offer_id: string | null
          approval_request_id: string | null
          approved_by_name: string | null
          approved_by_role: string | null
          body: string | null
          clauses_printed: Json | null
          conversation_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          decided_at: string | null
          discount_minor: number
          document: Json | null
          generated_by_run_id: string | null
          id: string
          opportunity_id: string
          organization_id: string
          plan_label: string | null
          plan_set_id: string | null
          plan_slot: number | null
          requirement_version_id: string | null
          responded_by_contact_id: string | null
          response_note: string | null
          sent_back_at: string | null
          sent_back_note: string | null
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
          applied_offer_id?: string | null
          approval_request_id?: string | null
          approved_by_name?: string | null
          approved_by_role?: string | null
          body?: string | null
          clauses_printed?: Json | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          decided_at?: string | null
          discount_minor?: number
          document?: Json | null
          generated_by_run_id?: string | null
          id?: string
          opportunity_id: string
          organization_id: string
          plan_label?: string | null
          plan_set_id?: string | null
          plan_slot?: number | null
          requirement_version_id?: string | null
          responded_by_contact_id?: string | null
          response_note?: string | null
          sent_back_at?: string | null
          sent_back_note?: string | null
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
          applied_offer_id?: string | null
          approval_request_id?: string | null
          approved_by_name?: string | null
          approved_by_role?: string | null
          body?: string | null
          clauses_printed?: Json | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          decided_at?: string | null
          discount_minor?: number
          document?: Json | null
          generated_by_run_id?: string | null
          id?: string
          opportunity_id?: string
          organization_id?: string
          plan_label?: string | null
          plan_set_id?: string | null
          plan_slot?: number | null
          requirement_version_id?: string | null
          responded_by_contact_id?: string | null
          response_note?: string | null
          sent_back_at?: string | null
          sent_back_note?: string | null
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
            foreignKeyName: "proposals_applied_offer_id_fkey"
            columns: ["applied_offer_id"]
            isOneToOne: false
            referencedRelation: "approved_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposals_plan_set_id_fkey"
            columns: ["plan_set_id"]
            isOneToOne: false
            referencedRelation: "proposal_plan_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      quotation_clauses: {
        Row: {
          body: string
          clause_key: string
          created_by: string
          effective_from: string
          id: string
          organization_id: string
          version: number
        }
        Insert: {
          body: string
          clause_key: string
          created_by: string
          effective_from?: string
          id?: string
          organization_id: string
          version: number
        }
        Update: {
          body?: string
          clause_key?: string
          created_by?: string
          effective_from?: string
          id?: string
          organization_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "quotation_clauses_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      proposal_plan_sets: {
        Row: {
          approval_request_id: string | null
          chosen_proposal_id: string | null
          conversation_id: string | null
          created_at: string
          created_by: string | null
          decided_at: string | null
          id: string
          opportunity_id: string
          organization_id: string
          recommended_proposal_id: string | null
          requirement_version_id: string | null
          responded_by_contact_id: string | null
          response_note: string | null
          sent_at: string | null
          sent_message_ref: string | null
          status: string
          updated_at: string
        }
        Insert: {
          approval_request_id?: string | null
          chosen_proposal_id?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          id?: string
          opportunity_id: string
          organization_id: string
          recommended_proposal_id?: string | null
          requirement_version_id?: string | null
          responded_by_contact_id?: string | null
          response_note?: string | null
          sent_at?: string | null
          sent_message_ref?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          approval_request_id?: string | null
          chosen_proposal_id?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          decided_at?: string | null
          id?: string
          opportunity_id?: string
          organization_id?: string
          recommended_proposal_id?: string | null
          requirement_version_id?: string | null
          responded_by_contact_id?: string | null
          response_note?: string | null
          sent_at?: string | null
          sent_message_ref?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "proposal_plan_sets_opportunity_id_fkey"
            columns: ["opportunity_id"]
            isOneToOne: false
            referencedRelation: "opportunities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_plan_sets_recommended_proposal_id_fkey"
            columns: ["recommended_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "proposal_plan_sets_chosen_proposal_id_fkey"
            columns: ["chosen_proposal_id"]
            isOneToOne: false
            referencedRelation: "proposals"
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
          p_features?: Json
          p_position?: number
          p_proposal_id: string
          p_quantity?: number
          p_serves?: Json
          p_unit_price_minor?: number
        }
        Returns: {
          item_id: string
          outcome: string
          subtotal_minor: number
          total_minor: number
        }[]
      }
      apply_approved_offer: {
        Args: { p_proposal_id: string }
        Returns: {
          discount_minor: number
          offer_id: string
          outcome: string
          total_minor: number
        }[]
      }
      clear_approved_offer: {
        Args: { p_organization_id: string }
        Returns: {
          outcome: string
        }[]
      }
      clear_payment_structure: {
        Args: { p_name: string; p_organization_id: string }
        Returns: {
          outcome: string
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
      draft_plan_set: {
        Args: {
          p_created_by?: string
          p_opportunity_id: string
          p_plans: Json
          p_recommended_slot: number
          p_requirement_version_id?: string
        }
        Returns: {
          outcome: string
          plan_set_id: string
          proposal_ids: string[]
        }[]
      }
      draft_proposal: {
        Args: {
          p_body?: string
          p_created_by?: string
          p_expected_supersede?: string
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
      open_renewal: {
        Args: { p_client_account_id: string; p_kind: string; p_name: string; p_project_id: string; p_value_minor?: number }
        Returns: { lead_id: string | null; opportunity_id: string | null; outcome: string }[]
      }
      record_plan_set_choice: {
        Args: {
          p_chosen_proposal_id: string
          p_contact_id?: string
          p_note?: string
          p_plan_set_id: string
        }
        Returns: {
          decided_at: string
          outcome: string
          status: string
        }[]
      }
      record_plan_set_response: {
        Args: {
          p_contact_id?: string
          p_note?: string
          p_plan_set_id: string
          p_response: string
        }
        Returns: {
          decided_at: string
          outcome: string
          status: string
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
      send_plan_set: {
        Args: {
          p_conversation_id?: string
          p_message_ref?: string
          p_plan_set_id: string
        }
        Returns: {
          outcome: string
          sent_at: string
          status: string
        }[]
      }
      clauses_for_proposal: {
        Args: {
          p_proposal_id: string
        }
        Returns: {
          clauses: Json | null
          outcome: string
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
      set_approved_offer: {
        Args: {
          p_condition: string
          p_discount_pct: number
          p_label: string
          p_organization_id: string
          p_valid_until?: string
        }
        Returns: {
          offer_id: string
          outcome: string
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
      set_payment_structure: {
        Args: {
          p_max_amount_minor?: number
          p_milestones: Json
          p_min_amount_minor?: number
          p_name: string
          p_organization_id: string
        }
        Returns: {
          outcome: string
          structure_id: string
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
      submit_plan_set: {
        Args: {
          p_plan_set_id: string
          p_requested_by?: string
          p_summary?: string
        }
        Returns: {
          outcome: string
          request_id: string
          status: string
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
      supersede_plan_set: {
        Args: { p_plan_set_id: string; p_reason?: string }
        Returns: string
      }
      sync_plan_set_decision: {
        Args: { p_plan_set_id: string }
        Returns: string
      }
      sync_proposal_decision: {
        Args: { p_proposal_id: string }
        Returns: string
      }
      won_gate_verdict: {
        Args: { p_opportunity_id: string }
        Returns: string | null
      }
      request_payment_exception: {
        Args: { p_opportunity_id: string; p_reason: string }
        Returns: {
          outcome: string
          request_id: string | null
          required_role: string | null
          sla_due_at: string | null
          state: string | null
        }[]
      }
      create_contract: {
        Args: {
          p_file_url?: string
          p_opportunity_id: string
          p_signed_on?: string
          p_signer_name?: string
          p_status?: string
          p_title: string
        }
        Returns: { contract_id: string | null; outcome: string }[]
      }
      update_contract_status: {
        Args: { p_contract_id: string; p_file_url?: string; p_signed_on?: string; p_signer_name?: string; p_status: string }
        Returns: { outcome: string }[]
      }
      record_won_handoff: {
        Args: { p_opportunity_id: string; p_project_id?: string }
        Returns: {
          handoff_id: string | null
          outcome: string
        }[]
      }
      won_handoff_packet: {
        Args: { p_opportunity_id: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  security: {
    Tables: {
      access_reviews: {
        Row: {
          created_at: string
          decision: string
          id: string
          membership_id: string
          note: string | null
          organization_id: string
          reviewed_at: string
          reviewer_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          decision: string
          id?: string
          membership_id: string
          note?: string | null
          organization_id: string
          reviewed_at?: string
          reviewer_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          decision?: string
          id?: string
          membership_id?: string
          note?: string | null
          organization_id?: string
          reviewed_at?: string
          reviewer_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "access_reviews_membership_id_fkey"
            columns: ["membership_id"]
            isOneToOne: false
            referencedRelation: "memberships"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          created_at: string
          evidence: Json
          id: string
          kind: string
          opened_at: string
          opened_by: string | null
          organization_id: string
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          summary: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          evidence?: Json
          id?: string
          kind: string
          opened_at?: string
          opened_by?: string | null
          organization_id: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity: string
          summary: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          evidence?: Json
          id?: string
          kind?: string
          opened_at?: string
          opened_by?: string | null
          organization_id?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          summary?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      open_incident: {
        Args: {
          p_evidence?: Json
          p_kind: string
          p_severity: string
          p_summary: string
        }
        Returns: {
          outcome: string
          id: string | null
        }[]
      }
      record_access_review: {
        Args: {
          p_decision: string
          p_membership_id: string
          p_note?: string
        }
        Returns: {
          outcome: string
          id: string | null
        }[]
      }
      resolve_incident: {
        Args: {
          p_incident_id: string
          p_resolution: string
        }
        Returns: {
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

