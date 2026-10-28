import { describe, expect, it } from 'vitest';
import { scratchDatabase } from '../test/scratch.js';
import { listUnassigned, readUnassignedSummary } from './unassigned/index.js';

/** 列表接口把时刻格式化成带微秒的 UTC。 */
function stamp(instant: string) {
  return instant.replace('.000Z', '.000000Z');
}

describe('mockup empty-tag and ignored seed (phase 8 decision 47)', () => {
  const seeded = scratchDatabase({ seed: true });

  it('lists 338 pending calls and 5 ignored calls on a fresh database', async () => {
    const db = seeded.app.db;
    expect(await readUnassignedSummary(db)).toEqual({
      pending: 338,
      ignored: 5,
    });

    const abc01 = await listUnassigned(db, {
      status: 'pending',
      tag: 'ABC01',
      page: 1,
      pageSize: 1,
    });
    expect(abc01.total).toBe(326);

    const empty = await listUnassigned(db, {
      status: 'pending',
      tag: '',
      page: 1,
      pageSize: 50,
    });
    expect(empty.total).toBe(12);
    expect(empty.items.every((row) => row.assignable)).toBe(true);
    expect(
      empty.items.map((row) => ({
        caller: row.caller,
        callee: row.callee,
        seconds: row.durationSeconds,
        reason: row.reason,
        time: row.time,
      })),
    ).toEqual([
      call('8613710023757', 311, '2026-09-29T05:45:10.000Z'),
      call('8613710245489', 27, '2026-09-29T05:27:24.000Z'),
      call('8613710467221', 343, '2026-09-29T05:09:46.000Z'),
      call('8613710688953', 59, '2026-09-29T04:51:59.000Z'),
      call('8613710910685', 375, '2026-09-29T04:34:20.000Z'),
      call('8613711132417', 91, '2026-09-29T04:16:32.000Z'),
      call('8613711354149', 407, '2026-09-29T03:58:52.000Z'),
      call('8613711575881', 123, '2026-09-29T03:41:03.000Z'),
      call('8613711797613', 439, '2026-09-29T03:23:22.000Z'),
      call('8613712019345', 155, '2026-09-29T03:05:32.000Z'),
      call('8613712241077', 471, '2026-09-29T02:47:50.000Z'),
      call('8613712462809', 187, '2026-09-29T02:30:16.000Z'),
    ]);

    const admins = await seeded.owner.pool.query<{ id: string; name: string }>(
      `select id, name from admins where name in ('王敏', '李俊')`,
    );
    const adminId = (name: string) => {
      const found = admins.rows.find((row) => row.name === name);
      if (!found) throw new Error(`种子管理员不存在：${name}`);
      return found.id;
    };
    const ignored = await listUnassigned(db, {
      status: 'ignored',
      page: 1,
      pageSize: 50,
    });
    expect(ignored.total).toBe(5);
    expect(
      ignored.items.map((row) => ({
        tag: row.tag,
        caller: row.caller,
        callee: row.callee,
        seconds: row.durationSeconds,
        reason: row.reason,
        assignable: row.assignable,
        time: row.time,
        ignoreReason: row.ignore?.reason,
        operator: row.ignore?.by,
        ignoredAt: row.ignore?.at,
      })),
    ).toEqual([
      ignoredCall({
        tag: 'TEST',
        caller: '075500000001',
        callee: '8613800000001',
        seconds: 12,
        reason: '租户不存在',
        time: '2026-09-28T09:42:10.000Z',
        ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
        operator: { id: adminId('王敏'), name: '王敏' },
        ignoredAt: '2026-09-28T10:05:00.000Z',
      }),
      ignoredCall({
        tag: 'TEST',
        caller: '075500000001',
        callee: '8613800000001',
        seconds: 9,
        reason: '租户不存在',
        time: '2026-09-28T09:40:51.000Z',
        ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
        operator: { id: adminId('王敏'), name: '王敏' },
        ignoredAt: '2026-09-28T10:05:00.000Z',
      }),
      ignoredCall({
        tag: 'TEST',
        caller: '075500000001',
        callee: '8613800000002',
        seconds: 31,
        reason: '租户不存在',
        time: '2026-09-28T09:39:33.000Z',
        ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
        operator: { id: adminId('王敏'), name: '王敏' },
        ignoredAt: '2026-09-28T10:05:00.000Z',
      }),
      ignoredCall({
        tag: '',
        caller: '02088776600',
        callee: '8613500135000',
        seconds: 64,
        reason: '缺少租户标签',
        time: '2026-09-26T02:15:08.000Z',
        ignoreReason: '内部线路，运维排障拨测',
        operator: { id: adminId('李俊'), name: '李俊' },
        ignoredAt: '2026-09-26T03:30:00.000Z',
      }),
      ignoredCall({
        tag: '',
        caller: '02088776600',
        callee: '8613500135000',
        seconds: 58,
        reason: '缺少租户标签',
        time: '2026-09-26T02:12:47.000Z',
        ignoreReason: '内部线路，运维排障拨测',
        operator: { id: adminId('李俊'), name: '李俊' },
        ignoredAt: '2026-09-26T03:30:00.000Z',
      }),
    ]);
  });
});

function call(digits: string, seconds: number, time: string) {
  return {
    caller: '02088776655',
    callee: `+${digits}`,
    seconds,
    reason: '缺少租户标签',
    time: stamp(time),
  };
}

function ignoredCall(input: {
  tag: string;
  caller: string;
  callee: string;
  seconds: number;
  reason: string;
  time: string;
  ignoreReason: string;
  operator: { id: string; name: string };
  ignoredAt: string;
}) {
  return {
    tag: input.tag,
    caller: input.caller,
    callee: `+${input.callee}`,
    seconds: input.seconds,
    reason: input.reason,
    assignable: true,
    time: stamp(input.time),
    ignoreReason: input.ignoreReason,
    operator: input.operator,
    ignoredAt: stamp(input.ignoredAt),
  };
}
