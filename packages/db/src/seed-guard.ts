/** `db:seed` 的拒绝原因：消息里没有输入，可以原样给操作者看。 */
export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefused';
  }
}

/**
 * `db:seed` 的生产保护（阶段 10 G2）。种子里是演示租户、充值与系统告警，账本只增不改，
 * 在生产库误跑一次就清不掉，所以：
 * - `NODE_ENV=production` 一律拒绝，owner 命令行没设 NODE_ENV 时也挡不住，见下一条；
 * - 库里已有租户时拒绝，必须显式加 `--force` 才允许重复播种。
 */
export function assertSeedAllowed(input: {
  nodeEnv: string | undefined;
  hasData: boolean;
  force: boolean;
}): void {
  if (input.nodeEnv === 'production')
    throw new SeedRefused('生产环境禁止写入演示种子数据');
  if (input.hasData && !input.force)
    throw new SeedRefused(
      '数据库已有数据，拒绝写入演示种子数据；确认要重复播种请加 --force',
    );
}
