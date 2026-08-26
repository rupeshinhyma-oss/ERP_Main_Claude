import pytest
from app.inquiries.ai_extractor import (
    ExtractedQuotation,
    build_system_prompt,
)


def test_extracted_quotation_schema():
    data = {
        "is_quotation_detected": True,
        "unit_price": 185.5,
        "currency": "CNY",
        "quantity": 50.0,
        "can_meet_target_date": True,
        "earliest_available_date": "2026-09-20",
        "lead_time_days": 12,
        "price_terms": "Ex-Factory",
        "payment_terms": "30% deposit, 70% before delivery",
        "remarks": "Export wooden box packaging",
        "supplier_notes_summary": "Quoted 185.5 CNY per unit with 12 days delivery.",
        "provider_used": "openai-gpt-4o-mini",
    }
    quote = ExtractedQuotation.model_validate(data)
    assert quote.is_quotation_detected is True
    assert quote.unit_price == 185.5
    assert quote.currency == "CNY"
    assert quote.lead_time_days == 12
    assert quote.provider_used == "openai-gpt-4o-mini"


def test_build_system_prompt():
    prompt = build_system_prompt(
        product_name="Band Sealer",
        product_code="DAR-01562",
        target_quantity=50.0,
        target_date="2026-09-10",
    )
    assert "Band Sealer" in prompt
    assert "DAR-01562" in prompt
    assert "50.0" in prompt
