"""Duplicate flagging. Every receipt and figure here is fictional."""
import base64
import copy
import io
from pathlib import Path

from PIL import Image, ImageDraw

from receipt_dupes import (
    PHASH_STRONG_MAX,
    attach_duplicate,
    backfill_documents,
    enrich_expense,
    match_expense,
    plan_paid_scan,
    sha256_hex,
)


def _png(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return buf.getvalue()


def _b64(image: Image.Image) -> str:
    return base64.b64encode(_png(image)).decode()


def _receipt_image() -> Image.Image:
    """A made-up servo docket: bars and blocks, not a photograph of a receipt."""
    im = Image.new("RGB", (400, 700), (252, 250, 245))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 36, 700], fill=(10, 40, 80))
    d.rectangle([50, 30, 220, 80], fill=(10, 40, 80))
    y = 110
    for width in (70, 140, 200, 90, 260, 110, 180, 240, 60, 300, 130, 210, 160, 280, 100):
        d.rectangle([50, y, 50 + width, y + 14], fill=(20, 20, 20))
        y += 32
    d.rectangle([50, 600, 360, 660], fill=(10, 40, 80))
    return im


def _other_image() -> Image.Image:
    im = Image.new("RGB", (400, 700), (230, 240, 245))
    d = ImageDraw.Draw(im)
    d.ellipse([40, 40, 360, 360], fill=(180, 50, 40))
    d.polygon([(0, 500), (400, 420), (400, 700), (0, 700)], fill=(20, 20, 20))
    d.rectangle([60, 400, 340, 470], fill=(255, 255, 255))
    return im


def _saved(image: Image.Image, **fields) -> dict:
    doc = {"id": "saved-1", "merchant": "Northside Servo", "date": "2026-04-02",
           "amount": 63.40, "category": "fuel", "receipt_image": _b64(image)}
    doc.update(fields)
    return enrich_expense(doc)


def test_cropped_or_rotated_rescan_is_a_strong_perceptual_match():
    original = _receipt_image()
    cropped = original.crop((24, 40, 376, 660))
    rotated = original.rotate(90, expand=True, resample=Image.Resampling.BICUBIC)
    rotated_crop = cropped.rotate(180, expand=True, resample=Image.Resampling.BICUBIC)
    saved = _saved(original, txn_time="07:10", liters=42.10)
    for variant in (cropped, rotated, rotated_crop):
        report = match_expense({"id": "new", "receipt_image": _b64(variant), "amount": 63.40,
                                 "date": "2026-04-02", "merchant": "Northside Servo", "category": "fuel"},
                                [saved])
        assert report["level"] == "strong", report
        assert report["reason"] == "perceptual"
        assert report["distance"] <= PHASH_STRONG_MAX
    other = match_expense({"receipt_image": _b64(_other_image()), "amount": 63.40,
                            "date": "2026-04-02", "merchant": "Northside Servo", "category": "fuel"},
                           [saved])
    assert other["reason"] != "perceptual"


def test_exact_same_file_is_caught_before_the_paid_scan():
    image = _png(_receipt_image())
    saved = _saved(_receipt_image(), txn_time="08:05", liters=40)
    plan = plan_paid_scan(image, [saved])
    assert plan["skip"] is True
    assert plan["duplicate"]["reason"] == "exact_image"
    assert plan["image_sha256"] == sha256_hex(image)
    different = plan_paid_scan(_png(_other_image()), [saved])
    assert different["skip"] is False
    # The route must consult this plan before it constructs the vision client.
    source = (Path(__file__).resolve().parents[1] / "server.py").read_text()
    body = source.split("async def scan_receipt", 1)[1].split("\n@api_router", 1)[0]
    assert body.index("plan_paid_scan") < body.index("anthropic_client")


def test_same_day_fuel_fills_are_not_the_same_purchase():
    base = {"date": "2026-04-02", "amount": 63.40, "category": "fuel", "merchant": "Northside Servo",
            "liters": 42.10, "pump": "4", "txn_time": "07:10"}
    saved = {**base, "id": "fill-a"}
    later = {**base, "id": "fill-b", "txn_time": "07:28"}
    assert match_expense(later, [saved])["level"] is None
    different_litres = {**base, "id": "fill-c", "txn_time": "07:14", "liters": 51.80}
    assert match_expense(different_litres, [saved])["level"] is None
    different_pump = {**base, "id": "fill-d", "txn_time": "07:13", "pump": "9"}
    assert match_expense(different_pump, [saved])["level"] is None
    close = {**base, "id": "fill-e", "txn_time": "07:14"}
    close_report = match_expense(close, [saved])
    assert close_report["level"] == "likely"
    assert close_report["reason"] == "amount_date_merchant_time"
    # Same card does not glue two fills together once the times are more than 10 minutes apart.
    card_later = {**base, "id": "fill-f", "txn_time": "07:26", "card_last4": "4242"}
    saved_card = {**saved, "card_last4": "4242"}
    assert match_expense(card_later, [saved_card])["level"] is None


def test_receipt_number_and_abn_is_strong():
    saved = {"id": "inv-1", "date": "2026-03-01", "amount": 88.00, "merchant": "Harbour Tools",
             "category": "vehicle", "receipt_number": "FICT-10042", "abn": "00 000 000 001"}
    again = {**saved, "id": "inv-2", "merchant": "Somewhere Else", "abn": "00000000001"}
    report = match_expense(again, [saved])
    assert report["level"] == "strong"
    assert report["reason"] == "receipt_abn"
    by_merchant = {**saved, "id": "inv-3", "abn": "11 111 111 111", "receipt_number": "fict 10042"}
    merchant_hit = match_expense(by_merchant, [saved])
    assert merchant_hit["level"] == "strong"
    assert merchant_hit["reason"] == "receipt_merchant"
    unrelated = {**saved, "id": "inv-4", "merchant": "Other Shop", "abn": "22 222 222 222",
                 "receipt_number": "FICT-10042"}
    assert match_expense(unrelated, [saved])["reason"] not in ("receipt_abn", "receipt_merchant")


