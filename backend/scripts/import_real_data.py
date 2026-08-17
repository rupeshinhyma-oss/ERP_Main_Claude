"""
Real Data Import Script
=======================
1. Deletes dummy data in strict foreign-key order
2. Builds master data from Excel files:
     - Categories
     - Sub-Categories (linked to Categories)
     - Brands
     - UOMs
     - HSN Codes
     - Suppliers (Inhyma, Darsh, FNB)
3. Queries back all master IDs from DB to ensure 100% valid FK references
4. Imports all products from:
     - inhyma.xlsx  (1382 rows)
     - Darsh.xlsx   (697 rows)
     - fnb.xlsx     (770 rows)
   Each product is linked to its supplier.

Run from backend/:
    python scripts/import_real_data.py
"""

import sys
import re
import uuid
from decimal import Decimal, InvalidOperation
from pathlib import Path

import openpyxl
import psycopg2

# Force UTF-8 output if possible, else ASCII-safe printing
def safe_print(msg: str):
    try:
        print(msg)
    except UnicodeEncodeError:
        print(msg.encode("ascii", "replace").decode("ascii"))

safe_print("Connecting to database...")
conn = psycopg2.connect(
    host="aws-0-ap-south-1.pooler.supabase.com",
    port=5432,
    user="postgres.mpvzjzunkiqchhhvxrza",
    password="Inhyma@2026",
    dbname="postgres"
)
conn.autocommit = False
cur = conn.cursor()
safe_print("Connected [OK]")

DATA_DIR = Path(r"D:\OM work\ERP_Main_Claude-main\Data original")

# ==============================================================================
# HELPERS
# ==============================================================================
def new_id() -> str:
    return str(uuid.uuid4())

def safe_decimal(val, default=None):
    if val is None or (isinstance(val, str) and not val.strip()):
        return default
    try:
        if isinstance(val, str):
            val = val.replace(",", "").replace("%", "").strip()
        return float(Decimal(str(val)))
    except (InvalidOperation, ValueError):
        return default

def clean_str(val) -> str | None:
    if val is None:
        return None
    s = str(val).strip()
    return s if s and s.lower() not in ("-", "n/a", "none", "", "null") else None

def clean_hsn(val) -> str | None:
    """Normalize HSN: strip %, remove float suffix like .0"""
    s = clean_str(val)
    if s is None:
        return None
    s = re.sub(r'\.0+$', '', s)
    s = s.replace('%', '').strip()
    return s if s else None

# ==============================================================================
# STEP 1 - CLEAR DUMMY DATA (in FK-safe order)
# ==============================================================================
safe_print("\n-- Step 1: Clearing dummy data -------------------------------------")

tables_to_clear = [
    ("inquiry_items",              "Inquiry Items"),
    ("buyer_sub_category_links",   "Buyer Sub-Category Links"),
    ("buyer_category_links",       "Buyer Category Links"),
    ("supplier_product_links",     "Supplier Product Links"),
    ("supplier_sub_category_links","Supplier Sub-Category Links"),
    ("supplier_category_links",    "Supplier Category Links"),
    ("supplier_contacts",          "Supplier Contacts"),
    ("supplier_emails",            "Supplier Emails"),
    ("products",                   "Products"),
    ("suppliers",                  "Suppliers"),
    ("product_sub_categories",     "Sub-Categories"),
    ("product_categories",         "Categories"),
    ("brands",                     "Brands"),
    ("units_of_measurement",       "UOMs"),
    ("hsn_codes",                  "HSN Codes"),
]

for table, label in tables_to_clear:
    try:
        cur.execute(f"DELETE FROM {table}")
        safe_print(f"  Cleared {label} ({cur.rowcount} rows deleted)")
    except Exception as e:
        safe_print(f"  Warning: Could not clear {table}: {e}")
        conn.rollback()

conn.commit()
safe_print("Dummy data cleared [OK]")

# Fetch valid non-deleted geo IDs for suppliers
cur.execute("SELECT id, name FROM cities WHERE deleted_at IS NULL AND name ILIKE '%Mumbai%' LIMIT 1")
city_row = cur.fetchone()
if not city_row:
    cur.execute("SELECT id, name FROM cities WHERE deleted_at IS NULL LIMIT 1")
    city_row = cur.fetchone()
