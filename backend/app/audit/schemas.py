"""Audit API Schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.audit.constants import AuditAction


class AuditLogRead(BaseModel):
    """Read-only representation of a single audit log entry."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    user_id: uuid.UUID | None
    username_snapshot: str | None
    action: AuditAction
    module: str
    entity_type: str | None
    entity_id: str | None
    old_values: str | None
    new_values: str | None
    ip_address: str | None
    user_agent: str | None
    request_id: str | None
    http_method: str | None
    endpoint: str | None
    response_status: int | None
    description: str | None
