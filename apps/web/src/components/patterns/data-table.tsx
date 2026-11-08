import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type HeaderContext,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
  MoreHorizontal,
  Search,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ListSkeleton, type QueryLike, QueryView } from '@/components/patterns/states';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

declare module '@tanstack/react-table' {
  interface ColumnMeta<TData, TValue> {
    /** Classes for the column's header and cells, e.g. `hidden md:table-cell` for secondary
     * columns, so the table fits a phone without horizontal scrolling. */
    className?: string;
  }
}

/** Column header that sorts on click; pass as `header: sortable('Name')`. */
export const sortable =
  (label: string) =>
  <T,>({ column }: HeaderContext<T, unknown>) => {
    const dir = column.getIsSorted();
    const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
    return (
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => column.toggleSorting(dir === 'asc')}
      >
        {label} <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      </Button>
    );
  };

export type RowAction = {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Destructive actions go last, in red, and must open a ConfirmDialog. */
  destructive?: boolean;
};

/** The "…" menu at the end of a row. `label` names the row for screen readers. */
export function RowActions({ label, actions }: { label: string; actions: RowAction[] }) {
  const safe = actions.filter((a) => !a.destructive);
  const destructive = actions.filter((a) => a.destructive);
  const item = ({ label: text, icon: Icon, onSelect, destructive: d }: RowAction) => (
    <DropdownMenuItem key={text} variant={d ? 'destructive' : 'default'} onSelect={onSelect}>
      {Icon && <Icon aria-hidden />} {text}
    </DropdownMenuItem>
  );
  return (
    <div className="text-right">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${label}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {safe.map(item)}
          {safe.length > 0 && destructive.length > 0 && <DropdownMenuSeparator />}
          {destructive.map(item)}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The list screen table: sorting, a text filter, client-side pagination, row actions, and the
 * error / loading / empty states. Columns are plain TanStack `ColumnDef`s. For server-side
 * paging, keep this markup and switch the table to `manualPagination` (TanStack docs).
 */
export function DataTable<T>({
  query,
  columns,
  label,
  errorTitle,
  empty,
  filterPlaceholder = 'Filter…',
  initialSorting = [],
  pageSize = 10,
}: {
  query: QueryLike<T[]>;
  columns: ColumnDef<T>[];
  /** Accessible name of the table, e.g. "Projects". */
  label: string;
  errorTitle: string;
  /** Shown when there are no rows at all (not when the filter hides them). */
  empty: ReactNode;
  filterPlaceholder?: string;
  initialSorting?: SortingState;
  pageSize?: number;
}) {
  return (
    <QueryView
      query={query}
      errorTitle={errorTitle}
      loading={<ListSkeleton rows={4} />}
      isEmpty={(rows) => rows.length === 0}
      empty={empty}
    >
      {(rows) => (
        <LoadedTable
          rows={rows}
          columns={columns}
          label={label}
          filterPlaceholder={filterPlaceholder}
          initialSorting={initialSorting}
          pageSize={pageSize}
        />
      )}
    </QueryView>
  );
}

function LoadedTable<T>({
  rows,
  columns,
  label,
  filterPlaceholder,
  initialSorting,
  pageSize,
}: {
  rows: T[];
  columns: ColumnDef<T>[];
  label: string;
  filterPlaceholder: string;
  initialSorting: SortingState;
  pageSize: number;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [filter, setFilter] = useState('');
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    initialState: { pagination: { pageSize } },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: true,
  });
  const shown = table.getRowModel().rows;
  const total = table.getFilteredRowModel().rows.length;
  const { pageIndex } = table.getState().pagination;
  const first = pageIndex * pageSize + 1;

  return (
    <div className="space-y-3">
      <div className="relative max-w-xs">
        <Search
          className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          placeholder={filterPlaceholder}
          aria-label={filterPlaceholder.replace(/…$/, '')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-8"
        />
      </div>
      <div className="rounded-lg border">
        <Table aria-label={label}>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const dir = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className={header.column.columnDef.meta?.className}
                      aria-sort={
                        dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined
                      }
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {shown.length ? (
              shown.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  Nothing matches “{filter}”.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {table.getPageCount() > 1 && (
        <nav
          aria-label={`${label} pages`}
          className="flex items-center justify-between gap-4 text-sm text-muted-foreground"
        >
          <span>
            {first}–{first + shown.length - 1} of {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeft /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next <ChevronRight />
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
