import type { zh } from '../zh/index.js';
import type { DeepSameShape } from '../types.js';
import { admin } from './admin.js';
import { auth } from './auth.js';
import { cdr } from './cdr.js';
import { common } from './common.js';
import { csv } from './csv.js';
import { enums } from './enums.js';
import { errors } from './errors.js';
import { format } from './format.js';
import { portal } from './portal.js';
import { rates } from './rates.js';
import { shell } from './shell.js';
import { statement } from './statement.js';
import { tenant } from './tenant.js';

const enCatalog = {
  common,
  auth,
  errors,
  enums,
  csv,
  format,
  portal,
  statement,
  shell,
  cdr,
  admin,
  rates,
  tenant,
} as const;

export const en: DeepSameShape<typeof zh, typeof enCatalog> = enCatalog;
