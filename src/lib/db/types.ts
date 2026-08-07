/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate after every migration:
 *   npm run db:types
 *
 * Currently a stub: no tables exist yet. Feature 2 (Database Schema) creates
 * the schemas, after which this file is regenerated from the live database and
 * the `--schema` list in package.json is expanded beyond `public`.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: Record<never, never>;
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
