"""
WeCom (WeChat Work / 企业微信) Two-Way Integration Service.

Handles:
1. Access token lifecycle management with in-memory TTL caching.
2. Outbound RFQ template & markdown cards dispatch.
3. WXBizMsgCrypt cryptographic signature validation & AES-256-CBC decryption.
4. Bidirectional message formatting for the ERP Messages timeline.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import struct
import time
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET
from typing import Any

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.backends import default_backend

logger = logging.getLogger("wecom_service")

class WeComService:
    def __init__(
        self,
        corp_id: str | None = None,
        secret: str | None = None,
        agent_id: int | None = None,
        token: str | None = None,
        encoding_aes_key: str | None = None,
    ) -> None:
        self.corp_id = corp_id or os.getenv("WECOM_CORP_ID", "ww0aafdc97cca27e0a")
        self.secret = secret or os.getenv("WECOM_SECRET", "8kzaUnGu34Q6aelEYTaVyB9xOH7EX7MSR6tsLpiL9B8")
        self.agent_id = agent_id or int(os.getenv("WECOM_AGENT_ID", "1000002"))
        self.token = token or os.getenv("WECOM_TOKEN", "Nr8CIsNe")
        self.encoding_aes_key = encoding_aes_key or os.getenv("WECOM_ENCODING_AES_KEY", "yoIVWBBr2iRASH0rIyu2H5VjsSVl1LcWAzXgwyAajLc")

        self._cached_token: str | None = None
        self._token_expires_at: float = 0

    def get_access_token(self, force_refresh: bool = False) -> str:
        """Fetch WeCom API access token with automatic in-memory TTL caching."""
        now = time.time()
        if not force_refresh and self._cached_token and now < (self._token_expires_at - 300):
            return self._cached_token

        url = f"https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={self.corp_id}&corpsecret={self.secret}"
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Yinglima-ERP/1.0"}
        )
        try:
            with urllib.request.urlopen(req, timeout=12) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("errcode") != 0:
                    err_msg = data.get("errmsg", "Unknown WeCom error")
                    logger.error("WeCom gettoken error: %s (code: %s)", err_msg, data.get("errcode"))
                    raise RuntimeError(f"WeCom token error: {err_msg} (errcode: {data.get('errcode')})")
                
                self._cached_token = data["access_token"]
                self._token_expires_at = now + float(data.get("expires_in", 7200))
                return self._cached_token
        except Exception as exc:
            logger.error("Failed to retrieve WeCom access token: %s", str(exc))
            raise

    def send_rfq_markdown_message(
        self,
        to_users: list[str],
        consignment_code: str,
        items: list[dict[str, Any]],
        general_notes: str | None = None,
    ) -> dict[str, Any]:
        """
        Send a professional, bilingual RFQ Markdown card to supplier WeChat accounts.
        """
        token = self.get_access_token()
        url = f"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}"

        # Build clean bilingual markdown body
        item_lines: list[str] = []
        for idx, itm in enumerate(items, start=1):
            p_name = itm.get("product_name") or "Product"
            p_code = itm.get("product_code") or "N/A"
            qty = itm.get("quantity") or 1
            t_date = itm.get("target_date") or "Earliest / 尽快"
            
            item_lines.append(
                f"> **{idx}. {p_name}** (`#{p_code}`)\n"
                f"> • 需求数量 (Qty): **{qty} 台/Units**\n"
                f"> • 期望交期 (Target): **{t_date}**"
            )

        items_formatted = "\n>\n".join(item_lines)
        notes_section = f"\n> • **备注说明 / Notes:** {general_notes}" if general_notes else ""

        markdown_content = (
            f"### 🏢 盈骊玛采购询价单 | Yinglima RFQ\n"
            f"**询价批次 / Batch:** <font color=\"info\">[#{consignment_code}]</font>\n"
            f"───────────────────\n"
            f"尊敬的供应商伙伴，请提供以下产品的最优惠报价与交货期：\n"
            f"{items_formatted}"
            f"{notes_section}\n"
            f"───────────────────\n"
            f"💬 **回复方式 / How to Reply:**\n"
            f"请直接在此微信对话中回复：**单价、交期、付款及价格条款** (或发送报价单图片/PDF)，系统将自动录入！\n"
            f"*盈骊玛进出口 (温州) 有限公司*"
        )

        touser_str = "|".join(to_users) if to_users else "@all"
        payload = {
            "touser": touser_str,
            "msgtype": "markdown",
            "agentid": self.agent_id,
            "markdown": {
                "content": markdown_content
            },
            "safe": 0,
            "enable_duplicate_check": 0
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": "Yinglima-ERP/1.0"
            }
        )

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                logger.info("Dispatched WeCom RFQ message to %s: %s", touser_str, res)
                return res
        except Exception as exc:
            logger.error("Failed to send WeCom RFQ message: %s", str(exc))
            return {"errcode": -1, "errmsg": str(exc)}

    # --------------------------------------------------------------------------
    # Cryptographic Handshake & Decryption per WeCom Doc 90556
    # --------------------------------------------------------------------------

    def verify_signature(self, msg_signature: str, timestamp: str, nonce: str, echostr_or_data: str) -> bool:
        """Validate SHA1 signature for incoming WeCom callback."""
        items = sorted([self.token, timestamp, nonce, echostr_or_data])
        raw_str = "".join(items)
        sha1_hash = hashlib.sha1(raw_str.encode("utf-8")).hexdigest()
        return sha1_hash == msg_signature

    def decrypt_echostr(self, msg_signature: str, timestamp: str, nonce: str, echostr: str) -> str:
        """Decrypt the GET verification echostr during WeCom callback setup."""
        if not self.verify_signature(msg_signature, timestamp, nonce, echostr):
            raise ValueError("WeCom URL verification failed: Invalid SHA1 signature")

        aes_key = base64.b64decode(self.encoding_aes_key + "=")
        iv = aes_key[:16]
        cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv), backend=default_backend())
        decryptor = cipher.decryptor()

        encrypted_bytes = base64.b64decode(echostr)
        decrypted_bytes = decryptor.update(encrypted_bytes) + decryptor.finalize()

        # Remove PKCS7 padding
        pad_len = decrypted_bytes[-1]
        decrypted_bytes = decrypted_bytes[:-pad_len]

        # Structure: 16-byte random + 4-byte msg_len + msg + receiveid
        msg_len = struct.unpack("!I", decrypted_bytes[16:20])[0]
        msg = decrypted_bytes[20 : 20 + msg_len].decode("utf-8")
        return msg

    def decrypt_message(self, msg_signature: str, timestamp: str, nonce: str, post_data: str) -> dict[str, Any]:
        """Decrypt incoming XML/JSON payload from WeChat and extract message dictionary."""
        root = ET.fromstring(post_data)
        encrypt_node = root.find("Encrypt")
        if encrypt_node is None or not encrypt_node.text:
            raise ValueError("Missing <Encrypt> node in WeChat webhook payload")

        encrypt_b64 = encrypt_node.text

        if not self.verify_signature(msg_signature, timestamp, nonce, encrypt_b64):
            raise ValueError("WeCom message verification failed: Invalid SHA1 signature")

        aes_key = base64.b64decode(self.encoding_aes_key + "=")
        iv = aes_key[:16]
        cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv), backend=default_backend())
        decryptor = cipher.decryptor()

        encrypted_bytes = base64.b64decode(encrypt_b64)
        decrypted_bytes = decryptor.update(encrypted_bytes) + decryptor.finalize()

        pad_len = decrypted_bytes[-1]
        decrypted_bytes = decrypted_bytes[:-pad_len]

        msg_len = struct.unpack("!I", decrypted_bytes[16:20])[0]
        msg_xml = decrypted_bytes[20 : 20 + msg_len].decode("utf-8")

        # Parse decrypted inner XML
        inner_root = ET.fromstring(msg_xml)
        result: dict[str, Any] = {}
        for child in inner_root:
            result[child.tag] = child.text
        return result


_wecom_service: WeComService | None = None

def get_wecom_service() -> WeComService:
    global _wecom_service
    if _wecom_service is None:
        _wecom_service = WeComService()
    return _wecom_service
