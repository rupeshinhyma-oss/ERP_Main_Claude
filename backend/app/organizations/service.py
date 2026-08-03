"""
Organization Service.

Business logic for the single company profile: enforces that exactly one
``Organization`` row can ever exist, and caches the current profile under
the ``settings`` cache namespace (via :class:`CacheManager`), invalidating
it on every update.
"""

from __future__ import annotations

from typing import Any

from app.cache.manager import CacheManager
from app.core.exceptions import ConflictException, NotFoundException
from app.organizations.models import Organization
from app.organizations.repository import OrganizationRepository

_SETTINGS_CACHE_KEY = "organization_profile"


class OrganizationService:
    """Orchestrates management of the single organization profile."""

    not_found_message = (
        "No organization profile has been created yet. Create one via POST /organizations."
    )

    def __init__(self, repository: OrganizationRepository, cache_manager: CacheManager) -> None:
        """Bind this service to its repository and the shared cache manager."""
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_or_raise(self) -> Organization:
        """Return the organization profile (cached), or raise :class:`NotFoundException`."""
        cached = await self.cache_manager.get_setting(_SETTINGS_CACHE_KEY)
        if cached is not None:
            return cached
        organization = await self.repository.get_singleton()
        if organization is None:
            raise NotFoundException(self.not_found_message)
        await self.cache_manager.set_setting(_SETTINGS_CACHE_KEY, organization)
        return organization

    async def create(self, **field_values: Any) -> Organization:
        """Create the organization profile. Fails if one already exists (single-company only)."""
        existing = await self.repository.get_singleton()
        if existing is not None:
            raise ConflictException(
                "An organization profile already exists. This ERP supports only one company; "
                "use PATCH /organizations to update it instead."
            )
        organization = await self.repository.create(**field_values)
        await self.cache_manager.invalidate_settings()
        return organization

    async def update(self, **field_values: Any) -> Organization:
        """Update the single organization profile's fields."""
        organization = await self.repository.get_singleton()
        if organization is None:
            raise NotFoundException(self.not_found_message)
        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(organization, **changes)
        await self.cache_manager.invalidate_settings()
        return organization
