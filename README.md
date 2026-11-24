# ZenBank — Agent conversațional pentru actualizarea datelor cu EUDI Wallet

**Echipa:** Banking 4.0 · Team 04 · **Soluție:** ZenBank EUDI Data Update

> **Același ZenBank. Aceeași nevoie. Aceeași experiență digitală — indiferent de documentul de identitate cu care ai început relația cu banca.**

**ZenBank EUDI Data Update** permite clienților bancari (inclusiv cetățenilor UE fără flux automat pe carte de identitate românească) să își actualizeze datele KYC direct în aplicația ZenBank (browser web sau wrapper Android nativ `ro.banking40.team04`) folosind **EUDI Wallet (`PID` + `Adresă` + `Atestare venit`)**, rutare dinamică pe profile minimale, reguli deterministe pe backend și un asistent conversațional **Zero-PII** bazat pe Gemini — cu **0 documente încărcate** și **0 câmpuri completate manual**.

---

## Teză & Flux principal

**Formula:** `Clientul cere → Agentul orchestrează → EUDI verifică → ZenBank actualizează`

1. **Flux principal — Actualizare date (`Radu Stan` — profil live; `Alex Popescu` și `Maria Ionescu` disponibili în foaia `Demo`):**
   - Clientul poate porni actualizarea din tab-ul **Datele mele** (**Actualizează-mi datele personale** pentru tot profilul, sau direct rândul **Adresa de domiciliu** / **Venit și angajator** pentru un scop minimal) ori din tab-ul **Chat** (limbaj natural sau chip-urile rapide `Mi-am schimbat adresa`, `Mi-am schimbat venitul`, `Actualizează tot profilul`).
   - **Rutare dinamică pe profile minimale (`orchestrator.ts` `resolveProfileCode`):**
     - `full` → **`qa-both-23`** (`PID` + `Adresă` + `Atestare venit`): pentru actualizarea completă a profilului sau reconfirmarea identității.
     - `address` → **`qa-address-23`**: solicită strict atestarea de **Adresă** (`address.formatted`), fără `PID` sau venit, când clientul este deja autentificat și actualizează doar domiciliul.
     - `income` → **`qa-income-23`**: solicită strict **Atestarea de venit** (interval de venit / media pe 6 luni și monedă), fără `PID` sau adresă (păstrând angajatorul/sursa existentă în profil dacă schema minimală nu le include).
   - Ecranul de pre-consimțământ explică clar **ce** se solicită și **de ce**:
     - **PID (`urn:banking40:sandbox:pid-ro:1`)**: `given_name`, `family_name`, `birthdate` *(reconfirmare identitate titular)*
     - **Adresă (`urn:banking40:sandbox:address:1`)**: `address.formatted` *(verificare schimbare domiciliu)*
     - **Sursă venit și angajator (`urn:banking40:sandbox:income:1`)**: `monthly_income.income_type`, `monthly_income.payer.legal_name`, `monthly_income.periods` → agregat KYC (`tranșă venit`), fără stocarea sumelor lunare brute
     - **Ignorate / nepersistate:** `personal_numeric_code` (CNP), `place_of_birth`, sumele lunare brute detaliate și încărcarea fizică de documente.
   - **Lansare cross-device vs. same-device:**
     - **Browser web:** Afișează butonul **Deschide în EUDI Wallet** și codul **QR** (`!isAndroidWrapper && !card.sameDevice`) pentru scanare cu telefonul.
     - **Wrapper Android (`android-wrapper/`):** Trimite `returnUri` (`ro.banking40.team04://same-device`), ascunde codul QR și afișează direct butonul **Deschide în EUDI Wallet**. După aprobarea cu PIN în Wallet, callback-ul `SameDeviceCallbackActivity` → `MainActivity` (`window.__zenbankHandleEudiCallback`) trimite `response_code` la `POST /api/verifications/claim` → `POST /api/website/verifications/{id}/claim` (serializat pe lacătul `inFlightPolls` față de polling-ul la 2s). Dacă este configurat `EUDI_VERIFIER_RETURN_URI`, și browserul Android poate folosi modul `same_device_web`.
   - **Validare criptografică, expirare și confirmare explicită:**
     - Backend-ul decriptează plicul JWE (`ECDH-ES+A256KW` / `A256GCM`), verifică semnătura internă `ES256` cu `/.well-known/jwks.json`, validează `typ`, `schema`, `iss`, `aud`, `exp`/`iat`, `transactionId`, protecția `jti`, verificările per credențial (`issuerSignature`, `holderBinding`, `validity`, `trustedIssuer`) și expirarea per credențial (`validUntil`/`validFrom`/`date_of_expiry`/`checks.validity`), apoi confirmă preluarea cu `DELETE /verifications/{id}/result`.
     - **Partajarea nu înseamnă actualizare automată:** Clientul vede comparația față în față (*În prezent* vs. *Din EUDI*) și apasă explicit **Confirmă și actualizează** înainte ca profilul ZenBank să fie modificat. Înainte de scriere, `confirmUpdate()` re-validează `validUntil` pentru a preveni salvarea unei credențiale expirate între timp (protecție TOCTOU).

