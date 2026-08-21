"""AI Offer Assistant orchestration (§4-§13, §28, §38)."""

from __future__ import annotations

import logging
from typing import Any

from ..prompts.assistant import SYSTEM, build_user_prompt
from ..prompts.common import correction_prompt
from ..providers.errors import InvalidModelOutput
from ..schemas.assistant import (
    AssistantRequest,
    AssistantResponse,
    Reason,
    Recommendation,
)
from ..schemas.common import GenerationMeta, Usage
from . import llm
from .json_utils import as_str_list
from .validation import ContextGuard

logger = logging.getLogger("ai.assistant")

OFFER_TYPES = {"percentage", "flat", "buy_x_get_y", "price_drop", "up_to", "other"}
DISCOUNT_TYPES = {"percentage", "flat", "none"}

_TYPE_ALIASES = {
    "buy_x_get_y_free": "buy_x_get_y",
    "buyxgety": "buy_x_get_y",
    "bogo": "buy_x_get_y",
    "quantity": "buy_x_get_y",
    "percent": "percentage",
    "percentage_discount": "percentage",
    "flat_discount": "flat",
    "fixed": "flat",
    "upto": "up_to",
    "clearance": "up_to",
    "price_cut": "price_drop",
}


def _number(value: Any, *, minimum: float | None = None, maximum: float | None = None):
    if value in (None, "", "null"):
        return None
    try:
        parsed = float(str(value).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None
    if minimum is not None and parsed < minimum:
        return None
    if maximum is not None and parsed > maximum:
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _int(value: Any, *, minimum: int = 1, maximum: int = 999) -> int | None:
    parsed = _number(value, minimum=minimum, maximum=maximum)
    return int(parsed) if parsed is not None else None


def _text(value: Any, limit: int) -> str | None:
    if value in (None, "", "null"):
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _offer_type(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    resolved = _TYPE_ALIASES.get(raw, raw)
    return resolved if resolved in OFFER_TYPES else "percentage"


def _discount_type(value: Any, offer_type: str) -> str:
    raw = str(value or "").strip().lower()
    if raw not in DISCOUNT_TYPES:
        # Derive it rather than reject: the app's own form does the same mapping.
        raw = {"buy_x_get_y": "none", "other": "none", "flat": "flat", "price_drop": "flat"}.get(
            offer_type, "percentage"
        )
    return raw


def _coerce_recommendation(raw: dict[str, Any], guard: ContextGuard) -> Recommendation | None:
    """Normalise one model-produced option into something the form can accept."""
    title = _text(raw.get("title"), 200)
    if not title:
        return None

    offer_type = _offer_type(raw.get("offerType"))
    discount_type = _discount_type(raw.get("discountType"), offer_type)

    discount_value = _number(
        raw.get("discountValue"),
        minimum=0,
        maximum=100 if discount_type == "percentage" else 10_000_000,
    )
    if discount_type == "none":
        discount_value = None

    buy_quantity = _int(raw.get("buyQuantity"))
    get_quantity = _int(raw.get("getQuantity") if raw.get("getQuantity") is not None else raw.get("freeQuantity"))

    # A quantity offer without quantities cannot pre-fill the form (§9), and a
    # percentage offer without a percentage is equally useless.
    if offer_type == "buy_x_get_y" and not (buy_quantity and get_quantity):
        return None
    if discount_type != "none" and not discount_value:
        return None

    reasoning: list[Reason] = []
    for entry in raw.get("reasoning") or []:
        if isinstance(entry, dict):
            text, basis = entry.get("text"), str(entry.get("basis") or "general").lower()
        else:
            text, basis = entry, "general"
        text = _text(text, 300)
        if not text:
            continue
        checked = guard.sanitise_reason(text, "observed" if basis == "observed" else "general")
        if checked:
            reasoning.append(Reason(text=checked[0], basis=checked[1]))

    return Recommendation(
        label=_text(raw.get("label"), 60) or "Recommended offer",
        title=title,
        offerText=_text(raw.get("offerText"), 200),
        description=_text(raw.get("description"), 2000),
        offerType=offer_type,
        discountType=discount_type,
        discountValue=discount_value,
        buyQuantity=buy_quantity if offer_type == "buy_x_get_y" else None,
        getQuantity=get_quantity if offer_type == "buy_x_get_y" else None,
        productName=_text(raw.get("productName"), 200),
        categoryName=_text(raw.get("categoryName"), 120),
        goal=_text(raw.get("goal"), 200),
        recommendedDurationDays=_int(raw.get("recommendedDurationDays"), minimum=1, maximum=365),
        recommendedStartDate=_text(raw.get("recommendedStartDate"), 40),
        recommendedEndDate=_text(raw.get("recommendedEndDate"), 40),
        recommendedSchedule=_text(raw.get("recommendedSchedule"), 200),
        targetRadiusKm=_number(raw.get("targetRadiusKm"), minimum=0, maximum=500),
        reasoning=reasoning[:6],
        tradeOffs=as_str_list(raw.get("tradeOffs"), limit=4),
    )


def _validate(data: dict[str, Any]) -> list[str]:
    """Problems worth one correction round."""
    problems: list[str] = []
    recommendations = data.get("recommendations")
    if not isinstance(recommendations, list) or not recommendations:
        problems.append("No recommendations were returned.")
        return problems

    for index, raw in enumerate(recommendations, start=1):
        if not isinstance(raw, dict):
            problems.append(f"Recommendation {index} is not an object.")
            continue
        if not str(raw.get("title") or "").strip():
            problems.append(f"Recommendation {index} has no title.")
        offer_type = _offer_type(raw.get("offerType"))
        if offer_type == "buy_x_get_y" and not (
            _int(raw.get("buyQuantity")) and _int(raw.get("getQuantity") or raw.get("freeQuantity"))
        ):
            problems.append(
                f"Recommendation {index} is a buy X get Y offer but is missing "
                "buyQuantity or getQuantity."
            )
    return problems


async def recommend(request: AssistantRequest) -> AssistantResponse:
    guard = ContextGuard(request.context)
    user_prompt = build_user_prompt(request)

    generation = await llm.generate_with_correction(
        system=SYSTEM,
        user=user_prompt,
        correction_prompt=correction_prompt,
        validate=_validate,
    )

    raw_list = generation.data.get("recommendations")
    if not isinstance(raw_list, list):
        raw_list = generation.data.get("items") if isinstance(generation.data.get("items"), list) else []

    recommendations: list[Recommendation] = []
    for raw in raw_list:
        if not isinstance(raw, dict):
            continue
        recommendation = _coerce_recommendation(raw, guard)
        if recommendation:
            recommendations.append(recommendation)

    if not recommendations:
        raise InvalidModelOutput(
            "The model did not return a usable offer recommendation.",
            details={"received": str(generation.data)[:400]},
        )

    warnings = list(generation.warnings)
    dropped = len(raw_list) - len(recommendations)
    if dropped > 0:
        warnings.append(f"{dropped} recommendation(s) were discarded as incomplete.")

    # A plan without the premium insight, or a shop without the data, must not
    # come back with an insight sentence anyway (§12, §13, §38).
    location_insight = _text(generation.data.get("locationInsight"), 300)
    if not (request.context.allowLocationInsights and request.context.locationDataAvailable):
        location_insight = None

    timing_insight = _text(generation.data.get("timingInsight"), 300)
    if not (request.context.allowTimingInsights and request.context.timingDataAvailable):
        timing_insight = None

    insufficient = bool(generation.data.get("insufficientData")) or not guard.may_claim_observed()
    notes = as_str_list(generation.data.get("dataNotes"), limit=5)
    if insufficient and not notes:
        notes = ["No past offer performance was available, so this is based on your goal alone."]

    return AssistantResponse(
        recommendations=recommendations[: max(1, request.input.optionCount)],
        insufficientData=insufficient,
        dataNotes=notes,
        locationInsight=location_insight,
        timingInsight=timing_insight,
        meta=GenerationMeta(
            provider=generation.provider,
            model=generation.model,
            usage=Usage(
                promptTokens=generation.prompt_tokens,
                completionTokens=generation.completion_tokens,
                totalTokens=generation.total_tokens,
            ),
            attempts=generation.attempts,
            warnings=warnings,
        ),
    )
