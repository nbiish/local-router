#!/usr/bin/env python3
"""
pqc_helper.py - PQC Cryptographic helper for ML-DSA-65 signatures.
Provides utilities to generate keys, sign files, and verify signatures using OpenSSL.
"""

import sys
import subprocess
import argparse
from pathlib import Path

DEFAULT_TIMEOUT = 30  # seconds


def run_command(
    args: list[str],
    *,
    check: bool = True,
    timeout: int = DEFAULT_TIMEOUT,
    input_data: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run command securely and capture output.

    Args:
        args: Command and arguments.
        check: If True, raise CalledProcessError on non-zero exit.
        timeout: Seconds before the subprocess is killed.
        input_data: Optional string piped to stdin.

    Returns:
        CompletedProcess result.
    """
    try:
        return subprocess.run(
            args,
            check=check,
            text=True,
            capture_output=True,
            timeout=timeout,
            input=input_data,
        )
    except subprocess.TimeoutExpired:
        print(f"Timeout executing command: {' '.join(args)}", file=sys.stderr)
        raise
    except subprocess.CalledProcessError as e:
        print(f"Error executing command: {' '.join(args)}", file=sys.stderr)
        print(f"Stdout: {e.stdout}", file=sys.stderr)
        print(f"Stderr: {e.stderr}", file=sys.stderr)
        raise


def generate_keypair(priv_path: Path, pub_path: Path) -> None:
    """Generate ML-DSA-65 keypair."""
    priv_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Generating ML-DSA-65 private key at: {priv_path}")
    run_command(["openssl", "genpkey", "-algorithm", "ML-DSA-65", "-out", str(priv_path)])
    priv_path.chmod(0o600)

    print(f"Generating public key at: {pub_path}")
    run_command(["openssl", "pkey", "-in", str(priv_path), "-pubout", "-out", str(pub_path)])
    print("Keypair generated successfully.")


def sign_file(file_path: Path, priv_path: Path, sig_path: Path) -> None:
    """Sign a file using ML-DSA-65 private key."""
    if not file_path.is_file():
        raise FileNotFoundError(f"File to sign not found: {file_path}")
    if not priv_path.is_file():
        raise FileNotFoundError(f"Private key not found: {priv_path}")

    print(f"Signing {file_path} -> {sig_path}")
    run_command([
        "openssl", "pkeyutl", "-sign",
        "-inkey", str(priv_path),
        "-in", str(file_path),
        "-out", str(sig_path),
    ])
    print("Signing complete.")


def verify_file(file_path: Path, pub_path: Path, sig_path: Path) -> bool:
    """Verify file signature against ML-DSA-65 public key.

    Returns True if the signature is valid, False otherwise.
    Distinguishes between a genuine verification failure (tampered/wrong
    signature) and an unexpected command execution error (e.g. missing
    openssl binary).
    """
    if not file_path.is_file():
        print(f"ERROR: Target file not found: {file_path}", file=sys.stderr)
        return False
    if not pub_path.is_file():
        print(f"ERROR: Public key not found: {pub_path}", file=sys.stderr)
        return False
    if not sig_path.is_file():
        print(f"ERROR: Signature file not found: {sig_path}", file=sys.stderr)
        return False

    try:
        # Use check=False so we can inspect the return code ourselves.
        # OpenSSL pkeyutl -verify exits 0 on success, 1 on failure.
        result = run_command(
            [
                "openssl", "pkeyutl", "-verify",
                "-pubin", "-inkey", str(pub_path),
                "-in", str(file_path),
                "-sigfile", str(sig_path),
            ],
            check=False,
        )

        if result.returncode == 0 and "Signature Verified Successfully" in result.stdout:
            print(f"✓ Verified: {file_path.name}")
            return True
        elif result.returncode == 1:
            # OpenSSL returns 1 for a genuine verification failure
            print(f"✗ Verification FAILED: {file_path.name} (signature mismatch)", file=sys.stderr)
            return False
        else:
            # Unexpected exit code — something else went wrong
            print(f"✗ Verification ERROR: {file_path.name}", file=sys.stderr)
            print(f"  Exit code: {result.returncode}", file=sys.stderr)
            if result.stderr:
                print(f"  Stderr: {result.stderr.strip()}", file=sys.stderr)
            return False
    except FileNotFoundError:
        print(f"✗ Verification ERROR: openssl not found in PATH", file=sys.stderr)
        return False
    except subprocess.TimeoutExpired:
        print(f"✗ Verification ERROR: {file_path.name} (timeout)", file=sys.stderr)
        return False
    except Exception as exc:
        print(f"✗ Verification ERROR: {file_path.name} ({exc})", file=sys.stderr)
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="PQC ML-DSA-65 Signature Helper Utility")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Keygen parser
    gen_parser = subparsers.add_parser("keygen", help="Generate ML-DSA-65 keypair")
    gen_parser.add_argument("--priv", type=Path, default=Path(".signing/agent_privkey.pem"), help="Path to private key")
    gen_parser.add_argument("--pub", type=Path, default=Path("AGENT_PUBKEY.pem"), help="Path to public key")

    # Sign parser
    sign_parser = subparsers.add_parser("sign", help="Sign a file")
    sign_parser.add_argument("file", type=Path, help="File to sign")
    sign_parser.add_argument("--priv", type=Path, default=Path(".signing/agent_privkey.pem"), help="Path to private key")
    sign_parser.add_argument("--sig", type=Path, help="Path to signature output (defaults to file.sig)")

    # Verify parser
    verify_parser = subparsers.add_parser("verify", help="Verify a file's signature")
    verify_parser.add_argument("file", type=Path, help="File to verify")
    verify_parser.add_argument("--pub", type=Path, default=Path("AGENT_PUBKEY.pem"), help="Path to public key")
    verify_parser.add_argument("--sig", type=Path, help="Path to signature file (defaults to file.sig)")

    args = parser.parse_args()

    if args.command == "keygen":
        generate_keypair(args.priv, args.pub)
    elif args.command == "sign":
        sig_file = args.sig or Path(f"{args.file}.sig")
        sign_file(args.file, args.priv, sig_file)
    elif args.command == "verify":
        sig_file = args.sig or Path(f"{args.file}.sig")
        success = verify_file(args.file, args.pub, sig_file)
        sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
