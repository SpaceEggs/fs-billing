import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

const searchDelayMs = 300;

/** 搜索框输入后稍等再写入地址，避免每个字都请求一次。 */
export function SearchBox({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft.trim() === value) return;
    const timer = setTimeout(() => latest.current(draft.trim()), searchDelayMs);
    return () => clearTimeout(timer);
  }, [draft, value]);
  return (
    <input
      type="search"
      aria-label={label}
      placeholder={label}
      maxLength={200}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className={cn(
        'h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9 md:text-sm',
        className,
      )}
    />
  );
}
