"""Audit Dependencies. FastAPI DI wiring for the audit module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.repository import AuditRepository
from app.audit.service import AuditService
from app.database.session import get_db_session


def get_audit_repository(db: AsyncSession = Depends(get_db_session)) -> AuditRepository:
    """Build a request-scoped :class:`AuditRepository`."""
    return AuditRepository(db)


def get_audit_service(audit_repository: AuditRepository = Depends(get_audit_repository)) -> AuditService:
    """Build a request-scoped :class:`AuditService`."""
    return AuditService(audit_repository)
