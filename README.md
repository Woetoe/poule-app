# Poule

Voorspellingspoule voor vrienden: WK darts 2026/27 en EK 2028.

- `web/` – de pagina's (startscherm, darts, EK). Dezelfde bestanden komen in de app en later op de weblink voor iPhone.
- `android/` – Android-app die `web/` toont.
- Elke push naar `main` bouwt via GitHub Actions een APK en zet die bij **Releases**.

De sleutel in `android/keystore/` is een testsleutel (wachtwoord staat in `app/build.gradle`). Prima voor installeren op je eigen telefoon; vervang hem als de app ooit in de Play Store moet.
