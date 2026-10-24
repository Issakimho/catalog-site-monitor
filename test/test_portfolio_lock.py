import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
CHILD = (
    "from portfolio_lock import acquire_portfolio_lock; "
    "import signal,sys; "
    "f=open(sys.argv[1],'a'); "
    "print('ready',flush=True); "
    "acquire_portfolio_lock(f); "
    "print('acquired',flush=True); "
    "signal.pause()"
)
RUNNER = """
import importlib.util, json, pathlib, sys
folder = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('collector', sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.BASE = folder
module.CONFIG = folder / 'sites.json'
module.CONFIG.write_text(json.dumps({'sites': {'de': {'root': '/home/imho/catalog/de'}}}))
sys.argv = ['run-site.py', 'de']
print('ready', flush=True)
module.main()
"""


class PortfolioLockTest(unittest.TestCase):
    def start_child(self, path):
        env = {**os.environ, "PYTHONPATH": str(SCRIPTS)}
        return subprocess.Popen(
            [sys.executable, "-u", "-c", CHILD, str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
        )

    def test_queued_worker_defers_when_cancelled(self):
        with tempfile.TemporaryDirectory() as folder:
            with open(Path(folder) / "lock", "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                child = self.start_child(lock.name)
                try:
                    self.assertEqual(child.stdout.readline().strip(), "ready")
                    time.sleep(0.1)
                    self.assertIsNone(child.poll())
                    child.send_signal(signal.SIGTERM)
                    out, err = child.communicate(timeout=5)
                    self.assertEqual(child.returncode, 0)
                    self.assertEqual(json.loads(out), {
                        "action": "deferred", "reason": "cancelled_while_waiting_for_portfolio"
                    })
                    self.assertEqual(err, "")
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()

    def test_active_worker_keeps_normal_termination(self):
        with tempfile.TemporaryDirectory() as folder:
            child = self.start_child(Path(folder) / "lock")
            try:
                self.assertEqual(child.stdout.readline().strip(), "ready")
                self.assertEqual(child.stdout.readline().strip(), "acquired")
                child.send_signal(signal.SIGTERM)
                out, err = child.communicate(timeout=5)
                self.assertEqual(child.returncode, -signal.SIGTERM)
                self.assertEqual(out, "")
                self.assertEqual(err, "")
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()

    def test_collector_entrypoint_handles_cancellation_while_queued(self):
        with tempfile.TemporaryDirectory() as folder:
            with open(Path(folder) / "portfolio.lock", "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                env = {**os.environ, "PYTHONPATH": str(SCRIPTS)}
                child = subprocess.Popen(
                    [sys.executable, "-u", "-c", RUNNER, folder, str(SCRIPTS / "raspberry-run-site.py")],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                )
                try:
                    self.assertEqual(child.stdout.readline().strip(), "ready")
                    time.sleep(0.1)
                    child.send_signal(signal.SIGTERM)
                    out, err = child.communicate(timeout=5)
                    self.assertEqual(child.returncode, 0)
                    self.assertEqual(json.loads(out), {
                        "action": "deferred", "reason": "cancelled_while_waiting_for_portfolio"
                    })
                    self.assertEqual(err, "")
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()


if __name__ == "__main__":
    unittest.main()
