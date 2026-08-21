"""Start the PyQt repo's demo sshd with password auth for the Tauri smoke test."""

import pathlib
import subprocess
import sys
import time

sys.path.insert(0, r"C:\code\RemotePal-python\tests")
import demo_sshd  # noqa: E402

SCRATCH = pathlib.Path(__file__).parent
key = SCRATCH / "demo_host_key"
if not key.exists():
    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-q", "-f", str(key)],
        check=True,
    )

port, _rec = demo_sshd.start(key, password="smoke-pw")
print(f"PORT={port}", flush=True)
time.sleep(600)  # smoke test window; process is killed by PID afterwards
