"""Inquiry Dependencies. FastAPI DI wiring for the inquiries module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.buyers.repository import BuyerRepository
from app.database.session import get_db_session
from app.inquiries.repository import ConsignmentCodeRepository, InquiryItemRepository, InquiryRepository
from app.inquiries.service import InquiryService
from app.masters.products.repository import ProductRepository


def get_inquiry_service(db: AsyncSession = Depends(get_db_session)) -> InquiryService:
    """Build a request-scoped :class:`InquiryService`, wired to every repository it needs."""
    return InquiryService(
        InquiryRepository(db),
        InquiryItemRepository(db),
        ConsignmentCodeRepository(db),
        BuyerRepository(db),
        ProductRepository(db),
    )
