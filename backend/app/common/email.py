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
from typing import Sequence

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
        f"👉 Please reply directly to this email with:\n"
        f"1. Best Unit Price (Currency: CNY ¥ / USD $ / INR ₹)\n"
        f"{date_checklist_text}\n"
        f"3. Payment & Price Terms (Ex-Factory / FOB Ningbo, Deposit %)\n"
        f"4. You may also attach your quotation PDF or product photo sheet directly.\n\n"
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

  <p>👉 <strong>Please provide:</strong></p>
  <ol style="margin-top: 6px; padding-left: 24px; line-height: 1.8;">
    <li>Best <strong>Unit Price</strong> (Currency: CNY ¥ / USD $ / INR ₹)</li>
    {date_checklist_html}
    <li><strong>Payment & Price Terms</strong> (FOB / Ex-Factory, Deposit %)</li>
  </ol>

  <p style="color: #475569; font-size: 14px; margin-top: 20px;">
    You can reply directly to this email with your quote or attach your quotation PDF / photo sheet.
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
