"""Product Constants."""

from __future__ import annotations

MODULE_NAME = "products"
DROPDOWN_CACHE_NAME = "products"

IMPORT_HEADERS = [
    "product_code",
    "product_name",
    "barcode",
    "category_code",
    "sub_category_code",
    "brand_code",
    "hsn_code",
    "uom_code",
    "secondary_uom_code",
    "specification",
    "description",
    "weight",
    "length",
    "width",
    "height",
    "color",
    "material",
    "conversion_factor",
    "minimum_order_quantity",
    "reorder_level",
    "standard_cost",
    "standard_price",
    "is_purchasable",
    "is_sellable",
    "status",
]

EXPORT_HEADERS = [
    "Product Code",
    "Product Name (As Per Tally)",
    "Category",
    "Sub-Category",
    "Brand",
    "HSN Code",
    "UOM",
    "Secondary UOM",
    "Compliance & License Requirements",
    "Description",
    "Pack Gross Weight (Kg)",
    "Length (cm)",
    "Width (cm)",
    "Height (cm)",
    "Status",
]
