import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { translate } from '@fs-billing/shared';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { cn } from '../lib/utils';
import { currentLocale } from '../i18n';
import { Button } from './ui/button';
import { SheetPanel } from './sheet-panel';

/**
 * 手机版「筛选」按钮与底部面板（设计系统 · 手机筛选）：筛选即时写入地址，
 * 「清除筛选」只清面板里的条件，搜索框不受影响。电脑版筛选直接排在列表上方，不渲染这里。
 */
export function FilterSheet({
  activeCount,
  resultLabel,
  onClear,
  children,
}: {
  activeCount: number;
  resultLabel: string;
  onClear: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(['common']);
  const [open, setOpen] = useState(false);
  return (
    <SheetPanel
      side="bottom"
      title={t('filter.title')}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          variant="outline"
          aria-label={
            activeCount
              ? t('filter.active', { n: activeCount })
              : t('filter.title')
          }
          className={cn(
            'h-11 gap-1.5 px-3.5 text-[15px] font-normal md:hidden',
            activeCount && 'border-primary bg-brand-soft hover:bg-brand-soft',
          )}
        >
          {t('filter.title')}
          {activeCount ? (
            <span
              aria-hidden
              className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground"
            >
              {activeCount}
            </span>
          ) : null}
        </Button>
      }
    >
      <div className="flex items-center justify-between">
        <span aria-hidden className="text-[17px] font-semibold">
          {t('filter.title')}
        </span>
        <Button
          variant="ghost"
          size="inline"
          disabled={activeCount === 0}
          onClick={onClear}
          className="h-11 text-[15px] text-muted-foreground hover:bg-transparent"
        >
          {t('action.clearFilters')}
        </Button>
      </div>
      <div className="flex flex-col gap-[18px] pt-2 pb-5">{children}</div>
      <Button size="lg" className="h-12" onClick={() => setOpen(false)}>
        {resultLabel}
      </Button>
    </SheetPanel>
  );
}

/** 面板里的一组条件：可见标题即分组名。 */
export function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: (labelId: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      {children(id)}
    </div>
  );
}

/** 面板里的多选一（如租户状态），三列按钮。 */
export function ChoiceGrid<Value extends string | undefined>({
  labelledBy,
  options,
  value,
  onChange,
}: {
  labelledBy: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      aria-labelledby={labelledBy}
      variant="outline"
      spacing={2}
      value={value ?? 'all'}
      onValueChange={(next) => {
        // 已选中的一项再次点击不取消选择。
        const option = options.find((item) => (item.value ?? 'all') === next);
        if (option) onChange(option.value);
      }}
      className="grid w-full grid-cols-3"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value ?? 'all'}
          value={option.value ?? 'all'}
          className="h-11"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** 面板里的结果按钮文字：结果未到时不显示上一次的数量。英文不带量词。 */
export function resultLabel(
  total: number | undefined,
  unit: string,
  locale = currentLocale(),
) {
  if (total === undefined) return translate(locale, 'common:filter.result');
  return translate(locale, 'common:filter.resultCount', {
    count: total,
    unit: locale === 'en' ? '' : unit,
  });
}
