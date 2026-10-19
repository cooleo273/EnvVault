import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Input } from '@/components/ui/input';
import { CopyField } from './copy-field';
import { FormField } from './form-field';
import { SECRET_MASK, SecretMaskedField } from './secret-masked-field';

vi.mock('@/components/feedback/toast', () => ({
  notify: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const SECRET = 'example-value-not-a-real-secret';

describe('FormField', () => {
  it('wires label, description, error and required state to the control', () => {
    render(
      <FormField label="Slug" description="Used in URLs." error="Invalid slug" required>
        {(control) => <Input {...control} />}
      </FormField>,
    );
    const input = screen.getByRole('textbox', { name: /Slug/ });
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Used in URLs. Invalid slug');
  });

  it('omits ARIA error attributes when valid', () => {
    render(<FormField label="Name">{(control) => <Input {...control} />}</FormField>);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });
});

describe('CopyField', () => {
  it('copies the value and confirms through the button label', async () => {
    const user = userEvent.setup();
    render(<CopyField label="Workspace ID" value="ws_123" />);
    expect(screen.getByRole('textbox', { name: 'Workspace ID' })).toHaveValue('ws_123');

    await user.click(screen.getByRole('button', { name: 'Copy Workspace ID' }));
    await expect(navigator.clipboard.readText()).resolves.toBe('ws_123');
    expect(await screen.findByRole('button', { name: 'Workspace ID copied' })).toBeInTheDocument();
  });
});

describe('SecretMaskedField', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not load or render the value until it is revealed', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const loadValue = vi.fn(() => Promise.resolve(SECRET));
    const { container } = render(<SecretMaskedField label="DATABASE_URL" loadValue={loadValue} />);

    expect(loadValue).not.toHaveBeenCalled();
    expect(container).not.toHaveTextContent(SECRET);
    expect(screen.getByText(SECRET_MASK)).toBeInTheDocument();

    const reveal = screen.getByRole('button', { name: 'Reveal DATABASE_URL' });
    expect(reveal).toHaveAttribute('aria-pressed', 'false');
    await user.click(reveal);

    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    expect(loadValue).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Hide DATABASE_URL' }));
    expect(container).not.toHaveTextContent(SECRET);
  });

  it('re-masks automatically after the timeout', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = render(
      <SecretMaskedField
        label="API_KEY"
        loadValue={() => Promise.resolve(SECRET)}
        autoHideMs={5_000}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reveal API_KEY' }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container).not.toHaveTextContent(SECRET);
    expect(screen.getByRole('button', { name: 'Reveal API_KEY' })).toBeInTheDocument();
  });

  it('copies without revealing the value on screen', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = render(
      <SecretMaskedField label="TOKEN" loadValue={() => Promise.resolve(SECRET)} />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy TOKEN' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(SECRET);
    expect(container).not.toHaveTextContent(SECRET);
  });

  it('stays masked when loading fails and can be disabled', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = render(
      <SecretMaskedField label="TOKEN" loadValue={() => Promise.reject(new Error('denied'))} />,
    );
    await user.click(screen.getByRole('button', { name: 'Reveal TOKEN' }));
    expect(await screen.findByText('Loading the value failed.')).toBeInTheDocument();
    expect(screen.getByText(SECRET_MASK)).toBeInTheDocument();

    rerender(
      <SecretMaskedField label="TOKEN" loadValue={() => Promise.resolve(SECRET)} disabled />,
    );
    expect(screen.getByRole('button', { name: 'Reveal TOKEN' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy TOKEN' })).toBeDisabled();
  });
});
