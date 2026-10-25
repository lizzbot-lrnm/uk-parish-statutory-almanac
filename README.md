# UK Parish Council, Charity & Property Tribunal Statutory Almanac (`v1.3.0`)

Live production deployment: **https://parish.technoplusit.co.uk**  
Live UK Property Tribunal RRO Precedent Finder & Section 44 Calculator: **https://parish.technoplusit.co.uk/rro**  
Live Streamable HTTP MCP Endpoint (`JSON-RPC 2.0`): **https://parish.technoplusit.co.uk/mcp**

## Ecosystem & Apify Store Actors
- **Apify Actor — UK & US Statutory Compliance & Property Tribunal MCP (`15 tools`):** [`https://apify.com/technoplusit/compliance-intel-mcp`](https://apify.com/technoplusit/compliance-intel-mcp) ([GitHub](https://github.com/lizzbot-lrnm/compliance-intel-mcp))
- **Apify Actor — UK Property Tribunal RRO Precedent Finder (`281 GOV.UK Rulings`):** [`https://apify.com/technoplusit/uk-property-tribunal-rro-finder`](https://apify.com/technoplusit/uk-property-tribunal-rro-finder) ([GitHub](https://github.com/lizzbot-lrnm/uk-property-tribunal-rro-finder))
- **Machine Discovery Manifests:** [`/llms.txt`](https://parish.technoplusit.co.uk/llms.txt) | [`/.well-known/agent.json`](https://parish.technoplusit.co.uk/.well-known/agent.json) | [`/sitemap.xml`](https://parish.technoplusit.co.uk/sitemap.xml)

## Deterministic Zero-LLM-Cost Statutory Calculators & Audits (`OGL v3.0`)
1. **UK Property Tribunal Rent Repayment Order (RRO) Precedent Finder & Section 44 Mitigation Calculator (`/rro`)** — `281` real GOV.UK First-tier Tribunal (Property Chamber) decisions (`163` direct verbatim extracts, `16` inferred, `102` dismissed/none), *Acheampong* utility deduction & Universal Credit adjuster, and 88 borough/region/year SEO pages.
2. **AGAR FY 2026/27 Statutory Deadline & Bank-Holiday-Adjusted Public Rights Calculator** (`Accounts and Audit Regulations 2015 SI 2015/234 reg. 12-15`)
3. **FY 2026/27 Section 137 (`£11.60`/elector) vs General Power of Competence (`Localism Act 2011 ss. 1-8` & `SI 2012/965`) Eligibility & Spend Cap Calculator**
4. **30 Sept 2026 Charity Commission External Scrutiny (`£40,000` IE / `£500,000` R&P / `£1.5m` Audit) & Charities SORP 2026 Tier Checker** (`SI 2026/945`)
5. **HMRC Mandatory Payrolling of Benefits in Kind (BiK) — 50% Cash-Pay Overriding Regulatory Cap & Carry-Forward Calculator** (`HMRC PAYE Technical Specification v24.0`)
6. **UK Scanned Legal Deed & Clause Extractor (`/api/pdf-clause-extract`)** — Section 106 obligations, Companies House MR01 negative pledges, and Charity Independent Examiner reports.
7. **Apify-to-MCP `input_schema.json` Silent Bug Linter & Auto-Fixer (`/api/apify-mcp-lint`)** (`required` + `default` silent drop protection & `prefill` enforcement)

## Running Tests

```bash
pytest -v tests/test_parish_almanac.py
```
