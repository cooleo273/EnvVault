import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentBadge, PermissionBadge } from '@/components/domain/badges';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from './confirm-dialog';
import { ResponsiveModal } from './responsive-modal';
import { EmptyState, ErrorState, LoadingSkeleton } from './states';
import { StatusBadge } from './status-badge';

describe('badges', () => {
  it('StatusBadge shows text, not just colour', () => {
    render(<StatusBadge tone="danger" label="Unreachable" />);
    const badge = screen.getByText('Unreachable');
    expect(badge).toHaveAttribute('data-tone', 'danger');
  });

  it('EnvironmentBadge uses the custom name and announces protection', () => {
    render(<EnvironmentBadge kind="PRODUCTION" name="prod-eu" isProtected />);
    const badge = screen.getByText('prod-eu').closest('[data-kind]');
    expect(badge).toHaveAttribute('data-kind', 'PRODUCTION');
    expect(badge).toHaveTextContent('prod-eu, protected');
  });

  it('PermissionBadge flags sensitive permissions and describes them', () => {
    const { rerender } = render(<PermissionBadge permission="secret:read" />);
    let badge = screen.getByText('secret:read').closest('[data-sensitive]');
    expect(badge).toHaveAttribute('data-sensitive', 'true');
    expect(badge).toHaveTextContent('(sensitive): Decrypt and read secret values');

    rerender(<PermissionBadge permission="secret:list" />);
    badge = screen.getByText('secret:list').closest('[data-sensitive]');
    expect(badge).toHaveAttribute('data-sensitive', 'false');
  });
});

describe('states', () => {
  it('EmptyState distinguishes unimplemented features from empty data', () => {
    const { rerender } = render(<EmptyState variant="placeholder" title="Search" />);
    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    rerender(<EmptyState title="No secrets" />);
    expect(screen.queryByText('Not available yet')).toBeNull();
    expect(screen.getByRole('heading', { name: 'No secrets' })).toBeInTheDocument();
  });

  it('ErrorState is announced and offers retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} requestId="req-12345678" />);
    expect(screen.getByRole('alert')).toHaveTextContent('req-12345678');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('LoadingSkeleton exposes a busy status to assistive technology', () => {
    render(<LoadingSkeleton variant="table" label="Loading projects" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading projects');
  });
});

describe('ConfirmDialog', () => {
  it('requires the confirmation text and closes after the action succeeds', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.resolve());
    render(
      <ConfirmDialog
        title="Delete environment?"
        description="This cannot be undone."
        confirmLabel="Delete"
        destructive
        confirmationText="production"
        onConfirm={onConfirm}
        trigger={<Button>Delete</Button>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete environment?' });
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByRole('textbox'), 'prod');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'uction');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
  });

  it('stays open and reports failure when the action throws', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        title="Revoke token?"
        description="Clients using it will stop working."
        confirmLabel="Revoke"
        onConfirm={() => Promise.reject(new Error('server said no'))}
        trigger={<Button>Open</Button>}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be completed');
    expect(screen.queryByText('server said no')).toBeNull();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('closes with Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog
        title="Sure?"
        description="Really."
        onConfirm={vi.fn()}
        trigger={<Button>Ask</Button>}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Ask' });
    await user.click(trigger);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });
});

describe('ResponsiveModal', () => {
  it('opens from its trigger with a labelled dialog and closes with Escape', async () => {
    const user = userEvent.setup();
    render(
      <ResponsiveModal
        title="Add variable"
        description="Values are encrypted."
        trigger={<Button>Add</Button>}
      >
        <p>Body</p>
      </ResponsiveModal>,
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add variable' });
    expect(dialog).toHaveAccessibleDescription('Values are encrypted.');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Add' })).toHaveFocus();
  });
});
