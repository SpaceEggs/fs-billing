import { useId } from 'react';
import type { AdminCdr } from '@fs-billing/shared';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { Alert } from '../ui/alert';
import { cn } from '../../lib/utils';
import type { CdrDetailExtra } from '../cdr/cdr-detail';
import type { CdrFilterExtra } from '../cdr/cdr-filters';
import { formatCount } from '../cdr/cdr-format';
import { StatusTag } from '../status-tag';

/**
 * 后台话单里与「未经验证」有关的全部界面（决定 17：门户组件不引用这里）。
 * 未经验证是计费系统授权超时期间由 FreeSWITCH 放行的通话，已按费率补记计费，客户看不到。
 */

function UnverifiedOnly({
  checked,
  onChange,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  className: string;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-lg border text-sm select-none has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring',
        checked ? 'border-primary bg-brand-soft' : 'border-input',
        className,
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      仅看未经验证
    </label>
  );
}

/** 筛选里的「仅看未经验证」：电脑端排在接通状态之后，手机端放进筛选面板。 */
export function unverifiedFilter(
  unverifiedOnly: boolean,
  onChange: (unverifiedOnly: boolean) => void,
): CdrFilterExtra {
  return {
    active: unverifiedOnly,
    desktop: (
      <UnverifiedOnly
        checked={unverifiedOnly}
        onChange={onChange}
        className="h-9 px-3"
      />
    ),
    sheet: (
      <UnverifiedOnly
        checked={unverifiedOnly}
        onChange={onChange}
        className="h-11 px-3 text-[15px]"
      />
    ),
  };
}

export function UnverifiedBadge({ cdr }: { cdr: AdminCdr }) {
  return cdr.unverified ? <StatusTag status="unverified" /> : null;
}

/**
 * 「仅看未经验证」时列表上方的说明（设计稿第三批 1c、3c）。设计稿里的故障开始时间、关联告警和
 * 「查看告警」链接依赖阶段 9 的告警，按决定 32 不显示。
 */
export function UnverifiedBanner({ total }: { total: number }) {
  return (
    <Alert variant="unverified" className="px-3.5">
      <p className="m-0 hidden md:block">
        <span className="font-semibold text-unv">未经验证：</span>
        以下话单发生在计费系统授权超时期间，由 FreeSWITCH 放行，最长 30
        分钟，已按费率正常计费。
      </p>
      <p className="m-0 md:hidden">
        <span className="font-semibold text-unv">
          仅看未经验证 · {formatCount(total)} 条
        </span>
        <br />
        授权超时期间由 FreeSWITCH 放行，最长 30 分钟。
      </p>
    </Alert>
  );
}

/** 汇总栏里通话数后的注释：全部为未经验证，或「其中未经验证 N 条」。 */
export function unverifiedSummaryNote(unverifiedCalls: number, total: number) {
  if (unverifiedCalls === 0) return null;
  return unverifiedCalls === total
    ? '全部为未经验证'
    : `其中未经验证 ${formatCount(unverifiedCalls)} 条`;
}

/** 详情里的验证状态与说明（设计稿第三批 2a、3l）；已验证的话单不加内容。 */
export function unverifiedDetail(cdr: AdminCdr): CdrDetailExtra {
  if (!cdr.unverified) return { rows: [], note: null };
  return {
    rows: [
      {
        label: '验证状态',
        value: <Badge variant="unverified">计费系统授权超时</Badge>,
      },
    ],
    note: (
      <Alert variant="unverified" className="px-3.5">
        <span className="font-semibold">未经验证</span>
        <span>
          计费系统故障期间由 FreeSWITCH 放行，最长 30
          分钟。通话结束后已按费率补记计费，此标签仅管理后台可见。
        </span>
      </Alert>
    ),
  };
}
