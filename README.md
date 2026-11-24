# ZenBank — Agent conversațional pentru actualizarea datelor cu EUDI Wallet

**Echipa:** Banking 4.0 · Team 04 · **Soluție:** ZenBank EUDI Data Update

> **Același ZenBank. Aceeași nevoie. Aceeași experiență digitală — indiferent de documentul de identitate cu care ai început relația cu banca.**

**ZenBank EUDI Data Update** permite clienților bancari (inclusiv cetățenilor UE fără flux automat pe carte de identitate românească) să își actualizeze complet datele KYC direct în aplicația ZenBank folosind **EUDI Wallet (`PID` + `Adresă` + `Atestare venit`)**, reguli deterministe pe backend și un asistent conversațional **Zero-PII** bazat pe Gemini — cu **0 documente încărcate** și **0 câmpuri completate manual**.

---

## Teză & Flux principal

**Formula:** `Clientul cere → Agentul orchestrează → EUDI verifică → ZenBank actualizează`

1. **Flux principal — Actualizare date (`Radu Stan` — profil live; `Alex Popescu` și `Maria Ionescu` disponibili în selector):**
   - Clientul apasă **Actualizează-mi datele personale** în ZenBank.
   - Agentul citește contextul ZenBank (`document: IDENTITY_DOCUMENT`, adresă curentă `Bulevardul Unirii 22, 030133 București, România`, venit anterior `Nedeclarat / 10.000 – 15.000 RON`) și explică ruta EUDI în locul încărcării actului de identitate și a adeverinței de venit.
   - Ecranul de pre-consimțământ explică clar **ce** se solicită și **de ce**:
     - **PID (`urn:banking40:sandbox:pid-ro:1`)**: `given_name`, `family_name`, `birthdate` *(reconfirmare identitate titular)*
     - **Adresă (`urn:banking40:sandbox:address:1`)**: `address.formatted` *(verificare schimbare domiciliu)*
     - **Sursă venit și angajator (`urn:banking40:sandbox:income:1`)**: `income_type`, `payer.legal_name`, `monthly_income.periods` → agregat KYC (`tranșă venit`), fără stocarea sumelor lunare brute
     - **Ignorate / nepersistate:** `personal_numeric_code` (CNP), `place_of_birth`, sumele lunare brute detaliate și încărcarea fizică de documente.
   - Verificare live cross-device prin **Tremend EUDI Verifier (`qa-both-23`)** și **EUDI Android Wallet**.
   - Backend-ul decriptează plicul JWE (`ECDH-ES+A256KW` / `A256GCM`), verifică semnătura internă `ES256` cu `/.well-known/jwks.json`, validează `typ`, `schema`, `iss`, `aud`, `exp`/`iat`, `transactionId`, protecția `jti`, verificările criptografice per credențial (`issuerSignature`, `holderBinding`, `validity`, `trustedIssuer`) și expirarea PID (`date_of_expiry`), apoi confirmă preluarea cu `DELETE /verifications/{id}/result`.
   - **Partajarea nu înseamnă actualizare automată:** Clientul vede comparația față în față (`Date curente ZenBank` vs. `Date verificate EUDI`) și apasă explicit **Confirmă actualizarea** înainte ca profilul ZenBank să fie modificat.

2. **Mini-demo secundar în chat — Recuperare restricție plăți (`"De ce nu pot face plăți?"`):**
   - Aceeași capabilitate, declanșată reactiv din suportul conversațional.
   - Agentul identifică `KYC_UPDATE_INCOMPLETE` (reconfirmare identitate pendinte) și direcționează clientul direct în **același** motor de verificare EUDI, ridicând restricția pe plăți după confirmare.

---

## Impact: Înainte vs. După

| Indicator | Astăzi (Flux clasic cu documente) | Cu ZenBank + EUDI Wallet |
| :--- | :--- | :--- |
| Câmpuri completate manual | ~12 câmpuri | **0** |
| Documente încărcate (act de identitate, factură, adeverință) | 3 fișiere / drum la sucursală | **0** |
| Timp de procesare KYC | 1–3 zile lucrătoare | **~20 secunde** |
| Supra-partajare date | Copie act de identitate + state de plată integrale | **PID minim + Adresă + Tranșă KYC (fără CNP sau sume brute)** |
| Risc de falsificare | PDF-uri / fotografii editabile | **VC semnat de emitent + JWE/ES256 Verifier** |

