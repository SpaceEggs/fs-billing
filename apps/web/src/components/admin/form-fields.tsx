import { useEffect, useId, useRef, useState } from 'react';
import type { Currency } from '@fs-billing/shared';
import { Label } from '../ui/label';
import { addRecipients } from '../../lib/tenant-create';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

export const currencySymbol = { CNY: '¥', USD: '$' } as const satisfies Record<
  Currency,
  string
>;

export type FieldControlProps = {
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
  'aria-required': true | undefined;
};

/**
 * 表单分组：电脑版左侧标题与说明、右侧两列字段；
 * 手机版（稿 4a/5a）只留小标题，不重复说明。
 */
export function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="grid gap-3 py-3 md:grid-cols-[240px_1fr] md:gap-8 md:border-t md:border-border md:py-6"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[13px] font-semibold text-muted-foreground md:text-[15px] md:text-foreground">
          {title}
        </h2>
        <span className="hidden text-[13px] leading-relaxed text-muted-foreground md:block">
          {description}
        </span>
      </div>
      <div className="grid gap-x-5 gap-y-3.5 md:grid-cols-2 md:gap-y-4">
        {children}
      </div>
    </section>
  );
}

export function Field({
  label,
  shortLabel,
  required = false,
  optional = false,
  badge,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  /** 手机上显示的短标签；读屏仍读完整标签。 */
  shortLabel?: string;
  required?: boolean;
  /** 显示“（可选）”。 */
  optional?: boolean;
  /** 标签行右侧的说明标记，例如“客户可见”。 */
  badge?: React.ReactNode;
  hint?: React.ReactNode;
  error: string | undefined;
  className?: string;
  children: (props: FieldControlProps) => React.ReactNode;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  const hintId = `${id}-hint`;
  const describedBy =
    [error ? messageId : null, hint ? hintId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5 text-sm font-medium', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>
          {shortLabel ? (
            <>
              <span aria-hidden className="md:hidden">
                {shortLabel}
              </span>
              <span className="max-md:sr-only">{label}</span>
            </>
          ) : (
            label
          )}
          {required ? (
            <span aria-hidden className="text-err">
              {' '}
              *
            </span>
          ) : null}
          {optional ? (
            <span className="font-normal text-muted-foreground">（可选）</span>
          ) : null}
        </Label>
        {badge}
      </div>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        'aria-required': required || undefined,
      })}
      {error ? (
        <span id={messageId} className="text-xs font-normal text-err">
          {error}
        </span>
      ) : null}
      {hint ? (
        <span
          id={hintId}
          className="text-xs leading-normal font-normal text-muted-foreground"
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export const invalidClass = (error: string | undefined) =>
  error ? 'border-err focus-visible:ring-err/30' : undefined;

export function MoneyInput({
  currency,
  value,
  onChange,
  placeholder,
  error,
  className,
  ...aria
}: FieldControlProps & {
  currency: Currency;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error: string | undefined;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex h-11 items-center overflow-hidden rounded-lg border border-input font-normal focus-within:ring-[3px] focus-within:ring-ring/50 md:h-10',
        error && 'border-err',
      )}
    >
      <span
        aria-hidden
        className="flex h-full items-center border-r border-input px-3 text-muted-foreground"
      >
        {currencySymbol[currency]}
      </span>
      <input
        {...aria}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent px-3 text-right text-base tabular-nums outline-none placeholder:text-muted-foreground md:text-sm',
          className,
        )}
      />
    </div>
  );
}

/**
 * 通知邮箱：回车、逗号或失焦时加入列表；小写去重后显示；为空时提示提醒无法送达。
 * `flagged` 中的邮箱属于已停用管理员，保留但标出，请管理员确认。
 * `stacked`（设置页稿 1h）时邮箱列在上方，下面是单独的输入框和「添加」按钮；默认两者在同一个框里。
 * `stacked` 在手机上（稿 3h）每个邮箱占一整行，输入框收在虚线「＋ 添加邮箱」按钮后面。
 */
