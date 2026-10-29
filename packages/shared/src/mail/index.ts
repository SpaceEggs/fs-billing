// 辅助函数（escapeHtml、oneLine、formatDuration 等）留在 templates.ts 内部，不进包的公共出口，免得与其他模块重名。
export {
  ALERT_KIND_LABELS,
  MAIL_TEMPLATES,
  alertDigestParamsSchema,
  alertRecoveredParamsSchema,
  alertStartParamsSchema,
  balanceLowParamsSchema,
  balanceSuspendedParamsSchema,
  mailParamsSchemas,
  renderMail,
  testParamsSchema,
  type MailParams,
  type MailTemplate,
  type RenderContext,
  type RenderedMail,
} from './templates.js';
