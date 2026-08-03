"""
Combined List-Query Parameters.

Bundles :class:`~app.common.pagination.PageParams`,
:class:`~app.common.search.SearchParams`, :class:`~app.common.sorting.SortParams`,
and :class:`~app.common.filtering.FilterParams` into a single FastAPI
dependency, so every "list" route across every future module declares
exactly one dependency to get pagination, search, sorting, and dynamic
filtering, instead of four.

Usage::

    @router.get("/widgets")
    async def list_widgets(
        query: ListQueryParams = Depends(get_list_query_params),
        service: WidgetService = Depends(get_widget_service),
    ) -> dict:
        items, total = await service.list_paginated(query)
        meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
        return build_success_response(data=[...], request_id=..., meta=meta)
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends

from app.common.filtering import FilterParams, get_filter_params
from app.common.pagination import PageParams
from app.common.search import SearchParams
from app.common.sorting import SortParams


@dataclass
class ListQueryParams:
    """The combined pagination + search + sort + filter parameters for one request."""

    page: PageParams
    search: SearchParams
    sort: SortParams
    filters: FilterParams


def get_list_query_params(
    page: PageParams = Depends(),
    search: SearchParams = Depends(),
    sort: SortParams = Depends(),
    filters: FilterParams = Depends(get_filter_params),
) -> ListQueryParams:
    """FastAPI dependency: assemble the combined list-query parameters for one request."""
    return ListQueryParams(page=page, search=search, sort=sort, filters=filters)
