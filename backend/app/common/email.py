"""
Automated Email Dispatch Service.

Handles sending transactional and RFQ dispatch emails via SMTP
(e.g. Gmail / Google Workspace / Microsoft 365) asynchronously.
"""

from __future__ import annotations

import asyncio
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Sequence

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


def _send_smtp_sync(
    to_emails: list[str],
    subject: str,
    html_content: str,
    text_content: str | None = None,
) -> bool:
    """Synchronous SMTP worker intended to run in a thread executor."""
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        logger.warning("SMTP credentials not configured. Skipping email dispatch.")
        return False

    valid_recipients = [e.strip() for e in to_emails if e and "@" in e]
    if not valid_recipients:
        logger.warning("No valid recipients provided for email dispatch.")
        return False

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{settings.SMTP_FROM_NAME} <{settings.SMTP_FROM_EMAIL}>"
    msg["To"] = ", ".join(valid_recipients)

    if text_content:
        msg.attach(MIMEText(text_content, "plain", "utf-8"))
    msg.attach(MIMEText(html_content, "html", "utf-8"))

    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as server:
            if settings.SMTP_USE_TLS:
                server.starttls()
            server.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            server.sendmail(settings.SMTP_FROM_EMAIL, valid_recipients, msg.as_string())
        logger.info(
            "Email dispatched successfully.",
            extra={"subject": subject, "recipients": valid_recipients},
        )
        return True
    except Exception as exc:
        logger.exception(
            "Failed to send email via SMTP: %s",
            exc,
            extra={"subject": subject, "recipients": valid_recipients},
        )
        return False


async def send_email_async(
    to_emails: Sequence[str] | str,
    subject: str,
    html_content: str,
    text_content: str | None = None,
) -> bool:
    """Send an email asynchronously without blocking the event loop."""
    recipients = [to_emails] if isinstance(to_emails, str) else list(to_emails)
    return await asyncio.to_thread(
        _send_smtp_sync,
        to_emails=recipients,
        subject=subject,
        html_content=html_content,
        text_content=text_content,
    )


async def send_rfq_email(
    *,
    to_emails: Sequence[str] | str,
    contact_name: str,
    company_name: str,
    product_name: str,
    product_code: str | None = None,
    quantity: int | float,
    quote_url: str,
    expected_receiving_date: str | None = None,
    notes: str | None = None,
) -> bool:
    """Format and send a professional RFQ invitation email to a supplier."""
    recipients = [to_emails] if isinstance(to_emails, str) else list(to_emails)
    valid_recipients = [e.strip() for e in recipients if e and "@" in e]
    if not valid_recipients:
        return False

    code_display = f" (#{product_code})" if product_code else ""
    subject = f"Request for Quotation: {product_name} ({quantity} units)"

    target_date_line_text = (
        f"• Required Expected Receiving Date: {expected_receiving_date}\n"
        if expected_receiving_date
        else "• Delivery Schedule: Please provide your earliest possible delivery date / lead time\n"
    )

    date_checklist_text = (
        f"2. Confirmation if you can meet delivery by {expected_receiving_date}"
        if expected_receiving_date
        else "2. Your Earliest Possible Delivery / Dispatch Date (or Lead Time in days)"
    )

    text_body = (
        f"Dear {contact_name} ({company_name}),\n\n"
        f"We are from Yinglima Procurement Team. We are requesting your best quotation for:\n\n"
        f"• Company: {company_name}\n"
        f"• Product: {product_name}{code_display}\n"
        f"• Required Quantity: {quantity} units\n"
        f"{target_date_line_text}"
        f"{f'• Notes / Specifications: {notes}\n' if notes else ''}\n"
        f"Please reply directly to this email with:\n"
        f"1. Best Unit Price (Currency: CNY / USD / INR / EUR)\n"
        f"{date_checklist_text}\n"
        f"3. Payment & Price Terms (Ex-Factory / FOB, Deposit %)\n"
        f"4. You may also attach your quotation PDF or sheet directly in your reply.\n\n"
        f"Best regards,\n"
        f"Yinglima Procurement Team\n"
    )

    target_date_line_html = (
        f"• <strong>Required Expected Receiving Date:</strong> {expected_receiving_date}<br>"
        if expected_receiving_date
        else "• <strong>Delivery Schedule:</strong> Please provide your earliest possible delivery date / lead time<br>"
    )

    date_checklist_html = (
        f"<li>Can you deliver by <strong>{expected_receiving_date}</strong>?</li>"
        if expected_receiving_date
        else "<li>Your <strong>Earliest Possible Delivery Date</strong> (or Lead Time in days)</li>"
    )

    html_body = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 14.5px; line-height: 1.7; color: #1e293b; margin: 0; padding: 12px;">
  <p>Dear <strong>{contact_name} ({company_name})</strong>,</p>
  
  <p>We are from <strong>Yinglima Procurement Team</strong>. We are requesting your quotation for:</p>

  <p style="margin: 12px 0 16px 0; line-height: 1.8;">
    • <strong>Product:</strong> {product_name}{code_display}<br>
    • <strong>Quantity:</strong> <strong>{quantity} units</strong><br>
    {target_date_line_html}
    {f'• <strong>Notes / Specifications:</strong> {notes}<br>' if notes else ''}
  </p>

  <p><strong>Please provide:</strong></p>
  <ol style="margin-top: 6px; padding-left: 24px; line-height: 1.8;">
    <li>Best <strong>Unit Price</strong> (Currency: CNY / USD / INR / EUR)</li>
    {date_checklist_html}
    <li><strong>Payment & Price Terms</strong> (FOB / Ex-Factory, Deposit %)</li>
  </ol>

  <p style="color: #475569; font-size: 14px; margin-top: 20px;">
    You can reply directly to this email with your quote or attach your quotation PDF / sheet.
  </p>

  <p style="margin-top: 24px;">
    Thank you,<br>
    <strong>Yinglima Procurement Team</strong>
  </p>
