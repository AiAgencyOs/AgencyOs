import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Fail the production build on type errors rather than shipping them.
  // Linting is a separate `npm run lint` step: Next 16 removed `next lint`.
  typescript: { ignoreBuildErrors: false },

  // Never expose which server stack is behind the app.
  poweredByHeader: false,

  // The quotation PDF's fonts are loose .ttf files read with `fs` at render
  // time (src/lib/pdf/fonts.ts) — invisible to the file tracer that decides
  // what ships in a serverless function bundle, so they are named here for
  // every route: the jobs runner renders the owner's copy, a Server Action
  // renders the client's, and the download route renders on request. A font
  // silently missing from the bundle is not a build error; it is a 500 in
  // production on the first send, which is why the glob is broad rather than
  // clever.
  outputFileTracingIncludes: {
    '/**': ['src/lib/pdf/fonts/**'],
  },
};

export default nextConfig;
