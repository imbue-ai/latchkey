"""Type checking test using pyright."""

import subprocess
from pathlib import Path


def test_pyright_type_check() -> None:
    """Run pyright type checking on the codebase."""
    project_root = Path(__file__).parent.parent
    pyright_path = project_root / ".venv" / "bin" / "pyright"

    result = subprocess.run(
        [str(pyright_path)],
        capture_output=True,
        text=True,
        cwd=project_root,
    )
    assert result.returncode == 0, f"Type checking failed:\n{result.stdout}\n{result.stderr}"
