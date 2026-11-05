import { Link } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { badgeVariants } from '@/components/ui/badge';
import type { AiStatus } from '@/lib/api';
import { cn } from '@/lib/utils';

const LABEL: Record<AiStatus, string> = {
  generated: 'AI-generated',
  confirmed: 'AI-generated · confirmed',
  corrected: 'AI-generated · corrected',
};

/** Discloses AI-produced content and links to the transparency page. */
export function AiBadge({ status }: { status: AiStatus }) {
  return (
    <Link
      to="/ai-transparency"
      title="How we use AI and how to contest a result"
      className={cn(
        badgeVariants({ variant: status === 'generated' ? 'default' : 'secondary' }),
        'gap-1 font-normal',
      )}
    >
      <Sparkles className="size-3" aria-hidden />
      {LABEL[status]}
    </Link>
  );
}
