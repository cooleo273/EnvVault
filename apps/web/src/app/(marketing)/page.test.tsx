import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HomePage from './page';

describe('HomePage', () => {
  it('renders a single top-level heading', () => {
    render(<HomePage />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('labels each section with a heading', () => {
    render(<HomePage />);
    for (const name of ['What EnvVault is being built to do', 'Security by design', 'Roadmap']) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('marks unreleased capabilities as planned', () => {
    render(<HomePage />);
    const capabilities = screen.getByRole('region', { name: 'What EnvVault is being built to do' });
    const items = within(capabilities).getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(within(item).getByText('Planned')).toBeInTheDocument();
    }
  });

  it('marks the current roadmap phase', () => {
    render(<HomePage />);
    const roadmap = screen.getByRole('region', { name: 'Roadmap' });
    const current = within(roadmap)
      .getAllByRole('listitem')
      .filter((item) => item.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Foundation');
  });

  it('does not present fake authentication or secret inputs', () => {
    render(<HomePage />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in|log in/i })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Hidden secret value').length).toBeGreaterThan(0);
  });
});
