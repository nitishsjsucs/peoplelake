"""Every process the stack starts runs in its own process group and is killed on stop; ports end free."""

import json
import socket
import sys
import time

import pytest

from peoplelake import stack as st


def free_port_or_skip(port):
    if st.port_in_use(port):
        pytest.skip(f"port {port} is in use by something else on this machine")


def dummy_server(port: int, log) -> st.ManagedProcess:
    # A parent that spawns a child: both must die with the group.
    code = (
        "import socket, subprocess, sys, time;"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)']);"
        f"s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', {port})); s.listen();"
        "time.sleep(600)"
    )
    return st.ManagedProcess("dummy", [sys.executable, "-c", code], log)


def wait_listening(port, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if st.port_in_use(port):
            return True
        time.sleep(0.1)
    return False


def test_kill_group_frees_the_port(tmp_path):
    free_port_or_skip(st.WRANGLER_PORT)
    proc = dummy_server(st.WRANGLER_PORT, tmp_path / "dummy.log")
    proc.start()
    assert wait_listening(st.WRANGLER_PORT)
    st.kill_group(proc.pid)
    assert st.wait_ports_free((st.WRANGLER_PORT,), timeout=10) == []
    assert proc.proc.wait(timeout=5) is not None


def test_stop_recorded_kills_groups_from_state_file(tmp_path):
    free_port_or_skip(st.INSPECTOR_PORT)
    proc = dummy_server(st.INSPECTOR_PORT, tmp_path / "dummy.log")
    proc.start()
    assert wait_listening(st.INSPECTOR_PORT)
    (tmp_path / "state.json").write_text(json.dumps({"processes": [{"name": "dummy", "pid": proc.pid}]}))
    st.stop_recorded(tmp_path)
    assert not (tmp_path / "state.json").exists()
    assert st.wait_ports_free((st.INSPECTOR_PORT,), timeout=10) == []


def test_up_refuses_busy_ports(tmp_path):
    free_port_or_skip(st.WRANGLER_PORT)
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", st.WRANGLER_PORT))
    s.listen()
    try:
        with pytest.raises(st.StackError, match="ports already in use"):
            st.LocalStack(state_dir=tmp_path).up()
    finally:
        s.close()


@pytest.mark.e2e
def test_real_stack_up_and_down_leaves_ports_free(tmp_path):
    for port in st.PORTS:
        free_port_or_skip(port)
    stack = st.LocalStack(state_dir=tmp_path / "stack", mode="eval", runner=False)
    try:
        stack.up()
        assert st.port_in_use(st.WRANGLER_PORT)
    finally:
        busy = stack.down()
    assert busy == []
    assert st.ports_busy(st.PORTS) == []
