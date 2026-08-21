"""The fact guard (§23).

A model asked to write exciting copy about "30% OFF" will occasionally write
"50% OFF", and that mistake is a promise the merchant has to honour. So every
generated string is scanned for the kinds of claim that must be grounded -
percentages, money, quantities and dates - and each one is checked against the
offer the merchant actually created.

Anything that cannot be traced back to the offer is a violation. Violations are
fed back to the model once as a correction, and copy that still fails is dropped
rather than shown, because silently publishing a wrong discount is the one
outcome this feature must never produce.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..schemas.common import MerchantContext, OfferFacts

_PERCENT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|percent\b|per\s?cent\b)", re.IGNORECASE)
_MONEY = re.compile(
    r"(?:₹|rs\.?|inr|\$|usd|€)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:rupees|rs\b)",
    re.IGNORECASE,
)
_BUY_GET = re.compile(
    r"buy\s*(\d+)[^.\n]{0,24}?\bget\s*(\d+)",
    re.IGNORECASE,
)
_BUY_GET_SHORT = re.compile(r"\b(\d+)\s*\+\s*(\d+)\s*free\b", re.IGNORECASE)
_DAY_MONTH = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b",
    re.IGNORECASE,
)
_MONTH_DAY = re.compile(
    r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b",
    re.IGNORECASE,
)
_NUMERIC_DATE = re.compile(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b")

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

#: Claims the AI is never allowed to make, whatever the offer says (§23, §24).
_BANNED_PHRASES = [
    "guaranteed",
    "guarantee",
    "money back",
    "money-back",
    "lowest price ever",
    "best price in the market",
    "no terms",
    "no conditions",
    "unlimited stock",
    "free for everyone",
]


@dataclass
class Violation:
    section: str
    kind: str
    value: str
    text: str

    def describe(self) -> str:
        return f"{self.section}: unsupported {self.kind} '{self.value}'"


def _numbers(value: str) -> set[str]:
    """Every number in a merchant-authored string, normalised."""
    return {_normalise(match) for match in re.findall(r"\d[\d,]*(?:\.\d+)?", value or "")}


def _normalise(value: str | float | int | None) -> str:
    """'1,000.00' / 1000.0 / '1000' all collapse to '1000'."""
    if value is None:
        return ""
    text = str(value).replace(",", "").strip()
    try:
        number = float(text)
    except ValueError:
        return text.lower()
    return str(int(number)) if number.is_integer() else str(number)


def _parse_iso_date(value: str | None) -> tuple[int, int] | None:
    """(day, month) from an ISO-ish date string, or None."""
    if not value:
        return None
    match = re.search(r"(\d{4})-(\d{2})-(\d{2})", str(value))
    if not match:
        return None
    return int(match.group(3)), int(match.group(2))


class OfferFactGuard:
    """Knows which numeric claims a piece of copy about this offer may make."""

    def __init__(self, offer: OfferFacts) -> None:
        self.offer = offer
        self.allowed_numbers = self._allowed_numbers()
        self.allowed_percentages = self._allowed_percentages()
        self.allowed_pairs = self._allowed_pairs()
        self.allowed_dates = self._allowed_dates()

    # -- allow lists ------------------------------------------------------

    def _allowed_numbers(self) -> set[str]:
        offer = self.offer
        values: set[str] = set()
        for value in (
            offer.discountValue,
            offer.originalPrice,
            offer.discountedPrice,
            offer.buyQuantity,
            offer.getQuantity,
            offer.minPurchase,
        ):
            if value is not None:
                values.add(_normalise(value))

        # A saving the merchant's own numbers imply is a fact, not an invention.
        if offer.originalPrice is not None and offer.discountedPrice is not None:
            values.add(_normalise(offer.originalPrice - offer.discountedPrice))
            if offer.originalPrice:
                percent = (offer.originalPrice - offer.discountedPrice) / offer.originalPrice * 100
                values.add(_normalise(round(percent)))

        # Numbers the merchant already wrote into their own fields.
        for text in (
            offer.title,
            offer.offerText,
            offer.applicableProducts,
            offer.termsConditions,
            offer.eligibility,
            offer.usageRestrictions,
            offer.productName,
        ):
            values |= _numbers(text or "")

        values.discard("")
        return values

    def _allowed_percentages(self) -> set[str]:
        allowed = set(self.allowed_numbers)
        # 100% is only sayable when the offer really is a full-value giveaway.
        if self.offer.discountType != "percentage":
            allowed.discard("100")
        return allowed

    def _allowed_pairs(self) -> set[tuple[str, str]]:
        offer = self.offer
        if offer.buyQuantity and offer.getQuantity:
            return {(_normalise(offer.buyQuantity), _normalise(offer.getQuantity))}
        return set()

    def _allowed_dates(self) -> set[tuple[int, int]]:
        dates = {_parse_iso_date(self.offer.startDate), _parse_iso_date(self.offer.endDate)}
        return {date for date in dates if date}

    # -- checking ---------------------------------------------------------

    def check(self, section: str, text: str) -> list[Violation]:
        if not text:
            return []
        violations: list[Violation] = []

        for match in _PERCENT.finditer(text):
            value = _normalise(match.group(1))
            if value not in self.allowed_percentages:
                violations.append(Violation(section, "discount percentage", f"{value}%", text))

        for match in _MONEY.finditer(text):
            value = _normalise(match.group(1) or match.group(2))
            if value not in self.allowed_numbers:
                violations.append(Violation(section, "price", value, text))

        for pattern in (_BUY_GET, _BUY_GET_SHORT):
            for match in pattern.finditer(text):
                pair = (_normalise(match.group(1)), _normalise(match.group(2)))
                if self.allowed_pairs and pair not in self.allowed_pairs:
                    violations.append(
                        Violation(section, "quantity offer", f"buy {pair[0]} get {pair[1]}", text)
                    )
                elif not self.allowed_pairs:
                    violations.append(
                        Violation(section, "quantity offer", f"buy {pair[0]} get {pair[1]}", text)
                    )

        violations.extend(self._check_dates(section, text))

        lowered = text.lower()
        for phrase in _BANNED_PHRASES:
            if phrase in lowered:
                violations.append(Violation(section, "unsupported claim", phrase, text))

        return violations

    def _check_dates(self, section: str, text: str) -> list[Violation]:
        # With no offer window on record there is nothing to check against, and
        # guessing would produce false positives on phrases like "this weekend".
        if not self.allowed_dates:
            return []

        found: list[tuple[int, int]] = []
        for match in _DAY_MONTH.finditer(text):
            found.append((int(match.group(1)), _MONTHS[match.group(2)[:3].lower()]))
        for match in _MONTH_DAY.finditer(text):
            found.append((int(match.group(2)), _MONTHS[match.group(1)[:3].lower()]))
        for match in _NUMERIC_DATE.finditer(text):
            day, month = int(match.group(1)), int(match.group(2))
            if 1 <= day <= 31 and 1 <= month <= 12:
                found.append((day, month))

        return [
            Violation(section, "date", f"{day:02d}/{month:02d}", text)
            for day, month in found
            if (day, month) not in self.allowed_dates
        ]

    def check_all(self, sections: dict[str, list[str]]) -> list[Violation]:
        violations: list[Violation] = []
        for section, variants in sections.items():
            for variant in variants:
                violations.extend(self.check(section, variant))
        return violations


class ContextGuard:
    """Keeps the assistant's *reasoning* honest (§11, §12, §13, §38).

    The offer being recommended is a proposal, so its numbers are free. The
    justification is not: claiming "your weekend offers perform better" when no
    weekday data was supplied is exactly the fabrication §38 forbids.
    """

    def __init__(self, context: MerchantContext) -> None:
        self.context = context
        self.observed_numbers = self._observed_numbers()

    def _observed_numbers(self) -> set[str]:
        values: set[str] = set()
        for offer in [*self.context.previousOffers, *self.context.activeOffers]:
            for value in (
                offer.views,
                offer.clicks,
                offer.claims,
                offer.redemptions,
                offer.favorites,
                offer.discountValue,
                offer.buyQuantity,
                offer.getQuantity,
                offer.durationDays,
            ):
                if value is not None:
                    values.add(_normalise(value))
        for band in self.context.radiusBands:
            values |= {
                _normalise(band.minKm),
                _normalise(band.maxKm),
                _normalise(band.views),
                _normalise(band.claims),
                _normalise(band.redemptions),
            }
        for day in self.context.dayPerformance:
            values |= {_normalise(day.views), _normalise(day.claims), _normalise(day.redemptions)}
        for hour in self.context.hourPerformance:
            values |= {_normalise(hour.hour), _normalise(hour.views), _normalise(hour.claims)}
        for trend in self.context.categoryTrends:
            values |= {
                _normalise(trend.activeOffers),
                _normalise(trend.views),
                _normalise(trend.claims),
            }
        values.discard("")
        return values

    def may_claim_observed(self) -> bool:
        return self.context.allowHistoricalInsights and self.context.has_any_history()

    def sanitise_reason(self, text: str, basis: str) -> tuple[str, str] | None:
        """Return the reason with a trustworthy basis, or None to drop it."""
        if not text.strip():
            return None

        if basis == "observed" and not self.may_claim_observed():
            # It cannot be observed if nothing was observed. Downgrading rather
            # than dropping keeps a useful, honestly-labelled suggestion.
            basis = "general"

        # A statistic in the text has to come from the numbers we supplied.
        if basis == "observed":
            for number in re.findall(r"\d[\d,]*(?:\.\d+)?", text):
                if _normalise(number) not in self.observed_numbers:
                    return None
        elif re.search(r"\d[\d,]*\s*(?:views|clicks|claims|redemptions)", text, re.IGNORECASE):
            # General advice must not quote merchant statistics at all.
            return None

        return text.strip(), basis
