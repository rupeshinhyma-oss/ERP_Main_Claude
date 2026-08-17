"""
Universal Search FastAPI Router.

Provides an endpoint GET /api/v1/search for universal queries across all ERP models.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.core.responses import SuccessResponse, build_success_response
from app.database.session import get_db_session
from app.search.schemas import UniversalSearchResponse
from app.search.service import search_universal

router = APIRouter(prefix="/search", tags=["Universal Search"])


@router.get(
    "",
    response_model=SuccessResponse[UniversalSearchResponse],
    summary="Universal Search Across Entire Database",
    description=(
        "Executes keyword searches across all system tables (Organization, Users, Suppliers, "
        "Products, Categories, Brands, Master Data, etc.). Accessible "
        "by default to every authenticated user."
    ),
)
async def perform_universal_search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=100, description="Keyword search query"),
    db: AsyncSession = Depends(get_db_session),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Execute universal search and return enveloped standard JSON response."""
    result = await search_universal(db=db, query_str=q)
    request_id = getattr(request.state, "request_id", "-")
    return build_success_response(data=result.model_dump(mode="json"), request_id=request_id)
