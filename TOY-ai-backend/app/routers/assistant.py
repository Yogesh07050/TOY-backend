"""AI Offer Assistant endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..schemas.assistant import AssistantRequest, AssistantResponse
from ..security import require_service_token
from ..services import assistant_service

router = APIRouter(
    prefix="/v1/assistant",
    tags=["assistant"],
    dependencies=[Depends(require_service_token)],
)


@router.post("/recommend", response_model=AssistantResponse)
async def recommend(request: AssistantRequest) -> AssistantResponse:
    return await assistant_service.recommend(request)


@router.post("/regenerate", response_model=AssistantResponse)
async def regenerate(request: AssistantRequest) -> AssistantResponse:
    """Same call; the caller supplies previousTitles so the ideas differ (§7)."""
    return await assistant_service.recommend(request)
