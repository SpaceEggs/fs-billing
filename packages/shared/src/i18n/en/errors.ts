export const errors = {
  validation: {
    request: {
      invalid: 'Invalid request',
    },
    field: {
      invalid: 'Invalid request field',
    },
    amount: {
      negativeZero: 'Amount must not be negative zero',
      negative: 'Amount must not be negative',
      zero: 'Amount must not be zero',
      positive: 'Amount must be greater than zero',
      precision:
        'Amount allows at most {{digits}} integer digits and {{decimalPlaces}} decimal places',
      callChargeNegative: 'Call charge amount must be negative',
    },
    ledger: {
      mergeDayMismatch:
        'The merged row time must fall on the day date (Beijing time)',
      creditNoteAdminOnly: 'Credit notes are visible to administrators only',
      callNamespace: 'call: is a reserved namespace for call charges',
    },
    context: {
      balanceCurrencyMismatch:
        'Balance currency must match the tenant currency',
    },
    usage: {
      dailyWindow:
        'Consumption dates must be the 30 consecutive days ending on the asOf Beijing date',
    },
    date: {
      outOfRange: 'Date range must be between 0001-01-01 and 9999-12-31',
      endBeforeStart: 'End date must not be earlier than start date',
      rangeTooLong: 'Date range must not exceed one month',
    },
    statement: {
      monthTooEarly: 'Statement month must be after 0001-01',
      regenerableReason:
        'A reason is not allowed when regeneration is available and is required when it is not',
      figuresBalance:
        'Closing balance must equal opening + recharge + gift + adjustment − call charges',
      generatedAtOnlyFinal: 'Only generated statements have a generation time',
      asOfOnlyLive: 'Only live months have a read time',
      noDeletedDetailsForLive: 'Live months have no deleted CDR details',
      duplicateCountry: 'Countries must not repeat',
      daysAscending: 'Days must be strictly ascending',
      versionOnlyFinal:
        'Only generated statements have a version and first generation time',
      reconcileOnlyFinal:
        'Only generated statements have a reconciliation status',
      regenerableReasonMismatch:
        'The regeneration reason does not match the state',
      monthsDescending: 'Months must be strictly descending',
      pendingFiguresNull: 'Only ungenerated rows have no figures',
      tenantCountMismatch: 'Tenant count must equal the number of rows',
      rowMonthMismatch: 'Row month must be the selected month',
      oneGroupPerCurrency: 'Each currency may have only one group',
      versionAndReconcileOnlyFinal:
        'Only generated statements have a version and reconciliation result',
      firstGeneratedOnlyFinal:
        'Only generated statements have a first generation time',
      generatedByOnlyFinal: 'Only generated statements have a generator',
      createdBefore: 'A created statement has no previous statement',
      regenerateRequiresBefore: 'Regeneration requires a previous statement',
      unchangedFigures: 'Figures must be identical when nothing changed',
    },
    cdr: {
      calleeChars:
        'The called number may contain only digits, +, spaces, hyphens and parentheses',
      calleeInvalid: 'The called number format is invalid',
      endBeforeStart: 'Hangup time must not be earlier than ring start time',
      unansweredZero:
        'An unanswered CDR must have zero duration, billed minutes and charge',
      answerWithin: 'Answer time must be between ring start and hangup',
      outboundFields:
        'An answered CDR must have country, matched prefix and rate',
      inboundMinutesZero: 'Inbound CDRs must have zero billed minutes',
      inboundChargeZero: 'Inbound CDRs must have zero charge',
      workerTiming: 'CDR times and duration are inconsistent',
      total: 'Total must not be less than the current page size',
      unverifiedTotal: 'Unverified count must not exceed the total',
    },
    rate: {
      prefixLeadingZeros: 'Prefix must not include the international 00 prefix',
      iso: 'ISO must be two letters or empty',
      descriptionNewline: 'Description must not contain line breaks',
      countryNewline: 'Country must not contain line breaks',
      duplicatePrefix: 'Prefixes must not repeat',
      scheduleHorizon:
        'Effective time must be between now and the configured scheduling horizon',
      csvDecodeTooLarge: 'Decoded CSV bytes exceed the limit',
      previewCounts: 'Preview counts must match the changes',
    },
    tenant: {
      copySourceVersion: 'Source version must belong to the source tenant',
      copyCurrency: 'Source and target currencies must match',
    },
    receivable: {
      receivedOnFuture:
        'Received date must not be later than the current Beijing date',
      latestSettlement:
        'A received receivable must reference the latest confirmation event',
      overdueAfter30:
        'A pending receivable is marked overdue only after 30 days',
      receivedBeforeCredit:
        'Received date must not be earlier than the credit date',
    },
    cdrDeletion: {
      remainingMatchesFailure:
        'Remaining months exist only when there is a failure',
      failureFirstRemaining:
        'The failed month must be the first remaining month',
    },
    mailSettings: {
      hostRequired: 'Enter the server address to enable email',
      portRequired: 'Enter the port to enable email',
      secureRequired: 'Choose an encryption mode to enable email',
      mailFromRequired: 'Enter the sender address to enable email',
      portAllowed: 'Only ports 25, 465, 587 or 2525 are allowed',
    },
  },
  conflict: {
    TENANT_CODE_EXISTS: 'Tenant code is already in use',
    EMAIL_EXISTS: 'This email is already used by another account',
    PORTAL_ACCOUNT_EXISTS: 'This tenant already has a portal account',
    CURRENCY_MISMATCH: 'Currency does not match the tenant currency',
    IDEMPOTENCY_CONFLICT:
      'This operation was already submitted with different content. Refresh and try again',
    RATE_VERSION_CONFLICT: 'The rate table was changed. Refresh and try again',
    PREVIEW_STALE:
      'The preview is stale; the rate table may have changed. Refresh and preview again',
    PREVIEW_EXPIRED: 'The preview expired. Preview again',
    ALREADY_RECEIVED: 'This receivable is already received',
    RECEIVABLE_VOIDED: 'This receivable is voided',
    SETTLEMENT_CONFLICT:
      'The settlement status changed. Refresh and confirm again',
    RECEIVABLE_REVERSAL_MISMATCH:
      'The reversal entry does not match this credit',
    SELF_DISABLE: 'You cannot disable your own account',
    LAST_ADMIN: 'Keep at least one enabled administrator',
    STATEMENT_DETAILS_DELETED:
      "This month's CDRs are deleted, so the statement cannot be regenerated",
    STATEMENT_NOT_FINAL:
      'This month is not over; regenerate the statement after month end',
    STATEMENT_VERSION_CONFLICT:
      'The statement was regenerated. Refresh and try again',
    UNASSIGNED_PREVIEW_STALE: 'Data changed after the preview. Preview again',
    UNASSIGNED_NOTHING_TO_ASSIGN:
      'The selection has no pending CDRs to assign. Refresh and select again',
    CDR_MONTH_NOT_DELETABLE:
      'CDRs cannot be deleted for the selected month. Refresh and select again',
    CDR_DELETE_COUNT_CHANGED:
      'The CDR count differs from the preview. Refresh and preview again',
    ALERT_SETTINGS_VERSION_CONFLICT:
      'Alert settings were changed by someone else. Refresh and try again',
    MAIL_SETTINGS_VERSION_CONFLICT:
      'Mail settings were changed by someone else. Refresh and try again',
  },
  mailSettings: {
    SETTINGS_KEY_MISSING:
      'The server has no settings encryption key (SETTINGS_ENCRYPTION_KEY), so the password cannot be saved or used',
    MAIL_SETTINGS_PASSWORD_REQUIRED:
      'Re-enter the password after changing the server or account',
    MAIL_SETTINGS_PASSWORD_UNUSABLE:
      'The saved password cannot be decrypted. Re-enter it',
    MAIL_SETTINGS_HOST_NOT_ALLOWED:
      'This mail server address is not allowed: loopback, private network and localhost addresses are rejected',
  },
  form: {
    amountFormat:
      'must be a number with at most {{maxDigits}} integer digits and {{decimals}} decimal places',
    amountInvalid: '{{label}} {{message}}',
    amountRequired: 'Enter {{label}}',
    amountNegative: '{{label}} cannot be negative',
    amountOverdraftNegative:
      'Overdraft limit cannot be negative. Enter 0 to disallow overdraft',
    overdraftLabel: 'Overdraft limit',
    emailRequired: 'Enter the sign-in email',
    emailInvalid: 'Email format is invalid',
    nameRequired: 'Enter a name',
    nameTooLong: 'Name must be at most {{max}} characters',
    submitInvalid: 'The submission is invalid. Check it and try again',
    passwordLength:
      'The initial password must be {{min}} to {{max}} characters',
  },
  csvRejected: {
    encodingUnsupported:
      'Unrecognized file encoding. Save as UTF-8 or GBK and upload again',
    limitExceeded: 'The file exceeds 2 MB or 10,000 rows',
  },
  csv: {
    file: {
      empty: 'The file has no rate rows',
      oldFormat:
        'The three-column format (prefix, country, rate) is no longer supported. Use five columns with the header ISO,Country,Destination Prefix,Description,Rate; download the CSV template from the import dialog',
      invalidHeader:
        'Unrecognized header. The first row must be ISO,Country,Destination Prefix,Description,Rate (the Chinese equivalent is also accepted)',
    },
    row: {
      columnCount: 'Expected 5 columns, got {{count}}',
      prefixDigits: 'Prefix must contain digits only: {{prefix}}',
      prefixLeadingZeros:
        'Prefix must not start with 00 (remove the international prefix): {{prefix}}',
      duplicatePrefix: 'Prefix {{prefix}} duplicates row {{firstLine}}',
      iso: 'ISO must be two letters or empty: {{iso}}',
      countryEmpty: 'Country must not be empty',
      rateNotNumber: 'Rate is not a number: {{rate}}',
      rateNegative: 'Rate must not be negative: {{rate}}',
      rateMaxFourDecimals: 'Rate allows at most 4 decimal places: {{rate}}',
      quoteUnclosed: 'Unclosed quote (quotes cannot span lines)',
      quoteAfter: 'Only a comma may follow a closing quote',
      quoteInUnquoted: 'An unquoted field must not contain quotes',
    },
  },
} as const;
