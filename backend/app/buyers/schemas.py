"""Buyer Pydantic Schemas (request/response contracts)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.buyers.models import BuyerCurrentStatus, BuyerGrade, BuyerPotential, BuyerType
from app.buyers.validators import validate_phone_number

# ---------------------------------------------------------------------------
# Shared field validators (reused across create/update schemas)
# ---------------------------------------------------------------------------


def _phone_validator(field_label: str):
    """Build a Pydantic field_validator closure for a named phone field."""

    def _validate(cls, value: str | None) -> str | None:
        return validate_phone_number(value, field_label=field_label)

    return _validate


# ---------------------------------------------------------------------------
# Contacts ("Add Contacts of Buyer (Client)")
# ---------------------------------------------------------------------------


class BuyerContactCreate(BaseModel):
    """Payload to add a contact person to a buyer."""

    salutation: str | None = Field(default=None, max_length=10)
    person_name: str = Field(..., min_length=1, max_length=150)
    designation: str | None = Field(default=None, max_length=150)
    country_id: uuid.UUID | None = None
    calling_number: str | None = Field(default=None, max_length=20)
    whatsapp_number: str | None = Field(default=None, max_length=20)
    email: EmailStr | None = None

    _validate_calling = field_validator("calling_number")(_phone_validator("Calling number"))
    _validate_whatsapp = field_validator("whatsapp_number")(_phone_validator("WhatsApp number"))


class BuyerContactUpdate(BaseModel):
    """Payload to update an existing contact person. All fields optional (partial update)."""

    salutation: str | None = Field(default=None, max_length=10)
    person_name: str | None = Field(default=None, min_length=1, max_length=150)
    designation: str | None = Field(default=None, max_length=150)
    country_id: uuid.UUID | None = None
    calling_number: str | None = Field(default=None, max_length=20)
    whatsapp_number: str | None = Field(default=None, max_length=20)
    email: EmailStr | None = None

    _validate_calling = field_validator("calling_number")(_phone_validator("Calling number"))
    _validate_whatsapp = field_validator("whatsapp_number")(_phone_validator("WhatsApp number"))


class BuyerContactRead(BaseModel):
    """A buyer contact, as returned by the API."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    buyer_id: uuid.UUID
    salutation: str | None
    person_name: str
    designation: str | None
    country_id: uuid.UUID | None
    calling_number: str | None
    whatsapp_number: str | None
    email: str | None
    is_primary: bool
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Buyer (main form)
# ---------------------------------------------------------------------------


class BuyerCreate(BaseModel):
    """Payload to create a new buyer (client) profile."""

    company_name: str = Field(..., min_length=1, max_length=255)
    category_ids: list[uuid.UUID] = Field(default_factory=list, description="Product Category (multiple).")
    sub_category_ids: list[uuid.UUID] = Field(
        default_factory=list, description="Product Sub Category, potential products for buying from us (multiple)."
    )
    buyer_type: str | None = None
    country_id: uuid.UUID  # default Uganda applied by the caller (frontend/route), not forced here
    city: str | None = Field(default=None, max_length=150)
    address: str | None = None

    contact_salutation: str | None = Field(default=None, max_length=10)
    contact_full_name: str | None = Field(default=None, max_length=150)
    contact_designation: str | None = Field(default=None, max_length=150)
    contact_calling_number: str | None = Field(default=None, max_length=20)
    contact_whatsapp_number: str | None = Field(default=None, max_length=20)
    emails: list[str] = Field(default_factory=list, description="Email ID (multiple emails).")

    tax_id_number: str | None = Field(default=None, max_length=100)
    website: str | None = Field(default=None, max_length=500)
    current_status: BuyerCurrentStatus | None = None
    product_range: str | None = None
    potential: BuyerPotential | None = None
    potential_reason: str | None = None
    buyer_grade: BuyerGrade | None = None
    currently_buying_from: str | None = None
    overall_remarks: str | None = None
    is_active: bool = True

    _validate_calling = field_validator("contact_calling_number")(_phone_validator("Calling number"))
    _validate_whatsapp = field_validator("contact_whatsapp_number")(_phone_validator("WhatsApp number"))

    @field_validator("buyer_type", "current_status", "potential", "buyer_grade", mode="before")
    @classmethod
    def empty_str_to_none(cls, v: Any) -> Any:
        if isinstance(v, str) and not v.strip():
            return None
        return v


