"""
Audit Service.

Exposes :meth:`AuditService.record`, the single entry point every other
module (and the audit middleware) uses to write an audit trail entry.
Deliberately never raises: a failure to write an audit row must never
block or roll back the business action that triggered it, so every
failure is logged and swallowed here instead of propagating.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.audit.constants import AuditAction
from app.audit.masking import to_safe_json
from app.audit.models import AuditLog
from app.audit.repository import AuditRepository
from app.core.logging import get_logger

logger = get_logger(__name__)


class AuditService:
    """Records audit trail entries. See module docstring for the non-raising contract."""

    def __init__(self, audit_repository: AuditRepository) -> None:
        self.audit_repository = audit_repository

    async def record(
        self,
        *,
        action: AuditAction,
        module: str,
        user_id: uuid.UUID | None = None,
        username_snapshot: str | None = None,
        entity_type: str | None = None,
        entity_id: str | None = None,
        old_values: dict[str, Any] | None = None,
        new_values: dict[str, Any] | None = None,
        ip_address: str | None = None,
        user_agent: str | None = None,
        request_id: str | None = None,
        http_method: str | None = None,
        endpoint: str | None = None,
        response_status: int | None = None,
        description: str | None = None,
    ) -> AuditLog | None:
        """
        Write one audit trail entry.

        ``old_values``/``new_values`` are masked (see
        :mod:`app.audit.masking`) before serialization, so callers never
        need to remember to scrub passwords/tokens/secrets themselves.

        Returns the created :class:`AuditLog`, or ``None`` if the write
        failed (the failure itself is logged, never raised).
        """
        try:
            return await self.audit_repository.create(
                action=action,
                module=module,
                user_id=user_id,
                username_snapshot=username_snapshot,
                entity_type=entity_type,
                entity_id=str(entity_id) if entity_id is not None else None,
                old_values=to_safe_json(old_values),
                new_values=to_safe_json(new_values),
                ip_address=ip_address,
                user_agent=(user_agent[:500] if user_agent else None),
                request_id=request_id,
                http_method=http_method,
                endpoint=endpoint,
                response_status=response_status,
                description=description,
            )
        except Exception:  # noqa: BLE001 - audit logging must never break the caller's request.
            logger.exception(
                "Failed to write audit log entry.",
                extra={"action": action.value, "module": module, "entity_type": entity_type},
            )
            return None
