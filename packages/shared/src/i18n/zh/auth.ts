export const auth = {
  login: {
    invalidCredentials: {
      title: '登录邮箱或密码错误',
      body: '请检查后重新输入',
    },
    accountDisabled: {
      portalTitle: '该账号已停用',
      adminTitle: '该管理员账号已停用',
      portalBody: '如需恢复使用，请联系客服',
      adminBody: '如需恢复，请联系其他管理员启用',
    },
    identityUnavailable: {
      title: '该账号暂时无法使用',
      portalBody: '请联系客服处理',
      adminBody: '请联系其他管理员处理',
    },
    locked: {
      title: '登录失败次数过多，已暂时锁定',
    },
    rateLimited: {
      title: '请求过于频繁',
    },
    retryAfter: '请在 {{duration}} 后重试',
    unavailable: {
      title: '暂时无法登录',
      body: '服务暂时不可用，请稍后重试',
    },
    mobileTitle: {
      portal: '登录客户门户',
      admin: '登录管理后台',
    },
    title: {
      portal: '登录',
      admin: '登录管理后台',
    },
    subtitle: {
      portal: '使用为你开通的登录邮箱和密码',
      admin: '仅限内部管理员使用',
    },
    emailPlaceholder: {
      portal: 'name@company.com',
      admin: 'name@fs-billing.com',
    },
    forgotHint: {
      portal: '请联系客服重置密码',
      admin: '请联系其他管理员在「管理员」页面为你重置密码',
    },
    expired: {
      title: '登录已过期，请重新登录',
      body: '登录后将返回之前的页面',
    },
    forgot: '忘记密码？',
    email: '登录邮箱',
    password: '密码',
    passwordPlaceholder: '请输入密码',
    showPassword: '显示密码',
    hidePassword: '隐藏密码',
    show: '显示',
    hide: '隐藏',
    submit: '登录',
    adminFooter: '客户请使用客户门户登录',
  },
  logout: {
    failed: '退出失败，请检查网络后重试',
  },
  changePassword: {
    validation: {
      currentRequired: '请输入当前密码',
      tooShort: '新密码至少 8 位',
      tooLong: '新密码最多 128 位',
      mismatch: '两次输入的新密码不一致',
      wrongCurrent: '当前密码不正确',
    },
    showLabel: '显示{{label}}',
    hideLabel: '隐藏{{label}}',
    show: '显示',
    hide: '隐藏',
    formLabel: '修改密码',
    success: {
      title: '密码已修改',
      body: '其他设备上的登录将失效',
    },
    locked: {
      title: '尝试次数过多，已暂时锁定',
      retry: '请在 {{duration}} 后重试',
    },
    unavailable: {
      title: '暂时无法修改密码',
      body: '服务暂时不可用，请稍后重试',
    },
    current: '当前密码',
    currentForcedHint: '管理员提供的临时密码',
    next: '新密码',
    nextHint: '至少 8 位',
    confirm: '确认新密码',
    submit: '修改密码',
    title: {
      forced: '请修改初始密码',
      normal: '修改密码',
    },
    description: {
      forced:
        '首次登录或密码被重置后，需要设置新密码才能继续使用。修改后，其他设备上的登录将失效',
      normal: '修改后，其他设备上的登录将失效',
    },
    back: '返回',
  },
} as const;