class BuyerUpdate(BaseModel):
    """Payload to update an existing buyer profile. All fields optional (partial update)."""

    company_name: str | None = Field(default=None, min_length=1, max_length=255)
    category_ids: list[uuid.UUID] | None = None
    sub_category_ids: list[uuid.UUID] | None = None
    buyer_type: str | None = None
    country_id: uuid.UUID | None = None
    city: str | None = Field(default=None, max_length=150)
    address: str | None = None

    contact_salutation: str | None = Field(default=None, max_length=10)
    contact_full_name: str | None = Field(default=None, max_length=150)
    contact_designation: str | None = Field(default=None, max_length=150)
    contact_calling_number: str | None = Field(default=None, max_length=20)
    contact_whatsapp_number: str | None = Field(default=None, max_length=20)
    emails: list[str] | None = None

    tax_id_number: str | None = Field(default=None, max_length=100)
    website: str | None = Field(default=None, max_length=500)
    current_status: BuyerCurrentStatus | None = None
    product_range: str | None = None
    potential: BuyerPotential | None = None
    potential_reason: str | None = None
    buyer_grade: BuyerGrade | None = None
    currently_buying_from: str | None = None
    overall_remarks: str | None = None
    is_active: bool | None = None

    _validate_calling = field_validator("contact_calling_number")(_phone_validator("Calling number"))
    _validate_whatsapp = field_validator("contact_whatsapp_number")(_phone_validator("WhatsApp number"))

    @field_validator("buyer_type", "current_status", "potential", "buyer_grade", mode="before")
    @classmethod
    def empty_str_to_none(cls, v: Any) -> Any:
        if isinstance(v, str) and not v.strip():
            return None
        return v


class BuyerGradeUpdate(BaseModel):
    """Inline list-view "editable dropdown" payload for Client Grade."""

    buyer_grade: BuyerGrade | None = None


class BuyerPotentialUpdate(BaseModel):
    """Inline list-view "editable dropdown" payload for Potential."""

    potential: BuyerPotential | None = None


class BuyerRead(BaseModel):
    """A buyer profile, as returned by the API (detail view)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    company_name: str
    buyer_type: str | None
    country_id: uuid.UUID
    city: str | None
    address: str | None

    contact_salutation: str | None
    contact_full_name: str | None
    contact_designation: str | None
    contact_calling_number: str | None
    contact_whatsapp_number: str | None

    tax_id_number: str | None
    website: str | None
    current_status: BuyerCurrentStatus | None
    product_range: str | None
    potential: BuyerPotential | None
    potential_reason: str | None
    buyer_grade: BuyerGrade | None
    currently_buying_from: str | None
    overall_remarks: str | None
    is_active: bool

    created_at: datetime
    updated_at: datetime

    emails: list[str] = Field(default_factory=list)
    contacts: list[BuyerContactRead] = Field(default_factory=list)
    category_ids: list[uuid.UUID] = Field(default_factory=list)
    sub_category_ids: list[uuid.UUID] = Field(default_factory=list)


class BuyerListItemRead(BaseModel):
    """A buyer, as returned in the list view (per the document's "Fields in List")."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    company_name: str
    buyer_type: str | None
    country_id: uuid.UUID
    current_status: BuyerCurrentStatus | None
    potential: BuyerPotential | None
    buyer_grade: BuyerGrade | None
    is_active: bool
    created_at: datetime
    updated_at: datetime

    category_ids: list[uuid.UUID] = Field(default_factory=list)
    sub_category_ids: list[uuid.UUID] = Field(default_factory=list)
