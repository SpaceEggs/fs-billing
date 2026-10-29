import type { FastifyBaseLogger } from 'fastify';
import type { PgBoss } from 'pg-boss';
import {
  lockUnassignedAlerts,
  previewDigestTopTenants,
  purgeEmailOutbox,
  queueAlertNotices,
  recoverClearedUnassignedAlerts,
  recoverPaidChargeReconcileAlerts,
  recoverQuietAlerts,
  recoverStaleRecipientAlerts,
  withSystem,
  type PoolDb,
  type QueueAlertNoticesResult,
  type Tx,
} from '@fs-billing/db';
import type { MailSettings } from './config.js';
import {
  createMailTransport,
  dispatchOutbox,
  type DispatchSummary,
  type MailTransport,
} from './mail.js';
import { NOTIFY_QUEUE } from './queue.js';

type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export const NOTIFY_CRON = '* * * * *';
export const NOTIFY_TIMEZONE = 'Asia/Shanghai';

export interface NotifyTickOptions {
  /** 邮件配置；SMTP_HOST 未设置时为 undefined：告警恢复与发件箱入队照常，只是不分发。 */
  readonly mail: MailSettings | undefined;
  /** 事件型告警的静默恢复窗口（分钟），ALERT_QUIET_MINUTES。 */
  readonly quietMinutes: number;
  readonly now?: () => Date;
  readonly logger?: Logger | undefined;
  /** 测试注入；默认按 mail 配置建 SMTP 传输。 */
  readonly createTransport?: (settings: MailSettings) => MailTransport;
  /** Worker 的停止信号，传给分发。 */
  readonly signal?: AbortSignal | undefined;
}

/**
 * notify-tick 的第 1–4 步，**一个事务内按序**（阶段 9 设计「notify-tick」）：
 *
 * 0. （事务之前）受影响租户：到期汇总的 `auth_timeout` 告警的前 5 个租户编码，在加锁之前用独立的只读事务算好，
 *    带语句超时，失败降级为空列表（{@link previewDigestTopTenants}）。
 * 1. 恢复：未归属 / 校验失败键对应的待处理行清零（全量扫描兜底）→ 对账告警的流水已补记 → 事件型告警静默窗口
 *    （`ALERT_QUIET_MINUTES`）→ `recipient:*` 告警 7 天窗口。
 * 2. 开始：新开的、要发邮件的告警合并为一封 `alert_start`。
 * 3. 汇总：到期且有新增事件的告警合并为一封 `alert_digest`。
 * 4. 恢复通知：已发过开始邮件的刚恢复的告警合并为一封 `alert_recovered`。
 * 5. 邮件入发件箱、告警上的通知列更新，与上面的恢复在同一事务提交，所以每个状态变化恰好产生一封邮件。
 *
 * **加锁。** 未归属族的互斥锁（`lock_alert_family()`）是事务里第一个动作，且在任何保存点之外取：入库路径的顺序是
 * 「未归属族 → fs-authorize」，静默窗口恢复会改 `fs-authorize` 那一行，先改行再拿锁会和入库事务成环；
 * 咨询锁若是在保存点里取的，保存点回滚时会被释放，所以不放在保存点里。
 * **tick 不为告警行等锁。** 三条认领查询和三个多行恢复都是 `FOR UPDATE SKIP LOCKED`（按 id 顺序）：被别的事务锁着的行
 * 这一分钟跳过、下一分钟再处理。别的写入路径逐行加锁的顺序各不相同（账单核对按开始时间锁 `statement:*`，对账告警
 * 按通话逐条），tick 如果等锁，就可能与它们成环；不等锁则永远不会成为环的一部分，也不必去改那些路径的加锁顺序。
 *
 * **一个步骤失败不拖住别的。** 恢复的每一步各在一个保存点里（`tx.transaction`）：失败只回滚这一步并记日志，
 * 其余照常；认领与入队（第 2–4 步）合为一个保存点，失败则这一轮的认领整体回滚（不会出现状态前进而没有邮件），
 * 恢复仍然提交，错误在提交之后抛出，让任务可见地失败。这样某个步骤的持续性错误既不会让告警永远恢复不了，
 * 也不会让开始邮件每分钟重试同一个失败。
 *
 * 所有查询都带注入的时钟，不读数据库 now()，所以验收 4 的 20 分钟场景可以在毫秒内跑完。
 * 不在事务里发邮件：分发（SMTP）是之后的独立步骤，每封各自一个事务。
 */