**Ipoteze explicite:**
- Emisiunea de PID, Adresă și Atestare de venit este activă în ecosistemul EUDI și acceptată de politica Relying Party a băncii.
- În producție, verificarea statusului de revocare folosește **Token Status List** live (în sandbox `checks.status = NOT_CHECKED`, motiv pentru care actualizările automate sunt limitate la adresă și sursă de venit pentru aceeași persoană, iar schimbările de nume/CNP merg la analiză KYC manuală).
- Nu există alerte de sancțiuni/PEP care să necesite escaladare manuală.

---

## Arhitectură & Limită Zero-PII către LLM

```text
+-------------------------------------------------------------------------+
| React + TypeScript Frontend (frontend/)                                 |
| - Profil ZenBank în timp real (adresă, sursă venit/angajator, plăți)    |
| - Flux conversațional în română (Pre-Consimțământ, QR/DeepLink, Diff)   |
| - Inspector Verificare & Zero-PII                                       |
+-----------------------------------+-------------------------------------+
                                    | HTTPS JSON (X-Session-Id; fără secrete/JWE)
                                    v
+-------------------------------------------------------------------------+
| Node.js + TypeScript Express Backend (backend/src/)                     |
|                                                                         |
|  [agent/piiScrubber.ts]    Anonimizează nume, CNP, IBAN, angajator, JWT |
|  [agent/geminiAssistant.ts] @google/genai (gemini-4-hydrogen, store:false)|
|                             primește DOAR ZeroPiiAgentContext (enum-uri)|
|  [banking/rules.ts]        Asociere identitate, diff adresă/venit, gate |
|  [verifier/crypto.ts]      ECDH-ES+A256KW JWE -> ES256 JWKS -> jti      |
|  [logging.ts]              Filtru redactare chei sensibile și token-uri |
+-----------------------------------+-------------------------------------+
                                    | HTTP semnat HMAC-SHA256 + JWE/JWKS
                                    v
+-------------------------------------------------------------------------+
| Tremend EUDI Verifier (qa-both-23) & EUDI Android Wallet                |
|  - VERIFIER_MODE=live -> apeluri HTTPS către Tremend Verifier           |
|  - VERIFIER_MODE=mock -> MockVerifierClient criptografic (teste/dev)    |
+-------------------------------------------------------------------------+
```

### De ce `DISCLOSURE` (`qa-both-23`) și asocierea între credențiale
- **De ce `DISCLOSURE` și nu `DECISION`:** ZenBank trebuie să lege identitatea prezentată (`given_name`, `family_name`, `birthdate`) de titularul autentificat în cont, să calculeze diferențele față de adresa curentă și să deriveze tranșa KYC de venit din atestarea de venit.
- **Asocierea între credențiale (Cross-Credential Binding):** Atunci când credențialele secundare includ atribute de titular (ex. modelul FIDES BRI), `rules.ts` verifică egalitatea (`given_name`, `family_name`, `birthdate`) față de `PID`. Când `ADDRESS` și `INCOME_ATTESTATION` din sandbox nu repetă numele titularului, ele sunt legate criptografic în aceeași prezentare OpenID4VP prin **`holderBinding: true`** (același `nonce` și `aud`), în timp ce `PID` leagă persoana de profilul ZenBank.
- **Ce atribut putem elimina:** Pentru o simplă reconfirmare de identitate (ex. deblocare plăți fără schimbare de adresă/loc de muncă), ambele credențiale `ADDRESS` și `INCOME_ATTESTATION` pot fi eliminate complet, păstrând doar `PID`.

---

## Stack & Structură

- **Backend (`backend/`)**: Node.js 24+, TypeScript 5, Express 4, `jose` v6, `@google/genai` (`gemini-4-hydrogen`), `zod`, `dotenv`, `vitest`, `supertest`
- **Frontend (`frontend/`)**: React 18, TypeScript 5, Vite 6, `lucide-react`

---

## Rulare locală

### 1. Backend
```bash
cd backend
cp .env.example .env
# Completează EUDI_VERIFIER_KEY, EUDI_VERIFIER_SECRET, VERIFIER_PROFILE_CODE=qa-both-23,
# RESULT_PRIVATE_KEY_PATH=../result-key.pem și opțional GEMINI_API_KEY
npm install
npm run dev
```
*(Rulează pe `http://localhost:3001`.)*

