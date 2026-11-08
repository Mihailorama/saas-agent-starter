import { CalendarIcon } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const format = (d: Date) =>
  d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** One date (Popover + Calendar). For a range, pass `mode="range"` to Calendar the same way. */
export function DatePicker({
  id,
  value,
  onChange,
  placeholder = 'Pick a date',
  defaultMonth,
  className,
  'aria-invalid': invalid,
}: {
  id?: string;
  value: Date | undefined;
  onChange: (value: Date | undefined) => void;
  placeholder?: string;
  /** Month shown when nothing is selected (defaults to the current month). */
  defaultMonth?: Date;
  className?: string;
  'aria-invalid'?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          aria-invalid={invalid}
          className={cn(
            'w-full justify-start font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <CalendarIcon aria-hidden /> {value ? format(value) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          defaultMonth={value ?? defaultMonth}
          onSelect={(d) => {
            onChange(d);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
