"""
Universal Search Pydantic Schemas.
"""

from __future__ import annotations

from typing import Any
from pydantic import BaseModel, ConfigDict, Field


class SearchResultItem(BaseModel):
    """A single match item in universal search results."""

    model_config = ConfigDict(from_attributes=True)

    category: str = Field(..., description="Category label (e.g. Organization, Users, Suppliers, Products, Tasks, etc.)")
    id: str = Field(..., description="Entity primary key ID")
    title: str = Field(..., description="Main matching title (e.g., Company name, User name, Product name)")
    subtitle: str | None = Field(None, description="Secondary details (e.g., Email, Code, Description)")
    target_url: str = Field(..., description="Frontend destination relative URL")
    icon: str = Field("box", description="Icon identifier for visual rendering")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Additional context fields")


class UniversalSearchResponse(BaseModel):
    """Envelope containing universal search query results."""

    model_config = ConfigDict(from_attributes=True)

    query: str = Field(..., description="The query string executed")
    total_hits: int = Field(..., description="Total count of items matching the query")
    results: list[SearchResultItem] = Field(default_factory=list, description="Flat or grouped search results")
