export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold tracking-tight">AgencyOS</h1>
      <p className="text-sm opacity-70">
        Foundation is up. Verify dependencies at{' '}
        <a className="underline underline-offset-4" href="/api/health">
          /api/health
        </a>
        .
      </p>
    </main>
  );
}
