import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Currency } from '@fs-billing/shared';
import { XIcon } from 'lucide-react';
import { Label } from '../ui/label';
import { addRecipients } from '../../lib/tenant-create';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '../ui/input-group';

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
  const { t } = useTranslation(['admin']);
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
            <span className="font-normal text-muted-foreground">
              {t('admin:field.optional')}
            </span>
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
    <InputGroup
      className={cn('font-normal max-md:h-11', error && 'border-err')}
    >
      <InputGroupAddon>
        <InputGroupText>{currencySymbol[currency]}</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        {...aria}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder ?? ''}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn('text-right tabular-nums', className)}
      />
    </InputGroup>
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
  label,
  helper,
  emptyNote,
}: {
  emails: string[];
  error: string | undefined;
  onChange: (emails: string[]) => void;
  flagged?: ReadonlySet<string>;
  stacked?: boolean;
  className?: string;
  label?: string;
  helper?: string;
  emptyNote?: string;
}) {
  const { t } = useTranslation(['admin']);
  const shownLabel = label ?? t('admin:recipients.label');
  const shownHelper = helper ?? t('admin:recipients.helper');
  const shownEmptyNote = emptyNote ?? t('admin:recipients.emptyNote');
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
          <span className="ml-1.5 text-[11px] text-warn">
            {t('admin:recipients.flagged')}
          </span>
        ) : null}
      </span>
      <Button
        variant="ghost"
        size="inline"
        aria-label={t('admin:recipients.remove', { email })}
        onClick={() => onChange(emails.filter((item) => item !== email))}
        className={cn(
          'shrink-0 text-muted-foreground hover:bg-transparent',
          stacked && 'size-10 md:size-auto',
        )}
      >
        <XIcon aria-hidden className="size-3" />
      </Button>
    </li>
  ));
  const input = (layout: string) => (
    <Input
      ref={inputRef}
      id={id}
      type="email"
      autoComplete="off"
      aria-invalid={error ? true : undefined}
      aria-describedby={`${id}-messages`}
      placeholder={t('admin:recipients.placeholder')}
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
      className={layout}
    />
  );
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 text-sm font-medium md:col-span-2',
        className,
      )}
    >
      <Label htmlFor={id}>{shownLabel}</Label>
      <span className="-mt-1 text-xs font-normal text-muted-foreground">
        {shownHelper}
      </span>
      {stacked ? (
        <>
          {emails.length ? (
            <ul
              aria-label={t('admin:recipients.listLabel', {
                label: shownLabel,
              })}
              className="m-0 flex list-none flex-col gap-2 p-0 font-normal md:flex-row md:flex-wrap"
            >
              {chipItems}
            </ul>
          ) : null}
          <Button
            variant="outline"
            onClick={() => setAdding(true)}
            className={cn(
              'h-11 border-dashed text-[15px] font-normal text-primary md:hidden',
              inputShown && 'hidden',
            )}
          >
            {t('admin:recipients.addMobile')}
          </Button>
          <div
            className={cn(
              'gap-2 font-normal md:flex',
              inputShown ? 'flex' : 'hidden',
            )}
          >
            {input(cn('flex-1', error && 'border-err'))}
            <Button
              type="button"
              variant="outline"
              className="h-11 md:h-9"
              onClick={commit}
            >
              {t('admin:recipients.add')}
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
          <ul
            aria-label={t('admin:recipients.listLabel', {
              label: shownLabel,
            })}
            className="contents"
          >
            {chipItems}
          </ul>
          {input(
            'h-8 max-md:h-8 w-auto min-w-[180px] flex-1 border-0 bg-transparent px-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent',
          )}
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
            {shownEmptyNote}
          </span>
        ) : null}
        {flaggedEmails.map((email) => (
          <span
            key={email}
            role="status"
            className="text-xs font-normal text-warn"
          >
            {t('admin:recipients.flaggedNote', { email })}
          </span>
        ))}
      </div>
    </div>
  );
}
