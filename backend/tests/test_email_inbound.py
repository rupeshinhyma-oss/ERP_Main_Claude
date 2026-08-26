import pytest
from app.inquiries.email_inbound_worker import (
    clean_decode_header,
    extract_email_address,
)


def test_clean_decode_header():
    assert clean_decode_header("Re: RFQ-1234 Quotation") == "Re: RFQ-1234 Quotation"
    assert clean_decode_header("") == ""


def test_extract_email_address():
    assert (
        extract_email_address("Yinglima Machinery <sales@yinglima.com>")
        == "sales@yinglima.com"
    )
    assert extract_email_address("supplier@factory.cn") == "supplier@factory.cn"
    assert (
        extract_email_address('"John Doe" <john.doe@company.org>')
        == "john.doe@company.org"
    )