export function RecipientsInput({
  emails,
  error,
  onChange,
  flagged,
  stacked = false,
  className,
}: {
  emails: string[];
  error: string | undefined;
  onChange: (emails: string[]) => void;
  flagged?: ReadonlySet<string>;
  stacked?: boolean;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);
  const inputShown = adding || draft !== '' || error !== undefined;
  const commit = () => {
    if (!draft.trim()) return;
    const next = addRecipients(emails, draft);
    onChange(next.emails);
    setNotice(next.notice);
    setDraft('');
  };
  const flaggedKeys = new Set(
    [...(flagged ?? [])].map((email) => email.toLowerCase()),
  );
  const isFlagged = (email: string) => flaggedKeys.has(email.toLowerCase());
  const flaggedEmails = emails.filter(isFlagged);
  const chipItems = emails.map((email) => (
    <li
      key={email}
      className={cn(
        'flex items-center gap-1.5 rounded-md border border-transparent bg-muted text-[13px]',
        stacked
          ? 'h-11 justify-between rounded-lg pr-0.5 pl-3 text-[15px] md:h-7 md:justify-start md:rounded-md md:pr-1.5 md:pl-2.5 md:text-[13px]'
          : 'h-7 pr-1.5 pl-2.5',
        isFlagged(email) && 'border-warn-border bg-warn-soft',
      )}
    >
      <span className="min-w-0 truncate">
        {email}
        {isFlagged(email) ? (
          <span className="ml-1.5 text-[11px] text-warn">已停用管理员</span>
        ) : null}
      </span>
      <button
        type="button"
        aria-label={`移除 ${email}`}
        onClick={() => onChange(emails.filter((item) => item !== email))}
        className={cn(
          'shrink-0 text-[11px] text-muted-foreground',
          stacked &&
            'flex size-10 items-center justify-center text-sm md:size-auto md:text-[11px]',
        )}
      >
        ✕
      </button>
    </li>
  ));
  const input = (layout: string) => (
    <input
      ref={inputRef}
      id={id}
      type="email"
      autoComplete="off"
      aria-invalid={error ? true : undefined}
      aria-describedby={`${id}-messages`}
      placeholder="输入邮箱后按回车添加"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ',') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Backspace' && !draft && emails.length)
          onChange(emails.slice(0, -1));
      }}
      className={cn(
        'bg-transparent text-base outline-none placeholder:text-[13px] placeholder:text-muted-foreground md:text-sm',
        layout,
      )}
    />
  );
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 text-sm font-medium md:col-span-2',
        className,
      )}
    >
      <Label htmlFor={id}>通知邮箱</Label>
      <span className="-mt-1 text-xs font-normal text-muted-foreground">
        可添加多个，余额不足和停机通知会发送到这些邮箱
      </span>
      {stacked ? (
        <>
          {emails.length ? (
            <ul
              aria-label="已添加的通知邮箱"
              className="m-0 flex list-none flex-col gap-2 p-0 font-normal md:flex-row md:flex-wrap"
            >
              {chipItems}
            </ul>
          ) : null}
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={cn(
              'h-11 items-center justify-center rounded-lg border border-dashed border-input text-[15px] font-normal text-primary outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:hidden',
              inputShown ? 'hidden' : 'flex',
            )}
          >
            ＋ 添加邮箱
          </button>
          <div
            className={cn(
              'gap-2 font-normal md:flex',
              inputShown ? 'flex' : 'hidden',
            )}
          >
            {input(
              cn(
                'h-11 flex-1 rounded-lg border px-3 focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9',
                error ? 'border-err' : 'border-input',
              ),
            )}
            <Button
              type="button"
              variant="outline"
              className="h-11 md:h-9"
              onClick={commit}
            >
              添加
            </Button>
          </div>
        </>
      ) : (
        <div
          className={cn(
            'flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1.5 font-normal focus-within:ring-[3px] focus-within:ring-ring/50',
            error && 'border-err',
          )}
        >
          <ul aria-label="已添加的通知邮箱" className="contents">
            {chipItems}
          </ul>
          {input('h-8 min-w-[180px] flex-1 px-1.5')}
        </div>
      )}
      <div id={`${id}-messages`} className="flex flex-col gap-1">
        {error ? (
          <span className="text-xs font-normal text-err">{error}</span>
        ) : null}
        {notice ? (
          <span className="text-xs font-normal text-muted-foreground">
            {notice}
          </span>
        ) : null}
        {emails.length === 0 ? (
          <span role="status" className="text-xs font-normal text-warn">
            未配置收件人，余额提醒无法送达
          </span>
        ) : null}
        {flaggedEmails.map((email) => (
          <span
            key={email}
            role="status"
            className="text-xs font-normal text-warn"
          >
            「{email}」属于已停用管理员，请确认收件人
          </span>
        ))}
      </div>
    </div>
  );
}
