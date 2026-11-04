"""Uber Eats Engaged-Time Guarantee (AU).

Drivers log each Uber Eats job (date, start, engaged duration, amount, optional
km) plus promotions. Over a 21-day cycle (3 Mon–Sun weeks, anchored on Monday
19/10/2026) the guarantee is: engaged hours × rate. Promotions count as
earnings but add no time. Top-up owed = max(0, guaranteed − earnings).

Jobs are separate from tax income: the driver still logs a daily Uber Eats
income total; we flag days where that total doesn't match the jobs + promos.
"""
import io
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, HTTPException, Query, Body, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

ANCHOR = date(2026, 10, 19)  # a Monday; cycles every 21 days either side
RATES = {"car": 32.00, "motorbike": 31.50, "bicycle": 31.30}  # A$/engaged hr, effective 17/08/2026
UE_PLATFORM = "Uber Eats"
DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


class UEJob(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    profile_id: str
    date: str                      # YYYY-MM-DD
    start_time: str = ""           # "12:03 PM" ("" for promotions)
    type: Literal["DELIVERY", "Package", "Promotion"] = "DELIVERY"
    duration_sec: int = 0          # engaged time, to the second (0 for promotions)
    amount: Optional[float] = None
    km: Optional[float] = None     # optional, not used in the guarantee maths
    platform: str = UE_PLATFORM    # food app — only Uber Eats jobs count toward the guarantee
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


def cycle_start_for(d: date) -> date:
    return ANCHOR + timedelta(days=((d - ANCHOR).days // 21) * 21)


def _pd(s: str) -> date:
    return date.fromisoformat(s[:10])


def fmt_dur(sec: int) -> str:
    """Uber style: '1 hr 1 min', '38 min 36 sec', totals '12 hr 5 min'."""
    sec = int(round(sec or 0))
    if sec <= 0:
        return "0 min"
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h} hr {m} min" if m else f"{h} hr"
    if m:
        return f"{m} min {s} sec" if s else f"{m} min"
    return f"{s} sec"


def _start_minutes(t: str) -> Optional[int]:
    try:
        tt = datetime.strptime(t.strip().upper(), "%I:%M %p")
        return tt.hour * 60 + tt.minute
    except Exception:
        return None


def _is_dup(a: dict, b: dict) -> bool:
    if a.get("type") == "Promotion" or b.get("type") == "Promotion":
        return False  # promos have no start time — two A$5 boosts on one day are both real
    return (a["date"] == b["date"] and (a.get("start_time") or "") == (b.get("start_time") or "")
            and (a.get("platform") or UE_PLATFORM) == (b.get("platform") or UE_PLATFORM)
            and abs((a.get("amount") or 0) - (b.get("amount") or 0)) <= 0.02)


def _validate(j: UEJob):
    if j.type == "Promotion":
        if j.amount is None:
            raise HTTPException(422, "Promotion needs an amount")
        j.start_time, j.duration_sec = "", 0
    else:
        if not j.start_time or _start_minutes(j.start_time) is None:
            raise HTTPException(422, "Job needs a start time like 12:03 PM")
        if j.duration_sec <= 0:
            raise HTTPException(422, "Job needs a duration")


def _build(data: dict) -> "UEJob":
    from pydantic import ValidationError
    try:
        j = UEJob(**data)
    except ValidationError as e:
        raise HTTPException(422, "Invalid job: " + "; ".join(
            f"{'.'.join(map(str, x['loc']))} {x['msg']}" for x in e.errors()))
    _validate(j)
    return j


def summarise(jobs: List[dict], rate: float) -> dict:
    work = [j for j in jobs if j.get("type") != "Promotion"]
    promos = [j for j in jobs if j.get("type") == "Promotion"]
    earnings = round(sum((j.get("amount") or 0) for j in jobs), 2)
    promo_total = round(sum((j.get("amount") or 0) for j in promos), 2)
    sec = sum(int(j.get("duration_sec") or 0) for j in work)
    hrs = sec / 3600
    guaranteed = round(hrs * rate, 2)
    return {
        "jobs": len(work), "promotions": len(promos), "earnings": earnings, "promo_total": promo_total,
        "engaged_sec": sec, "engaged_label": fmt_dur(sec), "engaged_hours": round(hrs, 4),
        "effective_rate": round(earnings / hrs, 2) if hrs > 0 else None,
        "guaranteed": guaranteed, "top_up": round(max(0.0, guaranteed - earnings), 2),
        "km": round(sum((j.get("km") or 0) for j in work), 1),
    }


def build_router(db, require_owner, require_owner_or_ticket, own_payload, require_entitled=None) -> APIRouter:
    require_entitled = require_entitled or require_owner
    """All routes require the caller's Bearer session (see server.require_owner)
    and are scoped to their own profile_id."""
    r = APIRouter(prefix="/api/ue")

    async def _profile(pid: str) -> dict:
        return await db.profiles.find_one({"profile_id": pid}) or {}

    async def _jobs(pid: str, start: Optional[date] = None, end: Optional[date] = None) -> List[dict]:
        q: dict = {"profile_id": pid}
        if start and end:
            q["date"] = {"$gte": start.isoformat(), "$lt": end.isoformat()}
        docs = await db.ue_jobs.find(q, {"_id": 0}).to_list(20000)
        return sorted(docs, key=lambda j: (j["date"], _start_minutes(j.get("start_time") or "") or 0))

    async def _mismatches(pid: str, start: date, end: date, jobs: List[dict]) -> List[dict]:
        """Per day and food app: logged income total vs that app's jobs + promos."""
        plats = sorted({j.get("platform") or UE_PLATFORM for j in jobs})
        inc = await db.income.find({"profile_id": pid, "platform": {"$in": plats},
                                    "date": {"$gte": start.isoformat(), "$lt": end.isoformat()}},
                                   {"_id": 0, "date": 1, "amount": 1, "platform": 1}).to_list(5000)
        logged: dict = {}
        for i in inc:
            k = (i["date"][:10], i["platform"])
            logged[k] = round(logged.get(k, 0) + (i.get("amount") or 0), 2)
        by_day: dict = {}
        for j in jobs:
            k = (j["date"], j.get("platform") or UE_PLATFORM)
            by_day[k] = round(by_day.get(k, 0) + (j.get("amount") or 0), 2)
        out = []
        for k in sorted(by_day):
            jt, lt = by_day[k], logged.get(k, 0.0)
            if abs(jt - lt) > 0.05:
                out.append({"date": k[0], "platform": k[1], "jobs_total": jt, "income_logged": lt,
                            "difference": round(lt - jt, 2)})
        return out

    @r.get("/jobs")
    async def list_jobs(start: Optional[str] = None, end: Optional[str] = None, owner=Depends(require_owner)):
        profile_id = owner.profile_id
        if start and end:
            return await _jobs(profile_id, _pd(start), _pd(end) + timedelta(days=1))
        return await _jobs(profile_id)

    @r.post("/jobs")
    async def add_jobs(payload: dict = Body(...), owner=Depends(require_entitled)):
        """Batch save. Duplicates (same date + start time, amounts within 2c —
        vs saved jobs or an earlier row in this batch) are NOT saved; their
        batch indexes are returned so the app can flag them."""
        payload = own_payload(payload, owner)
        pid = payload.get("profile_id")
        rows = payload.get("jobs") or []
        if not pid:
            raise HTTPException(400, "profile_id required")
        existing = await _jobs(pid)
        saved, dups, accepted = [], [], []
        for idx, raw in enumerate(rows):
            j = _build(dict(profile_id=pid, **{k: v for k, v in raw.items() if k not in ("id", "profile_id")}))
            d = j.model_dump()
            if any(_is_dup(d, e) for e in existing) or any(_is_dup(d, a) for a in accepted):
                dups.append(idx)
                continue
            accepted.append(d)
        if accepted:
            await db.ue_jobs.insert_many([dict(a) for a in accepted])
            saved = accepted
        return {"saved": saved, "duplicates": dups}

    @r.put("/jobs/{job_id}")
    async def update_job(job_id: str, payload: dict = Body(...), owner=Depends(require_entitled)):
        own_payload(payload, owner)
        cur = await db.ue_jobs.find_one({"id": job_id, "profile_id": owner.profile_id}, {"_id": 0})
        if not cur:
            raise HTTPException(404, "job not found")
        cur.update({k: v for k, v in payload.items() if k not in ("id", "profile_id")})
        j = _build(cur)
        d = j.model_dump()
        others = [e for e in await _jobs(j.profile_id) if e["id"] != job_id]
        if any(_is_dup(d, e) for e in others):
            raise HTTPException(409, "duplicate of an existing job")
        await db.ue_jobs.update_one({"id": job_id, "profile_id": owner.profile_id}, {"$set": d})
        return d

    @r.delete("/jobs/{job_id}")
    async def delete_job(job_id: str, owner=Depends(require_entitled)):
        res = await db.ue_jobs.delete_one({"id": job_id, "profile_id": owner.profile_id})
        if not res.deleted_count:
            raise HTTPException(404, "job not found")
        return {"ok": True}

    async def _cycle(pid: str, cycle_start: Optional[str]) -> dict:
        prof = await _profile(pid)
        vtype = prof.get("ue_vehicle_type") or "car"
        rate = RATES.get(vtype, RATES["car"])
        today = date.today()
        cs = cycle_start_for(_pd(cycle_start)) if cycle_start else cycle_start_for(today)
        ce = cs + timedelta(days=21)
        all_jobs = await _jobs(pid, cs, ce)
        jobs = [j for j in all_jobs if (j.get("platform") or UE_PLATFORM) == UE_PLATFORM]  # guarantee = Uber Eats only
        weeks = []
        for w in range(3):
            ws = cs + timedelta(days=7 * w)
            wj = [j for j in jobs if ws.isoformat() <= j["date"] < (ws + timedelta(days=7)).isoformat()]
            weeks.append({"index": w, "start": ws.isoformat(), "end": (ws + timedelta(days=6)).isoformat(),
                          **summarise(wj, rate)})
        # dropdown: every cycle from the earliest job (or 2 back) to the current one
        first = await db.ue_jobs.find_one({"profile_id": pid}, sort=[("date", 1)])
        earliest = cycle_start_for(_pd(first["date"])) if first else cycle_start_for(today) - timedelta(days=42)
        cycles, c = [], cycle_start_for(today)
        while c >= min(earliest, cs):
            cycles.append({"start": c.isoformat(), "end": (c + timedelta(days=20)).isoformat()})
            c -= timedelta(days=21)
        return {"cycle_start": cs.isoformat(), "cycle_end": (ce - timedelta(days=1)).isoformat(),
                "vehicle_type": vtype, "rate": rate, "weeks": weeks, "total": summarise(jobs, rate),
                "jobs": jobs, "cycles": cycles, "mismatches": await _mismatches(pid, cs, ce, all_jobs)}

    @r.get("/guarantee")
    async def guarantee(cycle_start: Optional[str] = None, owner=Depends(require_owner)):
        return await _cycle(owner.profile_id, cycle_start)

    @r.get("/mismatches")
    async def mismatches(owner=Depends(require_owner)):
        profile_id = owner.profile_id
        end = date.today() + timedelta(days=1)
        start = end - timedelta(days=22)
        return await _mismatches(profile_id, start, end, await _jobs(profile_id, start, end))

    @r.get("/export")
    async def export_xlsx(cycle_start: Optional[str] = None, owner=Depends(require_owner_or_ticket)):
        profile_id = owner.profile_id
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        c = await _cycle(profile_id, cycle_start)
        au = lambda s: _pd(s).strftime("%d/%m/%Y")  # noqa: E731
        wb = Workbook()
        ws = wb.active
        ws.title = "Summary"
        bold = Font(bold=True)
        thin = Side(style="thin", color="999999")
        box = Border(left=thin, right=thin, top=thin, bottom=thin)
        ws.column_dimensions["A"].width = 28
        for col in "BCDEFG":
            ws.column_dimensions[col].width = 16
        ws["A1"] = "Uber Eats Engaged-Time Guarantee — Cycle Summary"
        ws["A1"].font = Font(bold=True, size=14)
        rows = [("Driver name", ""), ("Contact (phone / email)", ""),
                ("Vehicle", c["vehicle_type"].title()), ("Guarantee rate", f"A${c['rate']:.2f} per engaged hour"),
                ("Cycle", f"{au(c['cycle_start'])} – {au(c['cycle_end'])}")]
        for i, (k, v) in enumerate(rows, start=3):
            ws.cell(i, 1, k).font = bold
            cell = ws.cell(i, 2, v)
            if k.startswith(("Driver", "Contact")):
                ws.merge_cells(start_row=i, start_column=2, end_row=i, end_column=5)
                for cc in range(2, 6):
                    ws.cell(i, cc).border = box
            del cell
        r0 = 10
        hdr = ["Week", "Jobs", "Earnings (A$)", "Promotions (A$)", "Engaged time", "Effective rate", "Guaranteed (A$)"]
        for ci, h in enumerate(hdr, 1):
            ws.cell(r0, ci, h).font = bold
        for w in c["weeks"]:
            r0 += 1
            ws.append([f"Week {w['index'] + 1} ({au(w['start'])} – {au(w['end'])})", w["jobs"], w["earnings"],
                       w["promo_total"], w["engaged_label"], w["effective_rate"], w["guaranteed"]])
        t = c["total"]
        ws.append(["Cycle total", t["jobs"], t["earnings"], t["promo_total"], t["engaged_label"],
                   t["effective_rate"], t["guaranteed"]])
        for ci in range(1, 8):
            ws.cell(ws.max_row, ci).font = bold
        ws.append([])
        owed = t["top_up"] > 0
        ws.append(["Top-up owed" if owed else "Guarantee met", f"A${t['top_up']:.2f}" if owed else "No top-up due"])
        fill = PatternFill("solid", fgColor="F8D7DA" if owed else "D4EDDA")
        for ci in (1, 2):
            cl = ws.cell(ws.max_row, ci)
            cl.fill, cl.font, cl.border = fill, Font(bold=True, color="C2403A" if owed else "15803D"), box
        ws.append([])
        note = ("How it's worked out: engaged time is the total of each job's duration (accept to complete). "
                "Guaranteed amount = engaged hours × rate. Earnings = all job amounts plus promotions "
                "(Quests, Boosts, incentives) — Uber counts promotions as earnings, but they add no time. "
                "Top-up owed = guaranteed amount − earnings (if positive), assessed over the whole 21-day cycle; "
                "weekly figures are a guide only.")
        ws.append([note])
        ws.merge_cells(start_row=ws.max_row, start_column=1, end_row=ws.max_row, end_column=7)
        ws.cell(ws.max_row, 1).alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[ws.max_row].height = 75

        jd = wb.create_sheet("Job Details")
        cols = ["Date", "Day", "Start", "Type", "Duration", "Duration (hrs)", "Amount (A$)", "Km",
                "Overlap with previous job (min)"]
        jd.append(cols)
        for ci in range(1, len(cols) + 1):
            jd.cell(1, ci).font = bold
            jd.column_dimensions[chr(64 + ci)].width = 16
        jd.column_dimensions["I"].width = 30
        prev_end = None
        for w in c["weeks"]:
            wj = [j for j in c["jobs"] if w["start"] <= j["date"] <= w["end"]]
            for j in wj:
                d = _pd(j["date"])
                overlap = 0
                if j["type"] != "Promotion":
                    sm = _start_minutes(j["start_time"])
                    start_abs = datetime.combine(d, datetime.min.time()) + timedelta(minutes=sm or 0)
                    if prev_end and prev_end > start_abs:
                        overlap = round((prev_end - start_abs).total_seconds() / 60, 1)
                    prev_end = max(prev_end or start_abs, start_abs + timedelta(seconds=j["duration_sec"]))
                jd.append([d.strftime("%d/%m/%Y"), DAY_NAMES[d.weekday()], j.get("start_time") or "", j["type"],
                           fmt_dur(j["duration_sec"]) if j["type"] != "Promotion" else "",
                           round(j["duration_sec"] / 3600, 4) if j["type"] != "Promotion" else "",
                           j.get("amount"), j.get("km"), overlap])
            jd.append([f"Week {w['index'] + 1} subtotal", "", "", f"{w['jobs']} jobs", w["engaged_label"],
                       w["engaged_hours"], w["earnings"], w["km"] or "", ""])
            for ci in range(1, 10):
                jd.cell(jd.max_row, ci).font = bold
        jd.append(["Cycle total", "", "", f"{t['jobs']} jobs", t["engaged_label"], t["engaged_hours"],
                   t["earnings"], t["km"] or "", ""])
        for ci in range(1, 10):
            jd.cell(jd.max_row, ci).font = bold
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        fname = f"uber-eats-guarantee-{c['cycle_start']}.xlsx"
        return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                 headers={"Content-Disposition": f"attachment; filename={fname}"})

    return r
