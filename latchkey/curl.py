"""Curl subprocess utilities."""

import subprocess
from collections.abc import Callable
from collections.abc import Sequence

# Type alias for the subprocess runner function (no output capture, for interactive use)
SubprocessRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[bytes]]

# Type alias for the capturing subprocess runner function (captures output)
CapturingSubprocessRunner = Callable[[Sequence[str], int], subprocess.CompletedProcess[str]]


def _default_subprocess_runner(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    """Default subprocess runner that calls the real subprocess.run without capturing output."""
    return subprocess.run(args, capture_output=False)


def _default_capturing_subprocess_runner(args: Sequence[str], timeout: int) -> subprocess.CompletedProcess[str]:
    """Default subprocess runner that calls the real subprocess.run with output capture."""
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


# Global subprocess runners that can be replaced for testing
_subprocess_runner: SubprocessRunner = _default_subprocess_runner
_capturing_subprocess_runner: CapturingSubprocessRunner = _default_capturing_subprocess_runner


def set_subprocess_runner(runner: SubprocessRunner) -> None:
    """Set the subprocess runner function. Used for testing."""
    global _subprocess_runner
    _subprocess_runner = runner


def reset_subprocess_runner() -> None:
    """Reset the subprocess runner to the default. Used for testing."""
    global _subprocess_runner
    _subprocess_runner = _default_subprocess_runner


def set_capturing_subprocess_runner(runner: CapturingSubprocessRunner) -> None:
    """Set the capturing subprocess runner function. Used for testing."""
    global _capturing_subprocess_runner
    _capturing_subprocess_runner = runner


def reset_capturing_subprocess_runner() -> None:
    """Reset the capturing subprocess runner to the default. Used for testing."""
    global _capturing_subprocess_runner
    _capturing_subprocess_runner = _default_capturing_subprocess_runner


def run(args: Sequence[str]) -> subprocess.CompletedProcess[bytes]:
    """Run curl without capturing output (for interactive CLI use)."""
    return _subprocess_runner(["curl", *args])


def run_captured(args: Sequence[str], timeout: int = 10) -> subprocess.CompletedProcess[str]:
    """Run curl with output capture (for credential checking)."""
    return _capturing_subprocess_runner(["curl", *args], timeout)
