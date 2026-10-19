import { LoadingSkeleton } from '@/components/feedback/states';

export default function WorkspaceLoading() {
  return <LoadingSkeleton variant="table" rows={4} label="Loading workspace…" />;
}
