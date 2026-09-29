'use client';

import { useEffect } from 'react';

/** The event a detail page raises to name itself in the header's breadcrumb. */
export const TRAIL_LABEL_EVENT = 'agencyos:trail-label';

/**
 * A detail page (Project 360, Lead 360, …) renders this with the record's
 * name so the breadcrumb reads "Projects › All projects › GanxTV" rather
 * than "… › Detail". The name comes from the page's own server read; the
 * header only echoes it.
 */
export function TrailLabel({ name }: { name: string }) {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(TRAIL_LABEL_EVENT, { detail: name }));
    return () => {
      window.dispatchEvent(new CustomEvent(TRAIL_LABEL_EVENT, { detail: null }));
    };
  }, [name]);
  return null;
}
