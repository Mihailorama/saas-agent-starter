import type { ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** A write-only secret (API key, auth header value): sent once, stored encrypted, never shown. */
export function SecretField({
  id,
  label,
  help,
  ...props
}: { id: string; label: string; help?: string } & ComponentProps<'input'>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        aria-describedby={help ? `${id}-help` : undefined}
        {...props}
      />
      {help && (
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}
