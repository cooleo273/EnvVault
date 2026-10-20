'use client';

import { Star } from 'lucide-react';
import { useState, useTransition } from 'react';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { setFavoriteAction } from './actions';

export function FavoriteToggle({
  workspaceId,
  projectId,
  name,
  initial,
}: {
  workspaceId: string;
  projectId: string;
  name: string;
  initial: boolean;
}) {
  const [favorite, setFavorite] = useState(initial);
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      aria-pressed={favorite}
      aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
      onClick={() => {
        const next = !favorite;
        setFavorite(next);
        startTransition(async () => {
          const result = await setFavoriteAction(workspaceId, projectId, next);
          if (!result.ok) {
            setFavorite(!next);
            notify.error(result.message);
          }
        });
      }}
    >
      <Star aria-hidden="true" className={cn(favorite && 'fill-amber-400 text-amber-500')} />
      <span className="hidden sm:inline">{favorite ? 'Favorited' : 'Favorite'}</span>
    </Button>
  );
}
