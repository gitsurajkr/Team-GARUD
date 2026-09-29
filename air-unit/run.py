#!/usr/bin/env python3
"""Convenience entry point:  python run.py

Equivalent to `python -m air_unit` but doesn't require setting PYTHONPATH.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from air_unit.app import main  # noqa: E402

if __name__ == "__main__":
    main()
