"""Payloads shared by every AI feature.

The Node API owns the database. It resolves what the merchant is allowed to see
(§30), aggregates it, and posts it here. This service never opens a database
connection, which is what keeps one merchant's context out of another's request.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


def format_amount(value: float | int | None) -> str:
    """'1999.0' reads as a typo in customer copy; '1999' does not."""
    if value is None:
        return ""
    number = float(value)
    return str(int(number)) if number.is_integer() else f"{number:.2f}"


def format_date(value: str | None) -> str | None:
    """Render an ISO timestamp the way a customer would read it.

    Without this the model copies '2026-08-15T10:00:00Z' straight into the
    banner. The fact guard still works from the raw ISO value, so this only
    changes what the model is shown.
    """
    if not value:
        return None
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text
    stamp = parsed.strftime("%-d %b %Y") if hasattr(parsed, "strftime") else text
    if (parsed.hour, parsed.minute) != (0, 0):
        stamp += parsed.strftime(", %-I:%M %p")
    return stamp

Tone = Literal["professional", "friendly", "exciting", "minimal", "urgent"]
Length = Literal["short", "medium", "long"]
ContentSection = Literal[
    "title",
    "shortDescription",
    "detailedDescription",
    "bannerText",
    "pushNotification",
    "socialCaption",
]


class Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class ShopProfile(Base):
    """Non-sensitive description of the merchant asking for help."""

    name: str | None = None
    description: str | None = None
    categories: list[str] = Field(default_factory=list)
    city: str | None = None
    branchCount: int = 0
    currency: str = "INR"


class OfferPerformance(Base):
    """One historical offer with its observed funnel (§11)."""

    title: str
    offerType: str | None = None
    offerText: str | None = None
    categoryName: str | None = None
    discountType: str | None = None
    discountValue: float | None = None
    buyQuantity: int | None = None
    getQuantity: int | None = None
    startDate: str | None = None
    endDate: str | None = None
    durationDays: int | None = None
    views: int = 0
    clicks: int = 0
    claims: int = 0
    redemptions: int = 0
    favorites: int = 0


class RadiusBand(Base):
    """Aggregated engagement for a distance band. Never per-customer (§12)."""

    label: str
    minKm: float
    maxKm: float | None = None
    views: int = 0
    claims: int = 0
    redemptions: int = 0


class DayPerformance(Base):
    weekday: str
    views: int = 0
    claims: int = 0
    redemptions: int = 0


class HourPerformance(Base):
    hour: int
    views: int = 0
    claims: int = 0


class CategoryTrend(Base):
    """Category-level, area-level aggregate only - never a named competitor (§31)."""

    categoryName: str
    activeOffers: int = 0
    views: int = 0
    claims: int = 0


class MerchantContext(Base):
    """Everything factual the model is allowed to reason from.

    ``dataAvailability`` is what stops §38 from being violated: when a section is
    marked unavailable the prompt forbids referring to it at all, instead of
    letting the model fill the gap with a plausible-sounding pattern.
    """

    shop: ShopProfile = Field(default_factory=ShopProfile)
    previousOffers: list[OfferPerformance] = Field(default_factory=list)
    activeOffers: list[OfferPerformance] = Field(default_factory=list)
    radiusBands: list[RadiusBand] = Field(default_factory=list)
    dayPerformance: list[DayPerformance] = Field(default_factory=list)
    hourPerformance: list[HourPerformance] = Field(default_factory=list)
    categoryTrends: list[CategoryTrend] = Field(default_factory=list)
    availableCategories: list[str] = Field(default_factory=list)
    availableProducts: list[str] = Field(default_factory=list)

    historyAvailable: bool = False
    locationDataAvailable: bool = False
    timingDataAvailable: bool = False

    #: Feature flags resolved from the shop's plan (§3). The model is told which
    #: kinds of insight it may offer so a Business plan never gets Premium copy.
    allowHistoricalInsights: bool = False
    allowLocationInsights: bool = False
    allowTimingInsights: bool = False

    def has_any_history(self) -> bool:
        return bool(self.previousOffers) and self.historyAvailable


class OfferFacts(Base):
    """The authoritative offer. Generated copy is checked against this (§23)."""

    title: str | None = None
    productName: str | None = None
    categoryName: str | None = None
    shopName: str | None = None
    offerType: str | None = None
    offerText: str | None = None
    discountType: str | None = None
    discountValue: float | None = None
    originalPrice: float | None = None
    discountedPrice: float | None = None
    buyQuantity: int | None = None
    getQuantity: int | None = None
    minPurchase: float | None = None
    startDate: str | None = None
    endDate: str | None = None
    termsConditions: str | None = None
    eligibility: str | None = None
    usageRestrictions: str | None = None
    applicableProducts: str | None = None
    currency: str = "INR"
    branchLabel: str | None = None

    def as_prompt_lines(self) -> list[str]:
        """Only the fields that are actually set - absent means "do not mention"."""
        labels = {
            "title": "Offer title",
            "productName": "Product",
            "categoryName": "Category",
            "shopName": "Shop",
            "offerType": "Offer type",
            "offerText": "Headline",
            "discountType": "Discount type",
            "discountValue": "Discount value",
            "originalPrice": "Original price",
            "discountedPrice": "Discounted price",
            "buyQuantity": "Buy quantity",
            "getQuantity": "Free/get quantity",
            "minPurchase": "Minimum purchase",
            "startDate": "Starts",
            "endDate": "Ends",
            "termsConditions": "Merchant terms",
            "eligibility": "Eligibility",
            "usageRestrictions": "Usage restrictions",
            "applicableProducts": "Applicable products",
            "branchLabel": "Locations",
        }
        lines: list[str] = []
        for key, label in labels.items():
            value = getattr(self, key, None)
            if value is None or value == "":
                continue
            if key in ("startDate", "endDate"):
                value = format_date(value)
            if key in ("originalPrice", "discountedPrice", "minPurchase"):
                value = f"{self.currency} {format_amount(value)}"
            if key == "discountValue":
                value = (
                    f"{format_amount(value)}%"
                    if self.discountType == "percentage"
                    else f"{self.currency} {format_amount(value)}"
                )
            lines.append(f"- {label}: {value}")
        return lines


class ContentControls(Base):
    """§18 - everything the admin can steer."""

    tone: Tone = "professional"
    length: Length = "medium"
    language: str = "English"
    targetAudience: str | None = None
    emoji: bool = True
    callToAction: str | None = None
    additionalNotes: str | None = None
    variants: int = Field(default=1, ge=1, le=3)


class Usage(Base):
    promptTokens: int = 0
    completionTokens: int = 0
    totalTokens: int = 0


class GenerationMeta(Base):
    provider: str
    model: str
    usage: Usage = Field(default_factory=Usage)
    attempts: int = 1
    #: Copy that failed the fact-guard and was repaired or removed (§23).
    warnings: list[str] = Field(default_factory=list)


class ErrorBody(Base):
    code: str
    message: str
    details: Any | None = None
