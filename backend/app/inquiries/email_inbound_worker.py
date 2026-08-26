"""Automated Inbound Email Quotation Ingestion Worker.

Continuously listens to incoming supplier reply emails via IMAP (om1inhyma@gmail.com),
extracts quotation details and PDF attachments using Gemini/OpenAI, automatically creates
Quotation records in the ERP database, and broadcasts real-time WebSocket events to update
the ERP screen with zero manual clicks.
"""

from __future__ import annotations

import asyncio
import email
from email.header import decode_header
import imaplib
import logging
import os
from pathlib import Path
import re
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import and_, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.engine import get_sessionmaker
from app.events.channels import module_channel
from app.events.dispatcher import EventDispatcher
from app.events.models import Event
from app.inquiries.ai_extractor import extract_supplier_quotation
from app.inquiries.models import Inquiry, InquiryItem, Quotation, QuotationStatus, RFQ
from app.inquiries.public_quotes import decode_rfq_token
from app.masters.products.models import Product
from app.suppliers.models import Supplier
from app.users.models import User

logger = logging.getLogger(__name__)


def clean_decode_header(header_value: str | None) -> str:
    """Safely decode RFC2047 email headers (Subject, From, etc.)."""
    if not header_value:
        return ""
    decoded_parts = decode_header(header_value)
    result = []
    for text_bytes, charset in decoded_parts:
        if isinstance(text_bytes, bytes):
            try:
                result.append(text_bytes.decode(charset or "utf-8", errors="replace"))
            except Exception:
                result.append(text_bytes.decode("latin1", errors="replace"))
        else:
            result.append(str(text_bytes))
    return "".join(result)


def extract_email_address(from_header: str) -> str:
    """Extract clean email address from 'Sender Name <user@domain.com>' format."""
    match = re.search(r"<([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)>", from_header)
    if match:
        return match.group(1).lower().strip()
    match_bare = re.search(r"([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)", from_header)
    if match_bare:
        return match_bare.group(1).lower().strip()
    return from_header.lower().strip()


