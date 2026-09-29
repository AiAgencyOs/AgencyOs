import { exportGstr } from '../gstr-export';

/**
 * GSTR-1 for the chosen month or quarter as the GST portal's offline tool
 * reads it — bucket E5. Same gate, reader and period parsing as the GST &
 * tax page; see ../gstr-export.ts.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return exportGstr('gstr1', request);
}
