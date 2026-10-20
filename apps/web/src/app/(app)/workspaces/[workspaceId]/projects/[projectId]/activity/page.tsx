import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ActivityList } from '@/features/projects/activity-list';
import { withApi } from '@/lib/api/server-api';
import { projectPath } from '@/lib/projects/server';
import { handleApiFailure } from '@/lib/workspaces/server';

export const metadata: Metadata = { title: 'Project activity' };

/** Project activity from the audit log, paged with an opaque cursor. */
export default async function ProjectActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const [{ workspaceId, projectId }, query] = await Promise.all([params, searchParams]);
  const base = `${projectPath(workspaceId, projectId)}/activity`;
  const page = await withApi((api) =>
    api.projectActivity(workspaceId, projectId, { limit: 30, cursor: query.cursor }),
  ).catch((error: unknown) => handleApiFailure(error, base));
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Every change to this project, its environments and access, newest first. Never includes
        secret values.
      </p>
      <ActivityList events={page.items} />
      <div className="flex justify-between">
        {query.cursor ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={base}>Newest</Link>
          </Button>
        ) : (
          <span />
        )}
        {page.nextCursor ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={`${base}?cursor=${encodeURIComponent(page.nextCursor)}`}>Older</Link>
          </Button>
        ) : null}
      </div>
    </>
  );
}