city_id, _ = city_row

cur.execute("SELECT state_id FROM cities WHERE id = %s", (city_id,))
state_id = cur.fetchone()[0]

cur.execute("SELECT country_id FROM states WHERE id = %s", (state_id,))
country_id = cur.fetchone()[0]

# ==============================================================================
# STEP 2 - READ ALL THREE EXCEL FILES
# ==============================================================================
safe_print("\n-- Step 2: Reading Excel files -------------------------------------")

def read_excel(filename: str):
    path = DATA_DIR / filename
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()
    headers = [str(h).strip() if h else "" for h in rows[0]]
    data = []
    for row in rows[1:]:
        if any(cell is not None for cell in row):
            data.append(dict(zip(headers, row)))
    return headers, data

_, inhyma_rows  = read_excel("inhyma.xlsx")
_, darsh_rows   = read_excel("Darsh.xlsx")
_, fnb_rows     = read_excel("fnb.xlsx")

safe_print(f"  inhyma.xlsx : {len(inhyma_rows)} rows")
safe_print(f"  Darsh.xlsx  : {len(darsh_rows)} rows")
safe_print(f"  fnb.xlsx    : {len(fnb_rows)} rows")

# ==============================================================================
# STEP 3 - COLLECT UNIQUE MASTER VALUES FROM ALL FILES
# ==============================================================================
safe_print("\n-- Step 3: Collecting unique master values --------------------------")

cat_sub_map: dict[str, set] = {}
brands: set[str] = set()
uoms: set[str] = set()
hsns: set[str] = set()

INHYMA_DARSH_COL_MAP = {
    "category":     "Category",
    "sub_category": "Sub Cate.",
    "brand":        "Brand",
    "uom":          "UOM",
    "hsn":          "HSN",
}
FNB_COL_MAP = {
    "category":     "Category",
    "sub_category": "Sub Category",
    "brand":        "Brand",
    "uom":          "UOM",
    "hsn":          "HSN",
}

def harvest(rows, col_map):
    for row in rows:
        cat   = clean_str(row.get(col_map["category"]))
        sub   = clean_str(row.get(col_map["sub_category"]))
        brand = clean_str(row.get(col_map["brand"]))
        uom   = clean_str(row.get(col_map["uom"]))
        hsn   = clean_hsn(row.get(col_map["hsn"]))

        if cat:
            if cat not in cat_sub_map:
                cat_sub_map[cat] = set()
            if sub:
                cat_sub_map[cat].add(sub)
        if brand:
            brands.add(brand)
        if uom:
            uoms.add(uom.upper().strip())
        if hsn:
            hsns.add(hsn)

harvest(inhyma_rows, INHYMA_DARSH_COL_MAP)
harvest(darsh_rows,  INHYMA_DARSH_COL_MAP)
harvest(fnb_rows,    FNB_COL_MAP)

# Fallback default UOMs
uoms.add("PCS")
uoms.add("NOS")
uoms.add("KG")
uoms.add("BAG")
uoms.add("SET")

safe_print(f"  Categories     : {len(cat_sub_map)}")
safe_print(f"  Sub-categories : {sum(len(v) for v in cat_sub_map.values())}")
safe_print(f"  Brands         : {len(brands)}")
safe_print(f"  UOMs           : {len(uoms)}")
safe_print(f"  HSN codes      : {len(hsns)}")

# ==============================================================================
# STEP 4 - INSERT MASTERS
# ==============================================================================
safe_print("\n-- Step 4: Inserting master data -----------------------------------")

# 4a - Categories
cat_idx = 1
for cat_name in sorted(cat_sub_map.keys()):
    cid = new_id()
    code = f"CAT-{cat_idx:03d}"
    cur.execute(
        """
        INSERT INTO product_categories (id, code, name, status, version, created_at, updated_at)
        VALUES (%s, %s, %s, 'ACTIVE', 1, now(), now())
        ON CONFLICT DO NOTHING
        """,
        (cid, code, cat_name)
    )
    cat_idx += 1

