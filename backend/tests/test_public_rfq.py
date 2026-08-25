import pytest
from httpx import AsyncClient
import uuid
from app.inquiries.public_quotes import generate_rfq_token

@pytest.mark.asyncio
async def test_public_rfq_workflow(client: AsyncClient):
    rfq_id = uuid.uuid4()
    item_id = uuid.uuid4()
    supplier_id = uuid.uuid4()

    # 1. Generate token
    token = generate_rfq_token(rfq_id, item_id, supplier_id)
    assert token is not None
    assert isinstance(token, str)

    # 2. Test invalid token
    invalid_res = await client.get("/api/v1/public/rfq/invalid-token-12345")
    assert invalid_res.status_code == 400

    # 3. Test valid token format but nonexistent item
    nonexistent_res = await client.get(f"/api/v1/public/rfq/{token}")
    assert nonexistent_res.status_code == 404
