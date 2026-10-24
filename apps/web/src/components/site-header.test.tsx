import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SiteHeader } from './site-header';

describe('SiteHeader', () => {
  it('provides a skip link targeting the main content', () => {
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
  });

  it('renders labelled primary navigation', () => {
    render(<SiteHeader />);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    // Absolute anchors, so the links also work from pages other than the landing page.
    expect(screen.getByRole('link', { name: 'Roadmap' })).toHaveAttribute('href', '/#roadmap');
    expect(screen.getByRole('link', { name: 'API' })).toHaveAttribute('href', '/developers/api');
  });
});
