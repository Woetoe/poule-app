# Werkafspraken voor Claude-sessies

Elke push naar `main` brengt meteen een nieuwe versie uit: GitHub bouwt de APK, zet hem bij Releases en zet een ondertekende update op de branch `uitgifte`. De app op Wouters telefoon haalt die bij het openen vanzelf op.

1. **Pagina's** staan in `web/` (startscherm `index.html`, `darts.html`, `ek.html`). Wijzigingen daarin komen zonder nieuwe APK bij de gebruiker.
2. **Android-schil veranderd** (Java, manifest, rechten, Gradle)? Dan `android/native_version.txt` ophogen. De app vraagt dan om de nieuwe APK te downloaden; anders komt de nieuwe code niet aan.
3. **Sleutel**: het geheim `POULE_SLEUTEL` (PKCS12, base64, wachtwoord `poule-sleutel`) ondertekent de APK én elke update. `android/update_key.pem` is de publieke kant; die twee moeten bij elkaar passen, anders stopt de bouw. Nooit een sleutel in de repo zetten: de repo is openbaar.
4. **Controleer lokaal** wat je kunt: `python3 tools/uitgifte.py manifest 1` en de pagina's in een browser. Gooi `web/manifest.json` daarna weg (staat in `.gitignore`).
5. **Tests**: `node --test tests/*.test.js` (draait ook in de bouw; faalt er één, dan komt er geen uitgave). `tools/nepfirebase.js` voert daarbij de echte databaseregels uit.
6. **Database**: de poule gebruikt dezelfde Firebase als W2 Apps, onder `/r/<ruimte>/…` (regels in `tools/firebase/regels.json`, kopie uit W2-apps). Alles is versleuteld met een sleutel uit de poulecode en ondertekend; zie de uitleg bovenin `web/poule.js`. Verander je de regels, dan ook in W2-apps.
7. Pagina's mogen alleen dingen van buiten laden die ook zonder internet kunnen ontbreken (zoals Google Fonts); al het andere hoort in `web/`.

Schrijf voor Wouter in gewoon Nederlands; commitberichten ook in het Nederlands.
