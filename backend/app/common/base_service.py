"""
Base Service.

The service layer is where ALL business logic lives. Routes must never
contain business logic -- they only: parse/validate input (via Pydantic
schemas), call a service method, and shape the output (via the standard
response envelope). Repositories must never contain business logic -- they
only translate method calls into SQL.

:class:`BaseService` provides the common CRUD orchestration (look up or
raise ``NotFoundException``, delegate to the repository, etc.) that most
concrete services need, while leaving concrete services free to override
any method to add real business rules (uniqueness checks, cross-module
validation, event emission, etc.).
"""

from __future__ import annotations

import uuid
from typing import Any, Generic, TypeVar

from app.common.base_repository import BaseRepository
from app.core.exceptions import NotFoundException
from app.database.base import Base

ModelT = TypeVar("ModelT", bound=Base)


class BaseService(Generic[ModelT]):
    """
    Generic service layer built on top of a :class:`BaseRepository`.

    Attributes:
        repository: The repository this service delegates persistence to.
        not_found_message: Overridable message used when a lookup fails,
            so subclasses get an on-brand error message (e.g. "Department
            not found.") without overriding every method.
    """

    not_found_message: str = "Resource not found."

    def __init__(self, repository: BaseRepository[ModelT]) -> None:
        """Bind this service instance to a repository."""
        self.repository = repository

    async def get_by_id_or_raise(self, id_: uuid.UUID) -> ModelT:
        """Fetch a record by ID or raise :class:`NotFoundException`."""
        instance = await self.repository.get_by_id(id_)
        if instance is None:
            raise NotFoundException(self.not_found_message)
        return instance

    async def list_paginated(
        self,
        *,
        offset: int,
        limit: int,
        filters: dict[str, Any] | None = None,
        order_by: Any | None = None,
    ) -> tuple[list[ModelT], int]:
        """Return a page of records and the total matching count, for building a :class:`Page`."""
        items = await self.repository.list(offset=offset, limit=limit, filters=filters, order_by=order_by)
        total = await self.repository.count(filters=filters)
        return items, total

    async def create(self, **field_values: Any) -> ModelT:
        """Create a new record. Subclasses should override to add validation/business rules."""
        return await self.repository.create(**field_values)

    async def update(self, id_: uuid.UUID, **field_values: Any) -> ModelT:
        """Update an existing record by ID, raising :class:`NotFoundException` if missing."""
        instance = await self.get_by_id_or_raise(id_)
        return await self.repository.update(instance, **field_values)

    async def delete(self, id_: uuid.UUID) -> None:
        """Delete an existing record by ID, raising :class:`NotFoundException` if missing."""
        instance = await self.get_by_id_or_raise(id_)
        await self.repository.delete(instance)
