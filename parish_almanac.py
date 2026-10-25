"""
UK Parish Council, Village Hall & Small Charity Statutory Almanac & AGAR Governance Toolkit.

Slow-compounding, uncrowded local-community public resource and deterministic statutory calculator:
1. Local Government Act 1972 (Sch. 12 para 10(2)(b) & s.243) "Three Clear Days" Summons & Agenda Notice Calculator
   backed by the live official GOV.UK Bank Holidays API (https://www.gov.uk/bank-holidays.json).
2. Accounts and Audit Regulations 2015 (SI 2015/234 reg. 15) 30-Working-Day Exercise of Public Rights Window
   Calculator (verifying inclusion of the mandatory first 10 working days of July + 30 September AGAR deadline).
3. ONS / Ordnance Survey OGL v3.0 Civil Parish, Ward & Local Authority Catchment Resolver
   (https://api.postcodes.io/postcodes/{postcode}).
4. JPAG Practitioners' Guide (AGAR Assertion 10) .gov.uk / .org.uk Domain & Email Security Audit (Cloudflare DoH)
   + UK Charity Commission / FindThatCharity cross-reference.
5. RFC-5545 (.ics) Statutory Governance Calendar Generator for Parish Clerks & Village Hall Treasurers.

Zero personal data scraping. Zero UK GDPR / PECR risk. Zero LLM tokens per execution.
"""

from __future__ import annotations

import datetime as dt
import re
import time
import urllib.parse
from typing import Any

import httpx

USER_AGENT = "ParishStatutoryAlmanac/1.0 (+https://technoplusit.co.uk; deterministic-ogl-governance)"
GOV_UK_BANK_HOLIDAYS_URL = "https://www.gov.uk/bank-holidays.json"
POSTCODES_IO_URL = "https://api.postcodes.io/postcodes"
FINDTHATCHARITY_URL = "https://findthatcharity.uk/orgid/typeahead.json"
CLOUDFLARE_DOH_URL = "https://cloudflare-dns.com/dns-query"

_BANK_HOLIDAY_CACHE: dict[str, Any] = {"fetched_at": 0.0, "data": None}
_CACHE_TTL_SECONDS = 3600.0


