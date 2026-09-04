/* Generated from the live cloud Supabase project `wouvkkaxehwuhtgpersx` ("Gantt").
   Do not edit by hand — regenerate after every migration. See README.md:
     supabase gen types typescript --project-id wouvkkaxehwuhtgpersx > src/lib/database.types.ts
   (or the Supabase MCP tool `generate_typescript_types` with that project id). */

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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_state: {
        Row: {
          active_project: string | null
          id: string
          owner: string | null
          updated_at: string
        }
        Insert: {
          active_project?: string | null
          id: string
          owner?: string | null
          updated_at?: string
        }
        Update: {
          active_project?: string | null
          id?: string
          owner?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_state_active_project_fkey"
            columns: ["active_project"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      gantt_store: {
        Row: {
          data: Json
          id: string
          saved_at: number
          updated_at: string
        }
        Insert: {
          data: Json
          id: string
          saved_at?: number
          updated_at?: string
        }
        Update: {
          data?: Json
          id?: string
          saved_at?: number
          updated_at?: string
        }
        Relationships: []
      }
      links: {
        Row: {
          id: string
          project_id: string
          source: string
          target: string
          type: string
        }
        Insert: {
          id: string
          project_id: string
          source: string
          target: string
          type?: string
        }
        Update: {
          id?: string
          project_id?: string
          source?: string
          target?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "links_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "links_source_fkey"
            columns: ["source"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "links_target_fkey"
            columns: ["target"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          created_at: string
          id: string
          name: string
          owner: string | null
          position: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id: string
          name?: string
          owner?: string | null
          position?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner?: string | null
          position?: number
          updated_at?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_at: string
          id: string
          name: string
          owner: string | null
          position: number
          updated_at: string
          view: string
        }
        Insert: {
          created_at?: string
          id: string
          name?: string
          owner?: string | null
          position?: number
          updated_at?: string
          view?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner?: string | null
          position?: number
          updated_at?: string
          view?: string
        }
        Relationships: []
      }
      tasks: {
        Row: {
          assignees: string | null
          days: number | null
          details: string
          duration: number | null
          end_date: string | null
          hours: number | null
          id: string
          open: boolean | null
          parent_id: string | null
          progress: number
          project_id: string
          release: string | null
          sort_order: number
          start_date: string | null
          status: string
          text: string
          type: string
          updated_at: string
          url: string | null
        }
        Insert: {
          assignees?: string | null
          days?: number | null
          details?: string
          duration?: number | null
          end_date?: string | null
          hours?: number | null
          id: string
          open?: boolean | null
          parent_id?: string | null
          progress?: number
          project_id: string
          release?: string | null
          sort_order?: number
          start_date?: string | null
          status?: string
          text?: string
          type?: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          assignees?: string | null
          days?: number | null
          details?: string
          duration?: number | null
          end_date?: string | null
          hours?: number | null
          id?: string
          open?: boolean | null
          parent_id?: string | null
          progress?: number
          project_id?: string
          release?: string | null
          sort_order?: number
          start_date?: string | null
          status?: string
          text?: string
          type?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "tasks"
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
      view_chunks: {
        Row: {
          data: string
          hash: string
          idx: number
        }
        Insert: {
          data: string
          hash: string
          idx: number
        }
        Update: {
          data?: string
          hash?: string
          idx?: number
        }
        Relationships: []
      }
      view_page: {
        Row: {
          chunk_count: number
          hash: string
          id: string
          updated_at: string | null
        }
        Insert: {
          chunk_count?: number
          hash: string
          id: string
          updated_at?: string | null
        }
        Update: {
          chunk_count?: number
          hash?: string
          id?: string
          updated_at?: string | null
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
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
