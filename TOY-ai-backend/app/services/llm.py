"""One place where a prompt turns into a parsed JSON document.

Retries live here rather than in the providers so that a transient 503 and a
model that answered with prose are handled the same way: try again, then give up
cleanly so §36's "you can still create the offer manually" stays true.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from ..config import settings
from ..providers import LLMProvider, get_provider
from ..providers.errors import AIProviderError, InvalidModelOutput
from .json_utils import parse_json_object

logger = logging.getLogger("ai.llm")


@dataclass
class Generation:
    data: dict[str, Any]
    provider: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    attempts: int = 1
    warnings: list[str] = field(default_factory=list)


async def generate(
    *,
    system: str,
    user: str,
    provider: LLMProvider | None = None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
) -> Generation:
    """Call the model until it produces a JSON object, or raise."""
    engine = provider or get_provider()
    attempts = 0
    last_error: AIProviderError | None = None
    total_attempts = max(1, settings.max_retries + 1)

    while attempts < total_attempts:
        attempts += 1
        try:
            result = await engine.generate_json(
                system=system,
                user=user,
                temperature=settings.temperature if temperature is None else temperature,
                max_output_tokens=max_output_tokens or settings.max_output_tokens,
            )
            data = parse_json_object(result.text)
            return Generation(
                data=data,
                provider=result.provider,
                model=result.model,
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
                total_tokens=result.total_tokens,
                attempts=attempts,
            )
        except AIProviderError as error:
            last_error = error
            if not error.retryable and not isinstance(error, InvalidModelOutput):
                raise
            if attempts >= total_attempts:
                raise
            logger.warning(
                "attempt %d/%d failed (%s); retrying", attempts, total_attempts, error.code
            )
            # Short linear backoff: the free tiers this runs against rate-limit
            # per minute, so a long sleep would just burn the request timeout.
            await asyncio.sleep(0.6 * attempts)

    raise last_error or InvalidModelOutput("The model produced no usable answer.")


async def generate_with_correction(
    *,
    system: str,
    user: str,
    correction_prompt,
    validate,
    provider: LLMProvider | None = None,
    temperature: float | None = None,
    max_output_tokens: int | None = None,
) -> Generation:
    """Generate, validate, and give the model exactly one chance to fix itself.

    ``validate(data)`` returns a list of human-readable problems.
    ``correction_prompt(user, problems)`` builds the follow-up prompt.

    One retry, not a loop: a model that ignored the offer facts twice is not
    going to be argued into it, and the caller drops the bad copy instead.
    """
    engine = provider or get_provider()

    first = await generate(
        system=system,
        user=user,
        provider=engine,
        temperature=temperature,
        max_output_tokens=max_output_tokens,
    )
    problems = validate(first.data)
    if not problems:
        return first

    logger.info("correcting generation: %s", "; ".join(problems[:5]))

    try:
        second = await generate(
            system=system,
            user=correction_prompt(user, problems),
            provider=engine,
            # Lower temperature for the correction: this pass wants obedience,
            # not creativity.
            temperature=0.2,
            max_output_tokens=max_output_tokens,
        )
    except AIProviderError:
        first.warnings.append("Some generated copy could not be verified against the offer.")
        return first

    second.attempts = first.attempts + second.attempts
    second.prompt_tokens += first.prompt_tokens
    second.completion_tokens += first.completion_tokens
    second.total_tokens += first.total_tokens
    second.warnings.append("Regenerated once so the wording matched the saved offer.")
    return second
