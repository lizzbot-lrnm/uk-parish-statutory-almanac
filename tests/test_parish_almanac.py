from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import parish_almanac as pa


def test_three_clear_days_with_bank_holiday_and_sunday() -> None:
    # Suppose meeting is Tuesday 2026-05-26 (day after Spring Bank Holiday Monday 2026-05-25)
    override_holidays = {"2026-05-25": "Spring bank holiday"}
    res = pa.calculate_three_clear_days_notice(
        "2026-05-26",
        bank_holidays_override=override_holidays,
    )
    assert res["status"] == "ok"
    # Strict LGA 1972 (Saturdays count, Sundays & Bank Holidays excluded):
    # Meeting = Tue 26 May
    # Mon 25 May = skipped (Spring bank holiday)
    # Sun 24 May = skipped (Sunday)
    # Clear days = Sat 23 May, Fri 22 May, Thu 21 May -> Publish Wed 20 May!
    strict = res["strict_lga1972_schedule12"]
    assert strict["clear_days_counted"] == ["2026-05-21", "2026-05-22", "2026-05-23"]
    assert strict["latest_publish_date"] == "2026-05-20"

    # NALC Model Standing Orders (Saturdays also excluded):
    # Clear days = Fri 22 May, Thu 21 May, Wed 20 May -> Publish Tue 19 May!
    nalc = res["nalc_model_standing_orders_recommended"]
    assert nalc["clear_days_counted"] == ["2026-05-20", "2026-05-21", "2026-05-22"]
    assert nalc["latest_publish_date"] == "2026-05-19"


def test_live_gov_uk_bank_holidays_and_agar_public_rights_window() -> None:
    bh = pa.fetch_uk_bank_holidays("england-and-wales")
    assert bh["division"] == "england-and-wales"
    assert "2026-12-25" in bh["holidays"] or "2026-08-31" in bh["holidays"]

    # Default 2025/26 AGAR window (auto-selects earliest compliant June date covering July 1-14)
    agar = pa.calculate_agar_public_rights_window(
        financial_year_end=2026,
    )
    assert agar["status"] == "ok"
    assert agar["financial_year"] == "2025/26"
    assert agar["commencement_date"] == "2026-06-03"
    assert agar["conclusion_date"] == "2026-07-14"
    assert agar["latest_announcement_date"] == "2026-06-02"
    assert agar["working_days_count"] == 30
    assert agar["first_10_working_days_of_july"]["included_in_window"] is True
    assert agar["statutory_compliant"] is True

    # Non-compliant window starting too early (e.g. 2026-05-05 ends before 10th working day of July)
    bad_agar = pa.calculate_agar_public_rights_window(
        financial_year_end=2026,
        commencement_date_iso="2026-05-05",
    )
    assert bad_agar["first_10_working_days_of_july"]["included_in_window"] is False
    assert bad_agar["statutory_compliant"] is False


def test_live_parish_and_ward_by_postcode_oxfordshire() -> None:
    # OX14 4AB -> Drayton Civil Parish, Vale of White Horse District
    pc = pa.resolve_parish_and_ward_by_postcode("OX14 4AB")
    assert pc["status"] == "ok"
    assert pc["found"] is True
    assert pc["is_parished_area"] is True
    assert pc["civil_parish"] == "Drayton"
    assert pc["principal_local_authority"] == "Vale of White Horse"
    assert pc["gss_codes"]["parish"] == "E04008205"


def test_live_jpag_assertion_10_and_ics_generation() -> None:
    audit = pa.audit_jpag_assertion_10_domain("gov.uk")
    assert audit["status"] == "ok"
    assert audit["is_gov_uk_domain"] is True
    assert audit["jpag_assertion_10_grade"] in ("A", "B")

    notice = pa.calculate_three_clear_days_notice("2026-11-16")
    agar = pa.calculate_agar_public_rights_window(financial_year_end=2026, commencement_date_iso="2026-06-01")
    ics = pa.generate_statutory_ics("Drayton Parish Council", notice, agar)
    assert "BEGIN:VCALENDAR" in ics
    assert "SUMMARY:DEADLINE: Publish Summons & Agenda (Drayton Parish Council)" in ics
    assert "SUMMARY:START: 30-Working-Day AGAR Public Rights Window (Drayton Parish Council)" in ics


