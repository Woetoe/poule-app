"""Tests voor tools/uitgifte.py: manifest, ondertekende uitgave en weigeren zonder sleutel."""
import base64
import hashlib
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import uitgifte  # noqa: E402  pylint: disable=wrong-import-position


@pytest.fixture(name='sleutel')
def fixture_sleutel(tmp_path):
    """Een nieuwe EC-sleutel (P-256) als PEM, met de publieke kant ernaast."""
    priv = tmp_path / 'update.pem'
    pub = tmp_path / 'update.pub.pem'
    subprocess.run(['openssl', 'ecparam', '-name', 'prime256v1', '-genkey', '-noout',
                    '-out', str(priv)], check=True)
    subprocess.run(['openssl', 'ec', '-in', str(priv), '-pubout', '-out', str(pub)],
                   check=True, capture_output=True)
    return priv, pub


@pytest.fixture(name='opruimen', autouse=True)
def fixture_opruimen():
    """web/manifest.json is een bouwproduct: na elke test weer weg."""
    yield
    pad = os.path.join(uitgifte.WEB, 'manifest.json')
    if os.path.exists(pad):
        os.remove(pad)


def test_manifest_noemt_alle_bestanden_met_hash():
    """Het manifest noemt elk webbestand met de juiste hash, en niet zichzelf."""
    uitgifte.manifest(41)
    with open(os.path.join(uitgifte.WEB, 'manifest.json'), encoding='utf-8') as f:
        m = json.load(f)
    assert m['build'] == 41 and m['version'] == '0.2.41'
    assert m['native'] == uitgifte.native()
    assert 'index.html' in m['files'] and 'manifest.json' not in m['files']
    with open(os.path.join(uitgifte.WEB, 'index.html'), 'rb') as f:
        assert m['files']['index.html']['h'] == hashlib.sha256(f.read()).hexdigest()


def verifieer(pub, sig_der, data):
    """True als de handtekening bij de data en de publieke sleutel past (via openssl)."""
    res = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(pub), '-signature', str(sig_der)],
                         input=data, capture_output=True, check=False)
    return res.returncode == 0


@pytest.fixture(name='uitgave')
def fixture_uitgave(tmp_path, sleutel, monkeypatch):
    """Publiceert build 7 naar een lege map met één verouderd bestand erin."""
    monkeypatch.setenv('UPDATE_SIGN_KEY_FILE', str(sleutel[0]))
    apk = tmp_path / 'poule.apk'
    apk.write_bytes(b'apk')
    doel = tmp_path / 'uit'
    (doel / 'f').mkdir(parents=True)
    (doel / 'f' / 'oud').write_text('weg ermee', encoding='utf-8')
    uitgifte.publish(str(doel), str(apk), 7)
    der = tmp_path / 'sig.der'
    der.write_bytes(base64.b64decode((doel / 'manifest.sig').read_bytes()))
    return doel, der


def test_publiceren_is_ondertekend(uitgave, sleutel):
    """De handtekening past bij het manifest, en niet bij een aangepast manifest."""
    doel, der = uitgave
    body = (doel / 'manifest.json').read_bytes()
    assert verifieer(sleutel[1], der, body)
    assert not verifieer(sleutel[1], der, body.replace(b'"build":7', b'"build":8'))


def test_publiceren_is_compleet(uitgave):
    """APK-hash, downloadlink, bestanden op hash, opgeruimde oude bestanden en webversie."""
    doel, _ = uitgave
    m = json.loads((doel / 'manifest.json').read_bytes())
    assert m['apk']['h'] == hashlib.sha256(b'apk').hexdigest()
    assert m['apkUrl'].endswith('/v0.2.7/poule-0.2.7.apk')
    for rel, info in m['files'].items():
        assert hashlib.sha256((doel / 'f' / info['h']).read_bytes()).hexdigest() == info['h'], rel
    assert not (doel / 'f' / 'oud').exists(), 'oude bestanden opgeruimd'
    assert (doel / 'web' / 'index.html').exists() and (doel / '.nojekyll').exists()


def test_zonder_sleutel_geen_uitgave(tmp_path, monkeypatch):
    """Zonder sleutel stopt het en komt er niets klaar te staan."""
    monkeypatch.delenv('UPDATE_SIGN_KEY_FILE', raising=False)
    apk = tmp_path / 'poule.apk'
    apk.write_bytes(b'apk')
    with pytest.raises(SystemExit):
        uitgifte.publish(str(tmp_path / 'uit'), str(apk), 1)
    assert not (tmp_path / 'uit').exists()
