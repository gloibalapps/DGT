import os
import io
import csv
import uuid
import logging
from pathlib import Path
from datetime import datetime, timezone, date
from typing import List, Optional, Literal, Annotated

from fastapi import FastAPI, APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, BeforeValidator, ConfigDict

import tax as taxlib

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY')

app = FastAPI(title="GigTax API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("gigtax")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


PyObjectId = Annotated[str, BeforeValidator(str)]


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class RecurringPayment(BaseModel):
    amount: float
    frequency: Literal["weekly", "fortnightly", "monthly"] = "weekly"
    anchor_type: Literal["acquisition", "gigstart"] = "gigstart"
    anchor_date: str  # YYYY-MM-DD


class Profile(BaseModel):
    model_config = ConfigDict(extra="allow")
    profile_id: str
    country: str = "AU"
    region: Optional[str] = None
    work_type: Literal["passengers", "delivery", "both"] = "delivery"
    platforms: List[str] = Field(default_factory=list)
    vehicle_ownership: Literal["own", "loan", "lease", "rental", "rent_to_buy"] = "own"
    acquisition_date: Optional[str] = None
    recurring_payment: Optional[RecurringPayment] = None
    # tax setup
    legal_name: Optional[str] = None
    accounting_method: Literal["cash", "accrual"] = "cash"
    tax_id_on_file: bool = False
    registration_status: Optional[Literal["registered", "not_registered", "unknown"]] = None
    registration_date: Optional[str] = None
    reporting_frequency: Optional[str] = None
    business_use_fallback: float = 100.0
    vehicle_method: Optional[str] = None  # US/UK only
    vehicle_first_business_year: Optional[str] = None
    theme: Literal["dark", "light"] = "dark"
    onboarded: bool = False
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class Trip(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    date: str
    distance_km: float
    type: Literal["business", "personal"] = "business"
    note: Optional[str] = None
    source: Literal["manual", "gps"] = "manual"
    created_at: str = Field(default_factory=now_iso)


class Income(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    date: str
    amount: float
    platform: Optional[str] = None
    tax_treatment: Literal["inclusive", "free", "exempt", "out_of_scope"] = "inclusive"
    note: Optional[str] = None
    created_at: str = Field(default_factory=now_iso)


class Expense(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    date: str
    amount: float
    category: Literal["fuel", "tolls", "vehicle", "phone", "other"] = "other"
    merchant: Optional[str] = None
    tax_treatment: Literal["inclusive", "free", "exempt", "out_of_scope"] = "inclusive"
    note: Optional[str] = None
    receipt_image: Optional[str] = None  # base64
    created_at: str = Field(default_factory=now_iso)


def clean(doc: dict) -> dict:
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


# ---------------------------------------------------------------------------
# Profile
# ---------------------------------------------------------------------------
@api_router.get("/profile")
async def get_profile(profile_id: str = Query(...)):
    doc = await db.profiles.find_one({"profile_id": profile_id})
    if not doc:
        prof = Profile(profile_id=profile_id)
        await db.profiles.insert_one(prof.model_dump())
        return clean(prof.model_dump())
    return clean(doc)


@api_router.put("/profile")
async def save_profile(payload: dict):
    profile_id = payload.get("profile_id")
    if not profile_id:
        raise HTTPException(400, "profile_id required")
    existing = await db.profiles.find_one({"profile_id": profile_id})
    base = clean(existing) if existing else Profile(profile_id=profile_id).model_dump()
    base.update(payload)
    base["updated_at"] = now_iso()
    prof = Profile(**base)
    data = prof.model_dump()
    await db.profiles.update_one({"profile_id": profile_id}, {"$set": data}, upsert=True)
    return clean(data)


# ---------------------------------------------------------------------------
# Generic CRUD helpers
# ---------------------------------------------------------------------------
async def _list(coll, profile_id):
    docs = await db[coll].find({"profile_id": profile_id}).sort("date", -1).to_list(2000)
    return [clean(d) for d in docs]


# Trips
@api_router.get("/trips")
async def list_trips(profile_id: str = Query(...)):
    return await _list("trips", profile_id)


@api_router.post("/trips")
async def add_trip(payload: dict):
    obj = Trip(**payload)
    await db.trips.insert_one(obj.model_dump())
    return clean(obj.model_dump())


@api_router.put("/trips/{item_id}")
async def update_trip(item_id: str, payload: dict):
    existing = await db.trips.find_one({"id": item_id})
    if not existing:
        raise HTTPException(404, "trip not found")
    base = clean(existing); base.update(payload)
    obj = Trip(**base)
    await db.trips.update_one({"id": item_id}, {"$set": obj.model_dump()})
    return clean(obj.model_dump())


@api_router.delete("/trips/{item_id}")
async def delete_trip(item_id: str):
    await db.trips.delete_one({"id": item_id})
    return {"ok": True}


# Income
@api_router.get("/income")
async def list_income(profile_id: str = Query(...)):
    return await _list("income", profile_id)


@api_router.post("/income")
async def add_income(payload: dict):
    obj = Income(**payload)
    await db.income.insert_one(obj.model_dump())
    return clean(obj.model_dump())


@api_router.put("/income/{item_id}")
async def update_income(item_id: str, payload: dict):
    existing = await db.income.find_one({"id": item_id})
    if not existing:
        raise HTTPException(404, "income not found")
    base = clean(existing); base.update(payload)
    obj = Income(**base)
    await db.income.update_one({"id": item_id}, {"$set": obj.model_dump()})
    return clean(obj.model_dump())


@api_router.delete("/income/{item_id}")
async def delete_income(item_id: str):
    await db.income.delete_one({"id": item_id})
    return {"ok": True}


# Expenses
@api_router.get("/expenses")
async def list_expenses(profile_id: str = Query(...)):
    return await _list("expenses", profile_id)


@api_router.post("/expenses")
async def add_expense(payload: dict):
    obj = Expense(**payload)
    await db.expenses.insert_one(obj.model_dump())
    return clean(obj.model_dump())


@api_router.put("/expenses/{item_id}")
async def update_expense(item_id: str, payload: dict):
    existing = await db.expenses.find_one({"id": item_id})
    if not existing:
        raise HTTPException(404, "expense not found")
    base = clean(existing); base.update(payload)
    obj = Expense(**base)
    await db.expenses.update_one({"id": item_id}, {"$set": obj.model_dump()})
    return clean(obj.model_dump())


@api_router.delete("/expenses/{item_id}")
async def delete_expense(item_id: str):
    await db.expenses.delete_one({"id": item_id})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Reports / dashboard
# ---------------------------------------------------------------------------
async def _load_all(profile_id):
    profile = await db.profiles.find_one({"profile_id": profile_id})
    if not profile:
        profile = Profile(profile_id=profile_id).model_dump()
    trips = await db.trips.find({"profile_id": profile_id}).to_list(5000)
    income = await db.income.find({"profile_id": profile_id}).to_list(5000)
    expenses = await db.expenses.find({"profile_id": profile_id}).to_list(5000)
    return (clean(profile), [clean(t) for t in trips],
            [clean(i) for i in income], [clean(e) for e in expenses])


@api_router.get("/reports")
async def reports(profile_id: str = Query(...),
                  period: str = Query("quarter"),
                  ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses = await _load_all(profile_id)
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    return taxlib.compute_report(profile, trips, income, expenses, period, ref)


@api_router.get("/dashboard")
async def dashboard(profile_id: str = Query(...), ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses = await _load_all(profile_id)
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    return taxlib.dashboard(profile, trips, income, expenses, ref)


@api_router.get("/export")
async def export_csv(profile_id: str = Query(...),
                     period: str = Query("quarter"),
                     ref_date: Optional[str] = Query(None)):
    profile, trips, income, expenses = await _load_all(profile_id)
    ref = taxlib.parse_date(ref_date) if ref_date else date.today()
    rep = taxlib.compute_report(profile, trips, income, expenses, period, ref)
    start = taxlib.parse_date(rep["period_start"])
    end = taxlib.parse_date(rep["period_end"])

    def in_p(row):
        d = taxlib.parse_date(row["date"])
        return start <= d < end

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["GigTax export", rep["period_label"]])
    w.writerow([])
    w.writerow(["Type", "Date", "Description", "Category/Platform",
                "Amount (AUD)", "Tax treatment"])
    for i in income:
        if in_p(i):
            w.writerow(["Income", i["date"], i.get("note") or "", i.get("platform") or "",
                        f"{i['amount']:.2f}", i.get("tax_treatment", "inclusive")])
    for e in expenses:
        if in_p(e):
            w.writerow(["Expense", e["date"], e.get("merchant") or "", e.get("category", ""),
                        f"-{e['amount']:.2f}", e.get("tax_treatment", "inclusive")])
    for t in trips:
        if in_p(t):
            w.writerow(["Trip", t["date"], t.get("note") or "",
                        t.get("type", "business"), f"{t['distance_km']} km", ""])
    # calculated recurring payment as its own line (exists in no logged entry)
    rp = rep["vehicle_deduction"]["recurring_payment_gross"]
    if rp:
        w.writerow(["Recurring vehicle payment (calculated)", rep["period_label"],
                    "Elapsed cycles × amount", profile.get("vehicle_ownership", ""),
                    f"-{rp:.2f}", "inclusive"])
    w.writerow([])
    w.writerow(["--- Summary ---"])
    w.writerow(["Total income", f"{rep['total_income']:.2f}"])
    w.writerow(["Total deductions", f"{rep['total_deductions']:.2f}"])
    w.writerow(["Net profit", f"{rep['net_profit']:.2f}"])
    w.writerow(["Business-use %", rep["business_use_pct"]])
    if rep["show_bas"]:
        w.writerow(["G1 (total sales incl GST)", f"{rep['bas']['G1']:.2f}"])
        w.writerow(["1A (GST on sales)", f"{rep['bas']['1A']:.2f}"])
        w.writerow(["1B (GST on purchases)", f"{rep['bas']['1B']:.2f}"])
        w.writerow(["Net GST (1A-1B)", f"{rep['bas']['net_gst']:.2f}"])

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=gigtax_{period}.csv"})


# ---------------------------------------------------------------------------
# AI receipt scanning
# ---------------------------------------------------------------------------
class ScanRequest(BaseModel):
    image_base64: str


@api_router.post("/receipts/scan")
async def scan_receipt(req: ScanRequest):
    from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent
    import json as _json

    system = (
        "You are a receipt data extractor for an Australian gig-driver tax app. "
        "Extract fields from the receipt image and respond with ONLY a compact JSON "
        "object, no markdown, no prose. Schema: "
        '{"amount": number (total incl GST, no currency symbol), '
        '"date": "YYYY-MM-DD" (best guess, today if unclear), '
        '"merchant": string, '
        '"category": one of "fuel","tolls","vehicle","phone","other"}. '
        "Map petrol/servo/gas -> fuel; car service/tyres/repairs/parts -> vehicle; "
        "toll/etoll/linkt -> tolls; telco/mobile/data -> phone; everything else -> other."
    )
    chat = LlmChat(api_key=EMERGENT_LLM_KEY,
                   session_id=f"receipt-{uuid.uuid4()}",
                   system_message=system).with_model("openai", "gpt-4o")
    img = req.image_base64
    if "," in img and img.strip().startswith("data:"):
        img = img.split(",", 1)[1]
    msg = UserMessage(text="Extract the receipt fields as JSON.",
                      file_contents=[ImageContent(image_base64=img)])
    try:
        resp = await chat.send_message(msg)
    except Exception as e:
        logger.exception("receipt scan failed")
        raise HTTPException(502, f"Receipt scan failed: {e}")

    text = resp if isinstance(resp, str) else str(resp)
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    try:
        s = text.index("{"); en = text.rindex("}") + 1
        data = _json.loads(text[s:en])
    except Exception:
        data = {}
    cat = data.get("category", "other")
    if cat not in ("fuel", "tolls", "vehicle", "phone", "other"):
        cat = "other"
    return {
        "amount": data.get("amount"),
        "date": data.get("date") or date.today().isoformat(),
        "merchant": data.get("merchant") or "",
        "category": cat,
    }


@api_router.get("/")
async def root():
    return {"message": "GigTax API", "market": "AU"}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