def test_s137_and_gpc_eligibility_calculator() -> None:
    # 1. Council NOT eligible for GPC (6/11 elected < 8 required, no CiLCA) -> capped at £11.60/elector in 2026/27
    capped = pa.calculate_s137_and_gpc_eligibility(
        electors_count=1000,
        total_councillor_seats=11,
        elected_councillors=6,
        clerk_cilca_qualified=False,
        proposed_s137_spend_gbp=8500.0,
        financial_year="2026/27",
    )
    assert capped["status"] == "ok"
    assert capped["s137_rate_per_elector_gbp"] == 11.60
    assert capped["s137_annual_cap_gbp"] == 11600.00
    assert capped["s137_remaining_headroom_gbp"] == 3100.00
    assert capped["within_s137_cap"] is True
    assert capped["gpc_assessment"]["two_thirds_elected_threshold"] == 8
    assert capped["gpc_assessment"]["gpc_eligible"] is False
    assert capped["governing_power"] == "SECTION_137_LGA_1972_CAPPED"

    # 2. Council eligible for GPC (8/11 elected >= 8, CiLCA clerk) -> Localism Act 2011 GPC applies
    gpc = pa.calculate_s137_and_gpc_eligibility(
        electors_count=669,
        total_councillor_seats=11,
        elected_councillors=8,
        clerk_cilca_qualified=True,
        proposed_s137_spend_gbp=15000.0,
        financial_year="2026/27",
    )
    assert gpc["s137_annual_cap_gbp"] == 7760.40
    assert gpc["gpc_assessment"]["gpc_eligible"] is True
    assert gpc["governing_power"] == "GENERAL_POWER_OF_COMPETENCE_LOCALISM_ACT_2011"


def test_charity_2026_thresholds_checker() -> None:
    # 1. Village Hall with £32,000 income after 30 Sept 2026 -> newly exempt from Independent Examination (£40k threshold)
    vh = pa.check_charity_2026_thresholds(
        gross_income_gbp=32000.0,
        gross_assets_gbp=180000.0,
        charity_structure="unincorporated_or_cio",
        financial_year_end_iso="2027-03-31",
    )
    assert vh["status"] == "ok"
    assert vh["threshold_regime"] == "POST_30_SEPT_2026_REFORMED_THRESHOLDS"
    assert vh["scrutiny_required"] == "NO_EXTERNAL_SCRUTINY_REQUIRED"
    assert vh["receipts_and_payments_accounts_permitted"] is True
    assert vh["sorp_2026_tier"] == "SORP_2026_TIER_1"
    assert len(vh["reform_2026_highlights"]) >= 1

    # 2. Medium charity with £380,000 income (non-company) -> R&P permitted (up to £500k) + non-CC32 IE permitted
    med = pa.check_charity_2026_thresholds(
        gross_income_gbp=380000.0,
        gross_assets_gbp=400000.0,
        charity_structure="unincorporated_or_cio",
        financial_year_end_iso="2026-12-31",
    )
    assert med["scrutiny_required"] == "INDEPENDENT_EXAMINATION_COMPETENT_PERSON"
    assert med["receipts_and_payments_accounts_permitted"] is True

    # 3. Larger charity triggering asset-based audit (>£500k income AND >£5m assets)
    aud = pa.check_charity_2026_thresholds(
        gross_income_gbp=600000.0,
        gross_assets_gbp=5500000.0,
        charity_structure="charitable_company",
        financial_year_end_iso="2027-03-31",
    )
    assert aud["scrutiny_required"] == "STATUTORY_AUDIT_MANDATORY"
    assert aud["receipts_and_payments_accounts_permitted"] is False
    assert aud["sorp_2026_tier"] == "SORP_2026_TIER_2"


def test_hmrc_bik_payrolling_50pct_cap_and_carry_forward() -> None:
    # Low cash pay (£12,000/yr = £1,000/mo) + high BIK (£48,000/yr = £4,000/mo), 50% cap = £500/mo
    res = pa.calculate_hmrc_bik_payrolling_cap(
        annual_cash_salary_gbp=12000.0,
        annual_bik_cash_equivalent_gbp=48000.0,
        pay_periods_per_year=12,
    )
    assert res["status"] == "ok"
    assert res["per_period_summary"]["period_cash_pay_gbp"] == 1000.00
    assert res["per_period_summary"]["hmrc_50pct_overriding_limit_gbp"] == 500.00
    assert res["overriding_limit_triggered"] is True
    assert res["period_schedule"][0]["tax_deducted_from_pay_gbp"] == 500.00
    assert res["period_schedule"][0]["uncollected_tax_carried_forward_gbp"] > 0.0
    assert res["year_end_uncollected_tax_for_hmrc_p800_recovery_gbp"] > 0.0
    assert res["employer_class_1a_nic_15pct"]["annual_class_1a_nic_gbp"] == 7200.00


def test_apify_mcp_input_schema_linter_catches_techtimmy_bug() -> None:
    buggy_schema = {
        "title": "Test Actor Input",
        "type": "object",
        "schemaVersion": 1,
        "properties": {
            "entity_name": {
                "title": "Entity Name",
                "type": "string",
                "description": "Organization or company name to screen against public registries.",
                "default": "Oxfam",
            },
            "api_target": {
                "title": "Target",
                "type": "string",
                "description": "Target endpoint URL to inspect.",
            },
        },
        "required": ["entity_name", "api_target"],
    }
    lint = pa.lint_apify_mcp_input_schema(buggy_schema)
    assert lint["status"] == "ok"
    assert lint["is_mcp_safe"] is False
    assert lint["critical_required_default_traps"] == 1
    assert lint["high_maintenance_prefill_gaps"] == 1
    codes = {i["code"] for i in lint["issues"]}
    assert "APIFY_MCP_REQUIRED_WITH_DEFAULT_TRAP" in codes
    assert "APIFY_MAINTENANCE_MISSING_PREFILL_ON_REQUIRED" in codes

    # Verify auto-remediated schema moved 'default' -> 'prefill' on entity_name
    fixed_entity = lint["fixed_input_schema"]["properties"]["entity_name"]
    assert "default" not in fixed_entity
    assert fixed_entity["prefill"] == "Oxfam"