# 4b - Sub-Categories
# Query DB to get exact category IDs
cur.execute("SELECT id, name FROM product_categories")
db_cat_map = {name.strip().lower(): cid for cid, name in cur.fetchall()}

sub_idx = 1
for cat_name, subs in cat_sub_map.items():
    cat_id = db_cat_map.get(cat_name.strip().lower())
    if not cat_id:
        continue
    for sub_name in sorted(subs):
        sid = new_id()
        code = f"SUB-{sub_idx:04d}"
        cur.execute(
            """
            INSERT INTO product_sub_categories (id, category_id, code, name, status, version, created_at, updated_at)
            VALUES (%s, %s, %s, %s, 'ACTIVE', 1, now(), now())
            ON CONFLICT DO NOTHING
            """,
            (sid, cat_id, code, sub_name)
        )
        sub_idx += 1

# 4c - Brands
brand_idx = 1
for brand_name in sorted(brands):
    bid = new_id()
    code = f"BRD-{brand_idx:03d}"
    cur.execute(
        """
        INSERT INTO brands (id, code, name, status, version, created_at, updated_at)
        VALUES (%s, %s, %s, 'ACTIVE', 1, now(), now())
        ON CONFLICT DO NOTHING
        """,
        (bid, code, brand_name)
    )
    brand_idx += 1

# 4d - UOMs
uom_idx = 1
for uom_name in sorted(uoms):
    uid = new_id()
    code = uom_name.upper()[:10]
    cur.execute(
        """
        INSERT INTO units_of_measurement (id, code, name, short_name, status, version, created_at, updated_at)
        VALUES (%s, %s, %s, %s, 'ACTIVE', 1, now(), now())
        ON CONFLICT DO NOTHING
        """,
        (uid, code, uom_name, code)
    )
    uom_idx += 1

# 4e - HSN Codes
for hsn_code in sorted(hsns):
    hid = new_id()
    cur.execute(
        """
        INSERT INTO hsn_codes (id, code, description, gst_percent, refund_vat_percent, status, version, created_at, updated_at)
        VALUES (%s, %s, %s, 0.0, 0.0, 'ACTIVE', 1, now(), now())
        ON CONFLICT DO NOTHING
        """,
        (hid, hsn_code, f"HSN {hsn_code}")
    )

conn.commit()
safe_print("Master data committed [OK]")

# ==============================================================================
# STEP 5 - INSERT 3 SUPPLIERS (Inhyma, Darsh, FNB)
# ==============================================================================
safe_print("\n-- Step 5: Inserting Suppliers -------------------------------------")

for supplier_name in ["Inhyma", "Darsh", "FNB"]:
    sid = new_id()
    cur.execute(
        """
        INSERT INTO suppliers (
            id, company_name, country_id, state_id, city_id,
            visited_factory_office, is_active, version, created_at, updated_at
        )
        VALUES (%s, %s, %s, %s, %s, false, true, 1, now(), now())
        ON CONFLICT DO NOTHING
        """,
        (sid, supplier_name, country_id, state_id, city_id)
    )
    safe_print(f"  Supplier '{supplier_name}' inserted")

conn.commit()
safe_print("Suppliers committed [OK]")

# ==============================================================================
# STEP 6 - BUILD MASTER LOOKUPS DIRECTLY FROM DB (100% FK SAFETY)
# ==============================================================================
safe_print("\n-- Step 6: Querying authoritative DB lookups -----------------------")

cur.execute("SELECT id, name FROM product_categories")
cat_id_lookup = {name.strip().lower(): cid for cid, name in cur.fetchall()}

cur.execute("SELECT id, category_id, name FROM product_sub_categories")
sub_id_lookup = {(cat_id, name.strip().lower()): sid for sid, cat_id, name in cur.fetchall()}

cur.execute("SELECT id, name FROM brands")
brand_id_lookup = {name.strip().lower(): bid for bid, name in cur.fetchall()}

