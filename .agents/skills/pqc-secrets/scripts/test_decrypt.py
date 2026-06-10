import json
import os
import sys
import base64
import subprocess
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from kyber_py.ml_kem import ML_KEM_768

BUNDLE_PATH = '/Users/nbiish/.config/pqc-secrets/secrets.bundle.json'
with open(BUNDLE_PATH) as f:
    bundle = json.load(f)

result = subprocess.run([
    "security", "find-generic-password",
    "-s", "pqc-secrets",
    "-a", os.environ.get("PQC_KEYCHAIN_ACCOUNT", "pqc-secrets-key"),
    "-w"
], check=True, capture_output=True, text=True)
raw = result.stdout.strip()
try:
    sk = bytes.fromhex(raw)
except ValueError:
    sk = base64.b64decode(raw)

kem_ct = base64.b64decode(bundle["kem"]["ciphertext_b64"])
dek = ML_KEM_768.decaps(sk, kem_ct)
print("DEK derived (len):", len(dek))

# The keywrap holds the encrypted Data Key (DK).
kw = bundle["keywrap"]
kw_ct = base64.b64decode(kw["ciphertext_b64"])
kw_nonce = base64.b64decode(kw["nonce_b64"])
kw_aad = kw["aad"].encode('utf-8')

aesgcm = AESGCM(dek)
try:
    dk = aesgcm.decrypt(kw_nonce, kw_ct, kw_aad)
    print("DK decrypted! len:", len(dk))
except Exception as e:
    print("Failed to decrypt DK with DEK directly:", e)
    # What if KDF was used?
    import hashlib
    dk_hash = hashlib.sha3_256(dek).digest()
    try:
        aesgcm = AESGCM(dk_hash)
        dk = aesgcm.decrypt(kw_nonce, kw_ct, kw_aad)
        print("DK decrypted with SHA3-256(DEK)! len:", len(dk))
    except Exception as e2:
        print("Failed to decrypt DK with SHA3-256(DEK):", e2)
        sys.exit(1)

# Now use DK to decrypt data
data_sec = bundle["data"]
data_ct = base64.b64decode(data_sec["ciphertext_b64"])
data_nonce = base64.b64decode(data_sec["nonce_b64"])
data_aad = data_sec["aad"].encode('utf-8')

try:
    aesgcm_data = AESGCM(dk)
    pt = aesgcm_data.decrypt(data_nonce, data_ct, data_aad)
    print("Data decrypted successfully!")
except Exception as e:
    print("Failed to decrypt data:", e)

