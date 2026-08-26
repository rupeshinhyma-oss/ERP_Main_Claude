"""OpenAI-Powered AI Quotation Extractor.

Extracts unit price, currency, quantity, lead times, target date feasibility,
and terms & conditions from raw supplier messages, images, and PDF quotation sheets
using OpenAI GPT-4o-mini.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from datetime import date, datetime
from typing import Any

import httpx
from dotenv import load_dotenv
from pydantic import BaseModel, Field

load_dotenv()

logger = logging.getLogger(__name__)

# Default OpenAI Model
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()


# ---------------------------------------------------------------------------
# Pydantic Schemas for AI Extraction
# ---------------------------------------------------------------------------

class ExtractedQuotation(BaseModel):
    is_quotation_detected: bool = Field(
        ...,
        description="True if the message/document contains actual quotation/pricing/delivery info. False if it is just a greeting, question, or unrelated message.",
    )
    unit_price: float | None = Field(
        None, description="The unit price quoted per piece/unit (as a numeric float, e.g. 185.0)."
    )
    currency: str | None = Field(
        "CNY", description="ISO Currency code: CNY (¥), USD ($), INR (₹), EUR (€), etc. Default CNY."
    )
    quantity: float | None = Field(
        None, description="The quoted quantity or MOQ. If not explicitly specified, defaults to inquiry quantity."
    )
    can_meet_target_date: bool | None = Field(
        None,
        description="True if the supplier confirmed they can deliver by the requested target date. False if they stated they cannot or proposed a later date.",
    )
    earliest_available_date: str | None = Field(
        None,
        description="The earliest delivery / dispatch date in YYYY-MM-DD format (or calculated from lead days).",
    )
    lead_time_days: int | None = Field(
        None, description="Number of days required for production / delivery (e.g. 10, 15, 30)."
    )
    price_terms: str | None = Field(
        None, description="Price terms, e.g. 'Ex-Factory (出厂价)', 'FOB Ningbo', 'CIF Mumbai', 'Tax Included (含税)'."
    )
    payment_terms: str | None = Field(
        None, description="Payment terms, e.g. '30% deposit, balance before shipment', '100% advance', 'Net 30'."
    )
    remarks: str | None = Field(
        None, description="Any additional technical specifications, packaging notes, or supplier remarks."
    )
    supplier_notes_summary: str | None = Field(
        None, description="A 1-2 sentence human-readable executive summary of the supplier's response in English."
    )
    provider_used: str = Field(f"openai-{OPENAI_MODEL}", description="AI Provider that completed the extraction.")


def extract_text_from_pdf_bytes(pdf_bytes: bytes) -> str:
    """Extract text from PDF quotation sheet bytes."""
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(pdf_bytes))
        extracted_pages = []
        for page in reader.pages:
            t = page.extract_text()
            if t:
                extracted_pages.append(t)
        return "\n".join(extracted_pages).strip()
    except Exception as e:
        logger.warning("Could not extract text from PDF: %s", str(e))
        return ""


def build_system_prompt(
    product_name: str | None,
    product_code: str | None,
    target_quantity: float | None,
    target_date: str | None,
) -> str:
    """Construct prompt for quotation extraction."""
    today_str = date.today().isoformat()
    return f"""You are an elite Procurement AI Assistant specializing in Chinese & Global B2B supplier quotation extraction.
Today's date is: {today_str}.

CONTEXT FOR INQUIRY:
- Target Product: {product_name or 'Not specified'}
- Product Code: {product_code or 'Not specified'}
- Target Quantity Required: {target_quantity or 'Not specified'} units
- Target Expected Receiving Date: {target_date or 'Not specified (Earliest possible delivery requested)'}

YOUR INSTRUCTIONS:
1. Determine if the input message, chat transcript, email, or document contains a genuine quotation / pricing offer / lead time for the inquiry item.
   - If the supplier just says "Hi", "Who are you?", "Let me check and get back to you", or casual conversation: set `is_quotation_detected: false` and set unit_price to null.
   - If pricing or delivery info is given: set `is_quotation_detected: true`.

