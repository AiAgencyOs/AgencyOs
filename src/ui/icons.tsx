/**
 * The icon set.
 *
 * Inline SVG rather than an icon package: every glyph here is a handful of
 * path data, and shipping a dependency to draw twenty-eight shapes would cost
 * more bytes than the shapes do. They are plain functions with no hooks, so a
 * Server Component and a Client Component can both render them.
 *
 * All of them inherit `currentColor` and size from the `size` prop, which is
 * what lets one icon sit in a nav row, a button, and a chat bubble without
 * three variants existing.
 */

export type IconProps = {
  size?: number;
  className?: string;
  /** Icons are decorative by default; give a label when the icon is the only content. */
  label?: string;
};

function Svg({
  size = 20,
  className,
  label,
  children,
  filled,
}: IconProps & { children: React.ReactNode; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {children}
    </svg>
  );
}

/* ── Navigation ─────────────────────────────────────────────────────────── */

export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Svg>
);

export const IconLeads = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 11.5a8.4 8.4 0 01-9 8.4 9 9 0 01-3.9-.9L3 20.5l1.6-4.7A8.4 8.4 0 013 11.5a8.4 8.4 0 018.9-8.4 8.4 8.4 0 019.1 8.4z" />
  </Svg>
);

export const IconProjects = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2.5h7A1.5 1.5 0 0119 10v7.5A1.5 1.5 0 0117.5 19h-13A1.5 1.5 0 013 17.5z" />
    <path d="M19 10V8a1.5 1.5 0 00-1.5-1.5H13" />
  </Svg>
);

export const IconInvoices = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
    <path d="M9 8h6M9 12h6M9 16h3" />
  </Svg>
);

export const IconPortfolio = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z" />
  </Svg>
);

export const IconAgents = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="7" width="16" height="12" rx="3" />
    <path d="M12 4v3M9 13h.01M15 13h.01M9.5 16.5h5" />
  </Svg>
);

export const IconOperations = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h4l2.5-7 5 14L17 12h4" />
  </Svg>
);

export const IconApprovals = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l2.1 1.6 2.6-.3 1 2.4 2.3 1.2-.6 2.6.6 2.6-2.3 1.2-1 2.4-2.6-.3L12 18l-2.1-1.6-2.6.3-1-2.4L4 13.1l.6-2.6L4 7.9l2.3-1.2 1-2.4 2.6.3z" />
    <path d="M9.3 11.2l1.9 1.9 3.6-3.9" />
  </Svg>
);

export const IconSecurity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l7 3v6c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6z" />
    <path d="M9.2 12.2l2 2 3.6-4" />
  </Svg>
);

export const IconAudit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4.5A1.5 1.5 0 016.5 3H15l4 4v12.5A1.5 1.5 0 0117.5 21h-11A1.5 1.5 0 015 19.5z" />
    <path d="M14 3v4h5M8.5 12h7M8.5 16h4" />
  </Svg>
);

export const IconUsage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Svg>
);

export const IconReadiness = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3c3.5 2 5.5 5.6 5.5 9.5L15 15H9l-2.5-2.5C6.5 8.6 8.5 5 12 3z" />
    <circle cx="12" cy="10" r="1.6" />
    <path d="M9 15l-2 4 3.5-1.2M15 15l2 4-3.5-1.2" />
  </Svg>
);

export const IconIntegrations = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3v5M15 3v5" />
    <path d="M6 8h12v4a6 6 0 01-6 6 6 6 0 01-6-6z" />
    <path d="M12 18v3" />
  </Svg>
);

export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v11M8 10l4 4 4-4" />
    <path d="M4 16v3.5A1.5 1.5 0 005.5 21h13a1.5 1.5 0 001.5-1.5V16" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 14.5a1.5 1.5 0 00.3 1.7l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.5 1.5 0 00-2.6 1v.2a2 2 0 11-4 0v-.1a1.5 1.5 0 00-2.6-1l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.5 1.5 0 00-1-2.6H3.8a2 2 0 110-4h.1a1.5 1.5 0 001-2.6l-.1-.1a2 2 0 112.8-2.8l.1.1a1.5 1.5 0 002.6-1V3.8a2 2 0 114 0v.1a1.5 1.5 0 002.6 1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.5 1.5 0 001 2.6h.2a2 2 0 110 4h-.1a1.5 1.5 0 00-1.4.9z" />
  </Svg>
);

/* ── Interface ──────────────────────────────────────────────────────────── */

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 9l7 7 7-7" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const IconArrowUpRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 17L17 7M8 7h9v9" />
  </Svg>
);

export const IconSignOut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 4h3.5A1.5 1.5 0 0120 5.5v13a1.5 1.5 0 01-1.5 1.5H15" />
    <path d="M10 8l-4 4 4 4M6 12h9" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17h.01" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.2l3.2 2" />
  </Svg>
);

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0115 0" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 10-1.6 5.6" />
    <path d="M20 5v6h-6" />
  </Svg>
);

export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 13l2.5-7.5A1.5 1.5 0 017 4.5h10a1.5 1.5 0 011.5 1L21 13v5.5A1.5 1.5 0 0119.5 20h-15A1.5 1.5 0 013 18.5z" />
    <path d="M3 13h5l1 2.5h6L16 13h5" />
  </Svg>
);

/* ── WhatsApp surface ───────────────────────────────────────────────────── */

export const IconSend = (p: IconProps) => (
  <Svg {...p} filled>
    <path d="M3.4 20.4l17.5-7.5a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4 1L4 11l9 1-9 1-2 5.4a1 1 0 001.4 1z" />
  </Svg>
);

/** A single grey tick — written, not yet sent. */
export const IconTickSingle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12.6l4.2 4.2L18.6 6.4" />
  </Svg>
);

/** Two ticks — accepted by the provider (blue once read). */
export const IconTickDouble = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 12.6l4.2 4.2L16.1 6.4" />
    <path d="M7.9 12.6l4.2 4.2L22.5 6.4" />
  </Svg>
);

export const IconAttach = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11.5l-8 8a5 5 0 01-7-7l8.5-8.5a3.4 3.4 0 014.8 4.8L9.7 17.4a1.8 1.8 0 01-2.5-2.5l7.8-7.8" />
  </Svg>
);

export const IconPhone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.2 3.5h3l1.5 4-2 1.4a12 12 0 006.4 6.4l1.4-2 4 1.5v3a2 2 0 01-2.2 2A17 17 0 014.2 5.7a2 2 0 012-2.2z" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p} filled>
    <circle cx="12" cy="5" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="12" cy="19" r="1.8" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8.5 10.5V7.8a3.5 3.5 0 017 0v2.7" />
  </Svg>
);

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  </Svg>
);
