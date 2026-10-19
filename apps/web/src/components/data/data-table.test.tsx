import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DataTable, type DataTableColumn } from './data-table';

interface Row {
  id: string;
  name: string;
  count: number | null;
}

const columns: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', isRowHeader: true, sortValue: (r) => r.name, cell: (r) => r.name },
  {
    id: 'count',
    header: 'Count',
    align: 'end',
    sortValue: (r) => r.count,
    cell: (r) => r.count ?? '—',
  },
  { id: 'static', header: 'Static', cell: () => 'x' },
];

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(i),
    name: `item ${String(i + 1)}`,
    count: i,
  }));
}

function bodyRowNames(): string[] {
  const table = screen.getByRole('table');
  const rows = within(table).getAllByRole('row').slice(1);
  return rows.map((row) => within(row).getByRole('rowheader').textContent);
}

describe('DataTable', () => {
  it('renders an accessible table with a caption, column headers and row headers', () => {
    render(
      <DataTable caption="Items" columns={columns} data={makeRows(3)} getRowId={(r) => r.id} />,
    );
    const table = screen.getByRole('table', { name: 'Items' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Name', 'Count', 'Static']);
    expect(bodyRowNames()).toEqual(['item 1', 'item 2', 'item 3']);
    // The scroll container is keyboard focusable.
    expect(screen.getByRole('region', { name: 'Items' })).toHaveAttribute('tabindex', '0');
  });

  it('sorts ascending, descending, then back to the original order (natural ordering)', async () => {
    const user = userEvent.setup();
    const rows: Row[] = [
      { id: 'a', name: 'item 10', count: 1 },
      { id: 'b', name: 'item 2', count: 3 },
      { id: 'c', name: 'item 1', count: 2 },
    ];
    render(<DataTable caption="Items" columns={columns} data={rows} getRowId={(r) => r.id} />);
    const header = screen.getByRole('columnheader', { name: /Name/ });
    expect(header).toHaveAttribute('aria-sort', 'none');

    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyRowNames()).toEqual(['item 1', 'item 2', 'item 10']);

    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(bodyRowNames()).toEqual(['item 10', 'item 2', 'item 1']);

    await user.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'none');
    // Third click clears sorting: back to the original data order.
    expect(bodyRowNames()).toEqual(['item 10', 'item 2', 'item 1']);
  });

  it('keeps empty values last in both directions and leaves unsortable columns plain', async () => {
    const user = userEvent.setup();
    const rows: Row[] = [
      { id: 'a', name: 'a', count: null },
      { id: 'b', name: 'b', count: 5 },
      { id: 'c', name: 'c', count: 1 },
    ];
    render(<DataTable caption="Items" columns={columns} data={rows} getRowId={(r) => r.id} />);
    const countButton = within(screen.getByRole('columnheader', { name: /Count/ })).getByRole(
      'button',
    );
    await user.click(countButton);
    expect(bodyRowNames()).toEqual(['c', 'b', 'a']);
    await user.click(countButton);
    expect(bodyRowNames()).toEqual(['b', 'c', 'a']);
    expect(
      within(screen.getByRole('columnheader', { name: 'Static' })).queryByRole('button'),
    ).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Static' })).not.toHaveAttribute('aria-sort');
  });

  it('paginates large datasets', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        caption="Items"
        columns={columns}
        data={makeRows(300)}
        getRowId={(r) => r.id}
        pageSize={25}
      />,
    );
    expect(bodyRowNames()).toHaveLength(25);
    expect(screen.getByText('1–25 of 300')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(bodyRowNames()[0]).toBe('item 26');
    await user.click(screen.getByRole('button', { name: 'Last page' }));
    expect(screen.getByText('276–300 of 300')).toBeInTheDocument();
  });

  it('renders loading, error and empty states instead of the table', () => {
    const { rerender } = render(
      <DataTable
        caption="Items"
        columns={columns}
        data={[]}
        getRowId={(r) => r.id}
        status="loading"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading items');
    expect(screen.queryByRole('table')).toBeNull();

    rerender(
      <DataTable
        caption="Items"
        columns={columns}
        data={[]}
        getRowId={(r) => r.id}
        status="error"
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <DataTable
        caption="Items"
        columns={columns}
        data={[]}
        getRowId={(r) => r.id}
        emptyState={<p>Nothing here</p>}
      />,
    );
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('applies the density token to the table container', () => {
    render(
      <DataTable
        caption="Items"
        columns={columns}
        data={makeRows(1)}
        getRowId={(r) => r.id}
        density="compact"
      />,
    );
    expect(screen.getByRole('region', { name: 'Items' })).toHaveAttribute(
      'data-density',
      'compact',
    );
  });
});