cur.execute("SELECT id, code, name FROM units_of_measurement")
uom_id_lookup = {}
for uid, code, name in cur.fetchall():
    uom_id_lookup[code.strip().upper()] = uid
    uom_id_lookup[name.strip().upper()] = uid

cur.execute("SELECT id, code FROM hsn_codes")
hsn_id_lookup = {code.strip(): hid for hid, code in cur.fetchall()}

cur.execute("SELECT id, company_name FROM suppliers")
supplier_id_lookup = {name.strip().lower(): sid for sid, name in cur.fetchall()}

fallback_uom_id = uom_id_lookup.get("PCS") or uom_id_lookup.get("NOS") or list(uom_id_lookup.values())[0]

safe_print(f"  Loaded {len(cat_id_lookup)} categories from DB")
safe_print(f"  Loaded {len(sub_id_lookup)} sub-categories from DB")
safe_print(f"  Loaded {len(brand_id_lookup)} brands from DB")
safe_print(f"  Loaded {len(uom_id_lookup)} UOM variations from DB")
safe_print(f"  Loaded {len(hsn_id_lookup)} HSN codes from DB")
safe_print(f"  Loaded {len(supplier_id_lookup)} suppliers from DB")

# ==============================================================================
# STEP 7 - IMPORT PRODUCTS
# ==============================================================================
safe_print("\n-- Step 7: Importing Products --------------------------------------")

inserted_total = 0
skipped_total  = 0

def import_products(rows, col_map, supplier_name, file_label):
    global inserted_total, skipped_total
    inserted = 0
    skipped  = 0
    supplier_id = supplier_id_lookup.get(supplier_name.strip().lower())

    for i, row in enumerate(rows, start=2):
        tally_name   = clean_str(row.get(col_map.get("tally_name", "Product Name (As per Tally)")))
        invoice_name = clean_str(row.get(col_map.get("invoice_name", "Product Name (As per Invoice)")))
        prod_code    = clean_str(row.get(col_map.get("code", "Product Code")))
        cat_name     = clean_str(row.get(col_map.get("category", "Category")))
        sub_name     = clean_str(row.get(col_map.get("sub_category", "Sub Cate.")))
        brand_name   = clean_str(row.get(col_map.get("brand", "Brand")))
        hsn_raw      = clean_hsn(row.get(col_map.get("hsn", "HSN")))
        uom_raw      = clean_str(row.get(col_map.get("uom", "UOM")))
        pack_qty     = safe_decimal(row.get(col_map.get("pack_qty", "Pack. Qty")))
        net_weight   = safe_decimal(row.get(col_map.get("net_weight", "Pack.Net.Weight")))
        gross_weight = safe_decimal(row.get(col_map.get("gross_weight", "Pack. Gross Weight")))
        length       = safe_decimal(row.get(col_map.get("length", "Length (CM)")))
        width        = safe_decimal(row.get(col_map.get("width", "Width (CM)")))
        height       = safe_decimal(row.get(col_map.get("height", "Height (CM)")))
        cbm          = safe_decimal(row.get(col_map.get("cbm", "Pack. Unit CBM")))
        spec         = clean_str(row.get(col_map.get("spec", "Product Specification")))

        if not tally_name:
            skipped += 1
            continue

        cat_id = cat_id_lookup.get(cat_name.strip().lower()) if cat_name else None
        if not cat_id:
            skipped += 1
            continue

        sub_id   = sub_id_lookup.get((cat_id, sub_name.strip().lower())) if (cat_id and sub_name) else None
        brand_id = brand_id_lookup.get(brand_name.strip().lower()) if brand_name else None
        hsn_id   = hsn_id_lookup.get(hsn_raw) if hsn_raw else None
        uom_id   = uom_id_lookup.get(uom_raw.upper().strip()) if uom_raw else fallback_uom_id

        if not uom_id:
            uom_id = fallback_uom_id

        # Generate product code if blank
        if not prod_code:
            prod_code = f"{supplier_name[:3].upper()}-{inserted_total + inserted + 1:05d}"

        # Ensure uniqueness
        base_code = prod_code
        attempt = 0
        while True:
            if attempt > 0:
                prod_code = f"{base_code}-{attempt}"
            cur.execute("SELECT 1 FROM products WHERE product_code = %s", (prod_code,))
            if not cur.fetchone():
                break
            attempt += 1

        pid = new_id()
        try:
            cur.execute(
                """
                INSERT INTO products (
                    id, product_code,
                    product_name, product_name_tally, product_name_invoice,
                    category_id, sub_category_id, brand_id, hsn_id, uom_id,
                    supplier_id,
                    packaging_quantity, packaging_net_weight, packaging_gross_weight,
                    length_cm, width_cm, height_cm, packaging_unit_cbm,
                    specification,
                    refund_vat_percent,
                    status, is_purchasable, is_sellable,
                    is_active_for_inventory, current_stock,
                    version, created_at, updated_at
                ) VALUES (
                    %s, %s,
                    %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s,
                    %s, %s, %s,
                    %s, %s, %s, %s,
                    %s,
                    0.0,
                    'ACTIVE', true, true,
                    true, 0,
                    1, now(), now()
                )
                """,
                (
                    pid, prod_code,
                    tally_name, tally_name, invoice_name,
                    cat_id, sub_id, brand_id, hsn_id, uom_id,
                    supplier_id,
                    pack_qty, net_weight, gross_weight,
                    length, width, height, cbm,
                    spec,
                )
            )
            inserted += 1
        except Exception as e:
            conn.rollback()
            safe_print(f"    Row {i}: Error inserting '{tally_name[:30]}': {e}")
            skipped += 1
            continue

    conn.commit()
    safe_print(f"  [{file_label}] Inserted: {inserted}, Skipped: {skipped}")
    inserted_total += inserted
    skipped_total  += skipped

