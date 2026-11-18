/** OpenAI 兼容的错误对象 */
export class ApiError extends Error {
  constructor(status, message, { type = 'invalid_request_error', code = null, param = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }

  toJSON() {
    return { error: { message: this.message, type: this.type, param: this.param, code: this.code } };
  }
}

export const badRequest = (message, code = 'invalid_request') => new ApiError(400, message, { code });
export const unauthorized = (message = '缺少或错误的 API Key') =>
  new ApiError(401, message, { type: 'authentication_error', code: 'invalid_api_key' });
export const notFound = (message = 'Not found') => new ApiError(404, message, { code: 'not_found' });

/** 浏览器/网页侧的问题（登录失效、验证码、页面改版……） */
export class UpstreamError extends ApiError {
  constructor(message, { status = 502, code = 'deepseek_web_error' } = {}) {
    super(status, message, { type: 'upstream_error', code });
    this.name = 'UpstreamError';
  }
}

export class AuthExpiredError extends UpstreamError {
  constructor(
    message = 'DeepSeek 登录态无效或已过期，请重新执行 `npm run auth -- <userToken>` 写入 token',
  ) {
    super(message, { status: 503, code: 'deepseek_auth_required' });
    this.name = 'AuthExpiredError';
  }
}

export class CaptchaError extends UpstreamError {
  constructor(message = 'DeepSeek 弹出了人机验证 / 验证码，自动化无法继续。请换网络或稍后重试') {
    super(message, { status: 503, code: 'deepseek_captcha' });
    this.name = 'CaptchaError';
  }
}

export class RateLimitError extends UpstreamError {
  constructor(
    message = 'DeepSeek 网页提示发送过于频繁（同一账号短时间内消息太多），请稍后重试',
    { retryAfterMs = 60_000 } = {},
  ) {
    super(message, { status: 429, code: 'deepseek_rate_limited' });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class PromptTooLongError extends ApiError {
  constructor(message = '拼接后的 prompt 超出 DeepSeek 网页输入上限，请减少上下文') {
    super(413, message, { type: 'invalid_request_error', code: 'context_length_exceeded' });
    this.name = 'PromptTooLongError';
  }
}

export class TimeoutError extends ApiError {
  constructor(message = '等待 DeepSeek 响应超时') {
    super(504, message, { type: 'upstream_error', code: 'upstream_timeout' });
    this.name = 'TimeoutError';
  }
}

/**
 * 风控类错误（40029 / 40303 / 40012 / 50006 …）。
 *
 * 单独一个类型，是为了让上层能按 kind 做不同处置：
 *  - challenge / ip_restricted：换号可能也没用，必须停手或换出口；
 *  - banned：这个号彻底废了；
 *  - muted：等到 mute_until 之后再说；
 *  - pow：同一账号换个 challenge 就能重试。
 *
 * `signal` 就是 risk.mjs 里的 RiskSignal，原样带出来便于日志/健康检查。
 */
export class RiskError extends UpstreamError {
  constructor(signal, { message = null } = {}) {
    const status =
      signal.kind === 'ip_restricted' || signal.kind === 'muted' ? 429 : signal.kind === 'pow' ? 502 : 503;
    const code = {
      challenge: 'deepseek_captcha',
      ip_restricted: 'deepseek_ip_restricted',
      banned: 'deepseek_banned',
      muted: 'deepseek_muted',
      pow: 'deepseek_pow',
      crypto: 'deepseek_crypto_required',
      auth: 'deepseek_auth_required',
    }[signal.kind] || 'deepseek_risk';
    super(message || signal.reason || '上游风控拦截', { status, code });
    this.name = 'RiskError';
    this.signal = signal;
    this.kind = signal.kind;
    if (signal.kind === 'ip_restricted' || signal.kind === 'muted' || signal.kind === 'challenge') {
      this.retryAfterMs = Math.max(1_000, signal.cooldownMs || 0);
    }
  }
}
