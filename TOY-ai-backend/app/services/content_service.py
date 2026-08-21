"""Content generation and offer improvement (§14-§22, §34)."""

from __future__ import annotations

import logging
import re
from typing import Any

from ..prompts.common import correction_prompt
from ..prompts.content import (
    CONTENT_SYSTEM,
    IMPROVE_SYSTEM,
    build_content_prompt,
    build_improve_prompt,
)
from ..providers.errors import InvalidModelOutput
from ..schemas.common import GenerationMeta, Usage
from ..schemas.content import (
    SECTION_LIMITS,
    ContentRequest,
    ContentResponse,
    ImproveRequest,
    ImproveResponse,
)
from . import llm
from .json_utils import as_str_list
from .validation import OfferFactGuard, Violation

logger = logging.getLogger("ai.content")

_EMOJI = re.compile(
    "["
    "\U0001f300-\U0001faff"  # pictographs, emoticons, symbols
    "\U00002600-\U000027bf"  # misc symbols and dingbats
    "\U0001f1e6-\U0001f1ff"  # regional indicators (flags)
    "\U00002b00-\U00002bff"  # arrows and stars
    "\U00002190-\U000021ff"  # arrows
    "\U0000fe0f"  # variation selector that trails many emoji
    "]"
)


def _clean(text: Any, section: str, allow_emoji: bool) -> str:
    value = str(text or "").strip()
    if not allow_emoji:
        value = _EMOJI.sub("", value)
        value = re.sub(r"[ \t]{2,}", " ", value).strip()
    limit = SECTION_LIMITS.get(section)
    if limit and len(value) > limit:
        value = _truncate(value, limit)
    return value


def _truncate(value: str, limit: int) -> str:
    """Trim on a word boundary so a cut push notification still reads properly."""
    if len(value) <= limit:
        return value
    clipped = value[:limit].rstrip()
    space = clipped.rfind(" ")
    if space > limit * 0.6:
        clipped = clipped[:space].rstrip()
    return clipped.rstrip(",;:-") + "…"


def _extract_sections(data: dict[str, Any], wanted: list[str]) -> dict[str, list[str]]:
    """Accept both {"sections": {...}} and a flat {...} answer."""
    raw = data.get("sections")
    if not isinstance(raw, dict):
        raw = data

    sections: dict[str, list[str]] = {}
    for section in wanted:
        value = raw.get(section)
        if value is None:
            # Tolerate snake_case, which models produce now and then.
            snake = re.sub(r"(?<!^)(?=[A-Z])", "_", section).lower()
            value = raw.get(snake)
        variants = as_str_list(value)
        if variants:
            sections[section] = variants
    return sections


def _validator(guard: OfferFactGuard, wanted: list[str], allow_emoji: bool):
    def validate(data: dict[str, Any]) -> list[str]:
        sections = _extract_sections(data, wanted)
        if not sections:
            return ["No content sections were returned."]

        problems = [
            f"'{section}' was requested but not returned."
            for section in wanted
            if section not in sections
        ]
        cleaned = {
            section: [_clean(variant, section, allow_emoji) for variant in variants]
            for section, variants in sections.items()
        }
        problems += [violation.describe() for violation in guard.check_all(cleaned)]
        return problems

    return validate


async def generate_content(request: ContentRequest) -> ContentResponse:
    if not request.sections:
        raise InvalidModelOutput("No content sections were requested.")

    guard = OfferFactGuard(request.offer)
    allow_emoji = request.controls.emoji
    user_prompt = build_content_prompt(request)

    generation = await llm.generate_with_correction(
        system=CONTENT_SYSTEM,
        user=user_prompt,
        correction_prompt=correction_prompt,
        validate=_validator(guard, request.sections, allow_emoji),
    )

    raw_sections = _extract_sections(generation.data, request.sections)
    warnings = list(generation.warnings)

    kept: dict[str, list[str]] = {}
    for section, variants in raw_sections.items():
        surviving: list[str] = []
        for variant in variants[: max(1, request.controls.variants)]:
            text = _clean(variant, section, allow_emoji)
            if not text:
                continue
            violations: list[Violation] = guard.check(section, text)
            if violations:
                # Dropped, not shown with a caveat: copy that misstates the
                # discount is worse than a missing variant (§23).
                warnings.append(violations[0].describe())
                continue
            surviving.append(text)
        if surviving:
            kept[section] = surviving

    if not kept:
        raise InvalidModelOutput(
            "None of the generated content matched the saved offer.",
            details={"warnings": warnings[:6]},
        )

    missing = [section for section in request.sections if section not in kept]
    if missing:
        warnings.append(f"Could not produce verified copy for: {', '.join(missing)}.")

    return ContentResponse(
        sections=kept,
        suggestedTerms=as_str_list(generation.data.get("suggestedTerms"), limit=4),
        meta=GenerationMeta(
            provider=generation.provider,
            model=generation.model,
            usage=Usage(
                promptTokens=generation.prompt_tokens,
                completionTokens=generation.completion_tokens,
                totalTokens=generation.total_tokens,
            ),
            attempts=generation.attempts,
            warnings=_dedupe(warnings),
        ),
    )


async def improve_offer(request: ImproveRequest) -> ImproveResponse:
    guard = OfferFactGuard(request.offer)
    allow_emoji = request.controls.emoji
    user_prompt = build_improve_prompt(request)

    fields = {
        "suggestedTitle": "title",
        "suggestedOfferText": "title",
        "suggestedShortDescription": "shortDescription",
        "suggestedDescription": "detailedDescription",
    }

    def validate(data: dict[str, Any]) -> list[str]:
        problems: list[str] = []
        if not any(data.get(field) for field in fields):
            problems.append("No suggested wording was returned.")
        for field, section in fields.items():
            text = _clean(data.get(field), section, allow_emoji)
            problems += [violation.describe() for violation in guard.check(field, text)]
        return problems

    generation = await llm.generate_with_correction(
        system=IMPROVE_SYSTEM,
        user=user_prompt,
        correction_prompt=correction_prompt,
        validate=validate,
    )

    warnings = list(generation.warnings)
    suggested: dict[str, str | None] = {}
    for field, section in fields.items():
        text = _clean(generation.data.get(field), section, allow_emoji)
        if not text:
            suggested[field] = None
            continue
        violations = guard.check(field, text)
        if violations:
            warnings.append(violations[0].describe())
            suggested[field] = None
        else:
            suggested[field] = text

    improvements = [
        point
        for point in as_str_list(generation.data.get("improvements"), limit=8)
        if not guard.check("improvements", point)
    ]

    if not improvements and not any(suggested.values()):
        raise InvalidModelOutput(
            "No verifiable improvement could be produced for this offer.",
            details={"warnings": warnings[:6]},
        )

    return ImproveResponse(
        improvements=improvements,
        suggestedTitle=suggested.get("suggestedTitle"),
        suggestedOfferText=suggested.get("suggestedOfferText"),
        suggestedShortDescription=suggested.get("suggestedShortDescription"),
        suggestedDescription=suggested.get("suggestedDescription"),
        meta=GenerationMeta(
            provider=generation.provider,
            model=generation.model,
            usage=Usage(
                promptTokens=generation.prompt_tokens,
                completionTokens=generation.completion_tokens,
                totalTokens=generation.total_tokens,
            ),
            attempts=generation.attempts,
            warnings=_dedupe(warnings),
        ),
    )


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result[:8]
