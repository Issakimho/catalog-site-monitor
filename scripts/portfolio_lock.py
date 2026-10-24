"""Cancel only a queued worker cleanly; active work retains normal failure handling."""
import fcntl
import json
import signal

def acquire_portfolio_lock(lock):
    previous = signal.getsignal(signal.SIGTERM)
    def deferred(signum, frame):
        print(json.dumps({"action": "deferred", "reason": "cancelled_while_waiting_for_portfolio"}), flush=True)
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, deferred)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
    finally:
        signal.signal(signal.SIGTERM, previous)
