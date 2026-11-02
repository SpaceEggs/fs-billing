import { databaseEnvironmentSchema } from '../client.js';
import { migrateDatabase } from '../migrate.js';

await migrateDatabase(databaseEnvironmentSchema.parse(process.env));
process.stdout.write('迁移完成\n');
