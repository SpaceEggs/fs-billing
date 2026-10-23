export {
  ASSIGN_MAX_ROWS,
  ASSIGNABLE_REASONS,
  UnassignedError,
  selectionDigest,
  selectionTag,
  type UnassignedErrorCode,
  type UnassignedSelection,
} from './types.js';
export {
  classifyRows,
  reasonLabel,
  type Classification,
  type NoRateReason,
} from './classify.js';
export {
  describeAffectedMonths,
  loadAssignmentTarget,
  previewAssignment,
  type AffectedMonth,
  type AffectedMonthState,
  type AssignmentPreview,
  type AssignmentTarget,
  type NoRateGroup,
} from './preview.js';
export {
  assignUnassigned,
  type AssignInput,
  type AssignResult,
} from './assign.js';
export {
  ignoreUnassigned,
  unignoreUnassigned,
  type IgnoreResult,
} from './ignore.js';