export async function queueNotifications(
  db: PoolDb,
  options: Pick<NotifyTickOptions, 'quietMinutes' | 'now' | 'logger'>,
): Promise<QueueAlertNoticesResult> {
  const clock = options.now ?? (() => new Date());
  const logger = options.logger;
  const at = clock();
  // 辅助信息：算不出来（超时、出错）就降级为没有租户编码，汇总照发。
  const topTenants = await previewDigestTopTenants(db, at).catch(
    (error: unknown) => {
      logger?.warn(
        { err: error },
        '汇总的受影响租户统计失败，本轮汇总不带租户编码',
      );
      return undefined;
    },
  );
  const outcome = await withSystem(db, async (tx) => {
    await lockUnassignedAlerts(tx);
    const step = async (name: string, run: (sp: Tx) => Promise<unknown>) => {
      try {
        await tx.transaction((sp) => run(sp));
      } catch (error) {
        logger?.error(
          { err: error, step: name },
          `告警恢复步骤失败，跳过：${name}`,
        );
      }
    };
    await step('未归属告警兜底恢复', (sp) =>
      recoverClearedUnassignedAlerts(sp, undefined, at),
    );
    await step('对账告警补记流水恢复', (sp) =>
      recoverPaidChargeReconcileAlerts(sp, at, { skipLocked: true }),
    );
    await step('事件型告警静默窗口恢复', (sp) =>
      recoverQuietAlerts(sp, {
        quietMinutes: options.quietMinutes,
        at,
        skipLocked: true,
      }),
    );
    await step('收件人告警 7 天窗口恢复', (sp) =>
      recoverStaleRecipientAlerts(sp, { at, skipLocked: true }),
    );
    try {
      const notices = await tx.transaction((sp) =>
        queueAlertNotices(sp, { at, topTenants }),
      );
      return { notices };
    } catch (error) {
      return { error };
    }
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.notices;
}

/**
 * 每分钟一次的 Worker 任务（阶段 9 设计：定时任务只有一个）：{@link queueNotifications} 的事务，
 * 然后分发发件箱（认领、租约、停止信号都在 `dispatchOutbox`）。`SMTP_HOST` 未设置时事务照常运行（邮件入发件箱），
 * 只是不分发，返回 undefined。
 */
export async function runNotifyTick(
  db: PoolDb,
  options: NotifyTickOptions,
): Promise<DispatchSummary | undefined> {
  const clock = options.now ?? (() => new Date());
  // 事务失败（已整体回滚，下一分钟重来）不应拖住发件箱里别的邮件（余额提醒）：先记下错误，照常分发，最后再抛出，
  // 让这次任务在 pg-boss 里可见地失败。
  let failure: { error: unknown } | undefined;
  try {
    const notices = await queueNotifications(db, options);
    if (notices.emails.length > 0)
      options.logger?.info(
        {
          started: notices.started,
          digested: notices.digested,
          recovered: notices.recovered,
          emails: notices.emails.map((email) => email.template),
        },
        '告警通知已入发件箱',
      );
  } catch (error) {
    failure = { error };
    options.logger?.error(
      { err: error },
      '告警恢复与通知入队失败，仍分发发件箱',
    );
  }
  let summary: DispatchSummary | undefined;
  if (options.mail) {
    const transport = (options.createTransport ?? createMailTransport)(
      options.mail,
    );
    try {
      summary = await dispatchOutbox(db, {
        transport,
        settings: options.mail,
        now: clock,
        logger: options.logger,
        signal: options.signal,
      });
    } finally {
      transport.close();
    }
  }
  if (failure) throw failure.error;
  return summary;
}

/** 北京时间的日期，用来每天只清理一次发件箱。 */
const beijingDay = (at: Date) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: NOTIFY_TIMEZONE }).format(at);

export async function startNotifyJobs(
  boss: PgBoss,
  db: PoolDb,
  options: NotifyTickOptions,
) {
  const logger = options.logger;
  let purgedOn = '';
  await boss.work(NOTIFY_QUEUE, async () => {
    try {
      await runNotifyTick(db, options);
      // 发件箱满 180 天的已结束行每天清一次（启动后的第一个 tick 也清一次）。
      const today = beijingDay((options.now ?? (() => new Date()))());
      if (today !== purgedOn) {
        // 清理失败不影响邮件：记日志，明天再试。
        purgedOn = today;
        try {
          const removed = await withSystem(db, purgeEmailOutbox);
          if (removed > 0) logger?.info(`已清理发件箱 ${removed} 行`);
        } catch (error) {
          logger?.error({ err: error }, '清理发件箱失败');
        }
      }
    } catch (error) {
      logger?.error({ err: error }, '邮件任务失败');
      throw error;
    }
  });
  // 错过的分钟没有补发的意义：下一分钟的 tick 会认领所有到期的邮件。
  await boss.schedule(NOTIFY_QUEUE, NOTIFY_CRON, null, { tz: NOTIFY_TIMEZONE });
}