INHYMA_DARSH_PROD_MAP = {
    "tally_name":   "Product Name (As per Tally)",
    "invoice_name": None,
    "code":         "Product Code",
    "category":     "Category",
    "sub_category": "Sub Cate.",
    "brand":        "Brand",
    "hsn":          "HSN",
    "uom":          "UOM",
    "pack_qty":     "Pack. Qty",
    "net_weight":   "Pack.Net.Weight",
    "gross_weight": "Pack. Gross Weight",
    "length":       "Length (CM)",
    "width":        "Width (CM)",
    "height":       "Height (CM)",
    "cbm":          "Pack. Unit CBM",
    "spec":         None,
}

FNB_PROD_MAP = {
    "tally_name":   "Product Name (As per Tally)",
    "invoice_name": "Product Name (As per EFRIS)",
    "code":         "Product Code",
    "category":     "Category",
    "sub_category": "Sub Category",
    "brand":        "Brand",
    "hsn":          "HSN",
    "uom":          "UOM",
    "pack_qty":     "Pack. Qty",
    "net_weight":   "Pack.Net.Weight",
    "gross_weight": "Pack. Gross Weight",
    "length":       None,
    "width":        None,
    "height":       None,
    "cbm":          "CBM",
    "spec":         "Product Specification",
}

import_products(inhyma_rows, INHYMA_DARSH_PROD_MAP, "Inhyma", "inhyma.xlsx")
import_products(darsh_rows,  INHYMA_DARSH_PROD_MAP, "Darsh",  "Darsh.xlsx")
import_products(fnb_rows,    FNB_PROD_MAP,           "FNB",   "fnb.xlsx")

# ==============================================================================
# SUMMARY
# ==============================================================================
safe_print("\n" + "=" * 60)
safe_print("IMPORT COMPLETE")
safe_print(f"  Products inserted : {inserted_total}")
safe_print(f"  Products skipped  : {skipped_total}")
safe_print(f"  Categories        : {len(cat_id_lookup)}")
safe_print(f"  Sub-Categories    : {len(sub_id_lookup)}")
safe_print(f"  Brands            : {len(brand_id_lookup)}")
safe_print(f"  UOMs              : {len(uom_id_lookup)}")
safe_print(f"  HSN Codes         : {len(hsn_id_lookup)}")
safe_print(f"  Suppliers         : {len(supplier_id_lookup)}")
safe_print("=" * 60)

cur.close()
conn.close()
