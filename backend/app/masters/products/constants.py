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
    "Product Name (As Per Tally)",
    "Product Code",
    "Supplier Company Name",
    "Brand",
    "Category",
    "Sub Category",
    "HSN Code",
    "UOM",
    "Organization",
    "Branches",
    "Pack. Qty",
    "Pack. Net Weight",
    "Pack. Gross Weight",
    "Length (cm)",
    "Width (cm)",
    "Height (cm)",
    "Pack. Unit CBM",
    "Refund VAT %",
    "Compliance & License Requirements",
    "Specification",
    "Status",
]
