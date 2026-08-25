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

    text_body = (
        f"Dear {contact_name},\n\n"
        f"We are inviting your company ({company_name}) to submit a quotation for the following item:\n\n"
        f"• Product: {product_name}{code_display}\n"
        f"• Quantity Required: {quantity} units\n"
        f"{f'• Expected Delivery Date: {expected_receiving_date}\n' if expected_receiving_date else ''}"
        f"{f'• Special Instructions: {notes}\n' if notes else ''}\n"
        f"Please click the link below to view technical specifications and submit your best price:\n"
        f"{quote_url}\n\n"
        f"Thank you,\n"
        f"Yinglima Procurement Team\n"
    )

    html_body = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{subject}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }}
    .card {{ max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }}
    .header {{ background: #0061f2; color: #ffffff; padding: 24px 30px; text-align: left; }}
    .header h1 {{ margin: 0; font-size: 20px; font-weight: 700; }}
    .header p {{ margin: 4px 0 0 0; font-size: 13px; opacity: 0.9; }}
    .body {{ padding: 28px 30px; }}
    .greeting {{ font-size: 15px; font-weight: 600; color: #0f172a; margin-bottom: 14px; }}
    .intro {{ font-size: 14px; line-height: 1.6; color: #475569; margin-bottom: 20px; }}
    .details-box {{ background: #f1f5f9; border-radius: 8px; padding: 18px 20px; margin-bottom: 24px; border-left: 4px solid #0061f2; }}
    .detail-row {{ display: flex; justify-content: space-between; padding: 6px 0; font-size: 13.5px; }}
    .detail-label {{ color: #64748b; font-weight: 500; }}
    .detail-value {{ color: #0f172a; font-weight: 700; text-align: right; }}
    .btn-container {{ text-align: center; margin: 30px 0 20px 0; }}
    .btn {{ display: inline-block; background: #0061f2; color: #ffffff !important; text-decoration: none; padding: 13px 32px; border-radius: 8px; font-size: 14.5px; font-weight: 700; letter-spacing: 0.2px; box-shadow: 0 4px 10px rgba(0,97,242,0.3); }}
    .link-alt {{ font-size: 12px; color: #94a3b8; word-break: break-all; margin-top: 18px; text-align: center; }}
    .footer {{ border-top: 1px solid #f1f5f9; padding: 20px 30px; text-align: center; font-size: 12px; color: #94a3b8; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Request for Quotation</h1>
      <p>Yinglima Procurement System</p>
    </div>
    <div class="body">
      <div class="greeting">Dear {contact_name},</div>
      <div class="intro">
        We would like to invite <strong>{company_name}</strong> to provide your quotation for the product detailed below:
      </div>
      
      <div class="details-box">
        <div class="detail-row">
          <span class="detail-label">Product Name:</span>
          <span class="detail-value">{product_name}</span>
        </div>
        {f'<div class="detail-row"><span class="detail-label">Item Code:</span><span class="detail-value">{product_code}</span></div>' if product_code else ''}
        <div class="detail-row">
          <span class="detail-label">Required Quantity:</span>
          <span class="detail-value">{quantity} units</span>
        </div>
        {f'<div class="detail-row"><span class="detail-label">Required Date:</span><span class="detail-value">{expected_receiving_date}</span></div>' if expected_receiving_date else ''}
        {f'<div class="detail-row"><span class="detail-label">Instructions:</span><span class="detail-value">{notes}</span></div>' if notes else ''}
      </div>

      <div class="btn-container">
        <a href="{quote_url}" class="btn" target="_blank">View Specs & Submit Quotation →</a>
      </div>

      <div class="link-alt">
        If the button above does not work, copy and paste this link into your browser:<br>
        <a href="{quote_url}" style="color: #0061f2;">{quote_url}</a>
      </div>
    </div>
    <div class="footer">
      This is an automated procurement inquiry from Yinglima Management.<br>
      © 2026 Yinglima. All rights reserved.
    </div>
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
