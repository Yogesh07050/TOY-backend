"""AI Offer Assistant request/response models (§4-§8, §27, §28)."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from .common import Base, GenerationMeta, MerchantContext

BusinessGoal = Literal[
    "increase_sales",
    "clear_inventory",
    "attract_new_customers",
    "win_back_customers",
    "promote_new_product",
    "weekend_traffic",
    "store_visits",
    "promote_category",
    "other",
]

#: The app's own offer_type enum. The model is constrained to it so the
#: recommendation can drop straight into the offer form (§9).
OfferType = Literal["percentage", "flat", "buy_x_get_y", "price_drop", "up_to", "other"]
DiscountType = Literal["percentage", "flat", "none"]


class AssistantInput(Base):
    """§27 - none of the optional fields is mandatory."""

    goal: BusinessGoal = "increase_sales"
    goalLabel: str | None = None
    details: str | None = Field(default=None, max_length=2000)
    productOrCategory: str | None = Field(default=None, max_length=200)
    preferredDiscount: str | None = Field(default=None, max_length=120)
    targetCustomer: str | None = Field(default=None, max_length=200)
    locationRadiusKm: float | None = Field(default=None, ge=0, le=500)
    startDate: str | None = None
    endDate: str | None = None
    budget: str | None = Field(default=None, max_length=120)
    inventoryNotes: str | None = Field(default=None, max_length=1000)
    additionalInstructions: str | None = Field(default=None, max_length=1000)
    optionCount: int = Field(default=3, ge=1, le=3)


class AssistantRequest(Base):
    input: AssistantInput
    context: MerchantContext = Field(default_factory=MerchantContext)
    #: Set by /regenerate so the next set of ideas is not a repeat (§7).
    previousTitles: list[str] = Field(default_factory=list)
    refinement: str | None = Field(default=None, max_length=500)


class Reason(Base):
    """§11 - observed data and model judgement must stay distinguishable."""

    text: str
    basis: Literal["observed", "general"] = "general"


class Recommendation(Base):
    label: str
    title: str
    offerText: str | None = None
    description: str | None = None
    offerType: OfferType = "percentage"
    discountType: DiscountType = "percentage"
    discountValue: float | None = None
    buyQuantity: int | None = None
    getQuantity: int | None = None
    productName: str | None = None
    categoryName: str | None = None
    goal: str | None = None
    recommendedDurationDays: int | None = Field(default=None, ge=1, le=365)
    recommendedStartDate: str | None = None
    recommendedEndDate: str | None = None
    recommendedSchedule: str | None = None
    targetRadiusKm: float | None = Field(default=None, ge=0, le=500)
    reasoning: list[Reason] = Field(default_factory=list)
    tradeOffs: list[str] = Field(default_factory=list)


class AssistantResponse(Base):
    recommendations: list[Recommendation] = Field(default_factory=list)
    #: True when there was too little history to ground the advice (§38).
    insufficientData: bool = False
    dataNotes: list[str] = Field(default_factory=list)
    locationInsight: str | None = None
    timingInsight: str | None = None
    meta: GenerationMeta