2. **Mini-demo secundar în chat — Recuperare restricție plăți (`"De ce nu pot iniția o plată?"`):**
   - Declanșat din tab-ul **Chat** prin chip-ul rapid **„De ce nu pot iniția o plată?”** (sau întrebări similare despre plăți blocate).
   - Când profilul are actualizări necesare, backend-ul activează automat starea de restricție (`paymentRestricted`, `INCOMPLETE_UPDATE`), afișează cardul **Verificare profil ZenBank** (`Identitate`, `Adresă`, `Venit și angajator`, `Plăți și transferuri`) și direcționează clientul în **același** motor EUDI (`qa-both-23`), ridicând restricția pe plăți după confirmare.

---

## Impact: Înainte vs. După

| Indicator | Astăzi (Flux clasic cu documente) | Cu ZenBank + EUDI Wallet |
| :--- | :--- | :--- |
| Câmpuri completate manual | ~12 câmpuri | **0** |
| Documente încărcate (act de identitate, factură, adeverință) | 3 fișiere / drum la sucursală | **0** |
| Timp de procesare KYC | 1–3 zile lucrătoare | **~20 secunde** |
| Supra-partajare date | Copie act de identitate + state de plată integrale | **PID minim / Adresă / Venit minimal (fără CNP sau sume brute)** |
| Risc de falsificare | PDF-uri / fotografii editabile | **VC semnat de emitent + JWE/ES256 Verifier + anti-TOCTOU** |

**Ipoteze explicite:**
- Emisiunea de PID, Adresă și Atestare de venit este activă în ecosistemul EUDI și acceptată de politica Relying Party a băncii.
- În producție, verificarea statusului de revocare folosește **Token Status List** live (în sandbox `checks.status = NOT_CHECKED`, motiv pentru care actualizările automate sunt limitate la adresă și sursă de venit pentru aceeași persoană, iar schimbările de nume/CNP merg la analiză KYC manuală).
- Nu există alerte de sancțiuni/PEP care să necesite escaladare manuală.

---

## Arhitectură & Limită Zero-PII către LLM

```text
+-------------------------------------------------------------------------+
| Wrapper Android nativ (android-wrapper/, ro.banking40.team04)           |
| - MainActivity (WebView ?client=android)                                |
| - SameDeviceCallbackActivity (ro.banking40.team04://same-device)        |
+-----------------------------------+-------------------------------------+
                                    | Încarcă UI & livrează response_code
                                    v
+-------------------------------------------------------------------------+
| React + TypeScript Frontend (frontend/)                                 |
| - Tab-uri mobile: "Datele mele" + "Chat", temă dark/light, foaie "Demo" |
| - Pre-consimțământ dinamic, buton/QR (QR doar pe browser web), Diff     |
+-----------------------------------+-------------------------------------+
                                    | HTTPS JSON (X-Session-Id; fără secrete/JWE)
                                    v
+-------------------------------------------------------------------------+
| Node.js + TypeScript Express Backend (backend/src/)                     |
|                                                                         |
|  [agent/piiScrubber.ts]    Anonimizează nume, CNP, IBAN, angajator, JWT |
|  [agent/geminiAssistant.ts] @google/genai (gemini-4-hydrogen, store:false)|
|                             primește DOAR ZeroPiiAgentContext (enum-uri)|
|  [agent/orchestrator.ts]   Rutare qa-both-23/qa-address-23/qa-income-23,|
|                             claim response_code, re-validare TOCTOU     |
|  [banking/claimsParser.ts] Extracție parțială + validitate per credențial|
|  [banking/rules.ts]        Cross-credential binding, expirare, diff     |
|  [verifier/crypto.ts]      ECDH-ES+A256KW JWE -> ES256 JWKS -> jti      |
|  [logging.ts]              Filtru redactare chei sensibile și token-uri |
+-----------------------------------+-------------------------------------+
                                    | HTTP semnat HMAC-SHA256 + JWE/JWKS
                                    v
+-------------------------------------------------------------------------+
| Tremend EUDI Verifier (qa-both-23, qa-address-23, qa-income-23) & Wallet|
|  - VERIFIER_MODE=live -> apeluri HTTPS către Tremend Verifier           |
|  - VERIFIER_MODE=mock -> MockVerifierClient criptografic (teste/dev)    |
+-------------------------------------------------------------------------+
```