def test_time_within_five_minutes_or_same_card_is_likely():
    saved = {"id": "cafe-1", "date": "2026-05-11", "amount": 18.50, "merchant": "Harbour Cafe",
             "category": "other", "txn_time": "12:00"}
    close = {**saved, "id": "cafe-2", "txn_time": "12:04"}
    hit = match_expense(close, [saved])
    assert hit["level"] == "likely" and hit["reason"] == "amount_date_merchant_time"
    six = {**saved, "id": "cafe-3", "txn_time": "12:06"}
    assert match_expense(six, [saved])["level"] is None
    saved_card = {**saved, "card_last4": "****4242", "txn_time": "12:00"}
    later_card = {**saved_card, "id": "cafe-4", "txn_time": "12:40", "card_last4": "4242"}
    card = match_expense(later_card, [saved_card])
    assert card["level"] == "likely" and card["reason"] == "amount_date_merchant_card"


def test_one_day_off_is_only_a_possible_hint():
    saved = {"id": "day-1", "date": "2026-06-01", "amount": 27.15, "merchant": "Example Mart",
             "category": "other"}
    next_day = {**saved, "id": "day-2", "date": "2026-06-02"}
    report = match_expense(next_day, [saved])
    assert report["level"] == "possible"
    assert report["reason"] == "amount_merchant_day_off"
    two_days = {**saved, "id": "day-3", "date": "2026-06-03"}
    assert match_expense(two_days, [saved])["level"] is None


def test_missing_fields_are_skipped():
    saved = {"id": "bare-1", "category": "other"}
    incoming = {"id": "bare-2", "category": "other", "note": ""}
    report = match_expense(incoming, [saved])
    assert report["skipped"] is True
    assert report["level"] is None
    assert report["match"] is None


def test_refunds_never_match():
    saved = {"id": "sale-1", "date": "2026-07-01", "amount": 44.00, "merchant": "Example Mart",
             "category": "other", "receipt_number": "FICT-9", "abn": "00 000 000 001",
             "txn_time": "09:00", "card_last4": "4242"}
    negative = {**saved, "id": "sale-2", "amount": -44.00}
    assert match_expense(negative, [saved])["level"] is None
    assert match_expense(negative, [saved])["reason"] == "refund"
    noted = {**saved, "id": "sale-3", "note": "Customer refund"}
    assert match_expense(noted, [saved])["level"] is None
    both_negative = {**negative, "id": "sale-4"}
    assert match_expense(both_negative, [negative])["level"] is None


def test_keep_both_is_not_flagged_again():
    saved = {"id": "keep-a", "date": "2026-08-04", "amount": 15.00, "merchant": "Example Mart",
             "category": "other", "receipt_number": "FICT-77", "abn": "00 000 000 001"}
    incoming = {**saved, "id": "keep-b"}
    assert match_expense(incoming, [saved])["level"] == "strong"
    dismissed = match_expense(incoming, [saved], keep_with=["keep-a"])
    assert dismissed["level"] is None
    saved_pair = {**saved, "dupe_keep_with": ["keep-b"]}
    incoming_pair = {**incoming, "dupe_keep_with": ["keep-a"]}
    assert match_expense(incoming_pair, [saved_pair])["level"] is None


def test_likely_and_possible_do_not_block_the_save():
    saved = {"id": "info-1", "date": "2026-09-01", "amount": 12.00, "merchant": "Example Mart",
             "category": "other", "txn_time": "15:00"}
    likely = match_expense({**saved, "id": "info-2", "txn_time": "15:03"}, [saved])
    body = attach_duplicate({"id": "info-2", "amount": 12.00, "date": "2026-09-01"}, likely)
    assert body["amount"] == 12.00
    assert body["duplicate"]["level"] == "likely"
    possible = match_expense({**saved, "id": "info-3", "date": "2026-09-02", "txn_time": None}, [saved])
    possible_body = attach_duplicate({"id": "info-3", "amount": 12.00}, possible)
    assert possible_body["duplicate"]["level"] == "possible"


def test_backfill_is_idempotent():
    image = _b64(_receipt_image())
    original = {"id": "old-1", "date": "2026-02-02", "amount": 19.95, "merchant": "Example Mart",
                "category": "other", "receipt_image": image, "txn_time": "18:42",
                "receipt_number": "FICT-5", "abn": "00 000 000 009", "card_last4": "1111"}
    no_image = {"id": "old-2", "date": "2026-02-03", "amount": 5}
    first = backfill_documents([copy.deepcopy(original), no_image])
    assert first["updated"] == 1
    filled = first["documents"][0]
    assert filled["image_sha256"] == sha256_hex(base64.b64decode(image))
    assert filled["image_dhash"] and filled["image_ahash"]
    assert filled["amount_cents"] == 1995
    assert filled["norm_date"] == "2026-02-02"
    assert filled["norm_time"] == "18:42"
    assert filled["norm_abn"] == "00000000009"
    assert filled["norm_receipt_number"] == "FICT5"
    assert filled["merchant_key"] == "EXAMPLEMART"
    assert filled["norm_card_last4"] == "1111"
    assert first["documents"][1] == no_image
    second = backfill_documents(copy.deepcopy(first["documents"]))
    assert second["updated"] == 0
    assert second["documents"] == first["documents"]
