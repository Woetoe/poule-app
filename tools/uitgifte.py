"""Updates voor de poule-app klaarzetten.

  python3 tools/uitgifte.py manifest <build>
      schrijft web/manifest.json (gaat mee in de APK als assets/www/manifest.json)
  python3 tools/uitgifte.py publish <map> <apk> <build>
      zet in <map> (de branch 'uitgifte'): f/<sha256> per bestand, manifest.json (met de hash van de APK),
      manifest.sig (ECDSA P-256 over manifest.json, base64) en web/ (de webversie voor GitHub Pages).

De privésleutel (PEM) staat in het bestand uit UPDATE_SIGN_KEY_FILE. De app controleert manifest.sig met
android/update_key.pem en weigert alles wat niet klopt. Zonder sleutel wordt er niets gepubliceerd.
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, 'web')
VERSION_PREFIX = '0.2.'
REPO = 'Woetoe/poule-app'


def read_bytes(path):
    """Inhoud van een bestand als bytes."""
    with open(path, 'rb') as f:
        return f.read()


def write_bytes(path, data):
    """Bytes naar een bestand schrijven."""
    with open(path, 'wb') as f:
        f.write(data)


def native():
    """Versie van de Android-schil (android/native_version.txt)."""
    with open(os.path.join(ROOT, 'android', 'native_version.txt'), encoding='utf-8') as f:
        return int(f.read().strip())


def files():
    """Alle bestanden in web/ met sha256 en grootte (zonder manifest.json en verborgen bestanden)."""
    out = {}
    for folder, _, names in os.walk(WEB):
        for name in sorted(names):
            full = os.path.join(folder, name)
            rel = os.path.relpath(full, WEB).replace(os.sep, '/')
            if rel == 'manifest.json' or name.startswith('.'):
                continue
            data = read_bytes(full)
            out[rel] = {'h': hashlib.sha256(data).hexdigest(), 's': len(data)}
    return dict(sorted(out.items()))


def base_manifest(build):
    """Het manifest zonder APK-gegevens."""
    return {'build': int(build), 'native': native(), 'version': VERSION_PREFIX + str(build),
            'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'files': files()}


def manifest(build):
    """Schrijft web/manifest.json; zo weet de app welke versie er in de APK zit."""
    m = base_manifest(build)
    with open(os.path.join(WEB, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(m, f, separators=(',', ':'))
    print('manifest', m['version'], 'native', m['native'], len(m['files']), 'bestanden')


def signing_key():
    """Pad naar de privésleutel; stopt als die ontbreekt (liever geen uitgave dan een niet-ondertekende)."""
    key = os.environ.get('UPDATE_SIGN_KEY_FILE')
    if not key or not os.path.isfile(key):
        sys.exit('Geen UPDATE_SIGN_KEY_FILE: zonder handtekening wordt er niets gepubliceerd.')
    return key


def sign(data):
    """ECDSA-handtekening (base64) over data."""
    der = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', signing_key()], input=data,
                         stdout=subprocess.PIPE, check=True).stdout
    return base64.b64encode(der)


def copy_files(target, m):
    """Zet elk bestand als f/<sha256> klaar en ruimt bestanden van oudere versies op."""
    fdir = os.path.join(target, 'f')
    os.makedirs(fdir, exist_ok=True)
    for rel, info in m['files'].items():
        dst = os.path.join(fdir, info['h'])
        if not os.path.exists(dst):
            shutil.copyfile(os.path.join(WEB, rel), dst)
    keep = {i['h'] for i in m['files'].values()}
    for name in os.listdir(fdir):
        if name not in keep:
            os.remove(os.path.join(fdir, name))


def copy_web(target):
    """Webversie (iPhone, laptop) via GitHub Pages: woetoe.github.io/poule-app/web/."""
    wdir = os.path.join(target, 'web')
    if os.path.isdir(wdir):
        shutil.rmtree(wdir)
    shutil.copytree(WEB, wdir, ignore=shutil.ignore_patterns('manifest.json'))
    write_bytes(os.path.join(target, '.nojekyll'), b'')


def publish(target, apk, build):
    """Ondertekende update klaarzetten in target (de branch 'uitgifte')."""
    signing_key()  # meteen stoppen als de sleutel ontbreekt, vóór er iets geschreven is
    m = base_manifest(build)
    copy_files(target, m)
    a = read_bytes(apk)
    m['apk'] = {'h': hashlib.sha256(a).hexdigest(), 's': len(a)}
    m['apkUrl'] = f"https://github.com/{REPO}/releases/download/v{m['version']}/poule-{m['version']}.apk"
    body = json.dumps(m, separators=(',', ':')).encode()
    write_bytes(os.path.join(target, 'manifest.json'), body)
    write_bytes(os.path.join(target, 'manifest.sig'), sign(body))
    copy_web(target)
    with open(os.path.join(target, 'README.md'), 'w', encoding='utf-8') as f:
        f.write('# Uitgifte poule-app\n\nAutomatisch gemaakt door de bouw. Niet met de hand aanpassen.\n')
    print('gepubliceerd', m['version'], len(m['files']), 'bestanden')


def main(argv):
    """Opdrachtregel: manifest of publish."""
    cmd = argv[1] if len(argv) > 1 else ''
    if cmd == 'manifest' and len(argv) == 3:
        manifest(argv[2])
    elif cmd == 'publish' and len(argv) == 5:
        publish(argv[2], argv[3], argv[4])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
