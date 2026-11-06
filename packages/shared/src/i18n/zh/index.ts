import { auth } from './auth.js';
import { common } from './common.js';
import { errors } from './errors.js';

export const zh = { common, auth, errors } as const;
