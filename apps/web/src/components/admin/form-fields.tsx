import { useId, useState } from 'react';
import type { Currency } from '@fs-billing/shared';
import { addRecipients } from '../../lib/tenant-create';
import { cn } from '../../lib/utils';

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

export function Field({
  label,
  required = false,
  optional = false,
  badge,
  hint,
  error,
  className,
  children,
}: {
  label: string;
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
        <label htmlFor={id}>
          {label}
          {required ? (
            <span aria-hidden className="text-err">
              {' '}
              *
            </span>
          ) : null}
          {optional ? (
            <span className="font-normal text-muted-foreground">（可选）</span>
          ) : null}
        </label>
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
 */
export function RecipientsInput({
  emails,
  error,
  onChange,
  flagged,
  className,
}: {
  emails: string[];
  error: string | undefined;
  onChange: (emails: string[]) => void;
  flagged?: ReadonlySet<string>;
  className?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const commit = () => {
    if (!draft.trim()) return;
    const next = addRecipients(emails, draft);
    onChange(next.emails);
    setNotice(next.notice);
    setDraft('');
  };
  const flaggedEmails = emails.filter((email) => flagged?.has(email));
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 text-sm font-medium md:col-span-2',
        className,
      )}
    >
      <label htmlFor={id}>通知邮箱</label>
      <span className="-mt-1 text-xs font-normal text-muted-foreground">
        可添加多个，余额不足和停机通知会发送到这些邮箱
      </span>
      <div
        className={cn(
          'flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1.5 font-normal focus-within:ring-[3px] focus-within:ring-ring/50',
          error && 'border-err',
        )}
      >
        <ul aria-label="已添加的通知邮箱" className="contents">
          {emails.map((email) => (
            <li
              key={email}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md border border-transparent bg-muted pr-1.5 pl-2.5 text-[13px]',
                flagged?.has(email) && 'border-warn-border bg-warn-soft',
              )}
            >
              {email}
              {flagged?.has(email) ? (
                <span className="text-[11px] text-warn">已停用管理员</span>
              ) : null}
              <button
                type="button"
                aria-label={`移除 ${email}`}
                onClick={() =>
                  onChange(emails.filter((item) => item !== email))
                }
                className="text-[11px] text-muted-foreground"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <input
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
          className="h-8 min-w-[180px] flex-1 bg-transparent px-1.5 text-base outline-none placeholder:text-[13px] placeholder:text-muted-foreground md:text-sm"
        />
      </div>
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
