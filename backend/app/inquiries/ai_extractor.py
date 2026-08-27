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

class ExtractedItemQuote(BaseModel):
    product_name: str | None = Field(None, description="The name or description of the product quoted.")
    product_code: str | None = Field(None, description="The model or code e.g. FR-900A, DBF-1000, DAR-01562.")
    unit_price: float | None = Field(None, description="The unit price quoted per piece/unit as a numeric float.")
    currency: str | None = Field("CNY", description="ISO Currency code: CNY, USD, INR, EUR, etc. Default CNY.")
    quantity: float | None = Field(None, description="The quoted quantity or MOQ.")
    earliest_available_date: str | None = Field(
        None, description="The earliest delivery / dispatch date in YYYY-MM-DD format."
    )
    lead_time_days: int | None = Field(None, description="Number of days required for production / delivery.")
    price_terms: str | None = Field(None, description="Price terms e.g. Ex-Factory, FOB Ningbo, CIF.")
    payment_terms: str | None = Field(None, description="Payment terms e.g. 30% deposit, balance before shipment.")
    remarks: str | None = Field(None, description="Any specific remarks, packaging, or notes for this product.")


class ExtractedQuotation(BaseModel):
    is_quotation_detected: bool = Field(
        ...,
        description="True if the message/document contains actual quotation/pricing/delivery info. False if it is just a greeting, question, or unrelated message.",
    )
    # Multi-product quotes list
    quotes: list[ExtractedItemQuote] = Field(
        default_factory=list,
        description="List of quotations for each individual product identified in the document or message.",
    )
    # Top-level / fallback fields for single-item backwards compatibility
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
    product_name: str | None = None,
    product_code: str | None = None,
    target_quantity: float | None = None,
    target_date: str | None = None,
    candidate_items: list[dict[str, Any]] | None = None,
) -> str:
    """Construct prompt for quotation extraction with candidate item mapping."""
    today_str = date.today().isoformat()

    candidates_block = ""
    if candidate_items:
        lines = []
        for idx, itm in enumerate(candidate_items, 1):
            c_code = itm.get("product_code") or "N/A"
            c_name = itm.get("product_name") or "Product"
            c_qty = itm.get("quantity") or "N/A"
            lines.append(f"  {idx}. [Product Code: {c_code}] {c_name} (Target Qty: {c_qty})")
        candidates_block = "OFFICIAL CANDIDATE PRODUCTS IN THIS INQUIRY CONSIGNMENT:\n" + "\n".join(lines) + "\n"
    elif product_name:
        candidates_block = f"TARGET PRODUCT: {product_name} (Code: {product_code or 'N/A'}, Qty: {target_quantity or 'N/A'})\n"

    return f"""You are an elite Procurement AI Assistant specializing in Chinese & Global B2B supplier quotation extraction for Yinglima.
Today's date is: {today_str}.

{candidates_block}
TARGET EXPECTED RECEIVING DATE: {target_date or 'Not specified (Earliest possible delivery requested)'}

YOUR INSTRUCTIONS:
1. Determine if the input message, chat transcript, email, or document contains genuine quotation / pricing offer / lead time for one or more products.
   - If the supplier just says "Hi", "Who are you?", "Let me check and get back to you", or casual conversation without prices: set `is_quotation_detected: false`.
   - If pricing or delivery info is given: set `is_quotation_detected: true`.

2. MULTI-PRODUCT MAPPING & EXTRACTION:
   - Identify every product quoted in the text body and/or attached document sheets.
   - Match each quoted item to one of the OFFICIAL CANDIDATE PRODUCTS above, even if the supplier used:
     * Short-forms / abbreviations (e.g. '900A' for 'FR 900A Band Sealer MSH')
     * Partial names or colloquial terms (e.g. 'rubber wheel' or 'roller' for 'Rubber Roller (FR900)')
     * Minor misspellings, typos, or slang.
   - For each quoted item, populate an object in the `quotes` array:
     * `product_code`: EXACT Product Code from the matching candidate above (e.g. 'DAR-01561', 'DAR-02020').
     * `product_name`: Official Product Name from the matching candidate above.
     * `unit_price`: Numeric unit price per piece (e.g. 180.0 or 4000.0). Do not include currency symbols in the number.
     * `currency`: ISO Currency code ('CNY', 'USD', 'INR', 'EUR'). If the supplier writes 'dollar' or '$', use 'USD'. If '元' or 'RMB', use 'CNY'. If 'rs' or 'rupees' or 'inr', use 'INR'. Default 'CNY'.
     * `quantity`: Quoted quantity or MOQ (if not explicitly specified, use the candidate's Target Qty).
     * `lead_time_days`: Production/delivery lead time in days.
     * `earliest_available_date`: YYYY-MM-DD calculated by adding lead_time_days to today's date ({today_str}). If supplier gave an explicit date, use that date in YYYY-MM-DD.
     * `price_terms`: e.g. 'Ex-Factory', 'FOB Ningbo', 'CIF'.
     * `payment_terms`: e.g. '30% deposit, balance before shipment'.
     * `remarks`: Any specifications, warranty, or packaging remarks for this item.

3. GLOBAL / SUMMARY FIELDS:
   - Also populate top-level `unit_price`, `currency`, `quantity`, `price_terms`, `payment_terms`, `remarks` (matching the first quote or overall summary for backwards compatibility).
   - `supplier_notes_summary`: A concise 1-2 sentence executive summary in English.

RETURN ONLY VALID JSON MATCHING THIS EXACT SCHEMA:
{{
  "is_quotation_detected": true/false,
  "quotes": [
    {{
      "product_name": "string or null",
      "product_code": "string or null",
      "unit_price": float or null,
      "currency": "CNY" / "USD" / "INR" / "EUR",
      "quantity": float or null,
      "earliest_available_date": "YYYY-MM-DD" or null,
      "lead_time_days": integer or null,
      "price_terms": "string or null",
      "payment_terms": "string or null",
      "remarks": "string or null"
    }}
  ],
  "unit_price": float or null,
  "currency": "CNY" / "USD" / "INR",
  "quantity": float or null,
  "can_meet_target_date": true/false/null,
  "earliest_available_date": "YYYY-MM-DD" or null,
  "lead_time_days": integer or null,
  "price_terms": "string or null",
  "payment_terms": "string or null",
  "remarks": "string or null",
  "supplier_notes_summary": "string or null"
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
    candidate_items: list[dict[str, Any]] | None = None,
) -> ExtractedQuotation:
    """Extract quotation from supplier text, images, or PDF documents using OpenAI GPT-4o-mini."""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured in backend .env file.")

    system_instruction = build_system_prompt(
        product_name=product_name,
        product_code=product_code,
        target_quantity=target_quantity,
        target_date=target_date,
        candidate_items=candidate_items,
    )
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

        # Normalize single vs multi-item fallback
        quotes_list = parsed_dict.get("quotes") or []
        if not quotes_list and parsed_dict.get("unit_price"):
            quotes_list.append({
                "product_name": product_name,
                "product_code": product_code,
                "unit_price": parsed_dict.get("unit_price"),
                "currency": parsed_dict.get("currency") or "CNY",
                "quantity": parsed_dict.get("quantity") or target_quantity,
                "earliest_available_date": parsed_dict.get("earliest_available_date"),
                "lead_time_days": parsed_dict.get("lead_time_days"),
                "price_terms": parsed_dict.get("price_terms"),
                "payment_terms": parsed_dict.get("payment_terms"),
                "remarks": parsed_dict.get("remarks"),
            })
            parsed_dict["quotes"] = quotes_list
        elif quotes_list and not parsed_dict.get("unit_price"):
            first_q = quotes_list[0]
            parsed_dict["unit_price"] = first_q.get("unit_price")
            parsed_dict["currency"] = first_q.get("currency") or "CNY"
            parsed_dict["quantity"] = first_q.get("quantity")
            parsed_dict["earliest_available_date"] = first_q.get("earliest_available_date")
            parsed_dict["lead_time_days"] = first_q.get("lead_time_days")
            parsed_dict["price_terms"] = first_q.get("price_terms")
            parsed_dict["payment_terms"] = first_q.get("payment_terms")
            parsed_dict["remarks"] = first_q.get("remarks")

        return ExtractedQuotation.model_validate(parsed_dict)
