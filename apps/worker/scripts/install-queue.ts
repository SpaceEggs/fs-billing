import { connect, databaseEnvironmentSchema } from '@fs-billing/db';
import { installQueue } from '../src/queue.js';

const env = databaseEnvironmentSchema.parse(process.env);
const owner = connect(env.DATABASE_URL);
try {
  await installQueue(owner);
  console.info('扣费队列安装完成');
} finally {
  await owner.pool.end();
}
