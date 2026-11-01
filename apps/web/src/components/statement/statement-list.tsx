import { Card } from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { useRouter } from '@tanstack/react-router';
import type { Currency } from '@fs-billing/shared';
import {
  minutesCount,
  statementMonthTitle,
  type StatementFigures,
  type StatementState,
} from '../../lib/statement';
import { cn } from '../../lib/utils';
import { Money } from '../data-format';
import { StatementStateTag } from './state-tag';

/** 站内链接：普通点击走路由，修饰键与中键保留浏览器默认（新标签页打开）。 */
function InternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        router.history.push(href);
      }}
    >
      {children}
    </a>
  );
}

export type StatementListRow = {
  month: string;
  state: StatementState;
  figures: StatementFigures;
};

/**
 * 月账单列表（设计稿 1a 至 1c）：电脑 ≥1280px 全部列，1024 左右只留期初、通话扣费、期末，
 * 手机用卡片。门户点整行进入详情；后台租户详情的账单标签页用 `renderAction` 在末尾加一列操作，
 * 不传 `hrefFor` 时行不可点击。
 */
export function StatementList<Row extends StatementListRow>({
  currency,
  rows,
  hrefFor,
  actionLabel = '操作',
  renderAction,
  renderMonthNote,
  renderMonthTag,
  renderCard,
  minutesUnit = false,
}: {
  currency: Currency;
  rows: readonly Row[];
  hrefFor?: (row: Row) => string;
  actionLabel?: string;
  /** 行末操作；`layout` 区分电脑表格与手机卡片（卡片里放在底部一行）。 */
  renderAction?: (row: Row, layout: 'table' | 'card') => React.ReactNode;
  /** 月份旁与月份下方的附加标签与备注（如后台的「话单已删除」「账单已过期」）。 */
  renderMonthNote?: (row: Row, layout: 'table' | 'card') => React.ReactNode;
  /** 电脑表格里月份同一行、状态标签之后的标签（后台的「话单已删除」，稿 1g）。 */
  renderMonthTag?: (row: Row) => React.ReactNode;
  /** 整张手机卡片：后台租户详情的账单标签页用稿 3f 的紧凑卡片；门户不传，用默认卡片。 */
  renderCard?: (row: Row) => React.ReactNode;
  /** 通话分钟数列带「分钟」（后台稿 1f）；门户稿的列表不带。 */
  minutesUnit?: boolean;
}) {
  const router = useRouter();
  const money = (amount: string) => ({ currency, amount });
  return (
    <>
      <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
        <Table className="whitespace-nowrap">
          <TableHeader>
            <TableRow className="border-t-0">
              <TableHead className="px-4">月份</TableHead>
              <TableHead className="text-right">期初余额</TableHead>
              <TableHead className="hidden text-right xl:table-cell">
                充值
              </TableHead>
              <TableHead className="hidden text-right xl:table-cell">
                赠送
              </TableHead>
              <TableHead className="hidden text-right xl:table-cell">
                调账
              </TableHead>
              <TableHead className="text-right">通话扣费</TableHead>
              <TableHead className="text-right">期末余额</TableHead>
              <TableHead className="hidden text-right xl:table-cell">
                通话分钟数
              </TableHead>
              {renderAction ? (
                <TableHead className="px-4 text-right">{actionLabel}</TableHead>
              ) : null}
              {hrefFor ? (
                <TableHead className="font-bold text-center w-10 px-4">
                  <span className="sr-only">查看详情</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody className="tabular-nums">
            {rows.map((row) => {
              const href = hrefFor?.(row);
              return (
                <TableRow
                  key={row.month}
                  onClick={
                    href
                      ? (event) => {
                          // 行内的链接与按钮自己处理点击。
                          if (
                            event.defaultPrevented ||
                            (event.target as HTMLElement).closest('a,button')
                          )
                            return;
                          router.history.push(href);
                        }
                      : undefined
                  }
                  className={cn(href && 'cursor-pointer hover:bg-row-hover')}
                >
                  <TableCell className="px-4 py-3.5">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        {href ? (
                          <InternalLink
                            href={href}
                            className="text-sm font-medium no-underline outline-none focus-visible:underline"
                          >
                            {statementMonthTitle(row.month)}
                          </InternalLink>
                        ) : (
                          <span className="text-sm font-medium">
                            {statementMonthTitle(row.month)}
                          </span>
                        )}
                        <StatementStateTag state={row.state} />
                        {renderMonthTag?.(row)}
                      </div>
                      {renderMonthNote?.(row, 'table')}
                    </div>
                  </TableCell>
                  <TableCell className="py-3.5 text-right">
                    <Money value={money(row.figures.openingBalance)} />
                  </TableCell>
                  <TableCell className="hidden py-3.5 text-right xl:table-cell">
                    <Money value={money(row.figures.recharge)} tone="plain" />
                  </TableCell>
                  <TableCell className="hidden py-3.5 text-right xl:table-cell">
                    <Money value={money(row.figures.gift)} tone="plain" />
                  </TableCell>
                  <TableCell className="hidden py-3.5 text-right xl:table-cell">
                    <Money value={money(row.figures.adjustment)} />
                  </TableCell>
                  <TableCell className="py-3.5 text-right">
                    <Money
                      value={money(row.figures.callCharges)}
                      tone="plain"
                    />
                  </TableCell>
                  <TableCell className="py-3.5 text-right font-semibold">
                    <Money value={money(row.figures.closingBalance)} />
                  </TableCell>
                  <TableCell className="hidden py-3.5 text-right xl:table-cell">
                    {minutesCount(row.figures.callMinutes)}
                    {minutesUnit ? '分钟' : ''}
                  </TableCell>
                  {renderAction ? (
                    <TableCell className="px-4 py-3.5 text-right">
                      {renderAction(row, 'table')}
                    </TableCell>
                  ) : null}
                  {hrefFor ? (
                    <TableCell
                      aria-hidden
                      className="px-4 py-3.5 text-right text-muted-foreground"
                    >
                      ›
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0 md:hidden">
        {rows.map((row) => {
          if (renderCard) return <li key={row.month}>{renderCard(row)}</li>;
          const href = hrefFor?.(row);
          const body = (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">
                    {statementMonthTitle(row.month)}
                  </span>
                  <StatementStateTag state={row.state} size="sm" />
                </div>
                {href ? (
                  <span aria-hidden className="text-muted-foreground">
                    ›
                  </span>
                ) : null}
              </div>
              {renderMonthNote?.(row, 'card')}
              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col gap-[3px]">
                  <span className="text-xs text-muted-foreground">期初</span>
                  <span className="text-sm">
                    <Money value={money(row.figures.openingBalance)} />
                  </span>
                </div>
                <div className="flex flex-col gap-[3px]">
                  <span className="text-xs text-muted-foreground">
                    通话扣费
                  </span>
                  <span className="text-sm">
                    <Money
                      value={money(row.figures.callCharges)}
                      tone="plain"
                    />
                  </span>
                </div>
                <div className="flex flex-col items-end gap-[3px]">
                  <span className="text-xs text-muted-foreground">期末</span>
                  <span className="text-[15px] font-semibold">
                    <Money value={money(row.figures.closingBalance)} />
                  </span>
                </div>
              </div>
              {renderAction?.(row, 'card')}
            </>
          );
          const cardClass =
            'flex flex-col gap-3 rounded-xl border border-border p-3.5 tabular-nums';
          return (
            <li key={row.month}>
              {href ? (
                <Card
                  asChild
                  className={cn(
                    'gap-0 bg-transparent py-0 text-inherit shadow-none',
                    cardClass,
                    'no-underline',
                  )}
                >
                  <InternalLink href={href}>{body}</InternalLink>
                </Card>
              ) : (
                <Card
                  className={cn(
                    'gap-0 bg-transparent py-0 text-inherit shadow-none',
                    cardClass,
                  )}
                >
                  {body}
                </Card>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
