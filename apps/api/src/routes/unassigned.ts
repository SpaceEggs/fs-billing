import {
  assignUnassigned,
  ignoreUnassigned,
  listUnassigned,
  previewAssignment,
  readUnassignedGroups,
  readUnassignedSummary,
  unignoreUnassigned,
  type PoolDb,
} from '@fs-billing/db';
import {
  adminUnassignedApiContract,
  adminUnassignedListQuerySchema,
} from '@fs-billing/shared';
import type { RouteHandlers } from './register.js';
import { mapBusinessErrors } from './business-errors.js';
import { adminActor } from './admin/tenants.js';

const requests = adminUnassignedApiContract;
const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function unassignedHandlers(
  db: PoolDb,
): Pick<
  RouteHandlers,
  | 'adminUnassignedSummary'
  | 'adminUnassignedGroups'
  | 'adminUnassignedList'
  | 'adminUnassignedAssignPreview'
  | 'adminUnassignedAssign'
  | 'adminUnassignedIgnore'
  | 'adminUnassignedUnignore'
> {
  return {
    adminUnassignedSummary: () => readUnassignedSummary(db),
    adminUnassignedGroups: () => readUnassignedGroups(db),
    adminUnassignedList: async (_context, request) => {
      const query = adminUnassignedListQuerySchema.parse(request.query);
      const list = await listUnassigned(db, query);
      return {
        status: list.status,
        items: list.items,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: list.total,
        },
      };
    },
    adminUnassignedAssignPreview: async (_context, request) => {
      const body = requests.adminUnassignedAssignPreview.request.body.parse(
        request.body,
      );
      const preview = await mapBusinessErrors(() =>
        previewAssignment(db, body),
      );
      return {
        ...preview,
        noRate: {
          ...preview.noRate,
          groups: preview.noRate.groups.map((group) => ({
            ...group,
            firstEffectiveFrom: iso(group.firstEffectiveFrom),
            samples: group.samples.map((sample) => ({
              ...sample,
              answeredAt: sample.answeredAt.toISOString(),
            })),
          })),
        },
      };
    },
    adminUnassignedAssign: async (context, request) => {
      const body = requests.adminUnassignedAssign.request.body.parse(
        request.body,
      );
      const result = await mapBusinessErrors(() =>
        assignUnassigned(db, { ...body, actor: adminActor(context) }),
      );
      return result;
    },
    adminUnassignedIgnore: (context, request) => {
      const body = requests.adminUnassignedIgnore.request.body.parse(
        request.body,
      );
      return mapBusinessErrors(() =>
        ignoreUnassigned(db, { ...body, actor: adminActor(context) }),
      );
    },
    adminUnassignedUnignore: (context, request) => {
      const body = requests.adminUnassignedUnignore.request.body.parse(
        request.body,
      );
      return mapBusinessErrors(() =>
        unignoreUnassigned(db, { ...body, actor: adminActor(context) }),
      );
    },
  };
}
