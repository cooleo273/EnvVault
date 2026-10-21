import { LoadingSkeleton } from '@/components/feedback/states';

export default function Loading() {
  return <LoadingSkeleton variant="table" rows={6} label="Loading variables" />;
}
