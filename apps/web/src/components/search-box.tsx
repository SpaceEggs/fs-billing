import { useEffect, useRef, useState } from 'react';
import { Input } from './ui/input';
import { cn } from '../lib/utils';

const searchDelayMs = 300;

/** 搜索框输入后稍等再写入地址，避免每个字都请求一次。 */
export function SearchBox({
  label,
  placeholder,
  value,
  onChange,
  className,
}: {
  label: string;
  /** 缺省与 label 相同。 */
  placeholder?: string;
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
    <Input
      type="search"
      aria-label={label}
      placeholder={placeholder ?? label}
      maxLength={200}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className={cn('w-auto sm:h-11 sm:text-base md:h-9 md:text-sm', className)}
    />
  );
}
