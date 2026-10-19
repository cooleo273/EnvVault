import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FilterDropdown } from './filter-dropdown';
import { Pagination } from './pagination';
import { SearchInput } from './search-input';

function ControlledSearch() {
  const [value, setValue] = useState('');
  return <SearchInput label="Search projects" value={value} onValueChange={setValue} />;
}

describe('SearchInput', () => {
  it('has an accessible name, clears with the button and with Escape', async () => {
    const user = userEvent.setup();
    render(<ControlledSearch />);
    const input = screen.getByRole('searchbox', { name: 'Search projects' });

    await user.type(input, 'api');
    expect(input).toHaveValue('api');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();

    await user.type(input, 'web{Escape}');
    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });
});

describe('Pagination', () => {
  it('summarises the range and disables unavailable directions', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <Pagination
        page={1}
        pageCount={4}
        totalItems={80}
        pageSize={25}
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    expect(screen.getByText('1–25 of 80')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole('button', { name: 'Last page' }));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it('clamps out-of-range pages', () => {
    render(
      <Pagination page={9} pageCount={3} totalItems={60} pageSize={25} onPageChange={vi.fn()} />,
    );
    expect(screen.getByText('51–60 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});

function ControlledFilter() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <FilterDropdown
      label="Environment"
      options={[
        { value: 'PRODUCTION', label: 'Production' },
        { value: 'STAGING', label: 'Staging' },
      ]}
      selected={selected}
      onSelectedChange={setSelected}
    />
  );
}

describe('FilterDropdown', () => {
  it('toggles options from the keyboard and reports the selection count', async () => {
    const user = userEvent.setup();
    render(<ControlledFilter />);
    const trigger = screen.getByRole('button', { name: 'Environment filter' });

    trigger.focus();
    await user.keyboard('{Enter}');
    const production = await screen.findByRole('menuitemcheckbox', { name: 'Production' });
    expect(production).toHaveAttribute('aria-checked', 'false');
    await user.click(production);

    // The menu stays open while toggling.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Production' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('menuitem', { name: 'Clear filter' }));
    await user.keyboard('{Escape}');

    expect(screen.getByRole('button', { name: 'Environment filter' })).toBeInTheDocument();
  });

  it('labels the trigger with the number of active filters', async () => {
    const user = userEvent.setup();
    render(<ControlledFilter />);
    await user.click(screen.getByRole('button', { name: 'Environment filter' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Staging' }));
    await user.keyboard('{Escape}');
    expect(
      screen.getByRole('button', { name: 'Environment filter, 1 selected' }),
    ).toBeInTheDocument();
  });
});
