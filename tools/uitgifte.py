"""Updates voor de poule-app klaarzetten.

  python3 tools/uitgifte.py manifest <build>
      schrijft web/manifest.json (gaat mee in de APK als assets/www/manifest.json)
  python3 tools/uitgifte.py publish <map> <apk> <build>
      zet in <map> (de branch 'uitgifte'): f/<sha256> per bestand, manifest.json (met de hash van de APK)
      en manifest.sig (ECDSA P-256 over manifest.json, base64).

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


def native():
    return int(open(os.path.join(ROOT, 'android', 'native_version.txt')).read().strip())


def files():
    out = {}
    for d, _, names in os.walk(WEB):
        for n in sorted(names):
            full = os.path.join(d, n)
            rel = os.path.relpath(full, WEB).replace(os.sep, '/')
            if rel == 'manifest.json' or n.startswith('.'):
                continue
            data = open(full, 'rb').read()
            out[rel] = {'h': hashlib.sha256(data).hexdigest(), 's': len(data)}
    return dict(sorted(out.items()))


def base_manifest(build):
    return {'build': int(build), 'native': native(), 'version': VERSION_PREFIX + str(build),
            'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'files': files()}


def manifest(build):
    m = base_manifest(build)
    with open(os.path.join(WEB, 'manifest.json'), 'w') as f:
        json.dump(m, f, separators=(',', ':'))
    print('manifest', m['version'], 'native', m['native'], len(m['files']), 'bestanden')


def sign(data):
    key = os.environ.get('UPDATE_SIGN_KEY_FILE')
    if not key or not os.path.isfile(key):
        sys.exit('Geen UPDATE_SIGN_KEY_FILE: zonder handtekening wordt er niets gepubliceerd.')
    der = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key], input=data,
                         stdout=subprocess.PIPE, check=True).stdout
    return base64.b64encode(der)


def publish(target, apk, build):
    m = base_manifest(build)
    os.makedirs(os.path.join(target, 'f'), exist_ok=True)
    for rel, info in m['files'].items():
        dst = os.path.join(target, 'f', info['h'])
        if not os.path.exists(dst):
            shutil.copyfile(os.path.join(WEB, rel), dst)
    # alleen de bestanden van deze versie bewaren
    keep = {i['h'] for i in m['files'].values()}
    for n in os.listdir(os.path.join(target, 'f')):
        if n not in keep:
            os.remove(os.path.join(target, 'f', n))
    a = open(apk, 'rb').read()
    m['apk'] = {'h': hashlib.sha256(a).hexdigest(), 's': len(a)}
    m['apkUrl'] = 'https://github.com/%s/releases/download/v%s/poule-%s.apk' % (REPO, m['version'], m['version'])
    body = json.dumps(m, separators=(',', ':')).encode()
    with open(os.path.join(target, 'manifest.json'), 'wb') as f:
        f.write(body)
    with open(os.path.join(target, 'manifest.sig'), 'wb') as f:
        f.write(sign(body))
    with open(os.path.join(target, 'README.md'), 'w') as f:
        f.write('# Uitgifte poule-app\n\nAutomatisch gemaakt door de build. Niet met de hand aanpassen.\n')
    print('gepubliceerd', m['version'], len(m['files']), 'bestanden')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'manifest':
        manifest(sys.argv[2])
    elif cmd == 'publish':
        publish(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        sys.exit(__doc__)
