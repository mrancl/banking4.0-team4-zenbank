# ZenBank EUDI Data Update · Team 04

**Banking 4.0 Hackathon** — Update retail KYC data (address, income band, and `18+` eligibility) via **EUDI Wallet** with **0 document uploads**, **0 manual form fields**, and **explicit customer confirmation** in ~20 seconds.

- **Live App:** https://zenbank-eudi-825682833200.europe-west1.run.app
- **Pitch Deck:** [`pitch-deck/index.html`](pitch-deck/index.html) (Reveal.js · press `S` for speaker notes)
- **Android Wrapper:** [`android-wrapper/`](android-wrapper) (`ro.banking40.team04`, same-device auto-return)

---

## Demo Accounts (`Demo` menu)

| Customer | Role in Demo |
| :--- | :--- |
| **Radu Stan** | Primary live EUDI Wallet journey (`full`, `address`, `income`, `age-18`, payment restriction recovery) |
| **Alex Popescu** | Bank-blocked account (`BANK_POLICY_EUDI_BLOCKED`) — shows EUDI Wallet is only offered when bank policy permits |
| **Maria Ionescu** | Security block test when presenting another person's wallet (`CUSTOMER_SUBJECT_MISMATCH`) |

---

## Verification Profiles & Safeguards

- **Right-sized Verifier profiles:**
  - `age-18` (`DECISION`): Zero-PII Yes/No check in Chat (*Verifică eligibilitatea 18+*), profile untouched.
  - `qa-address-23` / `qa-income-23`: Minimal single-field update + holder name (`given_name`, `family_name`).
  - `qa-both-23`: Full KYC refresh (`PID` + `Address` + `Income`).
- **Fail-closed holder binding:** Cross-checks holder identity across PID, Address, Income, and the logged-in customer; blocks missing or mismatched holders (`CROSS_CREDENTIAL_SUBJECT_MISMATCH`, `MISSING_CREDENTIAL_SUBJECT_BINDING`).
- **Privacy & least-privilege storage:** Never persists `CNP` (`personal_numeric_code`), place of birth, or raw monthly salary amounts; AI Chat runs behind a strict **Zero-PII** boundary (`store: false`).
- **Resilient unhappy paths:** Clean recovery on wallet decline/cancel, short-lived income expiry (confirm-time re-check preserves valid address), and mandatory explicit confirmation (*Sharing is not approval*).

---

## Live vs. Simulated & Path to Production

- **Live:** Tremend EUDI Verifier API (`POST /verifications`, polling, `/claim`, `GET/DELETE /result`), JWE (`P-256`) + `ES256` JWKS + `jti` anti-replay verification, all 4 profiles, Android same-device wrapper, and Gemini Zero-PII assistant.
- **Simulated:** ZenBank core banking profiles (`Radu Stan`, `Alex Popescu`, `Maria Ionescu`), mock payment restriction flag, and static KYC brackets *(income attestations reflect annual/past periods mapped strictly to KYC brackets — not current monthly net pay or active employment)*.
- **Production additions:** Official eIDAS 2 Relying Party registration & EU Trusted Lists, live revocation checks, AML/PEP screening & escalation, GDPR consent audit logs, and PSD2 SCA for sensitive profile edits.

---

## Quick Start & Tests

```bash
# 1. Backend (http://localhost:3001)
cd backend
cp .env.example .env   # set EUDI_VERIFIER_KEY, EUDI_VERIFIER_SECRET, RESULT_PRIVATE_KEY_PATH
npm install && npm run dev

# 2. Frontend (http://localhost:5173)
cd ../frontend
npm install && npm run dev

# 3. Backend tests (47 Vitest tests)
cd ../backend && npm test

# 4. Optional Android wrapper APK (android-wrapper/build/zenbank-team04.apk)
cd .. && ./android-wrapper/build-apk.sh
```

> **Cloud Run / Docker note:** Session state and `jti` anti-replay tracking live in memory for the prototype; run with `--max-instances=1` (see `Dockerfile` and `backend/.env.example`).
