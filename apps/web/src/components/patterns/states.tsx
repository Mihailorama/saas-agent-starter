import { AlertCircle, type LucideIcon, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Nothing here yet: say what belongs here and offer the one action that adds it. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn('border', className)}>
      <EmptyHeader>
        {/* The icon sits in flow, no tile behind it (a boxed icon over a heading reads as template UI). */}
        {Icon && (
          <EmptyMedia>
            <Icon className="size-8 text-muted-foreground" strokeWidth={1.5} aria-hidden />
          </EmptyMedia>
        )}
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/** Loading placeholder shaped like the content (rows of a list or table), not a spinner. */
export function ListSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div
      className={cn('space-y-2 rounded-lg border p-4', className)}
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders, never reordered
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** A request failed: say what failed, show the reason, and offer a retry when it can help. */
export function ErrorState({
  title,
  error,
  onRetry,
  className,
}: {
  title: string;
  error?: { message: string } | null;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <Alert variant="destructive" className={className}>
      <AlertCircle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span>{error?.message ?? 'Something went wrong.'}</span>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCw /> Retry
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** What QueryView needs from a TanStack `useQuery` result (any query result fits). */
export type QueryLike<T> = {
  data: T | undefined;
  error: { message: string } | null;
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
};

/**
 * The three states every data screen must cover, in one place: error (with retry), loading,
 * empty, then the content. Use it for every `useQuery` that fills a screen or a section.
 */
export function QueryView<T>({
  query,
  errorTitle,
  loading = <ListSkeleton />,
  isEmpty,
  empty,
  children,
}: {
  query: QueryLike<T>;
  errorTitle: string;
  loading?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isError) {
    return <ErrorState title={errorTitle} error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.isPending || query.data === undefined) return loading;
  if (empty && isEmpty?.(query.data)) return empty;
  return children(query.data);
}
