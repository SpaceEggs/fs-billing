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
  },
  logout: {
    failed: '退出失败，请检查网络后重试',
  },
} as const;
