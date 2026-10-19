'use client';

import type { ReceivedInvitation, WorkspaceType } from '@envvault/shared';
import { ArrowRight, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { CreateWorkspaceForm, WorkspaceTypePicker } from './create-workspace-form';
import { ReceivedInvitations } from './received-invitations';

type Step = 'welcome' | 'type' | 'details';
const STEPS: Step[] = ['welcome', 'type', 'details'];

function Progress({ step }: { step: Step }) {
  const index = STEPS.indexOf(step);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Step {index + 1} of {STEPS.length}
      </p>
      <div
        className="flex gap-1"
        role="progressbar"
        aria-label="Onboarding progress"
        aria-valuemin={1}
        aria-valuemax={STEPS.length}
        aria-valuenow={index + 1}
      >
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1 flex-1 rounded-full ${i <= index ? 'bg-brand' : 'bg-muted'}`}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * First-run flow for users without a workspace: welcome (and any pending
 * invitations), choose personal or team, name it, create it. Creation is a
 * server action; on success the user lands on the dashboard.
 */
export function OnboardingWizard({
  name,
  invitations,
}: {
  name: string | null;
  invitations: ReceivedInvitation[];
}) {
  const [step, setStep] = useState<Step>('welcome');
  const [type, setType] = useState<WorkspaceType>('TEAM');

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 py-6">
      <Progress step={step} />

      {step === 'welcome' ? (
        <section aria-labelledby="onboarding-title" className="flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-brand text-brand-foreground">
              <KeyRound aria-hidden="true" className="size-5" />
            </span>
            <h1 id="onboarding-title" className="text-2xl font-semibold tracking-tight">
              {name ? `Welcome to EnvVault, ${name}` : 'Welcome to EnvVault'}
            </h1>
            <p className="text-sm text-muted-foreground">
              Workspaces hold your projects, environments and the people who can access them. Create
              one to get started{invitations.length > 0 ? ', or join one you were invited to' : ''}.
            </p>
          </div>
          {invitations.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold">Invitations for you</h2>
              <ReceivedInvitations invitations={invitations} />
            </div>
          ) : null}
          <div className="flex justify-end">
            <Button
              onClick={() => {
                setStep('type');
              }}
            >
              Create a workspace
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'type' ? (
        <section aria-labelledby="type-title" className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h1 id="type-title" className="text-xl font-semibold tracking-tight">
              Who is this workspace for?
            </h1>
            <p className="text-sm text-muted-foreground">
              Both kinds have the same security model; you can invite people to either.
            </p>
          </div>
          <WorkspaceTypePicker value={type} onChange={setType} />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setStep('welcome');
              }}
            >
              Back
            </Button>
            <Button
              onClick={() => {
                setStep('details');
              }}
            >
              Continue
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </section>
      ) : null}

      {step === 'details' ? (
        <section aria-labelledby="details-title" className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h1 id="details-title" className="text-xl font-semibold tracking-tight">
              Name your {type === 'PERSONAL' ? 'personal' : 'team'} workspace
            </h1>
            <p className="text-sm text-muted-foreground">
              You will be its owner. You can rename it later.
            </p>
          </div>
          <CreateWorkspaceForm
            next="dashboard"
            defaultType={type}
            showType={false}
            submitLabel="Create workspace and continue"
            onBack={() => {
              setStep('type');
            }}
          />
        </section>
      ) : null}
    </div>
  );
}
