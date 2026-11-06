import type { zh } from '../zh/index.js';
import type { DeepSameShape } from '../types.js';
import { auth } from './auth.js';
import { common } from './common.js';
import { csv } from './csv.js';
import { enums } from './enums.js';
import { errors } from './errors.js';

const enCatalog = { common, auth, errors, enums, csv } as const;

export const en: DeepSameShape<typeof zh, typeof enCatalog> = enCatalog;
