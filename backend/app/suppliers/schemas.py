"""Supplier Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.exceptions import BadRequestException
from app.suppliers.models import SupplierCurrentStatus, SupplierGrade, SupplierPotential, SupplierType
from app.suppliers.validators import validate_phone_number

# ---------------------------------------------------------------------------
# Shared field validators (reused across create/update schemas)
# ---------------------------------------------------------------------------


def _phone_validator(field_label: str):
    """Build a Pydantic field_validator closure for a named phone field."""

    def _validate(cls, value: str | None) -> str | None:
        try:
            return validate_phone_number(value, field_label=field_label)
        except BadRequestException as exc:
            raise ValueError(exc.message) from exc

    return _validate


# ---------------------------------------------------------------------------
# Contacts ("Add Contacts Form/List")
# ---------------------------------------------------------------------------


class SupplierContactCreate(BaseModel):
    """Payload to add a contact person to a supplier."""

    salutation: str | None = Field(default=None, max_length=10)
    person_name: str = Field(..., min_length=1, max_length=150)
    designation: str | None = Field(default=None, max_length=150)
    handling_territory: str | None = Field(default=None, max_length=150)
    country_id: uuid.UUID | None = None
    calling_number: str | None = Field(default=None, max_length=50)
    whatsapp_number: str | None = Field(default=None, max_length=50)
    wechat_number: str | None = Field(default=None, max_length=50)
    email: EmailStr | None = None

    _validate_calling = field_validator("calling_number")(_phone_validator("Calling number"))
    _validate_whatsapp = field_validator("whatsapp_number")(_phone_validator("WhatsApp number"))


class SupplierContactUpdate(BaseModel):
    """Payload to update an existing contact person. All fields optional (partial update)."""

    salutation: str | None = Field(default=None, max_length=10)
    person_name: str | None = Field(default=None, min_length=1, max_length=150)
    designation: str | None = Field(default=None, max_length=150)
    handling_territory: str | None = Field(default=None, max_length=150)
    country_id: uuid.UUID | None = None
    calling_number: str | None = Field(default=None, max_length=50)
    whatsapp_number: str | None = Field(default=None, max_length=50)
    wechat_number: str | None = Field(default=None, max_length=50)
    email: EmailStr | None = None

    _validate_calling = field_validator("calling_number")(_phone_validator("Calling number"))
    _validate_whatsapp = field_validator("whatsapp_number")(_phone_validator("WhatsApp number"))


class SupplierContactRead(BaseModel):
    """A supplier contact, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    supplier_id: uuid.UUID
    salutation: str | None
    person_name: str
    designation: str | None
    handling_territory: str | None
    country_id: uuid.UUID | None
    calling_number: str | None
    whatsapp_number: str | None
    wechat_number: str | None
    email: str | None
    is_primary: bool
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Supplier (First Data Form + Second Form combined)
# ---------------------------------------------------------------------------


class SupplierCreate(BaseModel):
    """Payload to create a new supplier profile."""

    # --- First data form ---
    company_name: str = Field(..., min_length=1, max_length=255)
    category_ids: list[uuid.UUID] = Field(default_factory=list, description="Product Category (multiple).")
    supplier_type: SupplierType | None = None
    brand_description: str | None = None
    country_id: uuid.UUID
    state_id: uuid.UUID
    city_id: uuid.UUID

    contact_salutation: str | None = Field(default=None, max_length=10)
    contact_full_name: str | None = Field(default=None, max_length=150)
    contact_designation: str | None = Field(default=None, max_length=150)
    contact_calling_number: str | None = Field(default=None, max_length=50)
    contact_whatsapp_number: str | None = Field(default=None, max_length=50)
    contact_wechat_number: str | None = Field(default=None, max_length=50)
    emails: list[EmailStr] = Field(default_factory=list, description="Email ID (multiple emails).")

    # --- Second form ---
    tax_id_number: str | None = Field(default=None, max_length=100)
    address: str | None = None
    town: str | None = Field(default=None, max_length=150)
    primary_website: str | None = Field(default=None, max_length=500)
    secondary_website: str | None = Field(default=None, max_length=500)
    sub_category_ids: list[uuid.UUID] = Field(
        default_factory=list, description="Key Strength Product Sub Category (multiple)."
    )
    product_ids: list[uuid.UUID] = Field(
        default_factory=list, description="Specific Products (Item Master) this supplier supplies (multiple)."
    )
    supplier_grade: SupplierGrade | None = None
    current_status: SupplierCurrentStatus | None = None
    potential: SupplierPotential | None = None
    potential_reason: str | None = None
    secondary_products_description: str | None = None
    visited_factory_office: bool = False
    visit_remarks: str | None = None
    visit_media: list[str] | None = None
    overall_remarks: str | None = None
    is_active: bool = True

    @field_validator("supplier_type", "supplier_grade", "current_status", "potential", mode="before")
    @classmethod
    def _normalize_enum_fields(cls, value: Any) -> Any:
        if isinstance(value, str):
            cleaned = value.strip()
            if not cleaned or cleaned.lower() in ("select", "-- select --", "-- select status --", "-- select potential --", "-- select grade --", "-- select type --"):
                return None
            if cleaned.lower().startswith("grade "):
                grade_letter = cleaned[6:].strip().upper()
                if grade_letter in ("A", "B", "C"):
                    return grade_letter
            lower_v = cleaned.lower()
            if lower_v in ("new", "existing", "yes", "no", "manufacturer", "trader"):
                return lower_v
            if cleaned.upper() in ("A", "B", "C"):
                return cleaned.upper()
            return cleaned
        return value

    _validate_calling = field_validator("contact_calling_number")(_phone_validator("Calling number"))
    _validate_whatsapp = field_validator("contact_whatsapp_number")(_phone_validator("WhatsApp number"))



