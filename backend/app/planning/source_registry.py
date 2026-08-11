"""
Source Module Registry for Shipment Planning dynamic columns.

The "extract data from other parts" feature (linked-lookup and aggregate
columns) needs to know, for a given module key like ``"product"``: which
repository to query, which fields it's safe to expose, and how to read a
field off a fetched record. This registry is the single place that
mapping lives, so plugging in a new source module later (Supplier, Buyer,
User, ...) is adding one entry here -- not touching
``app.planning.service`` or the schemas.

Each entry only exposes an explicit allow-list of fields (never "every
column on the table"), so a module can't accidentally leak an internal or
sensitive field just by existing in this registry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class SourceField:
    """One field a source module exposes for lookup/aggregation."""

    key: str
    label: str
    is_numeric: bool  # numeric fields can be used in AGGREGATE (sum/avg/min/max) and in FORMULA row_values


@dataclass(frozen=True)
class SourceModule:
    """One module a Planning column can pull data from."""

    key: str
    label: str
    repository_factory: Callable[[Any], Any]  # (AsyncSession) -> repository instance
    fields: tuple[SourceField, ...]
    value_getter: Callable[[Any, str], Any]  # (record, field_key) -> raw value


def _default_getter(record: Any, field_key: str) -> Any:
    return getattr(record, field_key, None)


def _product_getter(record: Any, field_key: str) -> Any:
    """
    Value getter for the Product Master source module.

    ``supplier_name`` and ``supplier_city`` are not real columns on
    ``Product`` -- they're transient attributes
    (``_planning_supplier_name`` / ``_planning_supplier_city``) that
    ``ProductRepository`` attaches in bulk after fetching, by resolving
    each product's primary linked supplier (see
    ``ProductRepository.attach_planning_supplier_info``). Falling back to
    plain ``getattr`` for every other field keeps this a drop-in
    replacement for ``_default_getter``.
    """
    if field_key == "supplier_name":
        return getattr(record, "_planning_supplier_name", None)
    if field_key == "supplier_city":
        return getattr(record, "_planning_supplier_city", None)
    return getattr(record, field_key, None)


def _build_product_module() -> SourceModule:
    from app.masters.products.repository import ProductRepository

    fields = (
        SourceField("product_code", "Product Code", is_numeric=False),
        SourceField("product_name", "Product Name", is_numeric=False),
        SourceField("uom_id", "UOM (ID)", is_numeric=False),
        SourceField("license_certificate_required", "License/Certificate Required", is_numeric=False),
        # --- Supplier info, resolved via the product's primary linked supplier ---
        # "Primary" = the first SupplierProductLink created for this product
        # (see ProductRepository.attach_planning_supplier_info) -- a product
        # can have multiple linked suppliers, but Shipment Planning only
        # ever needs the one exact supplier for that exact item.
        SourceField("supplier_name", "Supplier Name", is_numeric=False),
        SourceField("supplier_city", "City", is_numeric=False),
        # --- Packaging attributes, used by the fixed NO. OF PKG / TOTAL WEIGHT / TOTAL CBM formulas ---
        SourceField("packaging_quantity", "PKG QTY", is_numeric=True),
        SourceField("packaging_net_weight", "Packaging Net Weight", is_numeric=True),
        SourceField("packaging_gross_weight", "UNIT WEIGHT/PKG (KG)", is_numeric=True),
        SourceField("packaging_unit_cbm", "CBM/PKG (KG)", is_numeric=True),
        SourceField("current_stock", "Current Stock", is_numeric=True),
        SourceField("standard_cost", "Standard Cost", is_numeric=True),
        SourceField("standard_price", "Standard Price", is_numeric=True),
        SourceField("minimum_order_quantity", "Minimum Order Quantity", is_numeric=True),
        SourceField("reorder_level", "Reorder Level", is_numeric=True),
    )
    return SourceModule(
        key="product",
        label="Product Master",
        repository_factory=lambda session: ProductRepository(session),
        fields=fields,
        value_getter=_product_getter,
    )


def _build_supplier_module() -> SourceModule:
    from app.suppliers.repository import SupplierRepository

    fields = (
        SourceField("company_name", "Company Name", is_numeric=False),
        SourceField("supplier_grade", "Supplier Grade", is_numeric=False),
        SourceField("current_status", "Current Status", is_numeric=False),
    )
    return SourceModule(
        key="supplier",
        label="Suppliers",
        repository_factory=lambda session: SupplierRepository(session),
        fields=fields,
        value_getter=_default_getter,
    )


def _build_buyer_module() -> SourceModule:
    from app.buyers.repository import BuyerRepository

    fields = (
        SourceField("company_name", "Company Name", is_numeric=False),
        SourceField("buyer_grade", "Client Grade", is_numeric=False),
        SourceField("current_status", "Current Status", is_numeric=False),
    )
    return SourceModule(
        key="buyer",
        label="Buyers",
        repository_factory=lambda session: BuyerRepository(session),
        fields=fields,
        value_getter=_default_getter,
    )


# Registered lazily (factories, not instances) so importing this module never
# has to import every other module's repository up front -- each module's
# repository import only happens the first time that source is actually used.
_REGISTRY_BUILDERS: dict[str, Callable[[], SourceModule]] = {
    "product": _build_product_module,
    "supplier": _build_supplier_module,
    "buyer": _build_buyer_module,
}

_cache: dict[str, SourceModule] = {}


def get_source_module(key: str) -> SourceModule | None:
    """Return the registered SourceModule for ``key``, or None if not registered."""
    if key in _cache:
        return _cache[key]
    builder = _REGISTRY_BUILDERS.get(key)
    if builder is None:
        return None
    module = builder()
    _cache[key] = module
    return module


def list_source_modules() -> list[SourceModule]:
    """Return every registered source module (for the admin UI's dropdown)."""
    return [get_source_module(key) for key in _REGISTRY_BUILDERS]  # type: ignore[misc]


def get_source_field(module_key: str, field_key: str) -> SourceField | None:
    """Return the SourceField definition for (module_key, field_key), or None if not found/registered."""
    module = get_source_module(module_key)
    if module is None:
        return None
    return next((f for f in module.fields if f.key == field_key), None)