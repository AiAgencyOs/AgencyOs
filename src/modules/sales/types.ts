import type { Database } from '@/lib/db/types';

type OpportunityRow = Database['sales']['Tables']['opportunities']['Row'];

export type OpportunityListItem = Pick<
  OpportunityRow,
  | 'id'
  | 'name'
  | 'stage'
  | 'currency'
  | 'value_minor'
  | 'lead_id'
  | 'client_account_id'
  | 'expected_close_on'
  | 'created_at'
>;