2. ACCURATE PRICE EXTRACTION:
   - Extract the numeric unit price (e.g. if '180元/台' or 'USD 285', extract 180.0 or 285.0).
   - Detect Currency: 'CNY', 'USD', 'INR', 'EUR', 'GBP', 'HKD'. Default to 'CNY' for Chinese Yuan/RMB.
   - If a total price is given for a batch, compute the unit price = total / quantity.

3. DELIVERY & DATE CALCULATION:
   - If the supplier provides lead time (e.g. '10 days', '交期15天', '2 weeks'): extract `lead_time_days` as an integer.
   - Compute `earliest_available_date` in YYYY-MM-DD format by adding `lead_time_days` to today's date ({today_str}).
   - If a target receiving date was requested ({target_date or 'N/A'}), assess whether the supplier can meet it (`can_meet_target_date`: true / false / null).

4. TERMS EXTRACTION:
   - `price_terms`: e.g. 'Ex-Factory (出厂价)', 'FOB Ningbo', 'CIF Mumbai', 'Tax Included (含税)'.
   - `payment_terms`: e.g. '30% deposit, balance before shipment', '100% advance T/T', 'LC at sight'.
   - `remarks`: note MOQ, warranty, packaging, or validity periods.
   - `supplier_notes_summary`: a brief 1-2 sentence executive summary in English.

RETURN ONLY VALID JSON MATCHING THIS EXACT SCHEMA:
{{
  "is_quotation_detected": true/false,
  "unit_price": float or null,
  "currency": "CNY" / "USD" / "INR",
  "quantity": float or null,
  "can_meet_target_date": true/false/null,
  "earliest_available_date": "YYYY-MM-DD" or null,
  "lead_time_days": integer or null,
  "price_terms": string or null,
  "payment_terms": string or null,
  "remarks": string or null,
  "supplier_notes_summary": string or null
}}
"""


async def extract_supplier_quotation(
    text_content: str | None = None,
    file_bytes: bytes | None = None,
    mime_type: str | None = None,
    product_name: str | None = None,
    product_code: str | None = None,
    target_quantity: float | None = None,
    target_date: str | None = None,
) -> ExtractedQuotation:
    """Extract quotation from supplier text, images, or PDF documents using OpenAI GPT-4o-mini."""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured in backend .env file.")

    system_instruction = build_system_prompt(product_name, product_code, target_quantity, target_date)
    user_text = text_content or ""

    # If PDF is uploaded, extract its text
    if file_bytes and mime_type and ("pdf" in mime_type.lower() or mime_type == "application/pdf"):
        pdf_text = extract_text_from_pdf_bytes(file_bytes)
        if pdf_text:
            user_text += f"\n\n--- ATTACHED PDF QUOTATION CONTENT ---\n{pdf_text}"

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_instruction},
    ]

    # Handle image attachment with OpenAI Vision
    if file_bytes and mime_type and mime_type.startswith("image/"):
        b64_img = base64.b64encode(file_bytes).decode("utf-8")
        messages.append({
            "role": "user",
            "content": [
                {"type": "text", "text": user_text or "Please extract quotation details from this attached image quote."},
                {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{b64_img}"}},
            ],
        })
    else:
        messages.append({
            "role": "user",
            "content": user_text or "Please extract quotation details from the provided message.",
        })

    model_name = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()
    payload = {
        "model": model_name,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )

        if resp.status_code != 200:
            logger.error("OpenAI API returned error %d: %s", resp.status_code, resp.text)
            raise RuntimeError(f"OpenAI API error ({resp.status_code}): {resp.text}")

        res_data = resp.json()
        content_str = res_data["choices"][0]["message"]["content"]
        parsed_dict = json.loads(content_str)
        parsed_dict["provider_used"] = f"openai-{model_name}"

        return ExtractedQuotation.model_validate(parsed_dict)
