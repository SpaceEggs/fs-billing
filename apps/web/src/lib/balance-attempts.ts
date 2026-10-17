function newIdempotencyKey() {
  return `web:${crypto.randomUUID()}`;
}

export type BalanceAttempt = {
  owner: string;
  fingerprint: string;
  key: string;
};

/**
 * 结果未知的提交（网络中断、500/503）按指纹各自保留幂等键，多笔可以并存：
 * 重新填写同一内容仍按原键重试，服务端据此去重。确定成功或明确拒绝后只清除对应那一笔，
 * 所以表里只有未决的提交，不需要淘汰。
 * 只属于当前登录的管理员：换人时整表作废，退出、重新登录、会话过期时由 clearBalanceAttempts 清空。
 * 表每次清空或换人都换代；计算指纹期间换了代的提交作废（返回 null），调用方不得提交。
 */
let attempts: { owner: string; unresolved: Map<string, string> } | null = null;
let generation = 0;

export async function beginAttempt(
  owner: string,
  fingerprintOf: () => Promise<string>,
): Promise<BalanceAttempt | null> {
  const startedIn = generation;
  const fingerprint = await fingerprintOf();
  if (generation !== startedIn) return null;
  if (attempts?.owner !== owner) {
    if (attempts) generation += 1;
    attempts = { owner, unresolved: new Map() };
  }
  let key = attempts.unresolved.get(fingerprint);
  if (!key) {
    key = newIdempotencyKey();
    attempts.unresolved.set(fingerprint, key);
  }
  return { owner, fingerprint, key };
}

export function resolveBalanceAttempt(attempt: BalanceAttempt) {
  if (
    attempts?.owner === attempt.owner &&
    attempts.unresolved.get(attempt.fingerprint) === attempt.key
  )
    attempts.unresolved.delete(attempt.fingerprint);
}

export function clearBalanceAttempts() {
  attempts = null;
  generation += 1;
}

/** 当前保留的未决提交（仅指纹与幂等键），供测试检查存储内容。 */
export function unresolvedBalanceAttempts() {
  return attempts
    ? { owner: attempts.owner, entries: [...attempts.unresolved] }
    : null;
}