def fetch_uk_bank_holidays(
    division: str = "england-and-wales",
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """
    Fetch official UK bank holidays from GOV.UK (https://www.gov.uk/bank-holidays.json).
    Returns a dictionary mapping ISO date strings (YYYY-MM-DD) to holiday titles.
    """
    now = time.time()
    raw_data = _BANK_HOLIDAY_CACHE.get("data")
    if client is None and raw_data is not None and (now - _BANK_HOLIDAY_CACHE["fetched_at"]) < _CACHE_TTL_SECONDS:
        payload = raw_data
    else:
        own_client = client is None
        http = client or httpx.Client(timeout=15.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
        try:
            resp = http.get(GOV_UK_BANK_HOLIDAYS_URL)
            resp.raise_for_status()
            payload = resp.json()
            if client is None:
                _BANK_HOLIDAY_CACHE["data"] = payload
                _BANK_HOLIDAY_CACHE["fetched_at"] = now
        finally:
            if own_client:
                http.close()

    div_block = payload.get(division) or payload.get("england-and-wales") or {}
    events = div_block.get("events", [])
    holidays: dict[str, str] = {}
    for ev in events:
        d_str = ev.get("date")
        title = ev.get("title", "Bank Holiday")
        if d_str:
            holidays[d_str] = title
    return {
        "division": division if division in payload else "england-and-wales",
        "holidays": holidays,
        "source_url": GOV_UK_BANK_HOLIDAYS_URL,
    }


def calculate_three_clear_days_notice(
    meeting_date_iso: str,
    division: str = "england-and-wales",
    bank_holidays_override: dict[str, str] | None = None,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """
    Compute the latest lawful date to publish a Parish/Town Council meeting summons & agenda
    under Local Government Act 1972 Schedule 12 paragraph 10(2)(b) and section 243.

    Statutory rule:
    - "Three clear days" excludes BOTH the day the notice is published/given AND the day of the meeting.
    - Excluded non-clear days under LGA 1972 s.243(1):
      * Sunday
      * Christmas Day, Good Friday, or a bank holiday under the Banking and Financial Dealings Act 1971
      * Any day appointed for public thanksgiving or mourning
    - Note: Saturdays ARE counted as clear days in strict LGA 1972 s.243 unless NALC Model Standing Orders
      also exclude Saturdays; we return both the strict statutory date (LGA 1972) and the NALC Model Standing
      Order conservative date (excluding Saturdays as well).
    """
    meeting_date = dt.date.fromisoformat(meeting_date_iso.strip())
    if bank_holidays_override is not None:
        holidays = bank_holidays_override
        source_url = GOV_UK_BANK_HOLIDAYS_URL
    else:
        bh_info = fetch_uk_bank_holidays(division=division, client=client)
        holidays = bh_info["holidays"]
        source_url = bh_info["source_url"]

    def _trace_clear_days(exclude_saturday: bool) -> dict[str, Any]:
        clear_days: list[str] = []
        skipped_days: list[dict[str, str]] = []
        cursor = meeting_date - dt.timedelta(days=1)
        while len(clear_days) < 3:
            d_iso = cursor.isoformat()
            weekday = cursor.weekday()  # Monday=0 .. Saturday=5, Sunday=6
            if weekday == 6:
                skipped_days.append({"date": d_iso, "reason": "Sunday (excluded under LGA 1972 s.243)"})
            elif exclude_saturday and weekday == 5:
                skipped_days.append({"date": d_iso, "reason": "Saturday (excluded under NALC Model Standing Orders)"})
            elif d_iso in holidays:
                skipped_days.append({"date": d_iso, "reason": f"Bank Holiday: {holidays[d_iso]}"})
            elif (cursor.month, cursor.day) == (12, 25):
                skipped_days.append({"date": d_iso, "reason": "Christmas Day (LGA 1972 s.243)"})
            else:
                clear_days.append(d_iso)
            cursor -= dt.timedelta(days=1)

        # Notice publication date is the day BEFORE the earliest of the 3 clear days,
        # and should itself not fall on a Sunday or Bank Holiday for physical/clerk posting.
        publish_date = cursor
        while (
            publish_date.weekday() == 6
            or (exclude_saturday and publish_date.weekday() == 5)
            or publish_date.isoformat() in holidays
        ):
            skipped_days.append(
                {
                    "date": publish_date.isoformat(),
                    "reason": "Non-posting day rolled back to preceding working day",
                }
            )
            publish_date -= dt.timedelta(days=1)

        return {
            "latest_publish_date": publish_date.isoformat(),
            "latest_publish_weekday": publish_date.strftime("%A"),
            "clear_days_counted": list(reversed(clear_days)),
            "skipped_days": list(reversed(skipped_days)),
        }

    strict_lga = _trace_clear_days(exclude_saturday=False)
    nalc_recommended = _trace_clear_days(exclude_saturday=True)

    return {
        "status": "ok",
        "statute": "Local Government Act 1972, Schedule 12, para 10(2)(b) & s.243",
        "meeting_date": meeting_date.isoformat(),
        "meeting_weekday": meeting_date.strftime("%A"),
        "division": division,
        "strict_lga1972_schedule12": strict_lga,
        "nalc_model_standing_orders_recommended": nalc_recommended,
        "source_url": source_url,
    }


def calculate_agar_public_rights_window(
    financial_year_end: int = 2026,
    commencement_date_iso: str | None = None,
    division: str = "england-and-wales",
    bank_holidays_override: dict[str, str] | None = None,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """
    Calculate the 30-working-day period for the Exercise of Public Rights under the
    Accounts and Audit Regulations 2015 (SI 2015/234, Regulation 15) for a Smaller Authority
    (Parish Council, Internal Drainage Board, etc.).

    Statutory requirements:
    - Financial year ends 31 March {financial_year_end}.
    - Inspection window must be a single period of 30 working days (excluding Saturdays, Sundays,
      Christmas Day, Good Friday, and Bank Holidays).
    - MUST include the first 10 working days of July {financial_year_end} (Reg. 15(1)(b)).
    - Notice must be published at least 1 day before the commencement date (and AGAR Section 1 & 2
      must be approved by Full Council prior to publication of the notice).
    - Final audited AGAR or Certificate of Exemption deadline: 30 September {financial_year_end}.
    """
    if bank_holidays_override is not None:
        holidays = bank_holidays_override
        source_url = GOV_UK_BANK_HOLIDAYS_URL
    else:
        bh_info = fetch_uk_bank_holidays(division=division, client=client)
        holidays = bh_info["holidays"]
        source_url = bh_info["source_url"]

    def _is_working_day(d: dt.date) -> bool:
        return d.weekday() < 5 and d.isoformat() not in holidays

    # Compute the first 10 working days of July in `financial_year_end`
    july_cursor = dt.date(financial_year_end, 7, 1)
    first_10_july_working_days: list[dt.date] = []
    while len(first_10_july_working_days) < 10:
        if _is_working_day(july_cursor):
            first_10_july_working_days.append(july_cursor)
        july_cursor += dt.timedelta(days=1)

    first_july_wd = first_10_july_working_days[0]
    tenth_july_wd = first_10_july_working_days[-1]

    # Default recommended commencement date: earliest June working day whose 30-working-day window
    # covers all first 10 working days of July (e.g., Wed 3 June 2026 -> Tue 14 July 2026).
    if commencement_date_iso:
        start_date = dt.date.fromisoformat(commencement_date_iso.strip())
    else:
        # Count backwards 30 working days ending on tenth_july_wd
        back_cursor = tenth_july_wd
        wd_back = 0
        while wd_back < 30:
            if _is_working_day(back_cursor):
                wd_back += 1
                if wd_back == 30:
                    break
            back_cursor -= dt.timedelta(days=1)
        start_date = back_cursor

    # Walk forward 30 working days from start_date
    working_days: list[str] = []
    cursor = start_date
    while len(working_days) < 30:
        if _is_working_day(cursor):
            working_days.append(cursor.isoformat())
        cursor += dt.timedelta(days=1)

    actual_start = dt.date.fromisoformat(working_days[0])
    actual_end = dt.date.fromisoformat(working_days[-1])

    # Latest notice publication date is at least 1 calendar/working day before commencement
    latest_notice_date = actual_start - dt.timedelta(days=1)
    while not _is_working_day(latest_notice_date):
        latest_notice_date -= dt.timedelta(days=1)

    includes_first_10_july = (actual_start <= first_july_wd) and (actual_end >= tenth_july_wd)

    return {
        "status": "ok",
        "statute": "Accounts and Audit Regulations 2015 (SI 2015/234, Reg. 15)",
        "financial_year": f"20{financial_year_end - 1 - 2000:02d}/{financial_year_end - 2000:02d}",
        "financial_year_end_date": f"{financial_year_end}-03-31",
        "latest_announcement_date": latest_notice_date.isoformat(),
        "commencement_date": actual_start.isoformat(),
        "conclusion_date": actual_end.isoformat(),
        "working_days_count": len(working_days),
        "first_10_working_days_of_july": {
            "start": first_july_wd.isoformat(),
            "end": tenth_july_wd.isoformat(),
            "included_in_window": includes_first_10_july,
        },
        "statutory_compliant": includes_first_10_july and len(working_days) == 30,
        "final_agar_publication_deadline": f"{financial_year_end}-09-30",
        "source_url": source_url,
    }


def resolve_parish_and_ward_by_postcode(
    postcode: str,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """
    Resolve a UK postcode to its Civil Parish, Electoral Ward, Local Authority Council,
    and ONS GSS codes via official Ordnance Survey / ONS Open Government Licence v3.0 data.
    """
    clean_pc = re.sub(r"\s+", "", (postcode or "").strip().upper())
    if not clean_pc:
        return {"status": "error", "error": "Empty postcode"}

    own_client = client is None
    http = client or httpx.Client(timeout=12.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
    url = f"{POSTCODES_IO_URL}/{urllib.parse.quote(clean_pc)}"
    try:
        resp = http.get(url)
        if resp.status_code == 404:
            return {"status": "ok", "found": False, "postcode_input": postcode, "source_url": url}
        resp.raise_for_status()
        res = (resp.json() or {}).get("result") or {}
        codes = res.get("codes") or {}
        parish_name = res.get("parish")
        parish_code = codes.get("parish")
        is_unparished = bool(parish_name and "unparished" in parish_name.lower())
        return {
            "status": "ok",
            "found": True,
            "postcode": res.get("postcode"),
            "civil_parish": parish_name,
            "is_parished_area": bool(parish_name and not is_unparished),
            "electoral_ward": res.get("admin_ward"),
            "principal_local_authority": res.get("admin_district"),
            "county": res.get("admin_county"),
            "parliamentary_constituency": res.get("parliamentary_constituency_2024") or res.get("parliamentary_constituency"),
            "country": res.get("country"),
            "gss_codes": {
                "parish": parish_code,
                "admin_district": codes.get("admin_district"),
                "admin_ward": codes.get("admin_ward"),
            },
            "licence": "Open Government Licence v3.0 (ONS / Ordnance Survey)",
            "source_url": url,
        }
    finally:
        if own_client:
            http.close()


def audit_jpag_assertion_10_domain(
    domain: str,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """
    Audit a Parish Council or Village Hall Charity domain against JPAG Practitioners' Guide
    (AGAR Assertion 10: Digital & Email Governance) using Cloudflare DNS-over-HTTPS (RFC 8484).
    Checks:
    - Official `.gov.uk` (or `.org.uk` for registered village hall charities) domain usage
    - MX record presence (council-owned email vs personal webmail)
    - SPF (`v=spf1`) configuration
    - DMARC (`v=DMARC1`) policy (`reject` / `quarantine` / `none`)
    - CAA record presence
    """
    clean_domain = re.sub(r"^https?://", "", (domain or "").strip().lower()).split("/")[0].strip(".")
    if not clean_domain or "." not in clean_domain:
        return {"status": "error", "error": "Invalid domain"}

    own_client = client is None
    http = client or httpx.Client(
        timeout=12.0,
        headers={"User-Agent": USER_AGENT, "Accept": "application/dns-json"},
        follow_redirects=True,
    )

    def _doh(name: str, qtype: str) -> list[str]:
        resp = http.get(CLOUDFLARE_DOH_URL, params={"name": name, "type": qtype})
        resp.raise_for_status()
        ans = (resp.json() or {}).get("Answer") or []
        return [str(a.get("data", "")).strip('"') for a in ans if a.get("data")]

    try:
        mx_records = _doh(clean_domain, "MX")
        txt_records = _doh(clean_domain, "TXT")
        dmarc_records = _doh(f"_dmarc.{clean_domain}", "TXT")
        caa_records = _doh(clean_domain, "CAA")

        spf_records = [r for r in txt_records if "v=spf1" in r.lower()]
        dmarc_valid = [r for r in dmarc_records if "v=dmarc1" in r.lower()]
        dmarc_policy = "missing"
        if dmarc_valid:
            m = re.search(r"p\s*=\s*([a-zA-Z]+)", dmarc_valid[0], flags=re.IGNORECASE)
            dmarc_policy = m.group(1).lower() if m else "present"

        is_gov_uk = clean_domain in ("gov.uk", "gov.wales") or clean_domain.endswith(".gov.uk") or clean_domain.endswith(".gov.wales")
        is_org_uk = clean_domain.endswith(".org.uk")

        score = 0
        recommendations: list[str] = []
        if is_gov_uk:
            score += 35
        elif is_org_uk:
            score += 25
            recommendations.append("JPAG Practitioners' Guide strongly recommends .gov.uk for Parish/Town Councils (.org.uk is standard for registered Village Hall charities).")
        else:
            score += 10
            recommendations.append("Migrate to a Cabinet Office CDDO-approved .gov.uk domain (eligible for Parish Council helper funding) to satisfy JPAG Assertion 10.")

        if mx_records:
            score += 20
        else:
            recommendations.append("Configure dedicated domain MX records so Clerk and Councillors do not use personal Gmail/BTInternet accounts (Freedom of Information & UK GDPR requirement).")

        if spf_records:
            score += 20
        else:
            recommendations.append("Publish an SPF TXT record (v=spf1) to prevent spoofing of council/charity precept and grant notices.")

        if dmarc_policy in ("reject", "quarantine"):
            score += 25
        elif dmarc_policy == "none":
            score += 10
            recommendations.append("Upgrade _dmarc policy from p=none to p=quarantine or p=reject.")
        else:
            recommendations.append("Publish a _dmarc TXT record (v=DMARC1; p=quarantine; ...).")

        grade = "A" if score >= 85 else ("B" if score >= 65 else ("C" if score >= 45 else "D"))
        return {
            "status": "ok",
            "domain": clean_domain,
            "is_gov_uk_domain": is_gov_uk,
            "is_org_uk_domain": is_org_uk,
            "jpag_assertion_10_score": score,
            "jpag_assertion_10_grade": grade,
            "mx_configured": len(mx_records) > 0,
            "spf_configured": len(spf_records) > 0,
            "dmarc_policy": dmarc_policy,
            "caa_configured": len(caa_records) > 0,
            "recommendations": recommendations,
            "source_url": CLOUDFLARE_DOH_URL,
        }
    finally:
        if own_client:
            http.close()


def generate_statutory_ics(
    council_or_charity_name: str,
    notice_calc: dict[str, Any],
    agar_calc: dict[str, Any],
) -> str:
    """
    Generate an RFC-5545 compliant .ics calendar file containing:
    1. Latest Agenda & Summons Publication Deadline (LGA 1972 Sch. 12)
    2. Council / Trustees Meeting Date
    3. AGAR Exercise of Public Rights Notice Announcement Deadline
    4. AGAR 30-Working-Day Public Inspection Commencement & Conclusion
    5. Statutory 30 September AGAR Publication Deadline
    """
    safe_name = re.sub(r"[\r\n,;]+", " ", council_or_charity_name or "Parish Council").strip()
    dtstamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    events = [
        (
            "lga1972-notice",
            notice_calc["nalc_model_standing_orders_recommended"]["latest_publish_date"],
            f"DEADLINE: Publish Summons & Agenda ({safe_name})",
            f"Statutory 3 Clear Days notice deadline (NALC recommended) for {notice_calc['meeting_date']} meeting under LGA 1972 Sch 12 para 10(2)(b).",
        ),
        (
            "lga1972-meeting",
            notice_calc["meeting_date"],
            f"Meeting: {safe_name}",
            "Parish Council / Trustees Statutory Meeting.",
        ),
        (
            "agar-notice",
            agar_calc["latest_announcement_date"],
            f"DEADLINE: Publish AGAR Public Rights Notice ({safe_name})",
            "Accounts and Audit Regulations 2015 Reg 15 notice must be published at least 1 day before public inspection starts.",
        ),
        (
            "agar-start",
            agar_calc["commencement_date"],
            f"START: 30-Working-Day AGAR Public Rights Window ({safe_name})",
            f"30 working days inspection window ({agar_calc['commencement_date']} to {agar_calc['conclusion_date']}).",
        ),
        (
            "agar-deadline",
            agar_calc["final_agar_publication_deadline"],
            f"STATUTORY DEADLINE: Final Audited AGAR Publication ({safe_name})",
            "Final date to publish audited AGAR Section 1, 2 & 3 or Certificate of Exemption.",
        ),
    ]

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//TechnoPlusIT//UK Parish & Charity Statutory Almanac//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]
    for uid_suffix, date_iso, summary, desc in events:
        d_compact = date_iso.replace("-", "")
        lines.extend(
            [
                "BEGIN:VEVENT",
                f"UID:{uid_suffix}-{d_compact}@technoplusit.co.uk",
                f"DTSTAMP:{dtstamp}",
                f"DTSTART;VALUE=DATE:{d_compact}",
                f"SUMMARY:{summary}",
                f"DESCRIPTION:{desc}",
                "END:VEVENT",
            ]
        )
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


# ---------------------------------------------------------------------------
# Stage-2 Sunday Extensions (25 Oct 2026):
# 1. FY 2026/27 Section 137 (£11.60/elector) vs General Power of Competence (Localism Act 2011)
# 2. 30 Sept 2026 Charity Commission Audit, Independent Examination & SORP 2026 Threshold Checker
# 3. HMRC Mandatory Payrolling of Benefits in Kind (BiKs) 50% Overriding Cap & Carry-Forward
# 4. Apify-to-MCP input_schema.json Silent Bug Linter (@TechTimmydcz required+default trap)
# ---------------------------------------------------------------------------

import copy
import json
import math

S137_RATES_BY_FY: dict[str, float] = {
    "2024/25": 10.81,
    "2025/26": 11.10,
    "2026/27": 11.60,
}


def calculate_s137_and_gpc_eligibility(
    electors_count: int = 1200,
    total_councillor_seats: int = 11,
    elected_councillors: int = 7,
    clerk_cilca_qualified: bool | None = None,
    proposed_s137_spend_gbp: float = 0.0,
    financial_year: str = "2026/27",
    *,
    clerk_ciLCA: bool | None = None,
    cilca: bool | None = None,
    clerk_qualified: bool | None = None,
    total_seats: int | None = None,
    elected: int | None = None,
    proposed_spend: float | None = None,
) -> dict[str, Any]:
    """
    Calculate Local Government Act 1972 s.137(4)(a) annual expenditure cap (£11.60/elector in 2026/27)
    AND evaluate General Power of Competence (GPC) eligibility under the Localism Act 2011 (ss. 1-8)
    and The Parish Councils (General Power of Competence) (Prescribed Conditions) Order 2012 (SI 2012/965).
    Supports parameter aliases (`clerk_ciLCA`, `cilca`, `clerk_qualified`, ` clerk_cilca_qualified`).
    """
    resolved_cilca = next(
        (bool(v) for v in (clerk_cilca_qualified, clerk_ciLCA, cilca, clerk_qualified) if v is not None),
        False,
    )
    clerk_cilca_qualified = resolved_cilca
    electors = max(0, int(electors_count))
    seats = max(1, int(total_seats if total_seats is not None else total_councillor_seats))
    elected = max(0, min(seats, int(elected if elected is not None else elected_councillors)))
    spend = max(0.0, float(proposed_spend if proposed_spend is not None else proposed_s137_spend_gbp))
    fy = financial_year if financial_year in S137_RATES_BY_FY else "2026/27"
    rate_per_elector = S137_RATES_BY_FY[fy]

    two_thirds_required = math.ceil((seats * 2) / 3)
    meets_elected_threshold = elected >= two_thirds_required
    gpc_eligible = bool(meets_elected_threshold and clerk_cilca_qualified)

    annual_s137_cap_gbp = round(electors * rate_per_elector, 2)
    remaining_s137_headroom_gbp = round(max(0.0, annual_s137_cap_gbp - spend), 2)
    exceeds_s137_cap = round(max(0.0, spend - annual_s137_cap_gbp), 2)
    within_s137_cap = spend <= annual_s137_cap_gbp

    if gpc_eligible:
        governing_power = "GENERAL_POWER_OF_COMPETENCE_LOCALISM_ACT_2011"
        statutory_warning = (
            "Council meets both statutory conditions for the General Power of Competence (Localism Act 2011 ss.1-8 & SI 2012/965). "
            "Once adopted by Full Council resolution, there is no per-elector s.137 cap — and under LGA 1972 s.137(9), the council "
            "must NOT use Section 137 for general discretionary spending (only narrow s.137(3) charity/public service contributions)."
        )
    else:
        governing_power = "SECTION_137_LGA_1972_CAPPED"
        missing_reasons: list[str] = []
        if not meets_elected_threshold:
            missing_reasons.append(
                f"elected councillors ({elected}/{seats}) is below the statutory two-thirds threshold ({two_thirds_required}/{seats} required; co-opted members excluded)"
            )
        if not clerk_cilca_qualified:
            missing_reasons.append("Clerk does not hold CiLCA / Level 4 Community Governance qualification")
        statutory_warning = (
            f"Council is NOT eligible for the General Power of Competence ({'; '.join(missing_reasons)}). "
            f"Discretionary 'power of last resort' spending is restricted to LGA 1972 Section 137, capped at £{rate_per_elector:.2f} "
            f"per elector (£{annual_s137_cap_gbp:,.2f} total for FY {fy}). Requires a separate s.137 account and minute resolution."
        )

    return {
        "status": "ok",
        "statutes": [
            "Local Government Act 1972, Section 137(4)(a)",
            "Localism Act 2011, Sections 1-8",
            "The Parish Councils (General Power of Competence) (Prescribed Conditions) Order 2012 (SI 2012/965)",
        ],
        "financial_year": fy,
        "electors_on_1_april_roll": electors,
        "s137_rate_per_elector_gbp": rate_per_elector,
        "s137_annual_cap_gbp": annual_s137_cap_gbp,
        "proposed_s137_spend_gbp": round(spend, 2),
        "s137_remaining_headroom_gbp": remaining_s137_headroom_gbp,
        "s137_excess_over_cap_gbp": exceeds_s137_cap,
        "within_s137_cap": within_s137_cap,
        "gpc_assessment": {
            "total_councillor_seats": seats,
            "elected_councillors_count": elected,
            "coopted_or_vacant_seats": seats - elected,
            "two_thirds_elected_threshold": two_thirds_required,
            "meets_two_thirds_elected_rule": meets_elected_threshold,
            "clerk_holds_cilca_or_level4": bool(clerk_cilca_qualified),
            "gpc_eligible": gpc_eligible,
        },
        "governing_power": governing_power,
        "statutory_guidance": statutory_warning,
        "source_url": "https://www.legislation.gov.uk/ukpga/1972/70/section/137",
    }


def check_charity_2026_thresholds(
    gross_income_gbp: float,
    gross_assets_gbp: float = 0.0,
    charity_structure: str = "unincorporated_or_cio",
    financial_year_end_iso: str = "2027-03-31",
) -> dict[str, Any]:
    """
    Evaluate UK Charity Commission for England & Wales external scrutiny (Independent Examination vs Audit),
    Receipts & Payments eligibility, and Charities SORP 2026 Tier under the 30 September 2026 threshold reforms.
    """
    income = max(0.0, float(gross_income_gbp))
    assets = max(0.0, float(gross_assets_gbp))
    structure = (charity_structure or "unincorporated_or_cio").strip().lower()
    is_company = structure in ("charitable_company", "company", "clg")
    fye = (financial_year_end_iso or "2027-03-31").strip()
    post_sept_2026 = fye >= "2026-09-30"

    if post_sept_2026:
        ie_threshold = 40_000.0
        qualified_ie_threshold = 500_000.0
        rp_max_income = 500_000.0
        audit_income_threshold = 1_500_000.0
        audit_asset_income_trigger = 500_000.0
        audit_asset_threshold = 5_000_000.0
        regime_label = "POST_30_SEPT_2026_REFORMED_THRESHOLDS"
    else:
        ie_threshold = 25_000.0
        qualified_ie_threshold = 250_000.0
        rp_max_income = 250_000.0
        audit_income_threshold = 1_000_000.0
        audit_asset_income_trigger = 250_000.0
        audit_asset_threshold = 3_260_000.0
        regime_label = "PRE_30_SEPT_2026_LEGACY_THRESHOLDS"

    audit_by_income = income > audit_income_threshold
    audit_by_assets = (income > audit_asset_income_trigger) and (assets > audit_asset_threshold)
    mandatory_audit = audit_by_income or audit_by_assets

    if mandatory_audit:
        scrutiny_required = "STATUTORY_AUDIT_MANDATORY"
        examiner_requirement = "Registered Statutory Auditor required (Charities Act 2011 s.144)."
    elif income > qualified_ie_threshold:
        scrutiny_required = "INDEPENDENT_EXAMINATION_QUALIFIED_CC32_EXAMINER"
        examiner_requirement = (
            f"Independent Examination permitted, but Examiner MUST hold a recognised professional qualification "
            f"listed in Charities Act 2011 s.145(3) / CC32 (income > £{qualified_ie_threshold:,.0f})."
        )
    elif income > ie_threshold:
        scrutiny_required = "INDEPENDENT_EXAMINATION_COMPETENT_PERSON"
        examiner_requirement = (
            f"Independent Examination required (income > £{ie_threshold:,.0f}), may be carried out by an independent "
            f"person whom trustees reasonably believe has the requisite ability and practical experience."
        )
    else:
        scrutiny_required = "NO_EXTERNAL_SCRUTINY_REQUIRED"
        examiner_requirement = (
            f"Exempt from mandatory Independent Examination or Audit (gross income <= £{ie_threshold:,.0f}), "
            "unless explicitly required by the charity's governing document or a grant funder."
        )

    receipts_and_payments_allowed = (not is_company) and (income <= rp_max_income)

    if income <= 500_000.0:
        sorp_tier = "SORP_2026_TIER_1"
        sorp_summary = "Tier 1 (<= £500k income): Simplified modular reporting; exempt from Cash Flow Statement."
    elif income <= 15_000_000.0:
        sorp_tier = "SORP_2026_TIER_2"
        sorp_summary = "Tier 2 (£500k - £15m income): Standard accruals disclosures under Charities SORP 2026."
    else:
        sorp_tier = "SORP_2026_TIER_3"
        sorp_summary = "Tier 3 (> £15m income): Full enhanced impact, sustainability, and cash-flow disclosures."

    reform_benefits: list[str] = []
    if post_sept_2026:
        if 25_000.0 < income <= 40_000.0:
            reform_benefits.append(
                "NEW 30 SEPT 2026 BENEFIT: Your Village Hall / charity (£25k–£40k income) is no longer subject to mandatory statutory Independent Examination (threshold raised from £25,000 to £40,000)."
            )
        if (not is_company) and (250_000.0 < income <= 500_000.0):
            reform_benefits.append(
                "NEW 30 SEPT 2026 BENEFIT: Non-company charities with £250k–£500k income can now prepare simpler Receipts & Payments accounts (threshold doubled from £250,000 to £500,000) and do not require a CC32-qualified examiner unless gross income exceeds £500,000."
            )
        if (1_000_000.0 < income <= 1_500_000.0) and not audit_by_assets:
            reform_benefits.append(
                "NEW 30 SEPT 2026 BENEFIT: Statutory full audit threshold increased from £1.0m to £1.5m — qualified Independent Examination is now permitted."
            )

    return {
        "status": "ok",
        "statute": "Charities Act 2011 (ss. 130, 133, 144, 145) as amended 30 September 2026 & Charities SORP 2026",
        "financial_year_end": fye,
        "threshold_regime": regime_label,
        "gross_income_gbp": round(income, 2),
        "gross_assets_gbp": round(assets, 2),
        "charity_structure": "charitable_company" if is_company else "unincorporated_or_cio",
        "scrutiny_required": scrutiny_required,
        "examiner_requirement": examiner_requirement,
        "receipts_and_payments_accounts_permitted": receipts_and_payments_allowed,
        "accruals_accounts_mandatory": not receipts_and_payments_allowed,
        "sorp_2026_tier": sorp_tier,
        "sorp_2026_summary": sorp_summary,
        "thresholds_applied_gbp": {
            "independent_examination_income_threshold": ie_threshold,
            "qualified_examiner_income_threshold": qualified_ie_threshold,
            "receipts_and_payments_max_income": rp_max_income,
            "statutory_audit_income_threshold": audit_income_threshold,
            "statutory_audit_asset_threshold": audit_asset_threshold,
        },
        "reform_2026_highlights": reform_benefits,
        "source_url": "https://www.gov.uk/guidance/prepare-a-charity-annual-return",
    }


def calculate_hmrc_bik_payrolling_cap(
    annual_cash_salary_gbp: float = 18_000.0,
    annual_bik_cash_equivalent_gbp: float = 36_000.0,
    pay_periods_per_year: int = 12,
    marginal_tax_rate: float | None = None,
    personal_allowance_gbp: float = 12_570.0,
    registration_month: int = 1,
    remaining_pay_periods: int | None = None,
    monthly_cash_pay_schedule: list[float] | dict[int | str, float] | str | None = None,
    bonus_month: int | None = None,
    bonus_amount_gbp: float = 0.0,
) -> dict[str, Any]:
    """
    HMRC Mandatory Payrolling of Benefits in Kind (BiKs) — 50% Overriding Regulatory Limit & Carry-Forward Calculator.
    Models:
    - HMRC PAYE Specification (v24.0): Income Tax deducted in any pay period cannot exceed 50% of the employee's
      cash pay (excluding notional payrolled benefits).
    - Mid-year benefit registration (`registration_month`, 1..12, or `remaining_pay_periods`): compresses an annual
      or newly registered benefit across the remaining active pay periods while regular cash tax applies normally.
    - Variable monthly cash pay (`monthly_cash_pay_schedule` or `bonus_month` + `bonus_amount_gbp`): models how
      uncollected BiK tax carried forward from a low-cash / capped period is absorbed in subsequent higher-cash
      periods vs spilling into year-end P800 recovery.
    - Real-time Class 1A Employer National Insurance (15% rate) per pay period vs annual total.
    """
    cash_annual = max(0.0, float(annual_cash_salary_gbp))
    bik_annual = max(0.0, float(annual_bik_cash_equivalent_gbp))
    periods = int(pay_periods_per_year) if int(pay_periods_per_year) in (1, 4, 12, 26, 52) else 12

    if remaining_pay_periods is not None:
        rem = max(1, min(periods, int(remaining_pay_periods)))
        reg_period = periods - rem + 1
    else:
        reg_period = max(1, min(periods, int(registration_month or 1)))
    active_bik_periods = max(1, periods - reg_period + 1)

    base_period_cash_pay = round(cash_annual / periods, 2)
    active_period_notional_bik = round(bik_annual / active_bik_periods, 2)
    base_overriding_50pct_cap = round(base_period_cash_pay * 0.50, 2)

    # Build per-period cash pay schedule (supports constant pay, CSV/list schedule, dict overrides, or bonus_month)
    cash_schedule: list[float] = [base_period_cash_pay for _ in range(periods)]
    if monthly_cash_pay_schedule is not None:
        if isinstance(monthly_cash_pay_schedule, str):
            parts = [p.strip() for p in monthly_cash_pay_schedule.split(",") if p.strip()]
            for idx, val_str in enumerate(parts[:periods]):
                cash_schedule[idx] = round(max(0.0, float(val_str)), 2)
        elif isinstance(monthly_cash_pay_schedule, (list, tuple)):
            for idx, val in enumerate(list(monthly_cash_pay_schedule)[:periods]):
                cash_schedule[idx] = round(max(0.0, float(val)), 2)
        elif isinstance(monthly_cash_pay_schedule, dict):
            for k, v in monthly_cash_pay_schedule.items():
                p_idx = int(k) - 1
                if 0 <= p_idx < periods:
                    cash_schedule[p_idx] = round(max(0.0, float(v)), 2)

    if bonus_month is not None and 1 <= int(bonus_month) <= periods and float(bonus_amount_gbp) != 0.0:
        b_idx = int(bonus_month) - 1
        cash_schedule[b_idx] = round(max(0.0, cash_schedule[b_idx] + float(bonus_amount_gbp)), 2)

    effective_annual_cash = round(sum(cash_schedule), 2)

    if marginal_tax_rate is not None:
        rate = max(0.0, min(0.60, float(marginal_tax_rate)))
        period_allowance = round(max(0.0, float(personal_allowance_gbp)) / periods, 2)
        cash_only_tax_per_period = round(max(0.0, base_period_cash_pay - period_allowance) * rate, 2)
        annual_bik_tax = round(bik_annual * rate, 2)
        bik_tax_per_active_period = round(annual_bik_tax / active_bik_periods, 2)
        raw_tax_per_period = round(cash_only_tax_per_period + bik_tax_per_active_period, 2)
        marginal_rate_for_delta = rate
    else:
        def _uk_annual_income_tax(gross: float) -> float:
            pa = float(personal_allowance_gbp)
            if gross > 100_000.0:
                pa = max(0.0, pa - ((gross - 100_000.0) / 2.0))
            taxable = max(0.0, gross - pa)
            basic_band = 37_700.0
            higher_limit = 125_140.0 - float(personal_allowance_gbp)
            if taxable <= basic_band:
                return taxable * 0.20
            if taxable <= higher_limit:
                return (basic_band * 0.20) + ((taxable - basic_band) * 0.40)
            return (basic_band * 0.20) + ((higher_limit - basic_band) * 0.40) + ((taxable - higher_limit) * 0.45)

        annual_total_tax = _uk_annual_income_tax(cash_annual + bik_annual)
        annual_cash_only_tax = _uk_annual_income_tax(cash_annual)
        annual_bik_tax = max(0.0, annual_total_tax - annual_cash_only_tax)
        cash_only_tax_per_period = round(annual_cash_only_tax / periods, 2)
        bik_tax_per_active_period = round(annual_bik_tax / active_bik_periods, 2)
        if reg_period == 1:
            raw_tax_per_period = round(annual_total_tax / periods, 2)
            bik_tax_per_active_period = round(raw_tax_per_period - cash_only_tax_per_period, 2)
        else:
            raw_tax_per_period = round(cash_only_tax_per_period + bik_tax_per_active_period, 2)
        marginal_rate_for_delta = 0.45 if (cash_annual + bik_annual) > 125_140.0 else (0.40 if (cash_annual + bik_annual) > 50_270.0 else 0.20)

    schedule: list[dict[str, Any]] = []
    carried_forward = 0.0
    total_tax_deducted = 0.0
    total_carried_forward_absorbed = 0.0
    any_cap_triggered = False

    for p in range(1, periods + 1):
        cash_p = cash_schedule[p - 1]
        cap_p = round(cash_p * 0.50, 2)
        bik_active = p >= reg_period
        notional_bik_p = active_period_notional_bik if bik_active else 0.0

        # Compute period tax directly on (cash_p + notional_bik_p) so low-cash / high-BiK and mid-year compression are exact
        if reg_period == 1 and abs(cash_p - base_period_cash_pay) < 0.01:
            period_new_tax = raw_tax_per_period
        elif marginal_tax_rate is not None:
            period_allowance = round(max(0.0, float(personal_allowance_gbp)) / periods, 2)
            period_new_tax = round(max(0.0, (cash_p + notional_bik_p) - period_allowance) * marginal_rate_for_delta, 2)
        else:
            period_new_tax = round(_uk_annual_income_tax((cash_p + notional_bik_p) * periods) / periods, 2)

        brought_forward = carried_forward
        total_due_this_period = round(period_new_tax + brought_forward, 2)
        if total_due_this_period > cap_p:
            any_cap_triggered = True
            deducted = cap_p
            uncollected_next = round(total_due_this_period - deducted, 2)
            absorbed_this_period = round(max(0.0, deducted - period_new_tax), 2)
        else:
            deducted = total_due_this_period
            uncollected_next = 0.0
            absorbed_this_period = brought_forward

        total_carried_forward_absorbed = round(total_carried_forward_absorbed + absorbed_this_period, 2)
        net_cash_take_home_before_ni = round(cash_p - deducted, 2)
        total_tax_deducted = round(total_tax_deducted + deducted, 2)
        schedule.append(
            {
                "period": p,
                "cash_pay_gbp": cash_p,
                "notional_payrolled_bik_gbp": notional_bik_p,
                "brought_forward_uncollected_tax_gbp": brought_forward,
                "current_period_tax_gbp": period_new_tax,
                "total_tax_liability_in_period_gbp": total_due_this_period,
                "hmrc_50pct_overriding_cap_gbp": cap_p,
                "tax_deducted_from_pay_gbp": deducted,
                "carried_forward_absorbed_in_period_gbp": absorbed_this_period,
                "uncollected_tax_carried_forward_gbp": uncollected_next,
                "cap_triggered": total_due_this_period > cap_p,
                "cash_pay_after_income_tax_gbp": net_cash_take_home_before_ni,
            }
        )
        carried_forward = uncollected_next

    annual_class_1a_nic = round(bik_annual * 0.15, 2)
    period_class_1a_nic = round(annual_class_1a_nic / active_bik_periods, 2)

    return {
        "status": "ok",
        "statute": "HMRC PAYE Specification for Tax Table Routines (v24.0) & Mandatory Payrolling of Benefits in Kind (April 2027)",
        "inputs": {
            "annual_cash_salary_gbp": round(cash_annual, 2),
            "effective_total_cash_pay_in_schedule_gbp": effective_annual_cash,
            "annual_bik_cash_equivalent_gbp": round(bik_annual, 2),
            "pay_periods_per_year": periods,
            "bik_registration_period": reg_period,
            "active_bik_pay_periods": active_bik_periods,
            "variable_cash_pay_mode": any(abs(c - base_period_cash_pay) >= 0.01 for c in cash_schedule),
        },
        "per_period_summary": {
            "period_cash_pay_gbp": base_period_cash_pay,
            "period_notional_bik_gbp": active_period_notional_bik,
            "hmrc_50pct_overriding_limit_gbp": base_overriding_50pct_cap,
            "cash_only_tax_per_period_gbp": cash_only_tax_per_period,
            "uncapped_tax_with_bik_per_period_gbp": raw_tax_per_period,
            "incremental_bik_tax_per_period_gbp": bik_tax_per_active_period,
        },
        "overriding_limit_triggered": any_cap_triggered,
        "total_tax_deducted_via_payroll_gbp": total_tax_deducted,
        "total_carried_forward_tax_absorbed_in_subsequent_periods_gbp": total_carried_forward_absorbed,
        "year_end_uncollected_tax_for_hmrc_p800_recovery_gbp": carried_forward,
        "employer_class_1a_nic_15pct": {
            "rate": 0.15,
            "annual_class_1a_nic_gbp": annual_class_1a_nic,
            "per_period_realtime_fps_class_1a_nic_gbp": period_class_1a_nic,
        },
        "compliance_timeline": {
            "november_2026": "HMRC online registration service opens for voluntary payrolling of non-mandatory BiKs.",
            "5_april_2027": "Final cut-off before mandatory real-time payrolling takes effect.",
            "6_april_2027": "Mandatory real-time RTI Full Payment Submission (FPS) reporting of Income Tax & Class 1A NIC on Benefits in Kind.",
            "6_july_2027": "Final legacy P11D / P11D(b) submission deadline for tax year 2026/27.",
        },
        "period_schedule": schedule,
        "source_url": "https://www.gov.uk/guidance/payrolling-tax-employees-benefits-and-expenses-through-your-payroll",
    }

def lint_apify_mcp_input_schema(
    input_schema_or_json: str | dict[str, Any],
    auto_fix_strategy: str = "move_default_to_prefill",
) -> dict[str, Any]:
    """
    Lint an Apify `.actor/input_schema.json` file for MCP (Model Context Protocol) silent failure bugs:
    1. CRITICAL (`APIFY_MCP_REQUIRED_WITH_DEFAULT_TRAP`): Field is in `required` AND has a `default` value.
       `apify/apify-mcp-server` treats any field with `default` as optional in `tools/list`, so MCP agents
       (Claude, Cursor, Grok Bot) omit the field and the Actor call fails or runs with unintended defaults —
       while Apify's automated daily maintenance check passes because it sends `prefill`.
    2. HIGH (`APIFY_MAINTENANCE_MISSING_PREFILL_ON_REQUIRED`): Required field has no `default` and no `prefill`,
       causing Apify's automated daily test to fail and flag the Actor "Under maintenance".
    3. MEDIUM (`UNDEFINED_REQUIRED_PROPERTY` / `MISSING_AGENT_DESCRIPTION`): Structural or agent-readiness gaps.
    Returns a 0-100 score, structured issues, and an auto-remediated `fixed_input_schema`.
    """
    if isinstance(input_schema_or_json, str):
        try:
            schema = json.loads(input_schema_or_json)
        except Exception as exc:
            return {
                "status": "error",
                "error": f"Invalid JSON: {exc}",
                "is_mcp_safe": False,
                "mcp_compatibility_score": 0,
            }
    elif isinstance(input_schema_or_json, dict):
        schema = copy.deepcopy(input_schema_or_json)
    else:
        return {
            "status": "error",
            "error": "Input must be a JSON string or dictionary representing .actor/input_schema.json",
            "is_mcp_safe": False,
            "mcp_compatibility_score": 0,
        }

    fixed = copy.deepcopy(schema)
    props = fixed.get("properties")
    if not isinstance(props, dict):
        props = {}
        fixed["properties"] = props

    req_raw = fixed.get("required")
    required_list: list[str] = [str(x) for x in req_raw] if isinstance(req_raw, list) else []
    required_set = set(required_list)

    issues: list[dict[str, Any]] = []
    score = 100

    for req_field in list(required_list):
        if req_field not in props or not isinstance(props.get(req_field), dict):
            score -= 20
            issues.append(
                {
                    "field": req_field,
                    "severity": "MEDIUM",
                    "code": "UNDEFINED_REQUIRED_PROPERTY",
                    "detail": f"Field '{req_field}' is listed in 'required' but missing from 'properties'.",
                    "remediation": f"Remove '{req_field}' from 'required' or define it in 'properties'.",
                }
            )
            required_list.remove(req_field)
            required_set.discard(req_field)

    for prop_name, prop_def in props.items():
        if not isinstance(prop_def, dict):
            continue
        is_req = prop_name in required_set
        has_default = "default" in prop_def and prop_def["default"] is not None
        has_prefill = "prefill" in prop_def and prop_def["prefill"] is not None
        prop_type = str(prop_def.get("type") or "string")
        desc = str(prop_def.get("description") or "").strip()

        if is_req and has_default:
            score -= 35
            default_val = prop_def["default"]
            issues.append(
                {
                    "field": prop_name,
                    "severity": "CRITICAL",
                    "code": "APIFY_MCP_REQUIRED_WITH_DEFAULT_TRAP",
                    "detail": (
                        f"Field '{prop_name}' is marked 'required' AND has 'default': {json.dumps(default_val)}. "
                        "Over Apify MCP Server (tools/list), fields with 'default' are advertised to AI agents as OPTIONAL, "
                        "causing agents to omit the field while Apify daily tests hide the bug via prefill."
                    ),
                    "remediation": (
                        f"Move 'default' ({json.dumps(default_val)}) to 'prefill' so MCP keeps '{prop_name}' required AND "
                        "Apify Console / daily maintenance tests still pre-populate it."
                    ),
                }
            )
            if auto_fix_strategy == "remove_from_required":
                if prop_name in required_list:
                    required_list.remove(prop_name)
                required_set.discard(prop_name)
            else:
                if not has_prefill and prop_type != "boolean":
                    prop_def["prefill"] = default_val
                prop_def.pop("default", None)
                has_default = False
                has_prefill = "prefill" in prop_def

        if is_req and not has_default and not has_prefill and prop_type != "boolean":
            score -= 20
            issues.append(
                {
                    "field": prop_name,
                    "severity": "HIGH",
                    "code": "APIFY_MAINTENANCE_MISSING_PREFILL_ON_REQUIRED",
                    "detail": (
                        f"Required field '{prop_name}' has neither 'prefill' nor 'default'. Apify automated daily health checks "
                        "will invoke the Actor with an empty value and mark the Actor 'Under maintenance'."
                    ),
                    "remediation": f"Add a valid 'prefill' sample value to '{prop_name}' in .actor/input_schema.json.",
                }
            )

        if len(desc) < 10:
            score -= 5
            issues.append(
                {
                    "field": prop_name,
                    "severity": "LOW",
                    "code": "SPARSE_MCP_TOOL_DESCRIPTION",
                    "detail": f"Property '{prop_name}' has a missing or very short description ({len(desc)} chars), degrading MCP agent parameter selection.",
                    "remediation": "Provide a clear 1-sentence description explaining expected format and units.",
                }
            )

    if required_list:
        fixed["required"] = required_list
    elif "required" in fixed:
        fixed["required"] = []

    score = max(0, min(100, score))
    critical_count = sum(1 for i in issues if i["severity"] == "CRITICAL")
    high_count = sum(1 for i in issues if i["severity"] == "HIGH")

    return {
        "status": "ok",
        "is_mcp_safe": critical_count == 0 and high_count == 0,
        "mcp_compatibility_score": score,
        "properties_scanned": len(props),
        "required_fields_count": len(required_list),
        "critical_required_default_traps": critical_count,
        "high_maintenance_prefill_gaps": high_count,
        "issues_count": len(issues),
        "issues": issues,
        "fixed_input_schema": fixed,
        "reference_url": "https://docs.apify.com/platform/actors/development/actor-definition/input-schema/specification/v1",
    }



def extract_uk_scanned_pdf_clauses(
    pdf_path: str | None = None,
    pdf_bytes: bytes | None = None,
    pdf_base64: str | None = None,
    pdf_url: str | None = None,
    raw_text: str | None = None,
    document_type: str = "auto",
    semantic_query: str | None = None,
    top_k: int = 5,
) -> dict[str, Any]:
    """
    Zero-Token UK Scanned PDF & Deed Clause Extractor (pdftotext + pypdfium2 + RapidOCR +
    local FastEmbed BAAI/bge-small-en-v1.5 + ephemeral in-memory sqlite-vec).
    """
    import sys
    from pathlib import Path

    mcp_dir = str(Path(__file__).resolve().parents[1] / "uk-us-compliance-mcp-actor")
    if mcp_dir not in sys.path:
        sys.path.insert(0, mcp_dir)
    from pdf_clause_extractor import extract_uk_scanned_pdf_clauses as _impl

    return _impl(
        pdf_path=pdf_path,
        pdf_bytes=pdf_bytes,
        pdf_base64=pdf_base64,
        pdf_url=pdf_url,
        raw_text=raw_text,
        document_type=document_type,
        semantic_query=semantic_query,
        top_k=top_k,
    )


# ---------------------------------------------------------------------------
# Stage-3 North Star Integration (25 Oct 2026):
# UK Property Tribunal Rent Repayment Order (RRO) & Section 13 Precedent Finder
# ---------------------------------------------------------------------------

def search_uk_rro_precedents(
    q: str = "",
    region: str = "",
    offence_type: str = "",
    mitigation: str = "",
    max_pct: float | None = None,
    limit: int = 25,
    *,
    export_format: str = "json",
) -> dict[str, Any]:
    """
    Search the read-only (`?mode=ro`) SQLite FTS5 + deterministic vector index of 80 real
    GOV.UK Residential Property Tribunal Rent Repayment Order (RRO) decisions.
    """
    import sys
    from pathlib import Path

    rro_dir = str(Path(__file__).resolve().parents[1] / "uk-property-tribunal-rro-finder")
    if rro_dir not in sys.path:
        sys.path.insert(0, rro_dir)
    from rro_engine import search_rro_precedents as _search_impl

    return _search_impl(
        q=q,
        region=region,
        offence_type=offence_type,
        mitigation=mitigation,
        max_pct=max_pct,
        limit=limit,
        export_format=export_format,
    )


def audit_private_rro_claim_or_pdf(
    payload_bytes: bytes | None = None,
    claim_text: str = "",
    region_hint: str = "",
    claimed_gbp_hint: float | None = None,
) -> dict[str, Any]:
    """
    Stateless per-request private RRO claim / PDF audit.
    Processes private user PDF bytes or claim text inside an isolated ephemeral workspace
    and deterministically wipes all temporary files in `finally:`.
    """
    import sys
    from pathlib import Path

    rro_dir = str(Path(__file__).resolve().parents[1] / "uk-property-tribunal-rro-finder")
    if rro_dir not in sys.path:
        sys.path.insert(0, rro_dir)
    from rro_engine import audit_private_pdf_bytes as _audit_impl

    return _audit_impl(
        payload_bytes=payload_bytes,
        claim_text=claim_text,
        region_hint=region_hint,
        claimed_gbp_hint=claimed_gbp_hint,
    )


def get_uk_rro_usage_stats() -> dict[str, Any]:
    """
    Return privacy-safe aggregate North Star usage counters and explicit zero-PII attestations.
    """
    import sys
    from pathlib import Path

    rro_dir = str(Path(__file__).resolve().parents[1] / "uk-property-tribunal-rro-finder")
    if rro_dir not in sys.path:
        sys.path.insert(0, rro_dir)
    from rro_engine import get_rro_usage_stats as _stats_impl

    return _stats_impl()


def record_uk_rro_usage_event(event_type: str) -> dict[str, Any]:
    """
    Increment a privacy-safe aggregate RRO usage counter ("search", "pack_download", "private_audit").
    """
    import sys
    from pathlib import Path

    rro_dir = str(Path(__file__).resolve().parents[1] / "uk-property-tribunal-rro-finder")
    if rro_dir not in sys.path:
        sys.path.insert(0, rro_dir)
    from rro_engine import record_rro_usage_event as _rec_impl

    return _rec_impl(event_type=event_type)
