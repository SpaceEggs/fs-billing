import { auth } from './auth.js';
import { common } from './common.js';
import { csv } from './csv.js';
import { enums } from './enums.js';
import { errors } from './errors.js';

export const zh = { common, auth, errors, enums, csv } as const;
