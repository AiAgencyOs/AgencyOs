export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  ai: {
    Tables: {
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
      agents: {
        Row: {
          autonomy_level: string
          created_at: string
          default_effort: string
          default_model: string
          description: string | null
          display_name: string
          enabled: boolean
          key: string
          max_cost_minor: number
          max_steps: number
          updated_at: string
        }
        Insert: {
          autonomy_level?: string
          created_at?: string
          default_effort?: string
          default_model: string
          description?: string | null
          display_name: string
          enabled?: boolean
          key: string
          max_cost_minor?: number
          max_steps?: number
          updated_at?: string
        }
        Update: {
          autonomy_level?: string
          created_at?: string
          default_effort?: string
          default_model?: string
          description?: string | null
          display_name?: string
          enabled?: boolean
          key?: string
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
          created_at: string
          currency: string
          id: string
          name: string
          settings: Json
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          id?: string
          name: string
          settings?: Json
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          id?: string
          name?: string
          settings?: Json
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      outbox_events: {
        Row: {
          attempts: number
          correlation_id: string | null
          created_at: string
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
      bootstrap_first_owner: { Args: { p_user_id: string }; Returns: string }
      can_write: { Args: never; Returns: boolean }
      claim_jobs: {
        Args: { batch_size?: number; worker_id: string }
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
      current_client_account_id: { Args: never; Returns: string }
      current_organization_id: { Args: never; Returns: string }
      current_user_role: { Args: never; Returns: string }
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      is_admin: { Args: never; Returns: boolean }
      is_client: { Args: never; Returns: boolean }
      is_internal: { Args: never; Returns: boolean }
      is_owner: { Args: never; Returns: boolean }
      reap_stalled_jobs: { Args: { stall_timeout?: string }; Returns: number }
      shares_organization: {
        Args: { target_user_id: string }
        Returns: boolean
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
          updated_at?: string
        }
        Relationships: []
      }
      conversation_messages: {
        Row: {
          author_id: string | null
          author_type: string
          body: string
          conversation_id: string
          created_at: string
          external_ref: string | null
          id: string
          metadata: Json
          occurred_at: string
          organization_id: string
          seq: number
        }
        Insert: {
          author_id?: string | null
          author_type: string
          body: string
          conversation_id: string
          created_at?: string
          external_ref?: string | null
          id?: string
          metadata?: Json
          occurred_at?: string
          organization_id: string
          seq: number
        }
        Update: {
          author_id?: string | null
          author_type?: string
          body?: string
          conversation_id?: string
          created_at?: string
          external_ref?: string | null
          id?: string
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
          channel: string
          contact_id: string | null
          created_at: string
          external_ref: string | null
          id: string
          lead_id: string
          organization_id: string
          status: string
          updated_at: string
        }
        Insert: {
          channel?: string
          contact_id?: string | null
          created_at?: string
          external_ref?: string | null
          id?: string
          lead_id: string
          organization_id: string
          status?: string
          updated_at?: string
        }
        Update: {
          channel?: string
          contact_id?: string | null
          created_at?: string
          external_ref?: string | null
          id?: string
          lead_id?: string
          organization_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
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
      [_ in never]: never
    }
    Functions: {
      ingest_whatsapp_message: {
        Args: {
          p_body: string
          p_external_ref: string
          p_from: string
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
        }
        Relationships: []
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      issue_invoice: {
        Args: { p_due_at?: string; p_invoice_id: string }
        Returns: {
          invoice_status: string
          outcome: string
        }[]
      }
      record_manual_payment: {
        Args: {
          p_amount_minor: number
          p_captured_at: string
          p_invoice_id: string
          p_provider_payment_id: string
        }
        Returns: {
          captured_before_minor: number
          invoice_status: string
          outcome: string
          payment_id: string
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
        ]
      }
      projects: {
        Row: {
          budget_minor: number | null
          client_account_id: string
          code: string | null
          completed_at: string | null
          created_at: string
          currency: string
          deleted_at: string | null
          description: string | null
          ends_on: string | null
          id: string
          lead_id: string | null
          name: string
          opportunity_id: string | null
          organization_id: string
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
          created_at?: string
          currency?: string
          deleted_at?: string | null
          description?: string | null
          ends_on?: string | null
          id?: string
          lead_id?: string | null
          name: string
          opportunity_id?: string | null
          organization_id: string
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
          created_at?: string
          currency?: string
          deleted_at?: string | null
          description?: string | null
          ends_on?: string | null
          id?: string
          lead_id?: string | null
          name?: string
          opportunity_id?: string | null
          organization_id?: string
          starts_on?: string | null
          status?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          assignee_id: string | null
          completed_at: string | null
          created_at: string
          description: string | null
          due_on: string | null
          estimate_hours: number | null
          id: string
          milestone_id: string | null
          organization_id: string
          priority: string
          project_id: string
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
          id?: string
          milestone_id?: string | null
          organization_id: string
          priority?: string
          project_id: string
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
          id?: string
          milestone_id?: string | null
          organization_id?: string
          priority?: string
          project_id?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_milestone_id_fkey"
            columns: ["milestone_id"]
            isOneToOne: false
            referencedRelation: "milestones"
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
      [_ in never]: never
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
  sales: {
    Tables: {
      opportunities: {
        Row: {
          client_account_id: string | null
          closed_at: string | null
          created_at: string
          currency: string
          expected_close_on: string | null
          id: string
          lead_id: string | null
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
          body: string | null
          created_at: string
          currency: string
          decided_at: string | null
          generated_by_run_id: string | null
          id: string
          opportunity_id: string
          organization_id: string
          sent_at: string | null
          status: string
          subtotal_minor: number
          tax_minor: number
          title: string
          total_minor: number
          updated_at: string
          version: number
        }
        Insert: {
          body?: string | null
          created_at?: string
          currency?: string
          decided_at?: string | null
          generated_by_run_id?: string | null
          id?: string
          opportunity_id: string
          organization_id: string
          sent_at?: string | null
          status?: string
          subtotal_minor?: number
          tax_minor?: number
          title: string
          total_minor?: number
          updated_at?: string
          version?: number
        }
        Update: {
          body?: string | null
          created_at?: string
          currency?: string
          decided_at?: string | null
          generated_by_run_id?: string | null
          id?: string
          opportunity_id?: string
          organization_id?: string
          sent_at?: string | null
          status?: string
          subtotal_minor?: number
          tax_minor?: number
          title?: string
          total_minor?: number
          updated_at?: string
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
  sales: {
    Enums: {},
  },
} as const

