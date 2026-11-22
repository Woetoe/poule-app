# Poule

Voorspellingspoule voor vrienden: WK darts 2026/27 en EK 2028.

- `web/` – de pagina's (startscherm, darts, EK). Dezelfde bestanden zitten in de app en komen later op de weblink voor iPhone.
- `android/` – Android-app die `web/` toont en zichzelf bijwerkt.
- `tools/uitgifte.py` – maakt het ondertekende updatemanifest.

## Uitgeven

Elke push naar `main` bouwt via GitHub Actions:

1. een APK, ondertekend met het geheim `POULE_SLEUTEL`, bij **Releases**;
2. een update op de branch `uitgifte`: `manifest.json`, `manifest.sig` en de bestanden als `f/<sha256>`.

De app zoekt bij elke start stil naar een nieuwe versie, controleert de handtekening met `android/update_key.pem` en zet de nieuwe pagina's klaar. Alleen als `android/native_version.txt` omhooggaat, vraagt de app om de nieuwe APK te installeren.