def test_spock_hmrc_bik_midyear_and_variable_cash_pay_recovery() -> None:
    # 1. Verify clerk_ciLCA alias on calculate_s137_and_gpc_eligibility
    gpc_alias = pa.calculate_s137_and_gpc_eligibility(
        electors_count=1200,
        total_seats=12,
        elected_councillors=8,
        clerk_ciLCA=True,
        proposed_spend=15000.0,
    )
    assert gpc_alias["gpc_assessment"]["clerk_holds_cilca_or_level4"] is True
    assert gpc_alias["gpc_assessment"]["gpc_eligible"] is True

    # 2. Mid-year registration (Month 10 -> 3 remaining pay periods: Oct, Nov, Dec/Jan-Mar)
    mid_year = pa.calculate_hmrc_bik_payrolling_cap(
        annual_cash_salary_gbp=24000.0,
        annual_bik_cash_equivalent_gbp=18000.0,
        pay_periods_per_year=12,
        registration_month=10,
    )
    assert mid_year["inputs"]["bik_registration_period"] == 10
    assert mid_year["inputs"]["active_bik_pay_periods"] == 3
    # Months 1..9 have £0 notional BiK; Month 10 has £6,000 notional BiK (£18,000 / 3)
    assert mid_year["period_schedule"][0]["notional_payrolled_bik_gbp"] == 0.0
    assert mid_year["period_schedule"][8]["notional_payrolled_bik_gbp"] == 0.0
    assert mid_year["period_schedule"][9]["notional_payrolled_bik_gbp"] == 6000.0

    # 3. Variable monthly cash pay: Month 1 has low cash pay (£600 unpaid leave month -> 50% cap = £300),
    # triggering carry-forward of uncollected BiK tax, followed by Month 2 bonus/normal pay (£4,500 -> cap = £2,250)
    # where the carried-forward tax is 100% absorbed inside the tax year (zero P800 balance at year end)!
    var_pay = pa.calculate_hmrc_bik_payrolling_cap(
        annual_cash_salary_gbp=24000.0,
        annual_bik_cash_equivalent_gbp=24000.0,
        pay_periods_per_year=12,
        monthly_cash_pay_schedule={1: 600.0, 2: 4500.0},
    )
    assert var_pay["inputs"]["variable_cash_pay_mode"] is True
    assert var_pay["overriding_limit_triggered"] is True
    assert var_pay["period_schedule"][0]["cap_triggered"] is True
    assert var_pay["period_schedule"][0]["uncollected_tax_carried_forward_gbp"] > 0.0
    assert var_pay["period_schedule"][1]["carried_forward_absorbed_in_period_gbp"] > 0.0
    assert var_pay["total_carried_forward_tax_absorbed_in_subsequent_periods_gbp"] > 0.0
    assert var_pay["year_end_uncollected_tax_for_hmrc_p800_recovery_gbp"] == 0.0


def test_parish_almanac_pdf_clause_extractor_integration() -> None:
    res = pa.extract_uk_scanned_pdf_clauses(
        raw_text=(
            "Clause 4.1: The Owner covenants to pay the Affordable Housing Contribution of £145,000 "
            "indexed to the BCIS All-In Tender Price Index prior to occupation of the 15th dwelling."
        ),
        document_type="s106",
    )
    assert res["status"] == "ok"
    assert res["tenant_isolation_proof"]["shared_database_used"] is False
    assert res["extracted_clauses"]["s106_planning_obligations"]["total_quantified_contributions_gbp"] == 145000.0
    assert res["benchmark_telemetry"]["llm_tokens_used"] == 0


def test_parish_almanac_rro_precedent_finder_and_ephemeral_audit() -> None:
    res = pa.search_uk_rro_precedents(q="LON/00AJ/HMG/2025/0666")
    assert res["isolation_mode"] == "OGL-v3.0-read-only"
    assert len(res["results"]) >= 1
    assert res["results"][0]["case_ref"] == "LON/00AJ/HMG/2025/0666"
    assert res["results"][0]["awarded_gbp"] == 8400.0
    assert res["results"][0]["award_pct_of_rent"] == 40.0

    audit = pa.audit_private_rro_claim_or_pdf(
        claim_text="Unlicensed HMO under section 72(1) in Ealing, London. Total rent claimed £18,000 inclusive of utilities.",
        region_hint="London",
        claimed_gbp_hint=18000.0,
    )
    assert audit["ephemeral_wiped"] is True
    assert audit["public_db_mode"] == "OGL-v3.0-read-only"
    assert audit["private_claim_summary"]["claimed_gbp_evaluated"] == 18000.0
    assert len(audit["comparable_ogl_precedents"]) >= 3
