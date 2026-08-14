"""
Pydantic Schemas for Trash Management.
"""

import uuid
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class TrashItemResponse(BaseModel):
    """Payload representing a single soft-deleted item in the trash."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    entity_type: str = Field(..., description="Module type (e.g. Product, Brand, Category, Supplier, User).")
    name: str = Field(..., description="Item display name or title.")
    details: str | None = Field(default=None, description="Optional extra detail (SKU, code, etc.).")
    deleted_at: datetime | None = Field(default=None, description="Timestamp when soft deleted.")
    purge_at: datetime | None = Field(
        default=None,
        description=(
            "Timestamp after which this item is eligible for automatic permanent "
            "deletion (deleted_at + the company's retention period, currently 4 "
            "years) if nobody restores it first. Informational only -- the "
            "background purge worker re-derives this from deleted_at at purge "
            "time rather than trusting this value."
        ),
    )


class TrashRestoreRequest(BaseModel):
    """Request payload to restore one or more soft-deleted items."""

    items: list[dict[str, str]] = Field(
        ...,
        description="List of dicts with 'entity_type' and 'id', e.g. [{'entity_type': 'Product', 'id': '...'}]",
    )


class TrashPermanentDeleteRequest(BaseModel):
    """Request payload to permanently hard-delete one or more items from the database."""

    items: list[dict[str, str]] = Field(
        ...,
        description="List of dicts with 'entity_type' and 'id', e.g. [{'entity_type': 'Product', 'id': '...'}]",
    )