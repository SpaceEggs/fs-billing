export const admin = {
  tabs: {
    overview: 'Overview',
    ledger: 'Balance history',
    rates: 'Rates',
    cdrs: 'Calls',
    statements: 'Statements',
    settings: 'Settings',
    portal: 'Portal account',
  },
  tenant: {
    fields: {
      overdraftLimit: 'Overdraft limit',
      lowBalanceThreshold: 'Low balance threshold',
    },
    create: {
      codeRequired: 'Enter the tenant code',
      codeChars: 'Only letters and digits are allowed; no spaces or symbols',
      codeTooLong: 'Tenant code must be at most 64 characters',
      nameRequired: 'Enter the tenant name',
      nameTooLong: 'Tenant name must be at most 200 characters',
      contactTooLong: 'Contact must be at most 200 characters',
      phoneTooLong: 'Phone must be at most 100 characters',
      remarkTooLong: 'Remark must be at most 2000 characters',
      portalEmailRequired: 'Enter the sign-in email',
      portalEmailInvalid: 'Email format is invalid',
      passwordLength: 'The initial password must be 8 to 128 characters',
      ratesFileRequired: 'Choose a CSV file to import',
      ratesSourceRequired: 'Choose a tenant whose rate table to copy',
      submitInvalid: 'The submission is invalid. Check it and try again',
      duplicateRecipient: '"{{email}}" is already in the list',
      maxRecipients: 'At most {{max}} notification recipients',
      invalidRecipient: '"{{email}}" is not a valid email address',
    },
  },
  balance: {
    kind: {
      topup: 'Recharge',
      creditTopup: 'Credit recharge',
      gift: 'Gift',
      adjustment: 'Adjustment',
    },
    confirmType: {
      topup: 'Recharge · received',
      creditTopup: 'Credit recharge · receivable',
      gift: 'Gift',
      adjustment: 'Adjustment',
    },
    hint: {
      topup: 'Positive amounts only',
      creditTopup: 'Positive amounts only; recorded as receivable',
      gift: 'Positive amounts only',
      adjustment: 'May be negative (deducts balance), up to 4 decimal places',
    },
    ledgerKind: {
      recharge: 'Recharge',
      creditRecharge: 'Credit recharge',
      gift: 'Gift',
      adjustment: 'Adjustment',
      callCharge: 'Call charges',
    },
    amountRequired: 'Enter an amount',
    adjustmentZero: 'Adjustment amount cannot be 0',
    amountPositive: 'Amount must be greater than 0',
    amountFormat: 'Amount {{message}}',
    adjustmentNoteRequired: 'Adjustments require a note',
    noteTooLong: 'Note must be at most {{max}} characters',
  },
  problem: {
    validation: 'The submission is invalid. Check the highlighted fields',
    csvRows: 'CSV has {{count}} row errors. Fix them and upload again',
    notFoundTitle: 'The content does not exist or has been deleted',
    notFoundBody: 'Refresh and try again',
    rateLimitedTitle: 'Too many requests',
    rateLimitedBody: 'Try again in {{seconds}} seconds',
    forbidden: 'You do not have permission to perform this action',
    blocked: 'This account is temporarily unavailable',
    reauthenticate: 'Your session has expired. Sign in again',
    passwordChange: 'Change your initial or reset password first',
    unavailableTitle: 'Service temporarily unavailable',
    unavailableBody: 'Try again later',
    networkTitle: 'Network interrupted',
    networkBody: 'Check your network and try again',
    refresh: 'Refresh',
  },
  accountDialogs: {
    temporaryLabel: 'Temporary password',
    oneTimeTitle: 'You cannot view this again after closing',
    oneTimeBody:
      'Copy it now and send it to the {{recipient}} through a secure channel. The {{recipient}} must change the password after first signing in. {{logged}}',
    logged: 'This reset has been recorded in the operation log.',
    copiedClose: "I've copied it; close",
    resetAdminTitle: 'Reset the password for {{name}}?',
    resetPortalTitle: 'Reset the portal account password?',
    resetSelfConfirm:
      'A new temporary password will be generated. The current password stops working immediately and all of your sessions will be signed out. Sign in again with the temporary password and change it.',
    resetAdminConfirm:
      'A new temporary password will be generated. The current password stops working immediately and all sessions for {{name}} will be signed out.',
    resetPortalConfirm:
      "A new temporary password will be generated. The current password stops working immediately and all sessions on the customer's devices will be signed out.",
    resetDoneAdmin: 'Temporary password generated for {{name}}',
    resetDonePortal: 'Temporary password generated',
    resetEffectAdmin:
      '{{email}} · The current password no longer works and all sessions for {{name}} have been signed out',
    resetEffectPortal:
      "{{email}} · The current password no longer works and all sessions on the customer's devices have been signed out",
    resetOnlyOnce:
      'The temporary password is shown only once. The {{recipient}} must change it after signing in. The reset is recorded in the operation log.',
    resetNetwork:
      'Cannot confirm whether the reset succeeded; the current password may already be invalid. Reset again to generate a new temporary password.',
    adminRecipient: 'recipient',
    portalRecipient: 'customer',
    cancel: 'Cancel',
    resetting: 'Resetting…',
    resetPassword: 'Reset password',
    cannotDisable: 'Cannot disable',
    known: 'Got it',
    refusalLastAdmin:
      'The system must keep at least one enabled administrator. Add or enable another administrator first.',
    refusalSelfDisable:
      'You cannot disable your own account. Ask another administrator to do it.',
    status: {
      admin: {
        disable: {
          title: 'Disable administrator {{name}}?',
          body: 'After disabling, {{name}} is signed out immediately and cannot sign in to the admin console again. Previous operation records are kept, and the account can be enabled again at any time. Disabling is recorded in the operation log.',
          confirm: 'Disable',
        },
        enable: {
          title: 'Enable administrator {{name}}?',
          body: 'After enabling, {{name}} can sign in to the admin console again. Sessions ended at disable time are not restored. Enabling is recorded in the operation log.',
          confirm: 'Enable',
        },
      },
      portal: {
        disable: {
          title: 'Disable portal account?',
          body: '{{email}} will be signed out immediately, and the customer cannot sign in to the portal while disabled.',
          confirm: 'Disable account',
        },
        enable: {
          title: 'Enable portal account?',
          body: '{{email}} can sign in to the customer portal again. Sessions ended at disable time are not restored. Enabling is recorded in the operation log.',
          confirm: 'Enable account',
        },
      },
    },
    portalDisableNoteTitle: 'Calls and billing are unaffected',
    portalDisableNoteBody:
      "The tenant's calls, billing, and balance are unaffected. To pause calls, use Disable in the top-right corner of the page. You can enable the account again at any time. Disabling and enabling are recorded in the operation log.",
    statusNetwork:
      'Cannot confirm whether the change took effect. The list has been refreshed; check the account status before trying again.',
    notice: {
      adminDisableChanged:
        'Disabled administrator {{name}}; recorded in the operation log',
      adminDisableSame: '{{name}} was already disabled; no change',
      adminEnableChanged:
        'Enabled administrator {{name}}; recorded in the operation log',
      adminEnableSame: '{{name}} was already enabled; no change',
      portalDisableChanged:
        'Portal account disabled; recorded in the operation log',
      portalDisableSame: 'Portal account was already disabled; no change',
      portalEnableChanged:
        'Portal account enabled; recorded in the operation log',
      portalEnableSame: 'Portal account was already enabled; no change',
    },
  },
  tenantStatus: {
    disableTitle: 'Disable tenant {{code}}?',
    disableConfirm: 'Disable tenant',
    disableNoteTitle: 'Disabling does not guarantee calls stop immediately',
    disableNote:
      'After disabling, the normal authorization path rejects new calls. If Worker authorization times out, new calls may still be allowed for up to 1800 seconds. Connected calls end at their original limit and are billed normally.',
    disableEffect1:
      'Customer portal accounts cannot sign in; the portal account status itself does not change.',
    disableEffect2:
      'Balance, rates, and ledger history are kept. Recharge, credit recharge, gift, and adjustment are still possible, and posting does not automatically enable the tenant.',
    disableEffect3:
      'The tenant can be enabled again at any time; disabling and enabling are recorded in the operation log.',
    enableTitle: 'Enable tenant {{code}}?',
    enableConfirm: 'Enable tenant',
    enableNoteTitle: 'Restore normal authorization',
    enableNote:
      'After enabling, new calls are authorized normally based on balance and overdraft limit; calls are still suspended if the balance is insufficient.',
    enableEffect1:
      'Only the tenant status is restored; portal accounts are unchanged. If a portal account was disabled separately, enable it on the Portal account tab.',
    enableEffect2: 'Enabling is recorded in the operation log.',
    network:
      'Cannot confirm whether the change took effect. Refresh the page and check the tenant status before trying again.',
    cancel: 'Cancel',
  },
  balanceDialog: {
    visibilityAdmin: 'Internal only',
    visibilityCustomer: 'Customer visible',
    kindLabel: 'Operation type',
    creditTopupNote:
      'Adds balance and records it as receivable; it becomes received once payment is confirmed. Customers see it as "Account recharge".',
    currentBalance: 'Current balance',
    afterBalance: 'After',
    title: 'Balance operation',
    successTitle: 'Operation successful',
    successBody: '{{kind}} {{amount}} posted; current balance {{balance}}',
    logged: 'Recorded in the operation log',
    done: 'Done',
    viewLedger: 'View balance history',
    confirmTitle: 'Confirm {{kind}}',
    ledgerNote:
      'Submitting adds a ledger entry that cannot be edited or deleted. If it is wrong, make a reversing adjustment.',
    tenant: 'Tenant',
    type: 'Type',
    amount: 'Amount',
    note: 'Note',
    balance: 'Balance',
    emptyNote: '(none)',
    internalVisibility: '(internal only)',
    customerVisibility: '(customer visible)',
    available:
      'Available credit after {{kind}}: {{amount}}; status {{change}} "{{status}}"',
    stay: 'stays',
    become: 'changes to',
    disabledTitle: 'This tenant is disabled; its status will not change',
    disabledBody:
      'After posting, the tenant remains disabled and is not enabled automatically; the normal authorization path still rejects new calls. To restore calls, use Enable in the top-right corner of the tenant details.',
    largeTitle: 'Large {{kind}} requires confirmation',
    largeBody:
      'The amount exceeds the {{currency}} large-amount threshold {{amount}}. Check the amount and tenant again.',
    largeConfirm: 'I have checked and confirm {{kind}} {{amount}}',
    network:
      'Cannot confirm whether the entry was posted. Clicking "{{confirm}}" again retries the same operation without posting twice. To change the content, verify it in the balance history first.',
    back: 'Back to edit',
    amountLabel: 'Amount',
    noteLabel: 'Note',
    customerHint: "Shown in the customer portal's balance history",
    adminHint: 'Visible only in the admin console',
    adjustmentPlaceholder: 'Explain the reason for the adjustment',
    notePlaceholder: 'e.g. bank transfer · CMB ending 6621',
    cancel: 'Cancel',
    next: 'Next',
  },
  field: {
    optional: '(optional)',
  },
  recipients: {
    label: 'Notification recipients',
    helper:
      'Add multiple addresses; low-balance and suspension notices are sent to these addresses',
    emptyNote:
      'No recipients configured, so balance alerts cannot be delivered; disabled tenants are skipped',
    flagged: 'Disabled admin',
    remove: 'Remove {{email}}',
    placeholder: 'Type an email and press Enter to add',
    listLabel: 'Added {{label}}',
    addMobile: '+ Add email',
    add: 'Add',
    flaggedNote:
      '{{email}} belongs to a disabled administrator; confirm the recipient',
  },
  statement: {
    reconcile: {
      stale: 'Statement is stale',
      inconsistent: 'Statement does not match the ledger',
    },
    regenerate: {
      inProgress: 'In progress; can be regenerated after month close',
      detailsDeleted: 'Call details deleted; cannot be recalculated',
    },
    regenerateDialog: {
      title: 'Regenerate the {{code}} {{month}} statement?',
      titlePlain: 'Regenerate statement',
      description:
        'Recalculate the statement for that month from current calls',
      bodyCurrent:
        'The statement for that month will be recalculated from current calls, to correct it after call details are resent.',
      bodyMissing:
        'The statement for that month has not been generated. It will be generated from current calls and ledger history, equivalent to creating it.',
      callCharges: 'Current call charges',
      closingBalance: 'Current closing balance',
      generatedAt: 'Generated at',
      portalNote:
        "After regeneration, the customer portal's monthly statement is updated too; the operator and before/after differences are recorded in the operation log.",
      network:
        'Cannot confirm whether the statement was regenerated. Refresh and check the statement version before trying again.',
      close: 'Close',
      cancel: 'Cancel',
      regenerating: 'Regenerating…',
      regenerate: 'Regenerate',
      created:
        'Generated the {{code}} {{month}} statement (version {{version}}); recorded in the operation log.',
      changedIntro:
        'Regenerated the {{code}} {{month}} statement (version {{version}}):',
      changedCallCharges: 'call charges',
      changedSeparator: ', ',
      changedClosingBalance: 'closing balance',
      changedSuffix: '; recorded in the operation log.',
      unchanged:
        'The {{code}} {{month}} statement matches current calls with no changes (version {{version}} unchanged); recorded in the operation log.',
      know: 'Got it',
      staleTitle: 'Statements for later months are stale',
      stalePrefix: '{{code}} ',
      staleSuffix:
        ' statement opening balances no longer match the ledger. Regenerating only handles the selected month; regenerate the following months in order.',
      monthSeparator: ', ',
    },
    parts: {
      regenerate: 'Regenerate',
      regenerated: 'Regenerated · original {{time}}',
      detailsDeleted: 'Call details for this month were deleted',
    },
  },
  scheduledVersion: {
    ariaLabel: 'Scheduled new version',
    badge: 'Scheduled new version',
    summaryPrefix: 'Effective from ',
    summarySuffix:
      '· Added {{added}} · Modified {{modified}} · Deleted {{deleted}}',
    exportCsv: 'Export CSV',
    cancelSchedule: 'Cancel schedule',
    cancelTitle: 'Cancel the scheduled new version?',
    cancelBody:
      'The new version scheduled to take effect from {{time}} will be deleted, and the current version stays in effect. This will be recorded in the operation log.',
    refresh: 'Refresh',
    network:
      'Cannot confirm whether the schedule was canceled. Refresh the rate table and check before trying again.',
    keep: 'Keep schedule',
  },
} as const;
