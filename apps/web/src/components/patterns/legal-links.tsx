import { legalLinks } from '@/lib/legal';
import { cn } from '@/lib/utils';

/** Footer links to every legal page (docs/legal.md); on the auth pages and in the app shell. */
export function LegalLinks({ align = 'center' }: { align?: 'center' | 'start' }) {
  return (
    <nav aria-label="Legal" className="text-xs text-muted-foreground">
      <ul
        className={cn(
          'flex flex-wrap gap-x-3 gap-y-1',
          align === 'center' ? 'justify-center' : 'justify-start',
        )}
      >
        {legalLinks.map((l) => (
          <li key={l.id}>
            <a
              href={l.href}
              target="_blank"
              rel="noopener"
              className="inline-flex min-h-6 items-center underline-offset-4 hover:underline"
            >
              {l.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
