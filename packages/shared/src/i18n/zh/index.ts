import { auth } from './auth.js';
import { common } from './common.js';
import { csv } from './csv.js';
import { enums } from './enums.js';
import { errors } from './errors.js';
import { format } from './format.js';
import { portal } from './portal.js';
import { statement } from './statement.js';

export const zh = {
  common,
  auth,
  errors,
  enums,
  csv,
  format,
  portal,
  statement,
} as const;
