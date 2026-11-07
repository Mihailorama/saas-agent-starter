import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

const copy = async (text: string) => {
  await navigator.clipboard.writeText(text);
  toast.success('Copied');
};

/** Shows a secret value once (new API key) or on demand (webhook secret). */
export function SecretDialog({
  title,
  description,
  value,
  onClose,
}: {
  title: string;
  description: string;
  value: string | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={value !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={value ?? ''} aria-label={title} className="font-mono text-xs" />
          <Button variant="outline" size="icon" aria-label="Copy" onClick={() => copy(value ?? '')}>
            <Copy className="size-4" />
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
