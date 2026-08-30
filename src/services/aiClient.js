'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');
const requestContext = require('../utils/requestContext');
const ApiError = require('../utils/ApiError');

/**
 * The only way this API talks to the Python AI service (§29).
 *
 * Provider keys live in that service, so nothing here knows or cares whether
 * the answer came from Groq or OpenAI. Failures are translated into the
 * merchant-facing wording from §36/§37 - the underlying provider message is
 * logged, never returned.
 */

const FRIENDLY_MESSAGES = {
  PROVIDER_NOT_CONFIGURED: 'AI features are not available right now. Please try again later.',
  PROVIDER_TIMEOUT: 'That took longer than expected. Please try again in a moment.',
  PROVIDER_RATE_LIMITED: 'The AI assistant is busy right now. Please try again in a minute.',
  PROVIDER_UNREACHABLE: 'Unable to reach the AI service right now. Please try again later.',
  PROVIDER_EMPTY_RESPONSE: 'Unable to generate content right now. Please try again.',
  INVALID_MODEL_OUTPUT: 'Unable to generate usable content right now. Please try again.',
  AI_SERVICE_DISABLED: 'AI features are turned off for this installation.',
  AI_SERVICE_UNAVAILABLE: 'Unable to generate content right now. Please try again later.',
};

const DEFAULT_MESSAGE = 'Unable to generate content right now. Please try again later.';

/** An AI call that failed, carrying the code the usage log records (§32). */
class AiServiceError extends ApiError {
  constructor(code, status = 503, details = undefined) {
    super(status, FRIENDLY_MESSAGES[code] ?? DEFAULT_MESSAGE, details, code);
    this.name = 'AiServiceError';
    this.aiCode = code;
  }
}

async function post(path, body) {
  if (!env.ai.enabled) throw new AiServiceError('AI_SERVICE_DISABLED', 503);

  /**
   * §22. The call is logged, its content is not: no prompt, no merchant data,
   * no provider key. What is kept is what an investigation needs - which
   * feature, how long it took, and whether it worked - correlated to the
   * request that triggered it (§4).
   */
  const log = logger.child({
    request_id: requestContext.currentId(),
    dependency: 'AI',
    category: 'AI',
    ai_path: path,
  });
  log.debug({ event: 'AI_REQUEST_STARTED' }, `AI request to ${path}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ai.timeoutMs);
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(`${env.ai.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.ai.token ? { 'x-ai-service-token': env.ai.token } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    // §22: the AI call itself, not its content. No prompt, no merchant data
    // and no provider key ever reaches this line.
    logger.error(
      {
        event: 'AI_REQUEST_FAILED',
        error_code: 'AI_SERVICE_UNAVAILABLE',
        category: 'AI',
        dependency: 'AI',
        ai_path: path,
        reason: error.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
        err_message: error.message,
      },
      `AI service call to ${path} failed`,
    );
    throw new AiServiceError(
      error.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
      504,
    );
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const code = payload?.error?.code ?? 'AI_SERVICE_UNAVAILABLE';
    // The provider's own message can name models, quotas and internals, so it
    // stays in the log and the merchant gets the §37 wording instead.
    log.error(
      {
        event: 'AI_REQUEST_FAILED',
        error_code: code === 'INVALID_MODEL_OUTPUT' ? 'INVALID_MODEL_OUTPUT' : 'AI_SERVICE_UNAVAILABLE',
        status_code: response.status,
        provider_code: code,
        duration_ms: durationMs,
        provider_message: payload?.error?.message ?? payload?.detail ?? '(no message)',
      },
      `AI request to ${path} failed`,
    );
    throw new AiServiceError(code, code === 'PROVIDER_RATE_LIMITED' ? 429 : 503);
  }

  log.info(
    {
      event: 'AI_REQUEST_SUCCEEDED',
      duration_ms: durationMs,
      // §22 asks for the model/provider identifier and the usage amount, both
      // of which only the AI service knows. Reported when it tells us.
      ...(payload?.model ? { ai_model: payload.model } : {}),
      ...(payload?.usage?.total_tokens ? { usage_tokens: payload.usage.total_tokens } : {}),
    },
    `AI request to ${path} succeeded in ${durationMs}ms`,
  );

  if (!payload || typeof payload !== 'object') {
    throw new AiServiceError('INVALID_MODEL_OUTPUT', 502);
  }

  return { data: payload, durationMs };
}

const recommend = (body) => post('/v1/assistant/recommend', body);
const regenerateRecommendation = (body) => post('/v1/assistant/regenerate', body);
const generateContent = (body) => post('/v1/content/generate', body);
const regenerateContent = (body) => post('/v1/content/regenerate', body);
const improveOffer = (body) => post('/v1/offer/improve', body);

/** Used by /api/ai/status so a Super Admin can see the wiring is live. */
async function health() {
  if (!env.ai.enabled) return { reachable: false, reason: 'disabled' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${env.ai.baseUrl}/health`, { signal: controller.signal });
    if (!response.ok) return { reachable: false, reason: `http_${response.status}` };
    return { reachable: true, ...(await response.json()) };
  } catch (error) {
    return { reachable: false, reason: error.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  AiServiceError,
  recommend,
  regenerateRecommendation,
  generateContent,
  regenerateContent,
  improveOffer,
  health,
};
