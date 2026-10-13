import { databaseEnvironmentSchema } from '../client.js';
import { migrateDatabase } from '../migrate.js';

await migrateDatabase(databaseEnvironmentSchema.parse(process.env));
console.log('迁移完成');
