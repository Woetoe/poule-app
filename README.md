# Poule

Voorspellingspoule voor vrienden. Nu: WK darts 2026/27. De EK 2028 volgt later.

- `web/` – de pagina's (startscherm, darts). Dezelfde bestanden zitten in de app en komen later op de weblink voor iPhone.
- `android/` – Android-app die `web/` toont en zichzelf bijwerkt.
- `web/poule.js` – gedeelde data: poules, leden, voorspellingen, punten (versleuteld en ondertekend, via de Firebase van W2 Apps).
- `tools/uitgifte.py` – maakt het ondertekende updatemanifest en zet de webversie klaar.
- `tests/` – `node --test tests/*.test.js`.

Webversie (iPhone, laptop): https://woetoe.github.io/poule-app/web/

## Uitgeven

Elke push naar `main` bouwt via GitHub Actions:

1. een APK, ondertekend met het geheim `POULE_SLEUTEL`, bij **Releases**;
2. een update op de branch `uitgifte`: `manifest.json`, `manifest.sig` en de bestanden als `f/<sha256>`.

De app zoekt bij elke start stil naar een nieuwe versie, controleert de handtekening met `android/update_key.pem` en zet de nieuwe pagina's klaar. Alleen als `android/native_version.txt` omhooggaat, vraagt de app om de nieuwe APK te installeren.
