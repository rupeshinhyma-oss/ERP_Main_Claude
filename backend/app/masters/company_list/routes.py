"""Company List FastAPI Router."""

from __future__ import annotations

import uuid
from typing import Any
from fastapi import APIRouter, Depends, Query, Request, status
from fastapi.responses import Response

from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.masters.company_list.dependencies import get_company_service
from app.masters.company_list.schemas import CompanyCreate, CompanyRead, CompanyUpdate
from app.masters.company_list.service import CompanyService

router = APIRouter(prefix="/masters/company-list", tags=["Masters - Company List"])


@router.get("", summary="List companies")
async def list_companies(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: CompanyService = Depends(get_company_service),
) -> dict:
    """List companies with search/pagination."""
    companies, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [CompanyRead.model_validate(c).model_dump(mode="json") for c in companies]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/dropdown", summary="List companies for dropdowns")
async def list_companies_dropdown(
    request: Request,
    service: CompanyService = Depends(get_company_service),
) -> dict:
    """Return all active companies for dropdown options."""
    companies = await service.list_all_dropdown()
    data = [{"id": str(c.id), "name": c.name, "code": c.code, "branches": c.branches or []} for c in companies]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{company_id}", summary="Get company by ID")
async def get_company(
    request: Request,
    company_id: uuid.UUID,
    service: CompanyService = Depends(get_company_service),
) -> dict:
    """Get a single company by ID."""
    company = await service.get_by_id_or_raise(company_id)
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create company")
async def create_company(
    request: Request,
    payload: CompanyCreate,
    service: CompanyService = Depends(get_company_service),
) -> dict:
    """Create a new master company."""
    company = await service.create(**payload.model_dump(exclude_unset=True))
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.patch("/{company_id}", summary="Update company")
async def update_company(
    request: Request,
    company_id: uuid.UUID,
    payload: CompanyUpdate,
    service: CompanyService = Depends(get_company_service),
) -> dict:
    """Update an existing master company."""
    company = await service.update(company_id, **payload.model_dump(exclude_unset=True))
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource updated successfully.")


@router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete company")
async def delete_company(
    company_id: uuid.UUID,
    service: CompanyService = Depends(get_company_service),
) -> Response:
    """Delete a company."""
    await service.delete(company_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{company_id}/activate", summary="Activate company")
async def activate_company(
    request: Request,
    company_id: uuid.UUID,
    service: CompanyService = Depends(get_company_service),
) -> dict:
    """Activate a company."""
    company = await service.activate(company_id)
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{company_id}/deactivate", summary="Deactivate company")
async def deactivate_company(
    request: Request,
    company_id: uuid.UUID,
    service: CompanyService = Depends(get_company_service),
) -> dict:
    """Deactivate a company."""
    company = await service.deactivate(company_id)
    data = CompanyRead.model_validate(company).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)
