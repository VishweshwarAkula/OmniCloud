"""Receipt detection + total extraction with Gemini structured output."""

import logging

from pydantic import BaseModel, Field

from .parsing import parse_total_to_number

log = logging.getLogger(__name__)

PROMPT = (
    "You are a precise receipt and bill analyser. Decide whether this image is a receipt, invoice or bill. "
    "If it is, extract the grand total actually paid (after tax/discounts), the ISO 4217 currency code, "
    "the merchant name and the transaction date (YYYY-MM-DD). Use null for anything you cannot read. "
    "Put the total exactly as printed in total_text as well."
)


class Receipt(BaseModel):
    is_receipt: bool
    total: float | None = None
    total_text: str | None = None
    currency: str | None = Field(default=None, description="ISO 4217 code, e.g. INR, USD")
    vendor: str | None = None
    date: str | None = Field(default=None, description="YYYY-MM-DD")
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


NOT_A_RECEIPT = Receipt(is_receipt=False)


class ReceiptReader:
    def __init__(self, client, model: str):
        self.model = model
        self.client = client

    def read(self, image: bytes, mime: str) -> Receipt:
        if not self.client:
            return NOT_A_RECEIPT
        from google.genai import types

        try:
            resp = self.client.models.generate_content(
                model=self.model,
                contents=[types.Part.from_bytes(data=image, mime_type=mime or "image/jpeg"), PROMPT],
                config=types.GenerateContentConfig(
                    temperature=0,
                    response_mime_type="application/json",
                    response_schema=Receipt,
                ),
            )
            receipt = (
                resp.parsed if isinstance(resp.parsed, Receipt) else Receipt.model_validate_json(resp.text or "{}")
            )
        except Exception as exc:  # OCR is best effort; indexing must not fail because of it
            log.warning("gemini receipt analysis failed: %s", exc)
            return NOT_A_RECEIPT

        if receipt.is_receipt and receipt.total is None:
            receipt.total = parse_total_to_number(receipt.total_text)
        if receipt.currency:
            receipt.currency = receipt.currency.strip().upper()[:3]
        return receipt
