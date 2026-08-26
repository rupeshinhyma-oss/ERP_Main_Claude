"""Inquiry Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.inquiries.models import InquiryConsignmentStatus, InquiryItemStatus

# ---------------------------------------------------------------------------
# Consignment Codes (admin-managed master)
# ---------------------------------------------------------------------------


class ConsignmentCodeCreate(BaseModel):
    """Document: "Master to create and choose from dropdown menu"."""

    code: str = Field(..., min_length=1, max_length=20, description='e.g. "FB1", "ING1".')
    label: str | None = Field(default=None, max_length=150)
    buyer_id: uuid.UUID
    branch_id: str | None = None


class ConsignmentCodeRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    label: str | None
    buyer_id: uuid.UUID
    branch_id: str | None = None
    status: str
    created_at: datetime


# ---------------------------------------------------------------------------
# Items (Layer 2: one product line within a consignment)
# ---------------------------------------------------------------------------


class InquiryItemCreate(BaseModel):
    """
    Payload for "Quick Access & Add New" -- both forms share this shape.

    Document: "From above fields, 'Brand Preference and Product Specs/
    Remarks' -- these 2 fields Optional, Rest all Mandatory fields in
    both forms."
    """

    buyer_id: uuid.UUID = Field(..., description="Inquiry by (buyer company name).")
    branch_id: str | None = None
    consignment_code_id: uuid.UUID
    product_id: uuid.UUID
    quantity: float = Field(..., gt=0)
    brand_preference: str | None = None
    product_specs_remarks: str | None = None
    status: InquiryItemStatus = Field(default=InquiryItemStatus.PROPOSED)


class InquiryItemUpdate(BaseModel):
    """Partial update. Quantity is editable; UOM/weight/CBM are not (see service docstring)."""

    quantity: float | None = Field(default=None, gt=0)
    brand_preference: str | None = None
    product_specs_remarks: str | None = None


class InquiryItemShift(BaseModel):
    """Document (Process Flow): "shifting between FB1 & FB2"."""

    to_consignment_code_id: uuid.UUID


class InquiryItemProcurementRemarksUpdate(BaseModel):
    """Document: "Remarks (by Yinglima China Procurement Team) ... added or edited from 'Action' Panel"."""

    remarks: str | None = None


class BulkTallyPostRequest(BaseModel):
    """Document: "some easy way to select and change multiple items to 'Posted'"."""

    item_ids: list[uuid.UUID] = Field(..., min_length=1)


class BulkItemLineCreate(BaseModel):
    product_id: uuid.UUID
    quantity: float = Field(gt=0, description="Quantity")
    brand_preference: str | None = Field(default=None, max_length=255)
    product_specs_remarks: str | None = Field(default=None)
    status: InquiryItemStatus = Field(default=InquiryItemStatus.PROPOSED)


class BulkInquiryItemCreate(BaseModel):
    """Payload for creating multiple inquiry items in a single request."""

    buyer_id: uuid.UUID
    branch_id: str | None = None
    consignment_code_id: uuid.UUID
    items: list[BulkItemLineCreate] = Field(..., min_length=1)


class InquiryItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    inquiry_id: uuid.UUID
    product_id: uuid.UUID
    uom_id: uuid.UUID
    quantity: float
    brand_preference: str | None
    product_specs_remarks: str | None
    status: InquiryItemStatus
    proposed_at: datetime
    proposed_by: uuid.UUID
    approved_at: datetime | None
    approved_by: uuid.UUID | None
    tally_entry_posted: bool
    tally_posted_at: datetime | None
    tally_posted_by: uuid.UUID | None
    procurement_remarks: str | None
    requires_license: bool
    product_name: str | None = None
    product_name_tally: str | None = None
    product_code: str | None = None
    uom_name: str | None = None
    uom_code: str | None = None
    license_details: str | None = None
    packaging_quantity: float | None = None
    packaging_gross_weight: float | None = None
    packaging_unit_cbm: float | None = None
    quotation_count: int = 0
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Quotations & RFQs
# ---------------------------------------------------------------------------


class QuotationCreate(BaseModel):
    supplier_id: uuid.UUID
    quantity: float = Field(..., gt=0)
    unit_price: float = Field(..., ge=0)
    total_cost: float = Field(..., ge=0)
    currency: str = Field(default="CNY", max_length=10)
    expected_receiving_date: str | None = None
    terms_and_conditions: str | None = None
    remarks: str | None = None
    attachment_url: str | None = None
    attachment_filename: str | None = None


class QuotationUpdate(BaseModel):
    quantity: float | None = Field(default=None, gt=0)
    unit_price: float | None = Field(default=None, ge=0)
    total_cost: float | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, max_length=10)
    expected_receiving_date: str | None = None
    terms_and_conditions: str | None = None
    remarks: str | None = None
    attachment_url: str | None = None
    attachment_filename: str | None = None


class QuotationStatusUpdate(BaseModel):
    status: str = Field(..., description="pending, approved, rejected, po_created")


class QuotationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    quote_number: str
    inquiry_item_id: uuid.UUID
    supplier_id: uuid.UUID
    supplier_name: str | None = None
    supplier_code: str | None = None
    quantity: float
    unit_price: float
    total_cost: float
    currency: str = "CNY"
    expected_receiving_date: date | str | None = None
    terms_and_conditions: str | None = None
    remarks: str | None = None
    attachment_url: str | None = None
    attachment_filename: str | None = None
    status: str
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class RFQCreate(BaseModel):
    expected_receiving_date: str | None = None
    supplier_type: str = Field(default="selected", description="all or selected")
    supplier_ids: list[uuid.UUID] = Field(default_factory=list)
    notes: str | None = None


class RFQRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    inquiry_item_id: uuid.UUID
    expected_receiving_date: date | str | None = None
    supplier_type: str
    supplier_ids: list[str] | None = None
    notes: str | None = None
    status: str
    created_by: uuid.UUID
    created_at: datetime


# ---------------------------------------------------------------------------
# Inquiries / Consignments (Layer 1)
# ---------------------------------------------------------------------------


class InquiryRead(BaseModel):
    """A consignment header, as returned by the API (Layer 1 detail view: "inside consignment layer")."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    buyer_id: uuid.UUID
    buyer_name: str | None = None
    branch_id: str | None = None
    consignment_code_id: uuid.UUID
    consignment_code: str | None = None
    consignment_status: InquiryConsignmentStatus
    total_cbm: float
    total_weight: float
    total_amount: float = 0.0
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime
    items: list[InquiryItemRead] = Field(default_factory=list)


class InquiryListItemRead(BaseModel):
    """One row in the Layer-1 "inside a company" list (document: "Columns in List (1st Layer)")."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    buyer_id: uuid.UUID
    buyer_name: str | None = None
    branch_id: str | None = None
    consignment_code_id: uuid.UUID
    consignment_code: str | None = None
    consignment_status: InquiryConsignmentStatus
    total_cbm: float
    total_weight: float
    total_amount: float = 0.0
    created_at: datetime
    updated_at: datetime


class CompanySummaryRead(BaseModel):
    """One row in the Layer-1 "company wise" summary (document: "1st layer summary is company wise")."""

    buyer_id: uuid.UUID
    company_name: str | None = None
    consignment_count: int
    proposed_count: int = 0
    approved_count: int = 0
    total_cbm: float
    total_weight: float
    total_amount: float = 0.0
    consignment_status: InquiryConsignmentStatus = InquiryConsignmentStatus.PROPOSED
    consignment_codes: list[str] = Field(default_factory=list)
    updated_at: datetime | None = None