class EmailInboundWorker:
    """Background worker that continuously polls the procurement inbox for supplier quotes."""

    def __init__(self, poll_interval_seconds: int = 10) -> None:
        self.poll_interval = poll_interval_seconds
        self._task: asyncio.Task | None = None
        self._running = False
        self._dispatcher = EventDispatcher()
        self._cache_file = Path("processed_email_ids.json")
        self._seen_message_ids: set[str] = set()
        if self._cache_file.exists():
            try:
                import json
                with open(self._cache_file, "r") as f:
                    self._seen_message_ids = set(json.load(f))
            except Exception:
                pass
        self._initialized = bool(self._seen_message_ids)

    def _save_seen_id(self, msg_id: str) -> None:
        if not msg_id:
            return
        self._seen_message_ids.add(msg_id)
        try:
            import json
            with open(self._cache_file, "w") as f:
                json.dump(list(self._seen_message_ids), f, indent=2)
        except Exception:
            pass

    async def start(self) -> None:
        """Start the background email poller task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("Automated Inbound Email Quotation Worker started (polling every %ds).", self.poll_interval)

    async def stop(self) -> None:
        """Stop the background worker."""
        if not self._running:
            return
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Automated Inbound Email Quotation Worker stopped.")

    async def _poll_loop(self) -> None:
        """Main polling loop."""
        await asyncio.sleep(3)
        while self._running:
            try:
                await self._check_inbox_and_process()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in inbound email quotation check: %s", str(e), exc_info=True)

            try:
                await asyncio.sleep(self.poll_interval)
            except asyncio.CancelledError:
                break

    async def _check_inbox_and_process(self) -> None:
        """Connect to IMAP and process all UNSEEN emails."""
        smtp_user = os.getenv("SMTP_USER", "").strip()
        smtp_pass = os.getenv("SMTP_PASSWORD", "").strip()
        imap_host = os.getenv("IMAP_HOST", "imap.gmail.com").strip()
        imap_port = int(os.getenv("IMAP_PORT", "993"))

        if not smtp_user or not smtp_pass:
            return

        def _fetch_unread_emails() -> list[tuple[bytes, bytes]]:
            """Synchronous IMAP connection and recent reply email retrieval."""
            results = []
            try:
                mail = imaplib.IMAP4_SSL(imap_host, imap_port)
                mail.login(smtp_user, smtp_pass)
                mail.select("INBOX")
                # Search ALL messages and inspect recent 15 messages so emails opened in Gmail web are never missed!
                status, search_data = mail.search(None, 'ALL')
                if status == "OK" and search_data and search_data[0]:
                    email_ids = search_data[0].split()
                    recent_ids = email_ids[-15:]
                    for e_id in recent_ids:
                        res_status, msg_data = mail.fetch(e_id, "(RFC822)")
                        if res_status == "OK" and msg_data and msg_data[0]:
                            results.append((e_id, msg_data[0][1]))
                mail.close()
                mail.logout()
            except Exception as ex:
                logger.debug("IMAP polling check: %s", str(ex))
            return results

        # Run blocking IMAP network call in executor thread
        unread_emails = await asyncio.to_thread(_fetch_unread_emails)
        if not unread_emails:
            return

        # On initial boot, mark all existing emails as seen so only new emails arriving after start are processed
        if not self._initialized:
            for email_id, raw_bytes in unread_emails:
                try:
                    m = email.message_from_bytes(raw_bytes)
                    m_id = (m.get("Message-ID") or "").strip()
                    if m_id:
                        self._seen_message_ids.add(m_id)
                except Exception:
                    pass
            self._initialized = True
            try:
                import json
                with open(self._cache_file, "w") as f:
                    json.dump(list(self._seen_message_ids), f, indent=2)
            except Exception:
                pass
            logger.info("Initialized inbound email poller with %d existing mailbox messages.", len(self._seen_message_ids))
            return

        for email_id, raw_bytes in unread_emails:
            try:
                await self._process_single_email(raw_bytes)
            except Exception as err:
                logger.error("Failed to process inbound email: %s", str(err))

    async def _process_single_email(self, raw_email_bytes: bytes) -> None:
        """Parse raw email, extract quotation via AI, and save to ERP."""
        msg = email.message_from_bytes(raw_email_bytes)
        msg_id = (msg.get("Message-ID") or "").strip()
        if msg_id and msg_id in self._seen_message_ids:
            return
        if msg_id:
            self._save_seen_id(msg_id)

        from_raw = clean_decode_header(msg.get("From", ""))
        sender_email = extract_email_address(from_raw)
        subject = clean_decode_header(msg.get("Subject", ""))

        # Skip outbound emails that are not replies
        smtp_user = os.getenv("SMTP_USER", "").lower().strip()
        is_reply = subject.strip().lower().startswith("re:") or bool(msg.get("In-Reply-To"))
        if sender_email == smtp_user and not is_reply:
            return

        # Extract text body and attachments
        body_text_parts: list[str] = []
        attachments: list[dict[str, Any]] = []

        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                content_disp = str(part.get("Content-Disposition", ""))

                if "attachment" in content_disp or content_type in ["application/pdf", "image/png", "image/jpeg"]:
                    filename = clean_decode_header(part.get_filename() or "attachment")
                    payload_bytes = part.get_payload(decode=True)
                    if payload_bytes:
                        attachments.append({
                            "filename": filename,
                            "content_type": content_type,
                            "bytes": payload_bytes,
                        })
                elif content_type in ["text/plain", "text/html"] and "attachment" not in content_disp:
                    payload_bytes = part.get_payload(decode=True)
                    if payload_bytes:
                        try:
                            text = payload_bytes.decode(part.get_content_charset() or "utf-8", errors="replace")
                            body_text_parts.append(text)
                        except Exception:
                            pass
        else:
            payload_bytes = msg.get_payload(decode=True)
            if payload_bytes:
                text = payload_bytes.decode(msg.get_content_charset() or "utf-8", errors="replace")
                body_text_parts.append(text)

        full_body_text = "\n".join(body_text_parts).strip()
        if not full_body_text and not attachments:
            return

        # Extract text from attached PDF (if any) to aid supplier and product matching
        pdf_extra_text = ""
        if attachments and attachments[0].get("content_type") == "application/pdf":
            try:
                import io
                import pypdf
                reader = pypdf.PdfReader(io.BytesIO(attachments[0]["bytes"]))
                pdf_extra_text = "\n".join(p.extract_text() or "" for p in reader.pages)
            except Exception:
                pass

        full_search_text = f"{subject} {full_body_text} {pdf_extra_text}".lower()

        session_factory = get_sessionmaker()
        async with session_factory() as session:
            from app.suppliers.models import SupplierContact, SupplierEmail

            # 1. Match Supplier in ERP: First by Company Name in PDF/Text, then fallback to Email
            supplier: Supplier | None = None
            all_suppliers_res = await session.execute(select(Supplier).limit(100))
            for s in all_suppliers_res.scalars().all():
                s_name = (s.company_name or "").strip()
                if s_name and len(s_name) > 3 and s_name.lower() in full_search_text:
                    supplier = s
                    break

            if not supplier:
                s_email_res = await session.execute(
                    select(SupplierEmail).where(SupplierEmail.email.ilike(sender_email))
                )
                s_email = s_email_res.scalars().first()
                if s_email:
                    supplier = await session.get(Supplier, s_email.supplier_id)

            if not supplier:
                s_contact_res = await session.execute(
                    select(SupplierContact).where(SupplierContact.email.ilike(sender_email))
                )
                s_contact = s_contact_res.scalars().first()
                if s_contact:
                    supplier = await session.get(Supplier, s_contact.supplier_id)

            # 2. Match RFQ / Inquiry Item
            matched_item_id: uuid.UUID | None = None
            target_rfq: RFQ | None = None

            token_match = re.search(r"rfq[_-]([a-zA-Z0-9_\-]+)", full_body_text + " " + subject, re.IGNORECASE)
            if token_match:
                token_str = token_match.group(1)
                try:
                    payload = decode_rfq_token(token_str)
                    matched_item_id = uuid.UUID(payload["inquiry_item_id"])
                except Exception:
                    pass

            # B) Match by product code or name in subject/body
            matched_product: Product | None = None
            if not matched_item_id:
                all_items_res = await session.execute(
                    select(InquiryItem, Product)
                    .join(Product, InquiryItem.product_id == Product.id)
                    .order_by(InquiryItem.created_at.desc())
                    .limit(20)
                )
                for itm, prod in all_items_res.all():
                    if prod.product_code and prod.product_code.lower() in (subject + " " + full_body_text).lower():
                        matched_item_id = itm.id
                        matched_product = prod
                        break
                    if prod.product_name and len(prod.product_name) > 3 and prod.product_name.lower() in (subject + " " + full_body_text).lower():
                        matched_item_id = itm.id
                        matched_product = prod
                        break

            # C) If active RFQ sent to this supplier
            if not matched_item_id and supplier:
                rfq_res = await session.execute(
                    select(RFQ).order_by(RFQ.created_at.desc()).limit(10)
                )
                recent_rfqs = rfq_res.scalars().all()
                for r in recent_rfqs:
                    if r.supplier_ids and str(supplier.id) in r.supplier_ids:
                        matched_item_id = r.inquiry_item_id
                        target_rfq = r
                        break

            if not matched_item_id:
                logger.info("Inbound email received from %s, but no matching open inquiry item was found.", sender_email)
                return

            # Check if this exact quotation was already recorded (deduplicate)
            existing_remark_check = await session.execute(
                select(Quotation).where(
                    Quotation.inquiry_item_id == matched_item_id,
                    Quotation.remarks.ilike(f"%{msg_id[:30]}%") if msg_id else False,
                )
            )
            if existing_remark_check.scalars().first():
                return

            # Fetch InquiryItem details
            item_res = await session.execute(select(InquiryItem).where(InquiryItem.id == matched_item_id))
            item = item_res.scalars().first()
            if not item:
                return

            if not matched_product:
                p_res = await session.execute(select(Product).where(Product.id == item.product_id))
                matched_product = p_res.scalars().first()

            prod_name = matched_product.product_name if matched_product else "Product"
            prod_code = matched_product.product_code if matched_product else None

            target_date_str = str(target_rfq.expected_receiving_date) if target_rfq and target_rfq.expected_receiving_date else None

            # 3. Extract Quotation with AI (Gemini 2.5 Flash / OpenAI fallback)
            primary_attachment = attachments[0] if attachments else None
            ai_result = await extract_supplier_quotation(
                text_content=full_body_text,
                file_bytes=primary_attachment["bytes"] if primary_attachment else None,
                mime_type=primary_attachment["content_type"] if primary_attachment else None,
                product_name=prod_name,
                product_code=prod_code,
                target_quantity=float(item.quantity) if item.quantity else None,
                target_date=target_date_str,
            )

            # 4. If AI detected a valid quotation, insert into DB!
            if ai_result.is_quotation_detected and ai_result.unit_price is not None and ai_result.unit_price > 0:
                # Resolve creator user ID from parent Inquiry or default User
                inquiry_res = await session.execute(select(Inquiry).where(Inquiry.id == item.inquiry_id))
                parent_inquiry = inquiry_res.scalars().first()
                creator_user_id = parent_inquiry.created_by if parent_inquiry else None
                if not creator_user_id:
                    user_res = await session.execute(select(User.id).limit(1))
                    creator_user_id = user_res.scalar_one()

                # Resolve supplier ID
                quote_supplier_id = supplier.id if supplier else None
                if not quote_supplier_id:
                    first_supp = await session.execute(select(Supplier.id).limit(1))
                    quote_supplier_id = first_supp.scalar_one()

                quoted_qty = ai_result.quantity or float(item.quantity or 1.0)
                quoted_unit_price = float(ai_result.unit_price)
                quote_currency = ai_result.currency or "CNY"

                # Check if this exact email message was already processed (Deduplicate by Message-ID)
                if msg_id and len(msg_id) > 5:
                    clean_msg_sig = msg_id.strip("<>").strip()[:25]
                    existing_dup_check = await session.execute(
                        select(Quotation).where(
                            Quotation.inquiry_item_id == item.id,
                            Quotation.remarks.ilike(f"%{clean_msg_sig}%"),
                        )
                    )
                    if existing_dup_check.scalars().first():
                        logger.info("Email message %s already recorded for item %s. Skipping.", msg_id, item.id)
                        return

                # Generate clean quote number
                quote_count_res = await session.execute(
                    select(Quotation).where(Quotation.inquiry_item_id == item.id)
                )
                existing_count = len(quote_count_res.scalars().all())
                quote_number = f"QT-AUTO-{existing_count + 1:02d}"

                total_cost = round(quoted_qty * quoted_unit_price, 2)

                terms_parts: list[str] = []
                if ai_result.price_terms:
                    terms_parts.append(ai_result.price_terms)
                if ai_result.payment_terms:
                    terms_parts.append(ai_result.payment_terms)
                terms_combined = " • ".join(terms_parts) if terms_parts else None

                # 4. Save quotation attachment file to uploads/quotations if present
                saved_attachment_url = None
                saved_attachment_filename = None
                if attachments:
                    first_att = attachments[0]
                    raw_fname = first_att.get("filename") or "quote_document.pdf"
                    clean_fname = re.sub(r"[^\w\-.]", "_", raw_fname)
                    unique_fname = f"{uuid.uuid4().hex[:10]}_{clean_fname}"
                    quotation_dir = Path("uploads/quotations")
                    quotation_dir.mkdir(parents=True, exist_ok=True)
                    file_path = quotation_dir / unique_fname
                    try:
                        with open(file_path, "wb") as f:
                            f.write(first_att["bytes"])
                        saved_attachment_url = f"/uploads/quotations/{unique_fname}"
                        saved_attachment_filename = raw_fname
                        logger.info("Saved supplier attachment to %s", saved_attachment_url)
                    except Exception as save_err:
                        logger.error("Failed to save quotation attachment: %s", str(save_err))

                dedup_remark = f"{ai_result.remarks + ' | ' if ai_result.remarks else ''}Auto-extracted from {sender_email} [msg:{msg_id[:30]}]"
                new_quotation = Quotation(
                    id=uuid.uuid4(),
                    quote_number=quote_number,
                    inquiry_item_id=item.id,
                    supplier_id=quote_supplier_id,
                    quantity=quoted_qty,
                    unit_price=quoted_unit_price,
                    total_cost=total_cost,
                    currency=quote_currency,
                    expected_receiving_date=datetime.strptime(ai_result.earliest_available_date, "%Y-%m-%d").date()
                    if ai_result.earliest_available_date
                    else None,
                    terms_and_conditions=terms_combined,
                    remarks=dedup_remark,
                    attachment_url=saved_attachment_url,
                    attachment_filename=saved_attachment_filename,
                    status=QuotationStatus.PENDING,
                    created_by=creator_user_id,
                )
                session.add(new_quotation)
                await session.commit()
                logger.info(
                    "🎉 [AUTOMATED QUOTATION CREATED] Quote %s (Price: %s %s) saved for item %s from %s",
                    quote_number,
                    quoted_unit_price,
                    ai_result.currency,
                    item.id,
                    sender_email,
                )

                # 5. Broadcast real-time WebSocket event -> Updates ERP screen instantly!
                await self._dispatcher.publish(
                    module_channel("inquiries"),
                    Event(
                        entity="inquiry",
                        entity_id=str(item.inquiry_id),
                        event_type="quotation.created",
                        changes={
                            "id": str(new_quotation.id),
                            "inquiry_item_id": str(item.id),
                            "inquiry_id": str(item.inquiry_id),
                            "quote_number": quote_number,
                            "unit_price": quoted_unit_price,
                            "currency": ai_result.currency,
                            "status": "pending",
                        },
                    ),
                )


# Global worker instance
email_inbound_worker = EmailInboundWorker(poll_interval_seconds=15)
