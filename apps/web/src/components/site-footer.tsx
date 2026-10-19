export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>EnvVault — secrets and configuration management.</p>
        <p>Early development preview. Not yet ready for production secrets.</p>
      </div>
    </footer>
  );
}