class SupplierUpdate(BaseModel):
    """Payload to update an existing supplier profile. All fields optional (partial update)."""

    company_name: str | None = Field(default=None, min_length=1, max_length=255)
    category_ids: list[uuid.UUID] | None = None
    supplier_type: SupplierType | None = None
    brand_description: str | None = None
    country_id: uuid.UUID | None = None
    state_id: uuid.UUID | None = None
    city_id: uuid.UUID | None = None

    contact_salutation: str | None = Field(default=None, max_length=10)
    contact_full_name: str | None = Field(default=None, max_length=150)
    contact_designation: str | None = Field(default=None, max_length=150)
    contact_calling_number: str | None = Field(default=None, max_length=50)
    contact_whatsapp_number: str | None = Field(default=None, max_length=50)
    contact_wechat_number: str | None = Field(default=None, max_length=50)
    emails: list[EmailStr] | None = None

    tax_id_number: str | None = Field(default=None, max_length=100)
    address: str | None = None
    town: str | None = Field(default=None, max_length=150)
    primary_website: str | None = Field(default=None, max_length=500)
    secondary_website: str | None = Field(default=None, max_length=500)
    sub_category_ids: list[uuid.UUID] | None = None
    product_ids: list[uuid.UUID] | None = None
    supplier_grade: SupplierGrade | None = None
    current_status: SupplierCurrentStatus | None = None
    potential: SupplierPotential | None = None
    potential_reason: str | None = None
    secondary_products_description: str | None = None
    visited_factory_office: bool | None = None
    visit_remarks: str | None = None
    visit_media: list[str] | None = None
    overall_remarks: str | None = None
    is_active: bool | None = None

    @field_validator("supplier_type", "supplier_grade", "current_status", "potential", mode="before")
    @classmethod
    def _normalize_enum_fields(cls, value: Any) -> Any:
        if isinstance(value, str):
            cleaned = value.strip()
            if not cleaned or cleaned.lower() in ("select", "-- select --", "-- select status --", "-- select potential --", "-- select grade --", "-- select type --"):
                return None
            if cleaned.lower().startswith("grade "):
                grade_letter = cleaned[6:].strip().upper()
                if grade_letter in ("A", "B", "C"):
                    return grade_letter
            lower_v = cleaned.lower()
            if lower_v in ("new", "existing", "yes", "no", "manufacturer", "trader"):
                return lower_v
            if cleaned.upper() in ("A", "B", "C"):
                return cleaned.upper()
            return cleaned
        return value

    _validate_calling = field_validator("contact_calling_number")(_phone_validator("Calling number"))
    _validate_whatsapp = field_validator("contact_whatsapp_number")(_phone_validator("WhatsApp number"))



class SupplierGradeUpdate(BaseModel):
    """Payload for the list-view inline "editable dropdown" for Grade."""

    supplier_grade: SupplierGrade | None = None


class SupplierPotentialUpdate(BaseModel):
    """Payload for the list-view inline "editable dropdown" for Potential."""

    potential: SupplierPotential | None = None


class SupplierRead(BaseModel):
    """A supplier profile, as returned by the API (detail view)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    company_name: str
    supplier_type: SupplierType | None
    brand_description: str | None
    country_id: uuid.UUID
    state_id: uuid.UUID
    city_id: uuid.UUID

    contact_salutation: str | None
    contact_full_name: str | None
    contact_designation: str | None
    contact_calling_number: str | None
    contact_whatsapp_number: str | None
    contact_wechat_number: str | None

    tax_id_number: str | None
    address: str | None
    town: str | None
    primary_website: str | None
    secondary_website: str | None
    supplier_grade: SupplierGrade | None
    current_status: SupplierCurrentStatus | None
    potential: SupplierPotential | None
    potential_reason: str | None
    secondary_products_description: str | None
    visited_factory_office: bool
    visit_remarks: str | None
    visit_media: list[str] | None
    overall_remarks: str | None
    is_active: bool

    created_at: datetime
    updated_at: datetime

    # Derived / joined data, populated by the service layer before serialization.
    emails: list[str] = Field(default_factory=list)
    category_ids: list[uuid.UUID] = Field(default_factory=list)
    sub_category_ids: list[uuid.UUID] = Field(default_factory=list)
    product_ids: list[uuid.UUID] = Field(default_factory=list)
    contacts: list[SupplierContactRead] = Field(default_factory=list)


class SupplierListItemRead(BaseModel):
    """A supplier, as returned in the list view (per the document's "Fields in List")."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    company_name: str
    country_id: uuid.UUID
    state_id: uuid.UUID
    city_id: uuid.UUID
    brand_description: str | None
    supplier_type: SupplierType | None
    current_status: SupplierCurrentStatus | None
    supplier_grade: SupplierGrade | None
    potential: SupplierPotential | None
    is_active: bool
    created_at: datetime
    updated_at: datetime

    category_ids: list[uuid.UUID] = Field(default_factory=list)
    sub_category_ids: list[uuid.UUID] = Field(default_factory=list)
    product_ids: list[uuid.UUID] = Field(default_factory=list)
    secondary_products_description: str | None = None
    visit_media: list[str] | None = None
    media_urls: str | None = None


class ImportSummaryRead(BaseModel):
    """Result summary returned after a CSV/Excel import.

    ``duplicates`` holds every row that collided with an existing record
    (a subset of ``failed``), each with its full original row data and --
    when available -- the existing record it collided with, so the client
    can render a side-by-side comparison instead of just an error string.
    """

    total_rows: int
    created: int
    failed: int
    duplicate_count: int = 0
    errors: list[dict]
    duplicates: list[dict] = []
    in_file_duplicate_count: int = 0
    in_file_duplicates: list[dict] = []
