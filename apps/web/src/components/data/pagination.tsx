'use client';

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface PaginationProps {
  /** 1-based current page. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  totalItems?: number;
  pageSize?: number;
  className?: string;
}

const numberFormat = new Intl.NumberFormat('en');

export function Pagination({
  page,
  pageCount,
  onPageChange,
  totalItems,
  pageSize,
  className,
}: PaginationProps) {
  const safeCount = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), safeCount);
  const isFirst = current <= 1;
  const isLast = current >= safeCount;

  let summary: string | null = null;
  if (totalItems !== undefined && pageSize !== undefined) {
    const start = totalItems === 0 ? 0 : (current - 1) * pageSize + 1;
    const end = Math.min(current * pageSize, totalItems);
    summary = `${numberFormat.format(start)}–${numberFormat.format(end)} of ${numberFormat.format(totalItems)}`;
  }

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center justify-between gap-3 text-sm', className)}
    >
      <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {summary ?? `Page ${current} of ${safeCount}`}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="First page"
          disabled={isFirst}
          onClick={() => {
            onPageChange(1);
          }}
        >
          <ChevronsLeftIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous page"
          disabled={isFirst}
          onClick={() => {
            onPageChange(current - 1);
          }}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <span className="px-2 text-xs text-muted-foreground tabular-nums">
          {current} / {safeCount}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next page"
          disabled={isLast}
          onClick={() => {
            onPageChange(current + 1);
          }}
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Last page"
          disabled={isLast}
          onClick={() => {
            onPageChange(safeCount);
          }}
        >
          <ChevronsRightIcon aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