### Profile `DISCLOSURE`, asocierea între credențiale și expirare parțială
- **De ce `DISCLOSURE` (`qa-both-23`, `qa-address-23`, `qa-income-23`) și nu `DECISION`:** ZenBank trebuie să lege identitatea prezentată (`given_name`, `family_name`, `birthdate`) de titularul autentificat în cont, să calculeze diferențele față de adresa curentă și să deriveze tranșa KYC de venit din atestarea de venit. Pentru actualizări punctuale de pe **Datele mele** sau **Chat**, aplicația minimizează datele cerute folosind `qa-address-23` (doar adresă) sau `qa-income-23` (doar venit).
- **Asocierea între credențiale (Cross-Credential Binding):** `claimsParser.ts` (`extractPartialIdentity`) și `rules.ts` (`findSubjectConflicts`) compară **orice** atribut de identitate disponibil între `PID`, `ADDRESS` și `INCOME` — inclusiv câmpuri parțiale (`given_name`, `family_name`, `birthdate`) și **CNP evaluat exclusiv în memorie** (`personal_numeric_code` / `cnp` / `national_id`, fără persistare sau trimitere către LLM) — **înainte** de filtrarea de expirare. Dacă două credențiale identifică persoane diferite, actualizarea este blocată imediat (`CROSS_CREDENTIAL_SUBJECT_MISMATCH` / `CUSTOMER_SUBJECT_MISMATCH`). Când credențialele secundare din sandbox nu repetă numele titularului, ele rămân legate criptografic în aceeași prezentare OpenID4VP prin **`holderBinding: true`**.
- **Expirare pe credențiale scurte (ex. venit 2 minute) & protecție TOCTOU:** `claimsParser.ts` verifică `validUntil`, `validFrom`, `date_of_expiry` și `checks.validity` individual pentru fiecare credențial. Dacă **doar** atestarea de venit a expirat în fluxul `full`, iar `PID` și `Adresă` rămân valide:
  - Pe rezultat `SATISFIED`, venitul expirat este exclus cu un banner de avertizare (`warningNote`), permițând confirmarea adresei și identității (menținând `kycStatus = INCOMPLETE_UPDATE` până la actualizarea venitului).
  - Pe rezultat `NOT_SATISFIED` (`INCOME_CREDENTIAL_EXPIRED`), cardul de recuperare oferă fallback direct cu un singur tap (**Actualizează doar adresa acum** → `qa-address-23`) alături de reîncercare.
  - La confirmarea finală (`confirmUpdate`), orchestratorul re-verifică timestamp-urile `validUntil` față de ora curentă (protecție TOCTOU) înainte de a scrie în profilul ZenBank.

---

## Stack & Structură

- **Backend (`backend/`)**: Node.js 24+, TypeScript 5, Express 4, `jose` v6, `@google/genai` (`gemini-4-hydrogen`), `zod`, `dotenv`, `vitest`, `supertest`
- **Frontend (`frontend/`)**: React 18, TypeScript 5, Vite 6, `lucide-react`
- **Wrapper Android (`android-wrapper/`)**: Java (`MainActivity.java`, `SameDeviceCallbackActivity.java`), `WebView`, schemă same-device `ro.banking40.team04://same-device`, script build APK (`build-apk.sh`)

---

## Rulare locală

