import type { ReactNode } from 'react';

/**
 * One group of settings: what it is and why on the left, the controls on the right
 * (stacked on mobile). Wrap several in <SettingsSections> for the dividers.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 py-6 first:pt-0 md:grid-cols-[16rem_1fr] md:gap-8">
      <div className="space-y-1">
        <h2 className="font-semibold">{title}</h2>
        {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

export function SettingsSections({ children }: { children: ReactNode }) {
  return <div className="divide-y">{children}</div>;
}
