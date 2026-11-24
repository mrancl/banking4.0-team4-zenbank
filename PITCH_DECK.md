# Pitch Deck & Live Demo Script — ZenBank EUDI Data Update
**Team 04 · Banking 4.0 Hackathon** · Format: **8 min pitch + live demo · 4 min Q&A**

---

## Slide-by-Slide Outline (8 Minutes Total)

### Slide 1 — Titlu & Teză (0:00 – 0:45)
- **ZenBank — Actualizare date KYC cu EUDI Wallet**
- *„Același ZenBank. Aceeași nevoie. Aceeași experiență digitală — indiferent de documentul cu care ai început relația cu banca.”*
- Formula: **`Clientul cere → Agentul orchestrează → EUDI verifică → ZenBank actualizează`**

### Slide 2 — Problema & Utilizatorul țintă (0:45 – 1:45)
- **Persona:** Radu Stan, cetățean UE, client ZenBank care are nevoie de actualizarea digitală a datelor personale și financiare.
- **Ce nu merge astăzi:** În lipsa unui flux digital unitar, clienții se lovesc de upload-uri de PDF/poze (act de identitate, dovadă adresă, adeverință salariu), 1–3 zile de verificare manuală în back-office sau drum la sucursală — iar între timp pot primi restricții pe plăți.

### Slide 3 — Soluția & Călătoria utilizatorului (1:45 – 2:45)
- Asistentul ZenBank citește contextul bancar (`document: IDENTITY_DOCUMENT`), explică **de ce** solicită datele înainte să deschidă wallet-ul, orchestrează verificarea reală prin **EUDI Wallet**, calculează diferențele și aplică actualizarea **doar după confirmarea explicită** a clientului.
- **Minimizare date:** PID (`nume, prenume, dată naștere` — fără CNP) + Adresă + Rezumat KYC sursă venit (`sursă, angajator, tranșă` — fără salvarea sumelor lunare brute).

### Slide 4 — LIVE DEMO (2:45 – 5:45)
1. **Flux principal (~2 min):**
   - În ZenBank (`Radu Stan`), apasă **Actualizează-mi datele personale**.
   - Arată cardul de **pre-consimțământ** (ce cerem, scop KYC, ce excludem).
   - Apasă **Continuă cu EUDI Wallet** → aprobă partajarea în **EUDI Android Wallet** (real).
   - Arată **comparația side-by-side** (`Bulevardul Unirii 22` → `Strada Exemplului 13, Timișoara`; `Nedeclarat` → `Example Services 4 SRL · 15.000–20.000 RON`) — subliniind că profilul din stânga încă NU s-a modificat.
   - Apasă **Confirmă actualizarea** → profilul ZenBank se actualizează instant (`Actualizat`, `0 documente încărcate`).
2. **Mini-demo chat (~45 sec):**
   - Comută scenariul la **Plăți restricționate**, întreabă **`"De ce nu pot face plăți?"`** → agentul diagnostichează automat actualizarea incompletă și îl introduce în același motor EUDI; confirmarea ridică restricția.
3. **Quick peek în Inspector (~20 sec):**
   - Arată verificările criptografice (`JWE`, `ES256 JWKS`, `jti`, `holderBinding`, `date_of_expiry`) și panoul **`llm_pii_exposed: false`**.

### Slide 5 — Impact de business & Ipoteze (5:45 – 6:45)
- **Înainte vs. După:** `~12 câmpuri manuale → 0`, `3 documente/PDF → 0`, `1–3 zile back-office → ~20 secunde`, `0 risc de PDF falsificat`.
- **Incluziune digitală:** Aceeași experiență digitală simplă pentru toți rezidenții UE.
- **Ipoteze asumate:** Emisii EUDI active (PID/Adresă/Venit), Token Status List live în producție, absența alertelor AML/sancțiuni.

### Slide 6 — Arhitectură tehnică & Limită Zero-PII (6:45 – 7:30)
- **Separare clară:** Gemini (`@google/genai`, `gemini-4-hydrogen`, `store: false`) primește **doar** stări și enum-uri fără PII; toate verificările criptografice (`ECDH-ES+A256KW`, `ES256`, `jti`) și regulile KYC rulează **determinist** pe backend-ul Node.js/TS.
- **Securitate:** Secretul API, cheia privată P-256 și valorile brute ale credențialelor nu părăsesc backend-ul și nu apar în loguri.

### Slide 7 — Ce e simulat vs. Drumul spre producție (7:30 – 8:00)
- **Real în demo:** EUDI Android Wallet, Tremend Verifier (`qa-both-23`), HMAC, JWE/ES256/JWKS, `jti` anti-replay, reguli deterministe.
- **Simulat:** Core Banking ZenBank (profil/restricții în memorie).
- **Pentru go-live:** Înregistrare eIDAS 2 Relying Party + certificate acces, Trusted Lists (`ETSI TS 119 612`), Token Status List live, integrare motoare AML/PEP și PSD2 SCA la confirmare.

---

## Cheat Sheet pentru cele 4 întrebări ale juriului (4 min Q&A)

1. **Ce verificați înainte să aveți încredere într-un atribut?**
   Decriptare JWE cu cheia privată P-256 → verificare semnătură `ES256` prin `/.well-known/jwks.json` → validare `typ=eudi-result+jwt`, `schema=eudi-verification-result/v1`, `iss`, `aud`, `exp`/`iat` → potrivire `transactionId` cu sesiunea → blocare replay `jti` → `outcome.status === SATISFIED` → verificări per credențial (`issuerSignature`, `holderBinding`, `validity`, `trustedIssuer`) + `date_of_expiry` → asociere titular EUDI cu clientul autentificat în ZenBank. În plus, pentru că în sandbox `checks.status = NOT_CHECKED`, limităm actualizarea automată la adresă și sursă de venit, fără schimbare de nume/CNP.
2. **Ce se întâmplă dacă clientul refuză în wallet?**
   Polling-ul se oprește imediat la `DECLINED` (sau `REFUSED`), profilul ZenBank rămâne neatins, iar asistentul oferă reluarea verificării EUDI sau fallback către încărcarea clasică / programare în sucursală.
3. **Ce atribut ați putea elimina și totuși să luați decizia?**
   Am eliminat deja CNP-ul (`personal_numeric_code`), locul nașterii și sumele lunare brute (păstrăm doar tranșa KYC). Iar dacă obiectivul este exclusiv deblocarea plăților prin reconfirmarea identității fără schimbare de adresă/loc de muncă, putem elimina **complet** atât `ADDRESS`, cât și `INCOME_ATTESTATION` și să solicităm doar `PID`.
4. **Ce este simulat și ce i-ar mai trebui unei bănci reale?**
   Simulat: interfața și baza de clienți ZenBank. Real: wallet-ul, Tremend Verifier și întreaga validare criptografică + reguli. Pentru producție: înregistrare eIDAS 2 RP, ETSI Trusted Lists, Token Status List live, screening AML/PEP și SCA la confirmarea modificării.
