import type * as React from 'react';

/** Heading block shared by the auth pages. */
export function AuthPageHeader({
  title,
  description,
}: {
  title: string;
  description?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-1">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="mb-4 rounded-md border border-info-border bg-info-subtle px-3 py-2 text-sm text-info"
    >
      {children}
    </p>
  );
}
