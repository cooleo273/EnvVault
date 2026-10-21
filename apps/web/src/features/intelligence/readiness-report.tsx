'use client';

import type { ReadinessReport as Report, ReadinessStatus } from '@envvault/shared';
import {
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  CircleMinus,
  CircleX,
  LoaderIcon,
} from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '@/components/feedback/states';
import { StatusBadge, type StatusBadgeProps } from '@/components/feedback/status-badge';
import { notify } from '@/components/feedback/toast';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/features/secrets/step-up-dialog';
import { evaluateReadinessAction } from './actions';

const STATUS: Record<
  ReadinessStatus,
  { tone: StatusBadgeProps['tone']; label: string; summary: string }
> = {
  READY: { tone: 'success', label: 'Ready', summary: 'Every check that ran passed.' },
  WARNING: {
    tone: 'warning',
    label: 'Ready with warnings',
    summary: 'Nothing blocks this environment, but some checks need attention.',
  },
  BLOCKED: {
    tone: 'danger',
    label: 'Blocked',
    summary: 'At least one blocking problem must be fixed.',
  },
  UNKNOWN: {
    tone: 'neutral',
    label: 'Unknown',
    summary: 'Some checks could not run, so readiness cannot be confirmed.',
  },
};

const OUTCOME_ICONS = {
  passed: { icon: CheckCircle2, className: 'text-success', label: 'Passed' },
  failed: { icon: CircleX, className: 'text-danger', label: 'Failed' },
  warning: { icon: CircleAlert, className: 'text-warning', label: 'Warning' },
  skipped: { icon: CircleMinus, className: 'text-muted-foreground', label: 'Not checked' },
} as const;

const SEVERITY: Record<
  Report['issues'][number]['severity'],
  { tone: StatusBadgeProps['tone']; label: string }
> = {
  blocking: { tone: 'danger', label: 'Blocking' },
  warning: { tone: 'warning', label: 'Warning' },
  unknown: { tone: 'neutral', label: 'Not checked' },
};

const timeFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Readiness of an environment. Value rules are only checked when the user
 * asks for it and may read values; skipped checks are shown as such.
 */
export function ReadinessReport({
  workspaceId,
  projectId,
  environmentId,
  initial,
  canInspectValues,
}: {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  initial: Report | null;
  canInspectValues: boolean;
}) {
  const [report, setReport] = useState<Report | null>(initial);
  const [loading, setLoading] = useState(false);
  const [stepUp, setStepUp] = useState(false);

  async function evaluate(inspectValues: boolean) {
    setLoading(true);
    try {
      const result = await evaluateReadinessAction(workspaceId, projectId, environmentId, {
        inspectValues,
      });
      if (result.ok) setReport(result.data);
      else if (result.code === 'STEP_UP_REQUIRED') setStepUp(true);
      else notify.error(result.message);
    } finally {
      setLoading(false);
    }
  }

  if (!report) {
    return (
      <div className="rounded-lg border bg-surface">
        <ErrorState
          title="Readiness unavailable"
          description="The readiness checks could not run."
          onRetry={() => void evaluate(false)}
        />
      </div>
    );
  }
  const status = STATUS[report.status];

  return (
    <div className="flex flex-col gap-4" aria-busy={loading}>
      <div className="flex flex-col gap-3 rounded-lg border bg-surface p-4 sm:flex-row sm:items-center">
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <StatusBadge tone={status.tone} label={status.label} data-testid="readiness-status" />
            <span className="text-xs text-muted-foreground">
              Checked {timeFormat.format(new Date(report.evaluatedAt))}
              {report.valuesInspected
                ? ' · values inspected on the server'
                : ' · values not inspected'}
            </span>
          </div>
          <p className="text-sm">{status.summary}</p>
          <p className="text-xs text-muted-foreground">
            Required variables present: {report.coverage.present} of {report.coverage.required} ·{' '}
            {report.counts.blocking} blocking, {report.counts.warning} warnings,{' '}
            {report.counts.unknown} not checked
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {loading ? (
            <LoaderIcon
              aria-label="Checking"
              className="size-4 animate-spin self-center text-muted-foreground motion-reduce:animate-none"
            />
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void evaluate(false)}
          >
            Check again
          </Button>
          {canInspectValues ? (
            <Button size="sm" disabled={loading} onClick={() => void evaluate(true)}>
              Check values too
            </Button>
          ) : null}
        </div>
      </div>
      {!canInspectValues && !report.valuesInspected ? (
        <p className="text-xs text-muted-foreground">
          Value rules (format, length, pattern, allowed values) need value read access, so they are
          reported as not checked.
        </p>
      ) : null}

      <section aria-labelledby="checks-heading" className="rounded-lg border bg-surface">
        <h3 id="checks-heading" className="border-b px-4 py-2.5 text-sm font-semibold">
          Checks
        </h3>
        <ul className="divide-y">
          {report.checks.map((check) => {
            const o = OUTCOME_ICONS[check.outcome];
            return (
              <li
                key={check.name}
                className="flex items-start gap-3 px-4 py-2.5 text-sm"
                data-testid="readiness-check"
              >
                <o.icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${o.className}`} />
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    {check.name} <span className="sr-only">: {o.label}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{check.detail}</span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="issues-heading" className="rounded-lg border bg-surface">
        <h3 id="issues-heading" className="border-b px-4 py-2.5 text-sm font-semibold">
          Issues ({report.issues.length})
        </h3>
        {report.issues.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
            <CircleHelp aria-hidden="true" className="size-4" />
            No issues found by the checks that ran.
          </p>
        ) : (
          <ul className="divide-y">
            {report.issues.map((issue, index) => (
              <li
                key={`${issue.code}:${issue.key ?? ''}:${String(index)}`}
                className="flex flex-col gap-1 px-4 py-2.5 text-sm"
                data-testid="readiness-issue"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    tone={SEVERITY[issue.severity].tone}
                    label={SEVERITY[issue.severity].label}
                    dot={false}
                  />
                  {issue.key ? <code className="font-mono text-xs">{issue.key}</code> : null}
                  <span>{issue.message}</span>
                </span>
                <span className="text-xs text-muted-foreground">{issue.remediation}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <StepUpDialog
        open={stepUp}
        onOpenChange={setStepUp}
        onConfirmed={() => void evaluate(true)}
        description="This environment is protected. Confirm your password so the server can check its values. Values are never shown."
      />
    </div>
  );
}
