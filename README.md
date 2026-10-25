# UK Parish Council & Charity Statutory Almanac (`v1.1.0`)

Live production deployment: **https://parish.technoplusit.co.uk**

Deterministic UK statutory compliance and governance micro-utility suite for English Parish & Town Council Clerks, Responsible Financial Officers (RFOs), Charity Trustees, Payroll Bureaus, and MCP Server Engineers:

1. **AGAR FY 2026/27 Statutory Deadline & Bank-Holiday-Adjusted Public Rights Calculator** (`Accounts and Audit Regulations 2015 SI 2015/234 reg. 12-15`)
2. **FY 2026/27 Section 137 (`£11.60`/elector) vs General Power of Competence (`Localism Act 2011 ss. 1-8` & `SI 2012/965`) Eligibility & Spend Cap Calculator**
3. **30 Sept 2026 Charity Commission External Scrutiny (`£40,000` IE / `£500,000` R&P / `£1.5m` Audit) & Charities SORP 2026 Tier Checker** (`SI 2026/945`)
4. **HMRC Mandatory Payrolling of Benefits in Kind (BiK) — 50% Cash-Pay Overriding Regulatory Cap & Carry-Forward Calculator** (`HMRC PAYE Technical Specification v24.0`)
5. **Apify-to-MCP `input_schema.json` Silent Bug Linter & Auto-Fixer** (`required` + `default` silent drop protection & `prefill` enforcement)

## Running Tests

```bash
pytest -v tests/test_parish_almanac.py
```
