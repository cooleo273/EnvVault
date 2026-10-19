import {
  ArrowRight,
  FileClock,
  GitCompareArrows,
  KeySquare,
  Layers,
  LockKeyhole,
  ShieldCheck,
  Terminal,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const CAPABILITIES = [
  {
    icon: Layers,
    title: 'Workspaces, projects & environments',
    description:
      'Organise configuration by workspace and project, with as many custom environments as you need — Development, QA, Staging, Production and beyond.',
  },
  {
    icon: LockKeyhole,
    title: 'Envelope-encrypted secrets',
    description:
      'Every value is encrypted with its own data key, wrapped by a root key that never leaves a managed KMS.',
  },
  {
    icon: Users,
    title: 'Granular access control',
    description:
      'Role- and policy-based permissions per workspace, project and environment, with team invitations.',
  },
  {
    icon: FileClock,
    title: 'Versioning & audit trail',
    description:
      'Full history for every secret with rollback, and an immutable audit log of who changed what and when.',
  },
  {
    icon: GitCompareArrows,
    title: 'Environment comparison',
    description:
      'Diff environments side by side and validate configuration before it reaches production.',
  },
  {
    icon: Terminal,
    title: 'CLI, API & CI/CD',
    description:
      'Fetch configuration from your terminal, pipelines and services using scoped machine identities.',
  },
];

const SECURITY_PRINCIPLES = [
  'Secrets are encrypted before they are stored; plaintext values are never persisted.',
  'Encryption root keys live in a managed KMS — never in the application database.',
  'Secrets, credentials and request bodies are never written to logs.',
  'The browser is untrusted: all authorization decisions are made by the API.',
  'Authentication relies on proven, standard protocols — no home-grown cryptography.',
];

const ROADMAP = [
  {
    phase: 'Phase 0',
    title: 'Foundation',
    description: 'Monorepo, API and web skeletons, CI, infrastructure and security baseline.',
    current: true,
  },
  {
    phase: 'Phase 1',
    title: 'Core secrets management',
    description: 'Authentication, workspaces, projects, environments and encrypted secrets.',
  },
  {
    phase: 'Phase 2',
    title: 'Collaboration & control',
    description: 'Team invitations, access policies, versioning, rollback and audit logs.',
  },
  {
    phase: 'Phase 3',
    title: 'Automation',
    description: 'CLI, SDKs, CI/CD integrations, machine identities and change approvals.',
  },
  {
    phase: 'Phase 4',
    title: 'Enterprise',
    description: 'Secret rotation, SSO and identity providers, alerting and self-hosting.',
  },
];

const EXAMPLE_VARIABLES = [
  { key: 'DATABASE_URL', masked: true },
  { key: 'STRIPE_SECRET_KEY', masked: true },
  { key: 'LOG_LEVEL', value: 'info' },
  { key: 'FEATURE_NEW_CHECKOUT', value: 'true' },
];

export default function HomePage() {
  return (
    <>
      <section aria-labelledby="hero-heading" className="relative overflow-hidden border-b">
        <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:py-28">
          <div className="flex flex-col items-start gap-6">
            <Badge variant="outline" className="gap-1.5 font-mono">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
              In development · Phase 0
            </Badge>
            <h1
              id="hero-heading"
              className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl"
            >
              Every environment variable. One secure source of truth.
            </h1>
            <p className="max-w-xl text-lg text-pretty text-muted-foreground">
              EnvVault is a centralized platform for managing environment variables and secrets
              across your projects, environments and teams — encrypted, versioned and audited.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link href="/dashboard">
                  Open the app preview
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="#roadmap">See the roadmap</a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="#security">Security model</a>
              </Button>
            </div>
          </div>

          <figure className="rounded-xl border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2 font-mono text-sm">
                <KeySquare aria-hidden="true" className="size-4 text-brand" />
                checkout-api
                <span className="text-muted-foreground">/</span>
                production
              </div>
              <Badge variant="secondary">Example</Badge>
            </div>
            <dl className="divide-y font-mono text-sm">
              {EXAMPLE_VARIABLES.map((variable) => (
                <div
                  key={variable.key}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <dt className="truncate">{variable.key}</dt>
                  <dd className="text-muted-foreground">
                    {variable.masked ? (
                      <span aria-label="Hidden secret value">••••••••••••</span>
                    ) : (
                      variable.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            <figcaption className="border-t px-4 py-3 text-xs text-muted-foreground">
              Illustration of a project environment. Secret management is not available yet.
            </figcaption>
          </figure>
        </div>
      </section>

      <section
        id="capabilities"
        aria-labelledby="capabilities-heading"
        className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6"
      >
        <div className="mb-10 flex max-w-2xl flex-col gap-3">
          <h2 id="capabilities-heading" className="text-3xl font-semibold tracking-tight">
            What EnvVault is being built to do
          </h2>
          <p className="text-muted-foreground">
            These capabilities are planned and will ship incrementally, phase by phase.
          </p>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map(({ icon: Icon, title, description }) => (
            <li key={title}>
              <Card className="h-full">
                <CardHeader className="gap-3">
                  <div className="flex items-center justify-between">
                    <span className="grid size-9 place-items-center rounded-lg bg-accent text-accent-foreground">
                      <Icon aria-hidden="true" className="size-4" />
                    </span>
                    <Badge variant="outline">Planned</Badge>
                  </div>
                  <CardTitle className="text-base">{title}</CardTitle>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </li>
          ))}
        </ul>
      </section>

      <section
        id="security"
        aria-labelledby="security-heading"
        className="scroll-mt-20 border-y bg-muted/40"
      >
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="flex flex-col gap-3">
            <ShieldCheck aria-hidden="true" className="size-8 text-brand" />
            <h2 id="security-heading" className="text-3xl font-semibold tracking-tight">
              Security by design
            </h2>
            <p className="text-muted-foreground">
              The principles every part of EnvVault is built on, starting with the foundation.
            </p>
          </div>
          <ol className="flex flex-col gap-3">
            {SECURITY_PRINCIPLES.map((principle, index) => (
              <li key={principle} className="flex gap-4 rounded-lg border bg-card p-4">
                <span className="font-mono text-sm text-brand" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span>{principle}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        id="roadmap"
        aria-labelledby="roadmap-heading"
        className="mx-auto w-full max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6"
      >
        <h2 id="roadmap-heading" className="mb-10 text-3xl font-semibold tracking-tight">
          Roadmap
        </h2>
        <ol className="relative flex flex-col gap-6 border-l pl-6">
          {ROADMAP.map((item) => (
            <li
              key={item.phase}
              className="relative"
              aria-current={item.current ? 'step' : undefined}
            >
              <span
                aria-hidden="true"
                className={`absolute top-1.5 -left-[1.95rem] size-3 rounded-full border-2 ${
                  item.current ? 'border-primary bg-primary' : 'border-border bg-background'
                }`}
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-muted-foreground">{item.phase}</span>
                <h3 className="font-semibold">{item.title}</h3>
                {item.current ? <Badge variant="default">Current</Badge> : null}
              </div>
              <p className="mt-1 text-muted-foreground">{item.description}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
