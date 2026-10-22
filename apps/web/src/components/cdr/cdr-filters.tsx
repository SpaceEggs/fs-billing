import { useId } from 'react';
import type { CdrFilters } from '../../lib/cdr-search';
import type { DayRange } from '../../lib/day-range';
import { latestRangeEnd } from '@fs-billing/shared';
import { DateRangeField } from '../date-range-field';
import { FilterGroup, FilterSheet } from '../filter-sheet';
import { SearchBox } from '../search-box';
import { Segmented } from '../ui/segmented';
import { Select } from '../ui/select';
import { cn } from '../../lib/utils';

const statusOptions = [
  { value: 'answered', label: '已接通' },
  { value: 'all', label: '全部' },
] as const;

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
  const countryId = useId();
  const sheetCountryId = useId();
  const status = filters.status ?? 'answered';
  const country = filters.country ?? '';
  const sheetActive =
    (filters.country ? 1 : 0) +
    (status === 'all' ? 1 : 0) +
    (extra?.active ? 1 : 0);
  const anyActive = sheetActive > 0 || Boolean(filters.callee);
  const clearSheet = (): CdrFilters => ({
    country: undefined,
    status: undefined,
    unverifiedOnly: undefined,
  });
  const countryOptions = (
    <>
      <option value="">全部国家</option>
      {filters.country && !countries.includes(filters.country) ? (
        <option value={filters.country}>{filters.country}</option>
      ) : null}
      {countries.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </>
  );
  const dateField = (className: string) => (
    <DateRangeField
      label="日期范围（北京时间）"
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
        label="被叫号码"
        className="min-w-0 flex-1 md:w-[220px] md:flex-none"
      >
        <SearchBox
          label="被叫号码"
          placeholder="搜索被叫号码"
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
        <FilterGroup label="日期范围">
          {() => (
            <>
              {dateField('w-full')}
              <span className="text-xs text-muted-foreground">最长一个月</span>
            </>
          )}
        </FilterGroup>
        <div className="flex flex-col gap-2">
          <label htmlFor={sheetCountryId} className="text-sm font-medium">
            国家
          </label>
          <Select
            id={sheetCountryId}
            value={country}
            onChange={(event) =>
              onFilters({ country: event.target.value || undefined })
            }
            className="w-full"
          >
            {countryOptions}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">接通状态</span>
          <Segmented
            label="接通状态"
            options={statusOptions}
            value={status}
            onChange={(next) =>
              onFilters({ status: next === 'all' ? 'all' : undefined })
            }
            className="w-full self-stretch [&>button]:flex-1"
          />
        </div>
        {extra?.sheet}
      </FilterSheet>
      <div className="hidden md:contents">
        <Field label="日期范围 · 最长一个月">{dateField('w-[260px]')}</Field>
        <Field label="国家">
          <label htmlFor={countryId} className="sr-only">
            国家
          </label>
          <Select
            id={countryId}
            value={country}
            onChange={(event) =>
              onFilters({ country: event.target.value || undefined })
            }
            className="w-[160px]"
          >
            {countryOptions}
          </Select>
        </Field>
        <Field label="接通状态">
          <Segmented
            label="接通状态"
            options={statusOptions}
            value={status}
            onChange={(next) =>
              onFilters({ status: next === 'all' ? 'all' : undefined })
            }
          />
        </Field>
        {extra?.desktop}
        <button
          type="button"
          disabled={!anyActive}
          onClick={() => onFilters({ callee: undefined, ...clearSheet() })}
          className="h-9 rounded-lg px-3 text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50"
        >
          重置
        </button>
        {trailing ? <div className="ml-auto">{trailing}</div> : null}
      </div>
    </div>
  );
}
