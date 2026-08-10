"""Validation utilities for Company List data import."""

from __future__ import annotations

from typing import Any


def validate_company_row(row: dict[str, Any], index: int) -> dict[str, Any]:
    """Validate a single CSV/Excel row during bulk import."""
    errors = []
    name = str(row.get("name") or row.get("company_name") or "").strip()
    if not name:
        errors.append(f"Row {index}: 'name' is required.")

    if errors:
        raise ValueError("; ".join(errors))

    return {
        "name": name,
        "code": str(row.get("code") or "").strip() or None,
        "status": str(row.get("status") or "active").strip().lower(),
    }
