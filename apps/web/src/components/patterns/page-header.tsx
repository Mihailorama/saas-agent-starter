import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Top of every page: one h1, an optional one-line description, primary actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <div className="text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Page body width: `default` for lists and tables, `narrow` for detail pages and forms. */
export function PageContainer({
  width = 'default',
  className,
  children,
}: {
  width?: 'default' | 'narrow';
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn('mx-auto space-y-6', width === 'narrow' ? 'max-w-3xl' : 'max-w-5xl', className)}
    >
      {children}
    </div>
  );
}
