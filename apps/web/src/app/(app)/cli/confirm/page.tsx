import type { Metadata } from 'next';
import { CliConfirm } from '@/features/cli/cli-confirm';

export const metadata: Metadata = { title: 'Confirm for the CLI' };

/** Linked from CLI errors on protected environments (STEP_UP_REQUIRED). */
export default function CliConfirmPage() {
  return (
    <section
      aria-labelledby="cli-confirm-heading"
      className="mx-auto flex w-full max-w-lg flex-col gap-4"
    >
      <h1 id="cli-confirm-heading" className="text-lg font-semibold tracking-tight">
        Confirm your password for the CLI
      </h1>
      <CliConfirm />
    </section>
  );
}
