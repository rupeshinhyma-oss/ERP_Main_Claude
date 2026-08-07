"""
Trash Service -- Queries and manages soft-deleted items across all system models.
"""

from __future__ import annotations

import uuid
from typing import Any, Type
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundException

# Import all models supporting soft-delete
from app.masters.products.models import Product
from app.masters.product_categories.models import ProductCategory
from app.masters.product_sub_categories.models import ProductSubCategory
from app.masters.brands.models import Brand
from app.masters.uom.models import UnitOfMeasurement
from app.masters.hsn.models import HsnCode
from app.masters.countries.models import Country
from app.masters.states.models import State
from app.masters.cities.models import City
from app.masters.currencies.models import Currency
from app.suppliers.models import Supplier
from app.users.models import User
from app.departments.models import Department

MODEL_MAP: dict[str, tuple[Type[Any], str, str | None]] = {
    "Product": (Product, "title", "sku"),
    "Category": (ProductCategory, "name", "code"),
    "SubCategory": (ProductSubCategory, "name", "code"),
    "Brand": (Brand, "name", "code"),
    "UOM": (UnitOfMeasurement, "name", "code"),
    "HSN Code": (HsnCode, "code", None),
    "Country": (Country, "name", "code"),
    "State": (State, "name", "code"),
    "City": (City, "name", None),
    "Currency": (Currency, "name", "code"),
    "Supplier": (Supplier, "company_name", "supplier_code"),
    "User": (User, "username", "employee_code"),
    "Department": (Department, "name", "code"),
}


class TrashService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_trash(self) -> list[dict[str, Any]]:
        """Return all soft-deleted records across registered models."""
        results: list[dict[str, Any]] = []

        for entity_type, (model_cls, name_attr, code_attr) in MODEL_MAP.items():
            if not hasattr(model_cls, "deleted_at"):
                continue

            stmt = select(model_cls).where(model_cls.deleted_at.is_not(None)).order_by(model_cls.deleted_at.desc())
            res = await self.db.execute(stmt)
            rows = res.scalars().all()

            for row in rows:
                name_val = getattr(row, name_attr, None) or f"{entity_type} {row.id}"
                if entity_type == "User" and hasattr(row, "first_name") and row.first_name:
                    name_val = f"{row.first_name} {row.last_name or ''}".strip()

                code_val = getattr(row, code_attr, None) if code_attr else None
                details = f"Code: {code_val}" if code_val else None

                results.append({
                    "id": str(row.id),
                    "entity_type": entity_type,
                    "name": str(name_val),
                    "details": details,
                    "deleted_at": row.deleted_at,
                })

        from datetime import datetime, timezone

        # Sort all trash items by deleted_at descending
        results.sort(key=lambda x: x["deleted_at"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
        return results

    async def restore_item(self, entity_type: str, item_id: str) -> bool:
        """Restore a single soft-deleted item by setting deleted_at = None."""
        if entity_type not in MODEL_MAP:
            raise NotFoundException(f"Unknown entity type '{entity_type}'.")

        model_cls, _, _ = MODEL_MAP[entity_type]
        uid = uuid.UUID(item_id)
        stmt = select(model_cls).where(model_cls.id == uid)
        res = await self.db.execute(stmt)
        row = res.scalar_one_or_none()

        if row is None:
            raise NotFoundException(f"{entity_type} with ID '{item_id}' not found.")

        row.deleted_at = None
        await self.db.commit()
        return True

    async def hard_delete_item(self, entity_type: str, item_id: str) -> bool:
        """Permanently delete a soft-deleted item from the database."""
        if entity_type not in MODEL_MAP:
            raise NotFoundException(f"Unknown entity type '{entity_type}'.")

        model_cls, _, _ = MODEL_MAP[entity_type]
        uid = uuid.UUID(item_id)
        stmt = select(model_cls).where(model_cls.id == uid)
        res = await self.db.execute(stmt)
        row = res.scalar_one_or_none()

        if row is None:
            raise NotFoundException(f"{entity_type} with ID '{item_id}' not found.")

        await self.db.delete(row)
        await self.db.commit()
        return True

    async def empty_trash(self) -> int:
        """Permanently hard-delete ALL soft-deleted records across all models."""
        count = 0
        for entity_type, (model_cls, _, _) in MODEL_MAP.items():
            if not hasattr(model_cls, "deleted_at"):
                continue
            stmt = select(model_cls).where(model_cls.deleted_at.is_not(None))
            res = await self.db.execute(stmt)
            rows = res.scalars().all()
            for row in rows:
                await self.db.delete(row)
                count += 1

        if count > 0:
            await self.db.commit()
        return count
