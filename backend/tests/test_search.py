"""
Tests for Universal Search endpoint.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_universal_search_unauthenticated(client: AsyncClient):
    """Unauthenticated search requests should fail with HTTP 403 or 401."""
    response = await client.get("/api/v1/search?q=test")
    assert response.status_code in (401, 403)