### 2. Frontend
```bash
cd frontend
npm install
npm run dev
```
Deschide `http://localhost:5173`. (Pentru producție pe un singur port: rulează `npm run build` în `frontend/` și `backend/`, apoi `node backend/dist/index.js` — Express servește automat `frontend/dist`.)

### 3. Teste automate
```bash
cd backend
npm test
```

---

## Scenarii de test și demo live

1. **Flux principal (`Radu Stan`):** Apasă **Actualizează-mi datele personale** → **Continuă cu EUDI Wallet** → scanează QR sau folosește comanda `adb` din **Ajutor emulator Android** → aprobă în wallet → verifică tabelul de comparație (`Strada Exemplului 13, 300001 Timișoara` + `Example Services 4 SRL`, `15.000 – 20.000 RON / lună`) → apasă **Confirmă actualizarea**.
2. **Recuperare restricție plăți (`Plăți restricționate`):** Selectează scenariul **Plăți restricționate (Demo chat)** → apasă **De ce nu pot face plăți?** → parcurge același flux EUDI → restricția se ridică automat după confirmare.
3. **Blocaj de securitate (`Maria Ionescu`):** Selectează clientul **Maria Ionescu** → aprobă în wallet cu credențialele lui Radu Stan → Verifier returnează `SATISFIED`, **dar** ZenBank blochează actualizarea (`CUSTOMER_SUBJECT_MISMATCH`).
4. **Scenarii negative & Inspector:** Deschide **Verificare & Audit** pentru a inspecta verificările criptografice/reguli, JSON-ul exact `ZeroPiiAgentContext` trimis la Gemini, jurnalul de audit anonimizat și simulările `DECLINED`, `WITHHELD_ADDRESS`, `EXPIRED`, `WALLET_ERROR`.

---

## Docker / Deployment

```bash
docker build -t zenbank-eudi-agent .
docker run -p 8080:8080 \
  -e VERIFIER_MODE=live \
  -e EUDI_VERIFIER_URL=https://srv-verifier-ui-prod-yrqn8u.wittyflower-739866d8.westeurope.azurecontainerapps.io \
  -e EUDI_VERIFIER_KEY=<your-key> \
  -e EUDI_VERIFIER_SECRET=<your-secret> \
  -e EUDI_VERIFIER_RESULT_AUDIENCE=646562f7-a30d-4536-92a8-56f358aaf035 \
  -e VERIFIER_PROFILE_CODE=qa-both-23 \
  -e RESULT_PRIVATE_KEY_PEM="$(cat result-key.pem)" \
  -e GEMINI_API_KEY=<optional-gemini-key> \
  zenbank-eudi-agent
```
> **Notă de deployment:** Deoarece sesiunile și registrul anti-replay `seenJtis` sunt ținute în memorie pentru prototip, la rularea pe Cloud Run / Railway setează numărul maxim de instanțe la **1** (ex. `--max-instances=1`).

---

## Ce este live vs. simulat & drumul spre producție

- **Live în prototip:** API-ul Tremend Verifier (`POST /verifications`, polling, `GET/DELETE /result`), semnare HMAC-SHA256, decriptare JWE P-256, validare semnătură `ES256` prin `/.well-known/jwks.json`, protecție `jti`, verificări `issuerSignature` / `holderBinding` / `validity` / `trustedIssuer` / `date_of_expiry`, reguli de potrivire și diff, orchestrare Gemini Zero-PII (`store: false`) și wallet-ul Android EUDI.
- **Simulat în prototip:** Interfața web ZenBank, API-ul intern de profil/restricții (`Radu Stan`, `Alex Popescu`, `Maria Ionescu`), selectorul de scenarii/reset și butoanele opționale de simulare scenarii negative din Inspector.
- **Necesar pentru producție bancară:**
  - Înregistrare oficială ca **Relying Party** sub eIDAS 2, certificate de acces/înregistrare și validare prin **ETSI Trusted Lists** (`ETSI TS 119 612` / `602`).
  - Verificare live **Token Status List** pentru revocare (înlocuind `NOT_CHECKED`).
  - Integrare cu motoarele KYC/AML ale băncii (conformitate bancară, screening sancțiuni/PEP, escaladare manuală pentru schimbări de nume/identitate).
  - **PSD2 Strong Customer Authentication (SCA)** în ZenBank pentru confirmarea modificărilor sensibile de profil și registre formale GDPR de consimțământ/retenție.
