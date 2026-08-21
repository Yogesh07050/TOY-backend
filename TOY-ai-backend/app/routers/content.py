"""Content generation and offer improvement endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..schemas.content import (
    ContentRequest,
    ContentResponse,
    ImproveRequest,
    ImproveResponse,
)
from ..security import require_service_token
from ..services import content_service

router = APIRouter(prefix="/v1", tags=["content"], dependencies=[Depends(require_service_token)])


@router.post("/content/generate", response_model=ContentResponse)
async def generate(request: ContentRequest) -> ContentResponse:
    return await content_service.generate_content(request)


@router.post("/content/regenerate", response_model=ContentResponse)
async def regenerate(request: ContentRequest) -> ContentResponse:
    """Same call; previousVersions and refinement steer it away from a repeat (§34)."""
    return await content_service.generate_content(request)


@router.post("/offer/improve", response_model=ImproveResponse)
async def improve(request: ImproveRequest) -> ImproveResponse:
    return await content_service.improve_offer(request)