</body>
</html>
"""

    return await send_email_async(
        to_emails=valid_recipients,
        subject=subject,
        html_content=html_body,
        text_content=text_body,
    )


async def send_bulk_rfq_email(
    *,
    to_emails: Sequence[str] | str,
    contact_name: str,
    company_name: str,
    consignment_code: str | None = None,
    items: list[dict[str, Any]],
    general_notes: str | None = None,
    custom_subject: str | None = None,
    custom_body: str | None = None,
) -> bool:
    """Format and send a consolidated multi-product RFQ email to a supplier."""
    recipients = [to_emails] if isinstance(to_emails, str) else list(to_emails)
    valid_recipients = [e.strip() for e in recipients if e and "@" in e]
    if not valid_recipients or not items:
        return False

    ref_tag = f"[{consignment_code}]" if consignment_code else ""
    if custom_subject and custom_subject.strip():
        subject = custom_subject.strip()
        if ref_tag and ref_tag not in subject:
            subject = f"{ref_tag} {subject}"
    else:
        ref_str = f" [{consignment_code}]" if consignment_code else ""
        subject = f"Request for Quotation{ref_str}: {len(items)} Items Required - Yinglima Procurement"

    if custom_body and custom_body.strip():
        text_body = custom_body.strip()
        escaped_custom = text_body.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
        html_body = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; line-height: 1.6; margin: 0; padding: 20px; background-color: #f8fafc;">
  <div style="max-width: 680px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 28px;">
    <div style="font-size: 14.5px; color: #0f172a; line-height: 1.7;">
      {escaped_custom}
    </div>
  </div>
</body>
</html>"""
        return await send_email_async(
            to_emails=valid_recipients,
            subject=subject,
            html_content=html_body,
            text_content=text_body,
        )

    # Text Table
    text_table_rows = []
    for idx, itm in enumerate(items, start=1):
        p_name = itm.get("product_name") or "Product"
        p_code = f" (#{itm['product_code']})" if itm.get("product_code") else ""
        p_qty = itm.get("quantity") or 1
        p_date = itm.get("expected_receiving_date") or "Earliest Possible"
        p_notes = f" | Notes: {itm['notes']}" if itm.get("notes") else ""
        text_table_rows.append(f"{idx}. {p_name}{p_code} - Qty: {p_qty} units | Req. Date: {p_date}{p_notes}")

    items_text = "\n".join(text_table_rows)

    text_body = (
        f"Dear {contact_name} ({company_name}),\n\n"
        f"We are from Yinglima Procurement Team. We are sourcing for our upcoming order and invite your company "
        f"to provide your best competitive quotation for the following {len(items)} items:\n\n"
        f"{items_text}\n\n"
        f"{f'General Notes: {general_notes}\n\n' if general_notes else ''}"
        f"Please reply directly to this email with:\n"
        f"1. Unit Price for each product (CNY / USD / INR / EUR)\n"
        f"2. Earliest Production / Delivery Lead Time\n"
        f"3. Payment Terms & Price Terms (Ex-Factory / FOB, Deposit %)\n\n"
        f"You can also attach your official quotation PDF or sheet directly in your reply.\n\n"
        f"Best regards,\n"
        f"Yinglima Procurement Team\n"
    )

    # HTML Table Rows
    html_table_rows = []
    for idx, itm in enumerate(items, start=1):
        p_name = itm.get("product_name") or "Product"
        p_code = f"<span style='color: #64748b; font-size: 12px;'>#{itm['product_code']}</span>" if itm.get("product_code") else "—"
        p_qty = f"<strong>{itm.get('quantity') or 1}</strong>"
        p_date = itm.get("expected_receiving_date") or "<span style='color: #64748b;'>Earliest Possible</span>"
        p_notes = itm.get("notes") or "—"
        html_table_rows.append(f"""
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 10px 12px; text-align: center; color: #64748b;">{idx}</td>
          <td style="padding: 10px 12px; font-weight: 600; color: #0f172a;">{p_name}</td>
          <td style="padding: 10px 12px;">{p_code}</td>
          <td style="padding: 10px 12px; text-align: center;">{p_qty}</td>
          <td style="padding: 10px 12px;">{p_date}</td>
          <td style="padding: 10px 12px; color: #475569; font-size: 13px;">{p_notes}</td>
        </tr>
        """)

    table_rows_html = "".join(html_table_rows)

    html_body = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 14.5px; line-height: 1.6; color: #1e293b; margin: 0; padding: 16px; background-color: #f8fafc;">
  <div style="max-width: 780px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
    
    <div style="border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 18px;">
      <h2 style="margin: 0; color: #0f172a; font-size: 18px; font-weight: 700;">Yinglima Procurement Team</h2>
      <p style="margin: 4px 0 0 0; color: #64748b; font-size: 13px;">Request for Quotation {ref_str}</p>
    </div>

    <p>Dear <strong>{contact_name} ({company_name})</strong>,</p>
    
    <p>We are from <strong>Yinglima Procurement Team</strong>. We are requesting your best quotation and delivery lead times for the following <strong>{len(items)} items</strong>:</p>

    <div style="overflow-x: auto; margin: 16px 0;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13.5px; border: 1px solid #e2e8f0; border-radius: 6px;">
        <thead>
          <tr style="background-color: #f1f5f9; border-bottom: 2px solid #cbd5e1; text-align: left;">
            <th style="padding: 10px 12px; text-align: center; width: 36px;">#</th>
            <th style="padding: 10px 12px;">Product Description</th>
            <th style="padding: 10px 12px;">Product Code</th>
            <th style="padding: 10px 12px; text-align: center;">Required Qty</th>
            <th style="padding: 10px 12px;">Target Date</th>
            <th style="padding: 10px 12px;">Specifications / Notes</th>
          </tr>
        </thead>
        <tbody>
          {table_rows_html}
        </tbody>
      </table>
    </div>

    {f'<p style="background: #f8fafc; padding: 10px 14px; border-left: 3px solid #3b82f6; margin: 16px 0; font-size: 13.5px;"><strong>General Notes:</strong> {general_notes}</p>' if general_notes else ''}

    <p style="margin-top: 18px;"><strong>Please reply directly to this email with:</strong></p>
    <ol style="margin-top: 6px; padding-left: 24px; line-height: 1.8;">
      <li>Unit Price for each product (CNY / USD / INR / EUR)</li>
      <li>Earliest Production / Delivery Lead Time</li>
      <li>Payment Terms & Price Terms (Ex-Factory / FOB, Deposit %)</li>
    </ol>

    <p style="color: #475569; font-size: 13.5px; margin-top: 18px; padding-top: 12px; border-top: 1px solid #f1f5f9;">
      You can reply directly to this email with your prices, or attach your official quotation PDF / sheet.
    </p>

    <p style="margin-top: 24px; color: #0f172a;">
      Best regards,<br>
      <strong>Yinglima Procurement Team</strong>
    </p>
  </div>
</body>
</html>
"""

    return await send_email_async(
        to_emails=valid_recipients,
        subject=subject,
        html_content=html_body,
        text_content=text_body,
    )