### 1. Backend
```bash
cd backend
cp .env.example .env
# Completează EUDI_VERIFIER_KEY, EUDI_VERIFIER_SECRET, VERIFIER_PROFILE_CODE=qa-both-23,
# RESULT_PRIVATE_KEY_PATH=../result-key.pem, opțional GEMINI_API_KEY,
# EUDI_VERIFIER_NATIVE_RETURN_URI=ro.banking40.team04://same-device
# și opțional EUDI_VERIFIER_RETURN_URI=<https-callback-url>
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

### 3. Wrapper Android (opțional, pentru same-device pe telefon/emulator)
```bash
./android-wrapper/build-apk.sh
```
*(Generează APK-ul semnat `android-wrapper/build/zenbank-team04.apk` folosind Android SDK build-tools și cheia din `Banking-4.0-Team-04/android-sdk/team-debug.p12`.)*

### 4. Teste automate
```bash
cd backend
npm test
```
Suitele Vitest acoperă: decriptare JWE și verificare ES256/JWKS/anti-replay `jti` (`crypto.test.ts`), semnare HMAC-SHA256 (`signer.test.ts`), anonimizare și barieră Zero-PII (`pii.test.ts`), motorul de reguli — profile minimale, cross-credential binding cu câmpuri parțiale/CNP în memorie, expirare venit cu fallback (`rules.test.ts`), și endpoint-urile Express — inclusiv `/api/verifications/claim` și protecția TOCTOU la confirmare (`api.test.ts`).

---

## Scenarii de test și demo live

1. **Flux principal (`Radu Stan`):** Apasă **Actualizează-mi datele personale** (sau selectează individual **Adresa de domiciliu** / **Venit și angajator** pentru profilul minimal) → **Continuă cu EUDI Wallet** → pe browser scanează codul QR sau deschide **Opțiuni testare / emulator Android** pentru comanda `adb` / link-ul EUDI (în wrapper-ul Android apasă direct **Deschide în EUDI Wallet**) → aprobă în wallet → verifică tabelul de comparație (`Strada Exemplului 13, 300001 Timișoara` + `Example Services 4 SRL`, `15.000 – 20.000 RON / lună`) → apasă **Confirmă și actualizează**.
2. **Recuperare restricție plăți (`Chat`):** Deschide tab-ul **Chat** → apasă chip-ul **„De ce nu pot iniția o plată?”** → agentul verifică contul ZenBank, activează automat restricția pe plăți când există actualizări necesare, afișează cardul **Verificare profil ZenBank** și pornește fluxul EUDI (`qa-both-23`) → restricția se ridică după confirmare.
3. **Blocaj de securitate (`Maria Ionescu`):** Deschide foaia **Demo** din antet → selectează clientul **Maria Ionescu** → aprobă în wallet cu credențialele lui Radu Stan → Verifier returnează `SATISFIED`, **dar** ZenBank blochează actualizarea (`CUSTOMER_SUBJECT_MISMATCH`).
4. **Verificări backend, audit & simulări automate:** Verificările criptografice/de reguli (`lastTrustChecks`), contextul `lastZeroPiiContext`, jurnalul de audit anonimizat (`auditLog`), schimbarea scenariului și simulările negative (`DECLINED`, `WITHHELD_ADDRESS`, `EXPIRED`, `WALLET_ERROR`) sunt expuse pe API-ul backend (`GET /api/session`, `POST /api/demo/scenario`, `POST /api/demo/simulate-unhappy`) și testate automat în `backend/src/__tests__/`.

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
  -e EUDI_VERIFIER_NATIVE_RETURN_URI=ro.banking40.team04://same-device \
  -e RESULT_PRIVATE_KEY_PEM="$(cat result-key.pem)" \
  -e GEMINI_API_KEY=<optional-gemini-key> \
  zenbank-eudi-agent
```
*(Opțional, pentru callback HTTPS same-device în browser Chrome pe Android, setează și `-e EUDI_VERIFIER_RETURN_URI=<https-callback-url>`.)*

> **Notă de deployment:** Deoarece sesiunile, lacătul `inFlightPolls` și registrul anti-replay `seenJtis` sunt ținute în memorie pentru prototip, la rularea pe Cloud Run / Railway setează numărul maxim de instanțe la **1** (ex. `--max-instances=1`).

---

## Ce este live vs. simulat & drumul spre producție

- **Live în prototip:** API-ul Tremend Verifier (`POST /verifications`, polling, `POST /claim`, `GET/DELETE /result`), rutare dinamică `qa-both-23` / `qa-address-23` / `qa-income-23`, semnare HMAC-SHA256, decriptare JWE P-256, validare semnătură `ES256` prin `/.well-known/jwks.json`, protecție `jti`, verificări `issuerSignature` / `holderBinding` / `validity` / `trustedIssuer` / expirare per credențial + TOCTOU, reguli cross-credential binding, orchestrare Gemini Zero-PII (`store: false`), wrapper Android same-device (`ro.banking40.team04`) și EUDI Android Wallet.
- **Simulat în prototip:** Interfața mobilă ZenBank (`Datele mele` + `Chat` + foaia `Demo`), API-ul intern de profil/restricții (`Radu Stan`, `Alex Popescu`, `Maria Ionescu`) și endpoint-urile de test/simulare scenarii negative de pe backend.
- **Necesar pentru producție bancară:**
  - Înregistrare oficială ca **Relying Party** sub eIDAS 2, certificate de acces/înregistrare și validare prin **ETSI Trusted Lists** (`ETSI TS 119 612` / `602`).
  - Verificare live **Token Status List** pentru revocare (înlocuind `NOT_CHECKED`).
  - Integrare cu motoarele KYC/AML ale băncii (conformitate bancară, screening sancțiuni/PEP, escaladare manuală pentru schimbări de nume/identitate).
  - **PSD2 Strong Customer Authentication (SCA)** în ZenBank pentru confirmarea modificărilor sensibile de profil și registre formale GDPR de consimțământ/retenție.
