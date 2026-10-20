'use client';

import type { EnvironmentSummary } from '@envvault/shared';
import { Check, ChevronsUpDown, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { COLOR_CLASSES } from './visual';

/**
 * EnvironmentSelector: switch between a project's environments, keeping the
 * current sub-page (overview or settings). Lists only environments the
 * caller may see; ids are stable, so renamed environments keep working.
 */
export function EnvironmentSelector({
  environments,
  currentId,
  baseHref,
  suffix = '',
}: {
  environments: EnvironmentSummary[];
  currentId: string;
  baseHref: string;
  suffix?: string;
}) {
  const current = environments.find((e) => e.id === currentId);
  const dot = (color: string) =>
    (COLOR_CLASSES as Partial<Record<string, { dot: string }>>)[color]?.dot ?? 'bg-slate-500';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Switch environment (current: ${current?.name ?? 'none'})`}
        >
          <span
            aria-hidden="true"
            className={cn('size-2 rounded-full', dot(current?.color ?? 'slate'))}
          />
          <span className="max-w-40 truncate">{current?.name ?? 'Environment'}</span>
          <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel>Environments</DropdownMenuLabel>
        {environments.map((env) => (
          <DropdownMenuItem key={env.id} asChild>
            <Link
              href={`${baseHref}/${env.id}${suffix}`}
              aria-current={env.id === currentId ? 'page' : undefined}
            >
              <span
                aria-hidden="true"
                className={cn('size-2 shrink-0 rounded-full', dot(env.color))}
              />
              <span className="truncate">{env.name}</span>
              {env.isProtected ? (
                <ShieldCheck aria-label="protected" className="size-3.5 text-muted-foreground" />
              ) : null}
              {env.id === currentId ? (
                <Check aria-hidden="true" className="ml-auto size-3.5" />
              ) : null}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={baseHref}>All environments</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
