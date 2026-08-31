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

from app.common.storage import save_uploaded_file
from app.database.engine import get_sessionmaker
from app.events.channels import module_channel
from app.events.dispatcher import EventDispatcher
from app.events.models import Event
from app.inquiries.ai_extractor import extract_supplier_quotation
from app.inquiries.models import ConsignmentCode, Inquiry, InquiryItem, InquiryMessage, Quotation, QuotationStatus, RFQ
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
            """Synchronous IMAP connection and recent email retrieval (both INBOX and Sent Mail)."""
            results = []
            try:
                mail = imaplib.IMAP4_SSL(imap_host, imap_port)
                mail.login(smtp_user, smtp_pass)

                folders_to_poll = ["INBOX"]
                if "gmail" in imap_host.lower():
                    folders_to_poll.append('"[Gmail]/Sent Mail"')
                else:
                    folders_to_poll.append("Sent")

                for folder in folders_to_poll:
                    try:
                        sel_status, _ = mail.select(folder)
                        if sel_status != "OK":
                            continue
                        status, search_data = mail.search(None, 'ALL')
                        if status == "OK" and search_data and search_data[0]:
                            email_ids = search_data[0].split()
                            recent_ids = email_ids[-10:]
                            for e_id in recent_ids:
                                res_status, msg_data = mail.fetch(e_id, "(RFC822)")
                                if res_status == "OK" and msg_data and msg_data[0]:
                                    results.append((e_id, msg_data[0][1]))
                    except Exception as f_err:
                        logger.debug("Error reading folder %s: %s", folder, str(f_err))

                mail.close()
                mail.logout()
            except Exception as ex:
                logger.debug("IMAP polling check: %s", str(ex))
            return results

        # Run blocking IMAP network call in executor thread
        unread_emails = await asyncio.to_thread(_fetch_unread_emails)
        if not unread_emails:
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
        plain_text_parts: list[str] = []
        html_text_parts: list[str] = []
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
                elif content_type == "text/plain" and "attachment" not in content_disp:
                    payload_bytes = part.get_payload(decode=True)
                    if payload_bytes:
                        try:
                            text = payload_bytes.decode(part.get_content_charset() or "utf-8", errors="replace")
                            plain_text_parts.append(text)
                        except Exception:
                            pass
                elif content_type == "text/html" and "attachment" not in content_disp:
                    payload_bytes = part.get_payload(decode=True)
                    if payload_bytes:
                        try:
                            text = payload_bytes.decode(part.get_content_charset() or "utf-8", errors="replace")
                            html_text_parts.append(text)
                        except Exception:
                            pass
        else:
            payload_bytes = msg.get_payload(decode=True)
            if payload_bytes:
                text = payload_bytes.decode(msg.get_content_charset() or "utf-8", errors="replace")
                if msg.get_content_type() == "text/html":
                    html_text_parts.append(text)
                else:
                    plain_text_parts.append(text)

        # 1. Prefer pure plain text if present; otherwise strip HTML cleanly
        raw_body_text = ""
        if plain_text_parts:
            raw_body_text = "\n".join(plain_text_parts).strip()
        elif html_text_parts:
            import html
            raw_html = "\n".join(html_text_parts)
            raw_html = re.sub(r"<(script|style).*?>.*?</\1>", "", raw_html, flags=re.DOTALL | re.IGNORECASE)
            raw_html = re.sub(r"<blockquote.*?>.*?</blockquote>", "", raw_html, flags=re.DOTALL | re.IGNORECASE)
            raw_html = re.sub(r"<br\s*/?>|</p>|</div>|</li>", "\n", raw_html, flags=re.IGNORECASE)
            clean_t = re.sub(r"<[^>]+>", "", raw_html)
            raw_body_text = html.unescape(clean_t).strip()

        # 2. Cut off quoted previous email trail (e.g. "On Sat, Aug 29... wrote:")
        reply_split_patterns = [
            r"\n\s*On\s+.+?wrote:\s*\n",
            r"\n\s*On\s+.+?at\s+.+?wrote:\s*\n",
            r"\n\s*---\s*Original Message\s*---\s*\n",
            r"\n\s*From:\s*.+?\nSent:\s*",
            r"\n\s*_{10,}\s*\n",
        ]
        cleaned_body = raw_body_text
        for pat in reply_split_patterns:
            splits = re.split(pat, cleaned_body, maxsplit=1, flags=re.IGNORECASE)
            if len(splits) > 1:
                cleaned_body = splits[0].strip()

        full_body_text = re.sub(r"\n{3,}", "\n\n", cleaned_body).strip()
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

            # 1. Determine Outbound (Company/Salesperson) vs Inbound (Supplier)
            smtp_user = os.getenv("SMTP_USER", "").lower().strip()
            is_outbound = bool(smtp_user and (sender_email == smtp_user or "om1inhyma" in sender_email or "yinglima" in sender_email))

            # 2. Match Supplier in ERP
            supplier: Supplier | None = None
            if is_outbound:
                # For outbound emails, extract all recipient emails from "To" and "Cc"
                to_raw = clean_decode_header(msg.get("To", "")) + " " + clean_decode_header(msg.get("Cc", ""))
                to_emails = re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", to_raw)
                for rec_email in to_emails:
                    rec_clean = rec_email.strip().lower()
                    if rec_clean and rec_clean != smtp_user and "om1inhyma" not in rec_clean:
                        s_email_res = await session.execute(
                            select(SupplierEmail).where(SupplierEmail.email.ilike(rec_clean))
                        )
                        s_email = s_email_res.scalars().first()
                        if s_email:
                            supplier = await session.get(Supplier, s_email.supplier_id)
                            if supplier:
                                break
                        s_contact_res = await session.execute(
                            select(SupplierContact).where(SupplierContact.email.ilike(rec_clean))
                        )
                        s_contact = s_contact_res.scalars().first()
                        if s_contact:
                            supplier = await session.get(Supplier, s_contact.supplier_id)
                            if supplier:
                                break

                if not supplier:
                    all_suppliers_res = await session.execute(select(Supplier).limit(100))
                    for s in all_suppliers_res.scalars().all():
                        s_name = (s.company_name or "").strip()
                        if s_name and len(s_name) > 3 and s_name.lower() in (subject + " " + full_body_text).lower():
                            supplier = s
                            break
            else:
                # For inbound emails, match sender
                all_suppliers_res = await session.execute(select(Supplier).limit(100))
                for s in all_suppliers_res.scalars().all():
                    s_name = (s.company_name or "").strip()
                    if s_name and len(s_name) > 3 and s_name.lower() in (subject + " " + full_body_text).lower():
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

            # 3. Match Consignment / Inquiry Header
            matched_inquiry_id: uuid.UUID | None = None
            target_rfq: RFQ | None = None

            # A) Try RFQ token if present in body/subject
            token_match = re.search(r"rfq[_-]([a-zA-Z0-9_\-]+)", full_body_text + " " + subject, re.IGNORECASE)
            if token_match:
                token_str = token_match.group(1)
                try:
                    payload = decode_rfq_token(token_str)
                    token_item_id = uuid.UUID(payload["inquiry_item_id"])
                    item_obj = await session.get(InquiryItem, token_item_id)
                    if item_obj:
                        matched_inquiry_id = item_obj.inquiry_id
                except Exception:
                    pass

            # B) Match Consignment Code from Subject / Body (e.g. [FB2] or #FB2)
            if not matched_inquiry_id:
                code_match = re.search(r"\[([a-zA-Z0-9_\-]+)\]", subject) or re.search(r"#([a-zA-Z0-9_\-]+)", subject)
                if code_match:
                    found_code = code_match.group(1).strip()
                    cc_res = await session.execute(
                        select(ConsignmentCode).where(ConsignmentCode.code.ilike(found_code))
                    )
                    cc_obj = cc_res.scalars().first()
                    if cc_obj:
                        inq_res = await session.execute(
                            select(Inquiry).where(Inquiry.consignment_code_id == cc_obj.id)
                        )
                        inq_obj = inq_res.scalars().first()
                        if inq_obj:
                            matched_inquiry_id = inq_obj.id

            # C) Active RFQ match for this supplier
            if not matched_inquiry_id and supplier:
                rfq_res = await session.execute(
                    select(RFQ, InquiryItem)
                    .join(InquiryItem, RFQ.inquiry_item_id == InquiryItem.id)
                    .order_by(RFQ.created_at.desc())
                    .limit(10)
                )
                for r, r_item in rfq_res.all():
                    if r.supplier_ids and str(supplier.id) in r.supplier_ids:
                        matched_inquiry_id = r_item.inquiry_id
                        target_rfq = r
                        break

            # D) Fallback: Match by product code or name in recent inquiries
            if not matched_inquiry_id:
                all_items_res = await session.execute(
                    select(InquiryItem, Product)
                    .join(Product, InquiryItem.product_id == Product.id)
                    .order_by(InquiryItem.created_at.desc())
                    .limit(30)
                )
                for itm, prod in all_items_res.all():
                    if prod.product_code and prod.product_code.lower() in (subject + " " + full_body_text).lower():
                        matched_inquiry_id = itm.inquiry_id
                        break
                    if prod.product_name and len(prod.product_name) > 4 and prod.product_name.lower() in (subject + " " + full_body_text).lower():
                        matched_inquiry_id = itm.inquiry_id
                        break

            if not matched_inquiry_id:
                logger.info("Email received from %s, but no matching consignment was found.", sender_email)
                return

            # Fetch all items in this consignment
            consignment_items_res = await session.execute(
                select(InquiryItem, Product)
                .join(Product, InquiryItem.product_id == Product.id)
                .where(
                    InquiryItem.inquiry_id == matched_inquiry_id,
                    InquiryItem.deleted_at.is_(None),
                )
            )
            consignment_items = consignment_items_res.all()
            if not consignment_items:
                logger.info("No active items found in consignment %s.", matched_inquiry_id)
                return

            candidate_items_list = [
                {
                    "item_id": str(ci.id),
                    "product_code": cp.product_code or "N/A",
                    "product_name": cp.product_name or cp.product_name_tally or "Product",
                    "quantity": float(ci.quantity or 1.0),
                }
                for ci, cp in consignment_items
            ]

            first_item, first_prod = consignment_items[0]

            # 4. Resolve Target Product Item with Thread-Aware Inheritance
            target_matched_item = None

            # A) Check if email body/subject explicitly mentions a product code/name in this consignment
            for c_item, c_prod in consignment_items:
                cp_code = (c_prod.product_code or "").lower().strip()
                cp_name = (c_prod.product_name or c_prod.product_name_tally or "").lower().strip()
                if cp_code and len(cp_code) >= 3 and cp_code in (subject + " " + full_body_text).lower():
                    target_matched_item = c_item
                    break
                if cp_name and len(cp_name) > 4 and cp_name in (subject + " " + full_body_text).lower():
                    target_matched_item = c_item
                    break

            # B) Thread-Aware Item Inheritance (For short follow-up / negotiation emails)
            if not target_matched_item and supplier:
                # 1. Inherit from recent message in this consignment with this supplier
                prev_msg_res = await session.execute(
                    select(InquiryMessage)
                    .where(
                        InquiryMessage.inquiry_id == matched_inquiry_id,
                        InquiryMessage.supplier_id == supplier.id,
                        InquiryMessage.inquiry_item_id.isnot(None),
                    )
                    .order_by(InquiryMessage.created_at.desc())
                    .limit(1)
                )
                prev_msg = prev_msg_res.scalars().first()
                if prev_msg and prev_msg.inquiry_item_id:
                    for c_item, _ in consignment_items:
                        if c_item.id == prev_msg.inquiry_item_id:
                            target_matched_item = c_item
                            break

                # 2. Inherit from active quotation for this supplier in this consignment
                if not target_matched_item:
                    prev_quote_res = await session.execute(
                        select(Quotation)
                        .where(
                            Quotation.supplier_id == supplier.id,
                            Quotation.deleted_at.is_(None),
                        )
                        .order_by(Quotation.created_at.desc())
                        .limit(1)
                    )
                    prev_quote = prev_quote_res.scalars().first()
                    if prev_quote:
                        for c_item, _ in consignment_items:
                            if c_item.id == prev_quote.inquiry_item_id:
                                target_matched_item = c_item
                                break

            if not target_matched_item:
                target_matched_item = consignment_items[0][0]

            resolved_item_id = target_matched_item.id if target_matched_item else (first_item.id if first_item else None)

            # 5. Always Record Email in InquiryMessage Timeline for Emails Tab
            msg_direction = "outbound" if is_outbound else "inbound"
            msg_sender_name = "Yinglima Procurement" if is_outbound else (supplier.company_name if supplier else from_raw or sender_email)
            msg_recipient = (supplier.company_name if supplier else "Supplier Partner") if is_outbound else "Yinglima Procurement"

            inbound_msg = InquiryMessage(
                id=uuid.uuid4(),
                inquiry_id=matched_inquiry_id,
                inquiry_item_id=resolved_item_id,
                supplier_id=supplier.id if supplier else None,
                channel="email",
                direction=msg_direction,
                sender_name=msg_sender_name,
                sender_contact=sender_email,
                recipient_contact=msg_recipient,
                message_text=full_body_text,
            )
            session.add(inbound_msg)
            await session.commit()

            # Broadcast WebSocket event for live update in Emails tab
            await self._dispatcher.publish(
                module_channel("inquiries"),
                Event(
                    entity="inquiry",
                    entity_id=str(matched_inquiry_id),
                    event_type="inquiry.message.created",
                    changes={"inquiry_id": str(matched_inquiry_id), "item_id": str(resolved_item_id)},
                ),
            )

            # 6. AI QUOTATION EXTRACTION GATE:
            # - Outbound emails from us: 0 AI calls
            # - Follow-up / negotiation replies (Quotation already exists): 0 AI calls
            # - Unverified emails: 0 AI calls
            if is_outbound:
                logger.info("Outbound email from company saved to Emails tab timeline. Skipping AI extraction (0 OpenAI tokens).")
                return

            if not supplier:
                logger.info("Inbound email received without verified supplier association. Skipping AI extraction.")
                return

            # Check if a quotation already exists for this (Item, Supplier) pair
            existing_supp_quote = await session.execute(
                select(Quotation).where(
                    Quotation.inquiry_item_id == resolved_item_id,
                    Quotation.supplier_id == supplier.id,
                    Quotation.deleted_at.is_(None),
                )
            )
            if existing_supp_quote.scalars().first():
                logger.info(
                    "Quotation already exists for supplier %s on item %s. Logged negotiation email to Emails tab without AI extraction (0 OpenAI tokens).",
                    supplier.id,
                    resolved_item_id,
                )
                return

            # 7. FIRST VALID SUPPLIER QUOTATION REPLY: CALL OPENAI EXACTLY ONCE
            logger.info("First valid quotation reply detected for supplier %s on item %s. Running AI extraction...", supplier.id, resolved_item_id)
            target_prod_name = first_prod.product_name or first_prod.product_name_tally or "Product"
            target_prod_code = first_prod.product_code
            target_qty_val = float(first_item.quantity) if first_item.quantity else None
            target_date_str = str(target_rfq.expected_receiving_date) if target_rfq and target_rfq.expected_receiving_date else None

            primary_attachment = attachments[0] if attachments else None
            ai_result = await extract_supplier_quotation(
                text_content=full_body_text,
                file_bytes=primary_attachment["bytes"] if primary_attachment else None,
                mime_type=primary_attachment["content_type"] if primary_attachment else None,
                product_name=target_prod_name,
                product_code=target_prod_code,
                target_quantity=target_qty_val,
                target_date=target_date_str,
                candidate_items=candidate_items_list,
            )

            # Save quotation attachment file to Supabase Storage (fallback to uploads/quotations)
            saved_attachment_url = None
            saved_attachment_filename = None
            if attachments:
                first_att = attachments[0]
                raw_fname = first_att.get("filename") or "quote_document.pdf"
                try:
                    att_url, _ = await save_uploaded_file(
                        content=first_att["bytes"],
                        original_filename=raw_fname,
                        bucket="quotations",
                        local_subfolder="quotations",
                    )
                    saved_attachment_url = att_url
                    saved_attachment_filename = raw_fname
                    logger.info("Saved supplier quotation attachment to %s", saved_attachment_url)
                except Exception as save_err:
                    logger.error("Failed to save quotation attachment: %s", str(save_err))

            # Resolve creator user ID
            inquiry_res = await session.execute(select(Inquiry).where(Inquiry.id == matched_inquiry_id))
            parent_inquiry = inquiry_res.scalars().first()
            creator_user_id = parent_inquiry.created_by if parent_inquiry else None
            if not creator_user_id:
                user_res = await session.execute(select(User.id).limit(1))
                creator_user_id = user_res.scalar_one()

            quote_supplier_id = supplier.id

            quotes_to_process = ai_result.quotes if ai_result.quotes else []
            if not quotes_to_process and ai_result.unit_price:
                quotes_to_process = [{
                    "product_name": target_prod_name,
                    "product_code": target_prod_code,
                    "unit_price": ai_result.unit_price,
                    "currency": ai_result.currency,
                    "quantity": ai_result.quantity,
                    "earliest_available_date": ai_result.earliest_available_date,
                    "price_terms": ai_result.price_terms,
                    "payment_terms": ai_result.payment_terms,
                    "remarks": ai_result.remarks,
                }]

            created_quotes_count = 0
            for q_obj in quotes_to_process:
                q_dict = q_obj if isinstance(q_obj, dict) else q_obj.model_dump()
                unit_p = q_dict.get("unit_price")
                if not unit_p or float(unit_p) <= 0:
                    continue

                # Final check before creating quotation row
                existing_check = await session.execute(
                    select(Quotation).where(
                        Quotation.inquiry_item_id == resolved_item_id,
                        Quotation.supplier_id == quote_supplier_id,
                        Quotation.deleted_at.is_(None),
                    )
                )
                if existing_check.scalars().first():
                    continue

                quoted_qty = q_dict.get("quantity") or float(target_matched_item.quantity or 1.0)
                quoted_unit_price = float(unit_p)
                quote_currency = q_dict.get("currency") or ai_result.currency or "CNY"
                total_cost = round(quoted_qty * quoted_unit_price, 2)

                quote_count_res = await session.execute(
                    select(Quotation).where(
                        Quotation.inquiry_item_id == resolved_item_id,
                        Quotation.deleted_at.is_(None),
                    )
                )
                existing_count = len(quote_count_res.scalars().all())
                quote_number = f"QT-AUTO-{existing_count + 1:02d}"

                t_parts: list[str] = []
                if q_dict.get("price_terms"):
                    t_parts.append(q_dict["price_terms"])
                elif ai_result.price_terms:
                    t_parts.append(ai_result.price_terms)
                if q_dict.get("payment_terms"):
                    t_parts.append(q_dict["payment_terms"])
                elif ai_result.payment_terms:
                    t_parts.append(ai_result.payment_terms)
                terms_combined = " • ".join(t_parts) if t_parts else None

                q_rem = q_dict.get("remarks") or ai_result.remarks or ""
                dedup_remark = f"{q_rem + ' | ' if q_rem else ''}Auto-extracted from {sender_email} [msg:{msg_id[:30]}]"

                exp_date = None
                date_val = q_dict.get("earliest_available_date") or ai_result.earliest_available_date
                if date_val:
                    try:
                        exp_date = datetime.strptime(date_val, "%Y-%m-%d").date()
                    except Exception:
                        pass

                quotation = Quotation(
                    id=uuid.uuid4(),
                    inquiry_item_id=resolved_item_id,
                    supplier_id=quote_supplier_id,
                    quote_number=quote_number,
                    unit_price=quoted_unit_price,
                    currency=quote_currency,
                    total_cost=total_cost,
                    terms_and_conditions=terms_combined,
                    remarks=dedup_remark,
                    expected_receiving_date=exp_date,
                    attachment_url=saved_attachment_url,
                    attachment_filename=saved_attachment_filename,
                    status=QuotationStatus.PENDING,
                    created_by=creator_user_id,
                )
                session.add(quotation)
                created_quotes_count += 1

            if created_quotes_count > 0:
                await session.commit()
                logger.info(
                    "Auto-created %d quotation record(s) for supplier %s on consignment %s.",
                    created_quotes_count,
                    quote_supplier_id,
                    matched_inquiry_id,
                )
                await self._dispatcher.publish(
                    module_channel("inquiries"),
                    Event(
                        entity="quotation",
                        entity_id=str(resolved_item_id),
                        event_type="quotation.created",
                        changes={
                            "id": str(quotation.id),
                            "inquiry_item_id": str(resolved_item_id),
                            "inquiry_id": str(matched_inquiry_id),
                            "quote_number": quote_number,
                            "unit_price": quoted_unit_price,
                            "currency": quote_currency,
                            "status": "pending",
                        },
                    ),
                )
                logger.info("Created quotation %s (%s %s) for item %s", quote_number, quoted_unit_price, quote_currency, resolved_item_id)


# Global worker instance
email_inbound_worker = EmailInboundWorker(poll_interval_seconds=15)
