import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import type { CdrFilters } from '../../lib/cdr-search';
import type { DayRange } from '../../lib/day-range';
import { latestRangeEnd } from '@fs-billing/shared';
import { DateRangeField } from '../date-range-field';
import { FilterGroup, FilterSheet } from '../filter-sheet';
import { OptionTabs } from '../option-tabs';
import { SearchBox } from '../search-box';
import { NativeSelect, NativeSelectOption } from '../ui/native-select';
import { cn } from '../../lib/utils';

/** 后台在筛选里多出的「仅看未经验证」：电脑端排在状态之后，手机端放在面板里。 */
export type CdrFilterExtra = {
  desktop: React.ReactNode;
  sheet: React.ReactNode;
  active: boolean;
};

/** 电脑端每个控件上方的小标签；手机上控件没有标签。 */
function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span
        aria-hidden
        className="hidden text-xs text-muted-foreground md:block"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * 话单筛选（设计稿 2a、2d、2e）：日期范围、被叫号码、国家、接通状态。
 * 电脑端排成一行，手机端只留搜索框和「筛选」，其余进底部面板。筛选即时写入地址。
 */
export function CdrFilterBar({
  range,
  maxDate,
  filters,
  countries,
  resultLabel,
  extra,
  trailing,
  onRange,
  onFilters,
}: {
  range: DayRange;
  maxDate: string;
  filters: CdrFilters;
  countries: readonly string[];
  /** 手机面板底部按钮的文字，如「查看 13,517 条结果」。 */
  resultLabel: string;
  extra?: CdrFilterExtra | undefined;
  /** 电脑端筛选行最右侧的内容，如后台的「导出 CSV」。 */
  trailing?: React.ReactNode;
  onRange: (range: DayRange) => void;
  onFilters: (patch: CdrFilters) => void;
}) {
  const { t } = useTranslation(['cdr', 'common']);
  const countryId = useId();
  const sheetCountryId = useId();
  const status = filters.status ?? 'answered';
  const country = filters.country ?? '';
  const statusOptions = [
    { value: 'answered', label: t('cdr:filters.statusAnswered') },
    { value: 'all', label: t('cdr:filters.all') },
  ] as const;
  const directionOptions = [
    { value: 'all', label: t('cdr:filters.all') },
    { value: 'inbound', label: t('cdr:direction.inbound') },
    { value: 'outbound', label: t('cdr:direction.outbound') },
  ] as const;
  const sheetActive =
    (filters.country ? 1 : 0) +
    (status === 'all' ? 1 : 0) +
    (filters.direction ? 1 : 0) +
    (extra?.active ? 1 : 0);
  const anyActive = sheetActive > 0 || Boolean(filters.callee);
  const clearSheet = (): CdrFilters => ({
    country: undefined,
    status: undefined,
    direction: undefined,
    unverifiedOnly: undefined,
  });
  const countryOptions = (
    <>
      <NativeSelectOption value="">
        {t('cdr:filters.allCountries')}
      </NativeSelectOption>
      {filters.country && !countries.includes(filters.country) ? (
        <NativeSelectOption value={filters.country}>
          {filters.country}
        </NativeSelectOption>
      ) : null}
      {countries.map((name) => (
        <NativeSelectOption key={name} value={name}>
          {name}
        </NativeSelectOption>
      ))}
    </>
  );
  const dateField = (className: string) => (
    <DateRangeField
      label={t('cdr:filters.dateRangeBeijing')}
      value={range}
      max={maxDate}
      maxRangeEndForStart={latestRangeEnd}
      onChange={onRange}
      className={className}
    />
  );
  return (
    <div className="flex items-end gap-2 md:flex-wrap md:gap-3">
      <Field
        label={t('cdr:filters.callee')}
        className="min-w-0 flex-1 md:w-[220px] md:flex-none"
      >
        <SearchBox
          label={t('cdr:filters.callee')}
          placeholder={t('cdr:filters.calleePlaceholder')}
          value={filters.callee ?? ''}
          onChange={(callee) => onFilters({ callee: callee || undefined })}
          className="w-full"
        />
      </Field>
      <FilterSheet
        activeCount={sheetActive}
        resultLabel={resultLabel}
        onClear={() => onFilters(clearSheet())}
      >
        <FilterGroup label={t('cdr:filters.dateRange')}>
          {() => (
            <>
              {dateField('w-full')}
              <span className="text-xs text-muted-foreground">
                {t('cdr:filters.maxOneMonth')}
              </span>
            </>
          )}
        </FilterGroup>
        <div className="flex flex-col gap-2">
          <Label htmlFor={sheetCountryId} className="text-sm font-medium">
            {t('cdr:filters.country')}
          </Label>
          <NativeSelect
            id={sheetCountryId}
            value={country}
            onChange={(event) =>
              onFilters({ country: event.target.value || undefined })
            }
            containerClassName="w-full"
          >
            {countryOptions}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('cdr:filters.status')}</span>
          <OptionTabs
            label={t('cdr:filters.status')}
            options={statusOptions}
            value={status}
            onChange={(next) =>
              onFilters({ status: next === 'all' ? 'all' : undefined })
            }
            className="w-full"
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            {t('cdr:filters.direction')}
          </span>
          <OptionTabs
            label={t('cdr:filters.direction')}
            options={directionOptions}
            value={filters.direction ?? 'all'}
            onChange={(next) =>
              onFilters({ direction: next === 'all' ? undefined : next })
            }
            className="w-full"
          />
        </div>
        {extra?.sheet}
      </FilterSheet>
      <div className="hidden md:contents">
        <Field label={t('cdr:filters.dateRangeLimited')}>
          {dateField('w-[260px]')}
        </Field>
        <Field label={t('cdr:filters.country')}>
          <Label htmlFor={countryId} className="sr-only">
            {t('cdr:filters.country')}
          </Label>
          <NativeSelect
            id={countryId}
            value={country}
            onChange={(event) =>
              onFilters({ country: event.target.value || undefined })
            }
            containerClassName="w-[160px]"
          >
            {countryOptions}
          </NativeSelect>
        </Field>
        <Field label={t('cdr:filters.status')}>
          <OptionTabs
            label={t('cdr:filters.status')}
            options={statusOptions}
            value={status}
            onChange={(next) =>
              onFilters({ status: next === 'all' ? 'all' : undefined })
            }
          />
        </Field>
        <Field label={t('cdr:filters.direction')}>
          <OptionTabs
            label={t('cdr:filters.direction')}
            options={directionOptions}
            value={filters.direction ?? 'all'}
            onChange={(next) =>
              onFilters({ direction: next === 'all' ? undefined : next })
            }
          />
        </Field>
        {extra?.desktop}
        <Button
          variant="ghost"
          disabled={!anyActive}
          onClick={() => onFilters({ callee: undefined, ...clearSheet() })}
          className="font-normal text-muted-foreground hover:bg-transparent"
        >
          {t('common:action.reset')}
        </Button>
        {trailing ? <div className="ml-auto">{trailing}</div> : null}
      </div>
    </div>
  );
}
