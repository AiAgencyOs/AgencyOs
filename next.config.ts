import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Fail the production build on type errors rather than shipping them.
  // Linting is a separate `npm run lint` step: Next 16 removed `next lint`.
  typescript: { ignoreBuildErrors: false },

  // Never expose which server stack is behind the app.
  poweredByHeader: false,
};

export default nextConfig;
